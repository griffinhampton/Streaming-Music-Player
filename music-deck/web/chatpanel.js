/* The chat panel (S11), shared by the deck and the Canvas Builder.

   The plan says "chat in the Live view" - and S9's Live view does not exist,
   while S9 says it shows "the chat from S11". Rather than build half a page to
   hold this, it is a shared panel exactly as LivePanel and AudioPanel are:
   any page mounts it once and opens it from a button. S9 then places it
   instead of owning it, and nothing has to be unpicked when it arrives.

   Where the messages come from: chat.py's hub, over /ws/chat. The socket is
   open only while the panel is - a page not showing chat has no business
   holding a feed - and /api/chat/recent fills in what was said while it was
   shut. feeds.serve_ws_feed sends nothing at all on connect, so that backfill
   is not a nicety: without it the panel would sit blank until somebody typed.
   The page names itself in the query because a WebSocket carries no Referer,
   and the feed accounting would otherwise not know who is holding it.

   What is kept and what is not:
   * Hiding one message lasts as long as the panel is open. The hub keeps 300
     messages and they age out, so a saved list of ids could only ever grow.
   * Blocking someone is kept in config (chat.blocked), so both pages agree and
     it survives a restart. It is local in the plan's sense: nothing is sent to
     the service, nobody is banned, they simply stop appearing here.

   Read-only, as the plan asks: there is no box to type in. Replying needs the
   account and the OAuth that S10 deliberately did without. */
const ChatPanel = (() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({ ok: false }));
  const getJSON = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);

  const CAP = 300;                       // what the hub keeps, so what we draw

  let el = null, anchor = null, docked = false;
  let ws = null, retry = null;
  let msgs = [];                         // newest last
  let blocked = [];                      // logins, from config.chat.blocked
  // The channel each service last connected to, kept in config by the connect
  // route - offered again rather than asked for every stream. Public names.
  let saved = { twitch: '', tiktok: '', show: false };
  const hidden = new Set();              // message ids, this session only
  let services = [];                     // from the state snapshot
  let paused = false, unseen = 0;

  const $ = (sel) => el.querySelector(sel);
  const login = (m) => (m.user && m.user.login) || '';

  /* The channel being read is the streamer, so "@them" is a mention of you.
     Built once per state change rather than per message. */
  let mentionRe = null;
  function setMention() {
    const names = services.map((s) => s.channel).filter(Boolean);
    mentionRe = names.length
      ? new RegExp('(^|[^\\w])@?(' + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i')
      : null;
  }

  function visible(m) {
    return !hidden.has(m.id) && !blocked.includes(login(m));
  }

  /* ------------------------------------------------------------- drawing */

  function row(m) {
    const cls = ['cp-msg'];
    if (m.command) cls.push('cmd');
    if (mentionRe && mentionRe.test(m.text || '')) cls.push('mention');
    if (m.action) cls.push('act');
    const when = new Date((m.at || 0) * 1000);
    const badges = (m.badges || []).map((b) => `<span class="cp-badge">${esc(String(b).split('/')[0])}</span>`).join('');
    const color = /^#[0-9a-f]{6}$/i.test(m.user && m.user.color || '') ? m.user.color : '';
    return `<div class="${cls.join(' ')}" data-id="${esc(m.id)}" title="${esc(when.toLocaleTimeString())}">`
      + `<span class="cp-svc">${esc(m.service)}</span>${badges}`
      + `<b class="cp-who"${color ? ` style="color:${esc(color)}"` : ''}>${esc((m.user && m.user.name) || login(m) || '?')}</b>`
      + `<span class="cp-text">${esc(m.text)}</span>`
      + `<span class="cp-acts">`
      + `<button type="button" class="cp-act" data-act="hide" title="Hide just this message">Hide</button>`
      + `<button type="button" class="cp-act" data-act="block" title="Stop showing this person here. Nothing is sent to the service.">Block</button>`
      + `</span></div>`;
  }

  function render() {
    if (!el) return;
    const log = $('[data-cp="log"]');
    const shown = msgs.filter(visible);
    log.innerHTML = shown.length ? shown.map(row).join('')
      : `<p class="cp-empty">${services.some((s) => s.state === 'joined')
        ? 'Connected. Nothing said yet.' : 'Not reading a channel yet.'}</p>`;
    if (!paused) toBottom();
    paintBlocked();
  }

  function append(m) {
    const log = $('[data-cp="log"]');
    const empty = log.querySelector('.cp-empty');
    if (empty) log.innerHTML = '';
    log.insertAdjacentHTML('beforeend', row(m));
    while (log.children.length > CAP) log.removeChild(log.firstElementChild);
    if (paused) { unseen += 1; paintNew(); } else toBottom();
  }

  function toBottom() {
    const log = $('[data-cp="log"]');
    log.scrollTop = log.scrollHeight;
    unseen = 0;
    paintNew();
  }

  function paintNew() {
    const b = $('[data-cp="new"]');
    b.hidden = !(paused && unseen > 0);
    b.textContent = unseen === 1 ? '1 new message' : `${unseen} new messages`;
  }

  function paintBlocked() {
    const box = $('[data-cp="blocked"]');
    box.hidden = blocked.length === 0;
    $('[data-cp="blockedList"]').innerHTML = blocked
      .map((n) => `<button type="button" class="cp-unblock" data-who="${esc(n)}" title="Show ${esc(n)} again">${esc(n)} &times;</button>`)
      .join('');
  }

  /* Twitch and TikTok side by side (T5). The pill names every service being
     read; each has its own row, and TikTok a line saying what its window can
     see - which is what tells you the missing step when nothing arrives. */
  const svc = (name) => services.find((s) => s.service === name) || null;
  function paintState() {
    const tw = svc('twitch'), tt = svc('tiktok');
    const on = services.filter((s) => s.state === 'joined');
    const busy = services.find((s) => s.state === 'connecting' || s.state === 'reconnecting');
    const failed = services.find((s) => s.state === 'failed');
    const pill = $('[data-cp="state"]');
    pill.dataset.state = on.length ? 'joined' : busy ? busy.state : failed ? 'failed' : 'idle';
    pill.textContent = on.length ? on.map((s) => (s.service === 'tiktok' ? '@' : '#') + s.channel).join(' · ')
      : busy ? (busy.state === 'connecting' ? 'Connecting…' : 'Reconnecting…')
      : failed ? 'Failed' : 'Not connected';
    const err = $('[data-cp="error"]');
    err.hidden = !(failed && failed.error);
    err.textContent = (failed && failed.error) || '';
    $('[data-cp="go"]').hidden = !!tw;
    $('[data-cp="stop"]').hidden = !tw;
    const input = $('[data-cp="channel"]');
    if (document.activeElement !== input && !input.value) input.value = (tw && tw.channel) || saved.twitch || '';
    const live = !!tt && tt.state !== 'failed';
    $('[data-cp="ttgo"]').hidden = live;
    $('[data-cp="ttstop"]').hidden = !live;
    const ti = $('[data-cp="ttname"]');
    if (document.activeElement !== ti && !ti.value) ti.value = (tt && tt.channel) || saved.tiktok || '';
    const pg = (tt && tt.page) || {};
    // Signing in is optional: TikTok's page receives a live's chat and gifts
    // signed out too - every real live the reader was checked on was read
    // signed out - and a window never signed in holds no TikTok login at all.
    // Reading means something is arriving: the room socket, or lines of chat.
    // A chat list alone is not enough - an offline live page draws one too.
    const reading = pg.live || pg.chat_from === 'socket';
    // Hidden unless asked (tiktok_chat.py): running, the reader says which kind
    // it is; not running, the choice kept is what Open TikTok will start.
    const shown = tt ? pg.shown === true : saved.show;
    const quietFor = Math.max(1, Math.round((pg.quiet || 0) / 60));
    $('[data-cp="tthint"]').textContent = !tt
      ? (shown ? 'Opens your TikTok live page in a window of its own and reads its chat and gifts - nothing leaves this PC. You do not have to sign in there.'
        : 'Reads your TikTok live page in the background - no window, muted - and takes its chat and gifts. Nothing leaves this PC, and you do not have to sign in.')
      : tt.state === 'failed' ? (tt.error || 'The TikTok reader stopped.')
      : tt.state !== 'joined' ? 'Opening TikTok…'
      // The window moved to someone else's live (tiktok_chat.py _own): nothing
      // from there reaches the stream, and the streamer should know why. A
      // hidden reader goes back by itself (_reopen_due).
      : pg.own === false && pg.path ? (shown
        ? `The TikTok window is on another page. Chat and gifts are read only from your own live page (@${tt.channel}) - open it there again.`
        : `TikTok moved on to another page. Nothing from there is read, and the reader goes back to your live page (@${tt.channel}) by itself.`)
      // Opened before going live: the page has no live on it, and the reader
      // looks again by itself (tiktok_chat.py _reopen_due).
      : pg.waiting ? 'Your live page is open, but TikTok has no live on it yet. When your LIVE starts, the reader finds it by itself - it looks again every few minutes, nothing to press.'
      // Nothing heard and no chat list: the page is still loading, or the
      // window is on some other page. Which one cannot be told, so say both.
      : !reading ? (shown ? 'Waiting for your live page. If the TikTok window shows something else, open your live page there - the chat is read as soon as TikTok shows it.'
        : 'Waiting for your live page to load.')
      // Heard nothing for a while (tiktok_chat's quiet). Chat limps on from the
      // page's own drawing, so the panel would otherwise say all is well while
      // gifts - which arrive on the room socket and nowhere else - stopped
      // dead. Seen on a real live: 157 seconds, and it came back by itself.
      : pg.quiet >= 60 ? `TikTok has sent nothing for ${quietFor} minute${quietFor === 1 ? '' : 's'}. Chat is coming from the page meanwhile, but gifts and coins cannot arrive until TikTok speaks again. If it stays quiet the reader opens your live page again.`
      : shown ? 'Reading your live chat and gifts. Leave the TikTok window open - it can sit behind everything, and it stays muted.' +
        (pg.signed_in === false ? ' Signed out is fine; sign in there only if your live does not show without it.' : '')
      : 'Reading your live chat and gifts, in the background.' +
        (pg.signed_in === false ? ' Signed out is fine; to sign in, tick Show the TikTok window.' : '');
  }

  /* --------------------------------------------------------------- wiring */

  function mount(host) {
    if (el) return;
    el = document.createElement('div');
    el.className = 'lp cp';
    el.id = 'chatPanel';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Chat');
    el.innerHTML = `
      <div class="lp-head">
        <h2>Chat</h2>
        <span class="lp-pill" data-cp="state">Not connected</span>
        <button type="button" class="lp-x" data-cp="close" aria-label="Close">&times;</button>
      </div>
      <p class="lp-error" data-cp="error" hidden></p>
      <div class="lp-row">
        <input class="lp-input" data-cp="channel" placeholder="Twitch channel" aria-label="Twitch channel" style="flex:1 1 120px">
        <button type="button" class="lp-btn primary" data-cp="go">Read it</button>
        <button type="button" class="lp-btn" data-cp="stop" hidden>Stop</button>
      </div>
      <div class="lp-row">
        <input class="lp-input" data-cp="ttname" placeholder="TikTok username" aria-label="TikTok username" spellcheck="false" style="flex:1 1 120px">
        <button type="button" class="lp-btn primary" data-cp="ttgo">Open TikTok</button>
        <button type="button" class="lp-btn" data-cp="ttstop" hidden>Stop</button>
      </div>
      <label class="lp-check"><input type="checkbox" data-cp="ttshow"><span>Show the TikTok window, to sign in there</span></label>
      <p class="lp-hint" data-cp="tthint" aria-live="polite"></p>
      <div class="cp-logwrap">
        <div class="cp-log" data-cp="log" role="log" aria-live="polite" aria-label="Chat messages"></div>
        <button type="button" class="cp-new" data-cp="new" hidden></button>
      </div>
      <div class="lp-group" data-cp="blocked" hidden>
        <legend>Blocked here</legend>
        <div class="lp-row" data-cp="blockedList"></div>
      </div>
      <p class="lp-hint">Read-only. Blocking someone hides them in this app - nothing is sent to the service.</p>`;
    // Docked (the Live view, S9): the same panel sitting in a page instead of
    // floating over one, so that view shows this panel rather than a copy of
    // it. Docked it is always open, which makes close() a no-op and takes the
    // dialog's manners with it - Escape, click-away and the x all go through
    // close(), so one guard there covers every way out.
    (host || document.body).appendChild(el);
    if (host) { docked = true; el.classList.add('docked'); el.setAttribute('role', 'region'); }
    wire();
  }

  /* One service at a time changes; the others are left as they were. */
  function connect(service, channel) {
    post('/api/chat/connect', { service, channel }).then((d) => {
      if (d && d.status) {
        services = services.filter((s) => s.service !== service).concat([d.status]);
        setMention(); paintState();
      } else if (d && d.error) { const e = $('[data-cp="error"]'); e.hidden = false; e.textContent = d.error; }
    });
  }
  function disconnect(service) {
    post('/api/chat/disconnect', { service }).then(() => {
      services = services.filter((s) => s.service !== service);
      setMention(); paintState();
    });
  }

  function wire() {
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } });
    $('[data-cp="close"]').addEventListener('click', () => close(true));

    $('[data-cp="go"]').addEventListener('click', () => {
      const channel = $('[data-cp="channel"]').value.trim();
      if (!channel) { $('[data-cp="channel"]').focus(); return; }
      connect('twitch', channel);
    });
    $('[data-cp="stop"]').addEventListener('click', () => disconnect('twitch'));
    $('[data-cp="ttgo"]').addEventListener('click', () => {
      const name = $('[data-cp="ttname"]').value.trim().replace(/^@/, '');
      if (!name) { $('[data-cp="ttname"]').focus(); return; }
      connect('tiktok', name);
    });
    $('[data-cp="ttstop"]').addEventListener('click', () => disconnect('tiktok'));
    // Hidden unless asked (tiktok_chat.py): ticked, the reader starts again as
    // a window, to sign in there; unticked, hidden again, still signed in.
    $('[data-cp="ttshow"]').addEventListener('change', (e) => {
      const show = e.target.checked;
      saved.show = show;
      post('/api/chat/tiktok/window', { show }).then((d) => {
        if (d && d.status) { services = services.filter((s) => s.service !== 'tiktok').concat([d.status]); setMention(); }
        paintState();
      });
    });

    const log = $('[data-cp="log"]');
    /* Pause on scroll: reading something further up must not be yanked away by
       the next message. Within a few pixels of the bottom counts as at it. */
    log.addEventListener('scroll', () => {
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
      if (atEnd && paused) { paused = false; toBottom(); }
      else if (!atEnd && !paused) { paused = true; paintNew(); }
    });
    $('[data-cp="new"]').addEventListener('click', () => { paused = false; toBottom(); log.focus(); });

    log.addEventListener('click', (e) => {
      const btn = e.target.closest('.cp-act');
      if (!btn) return;
      const box = btn.closest('.cp-msg');
      const id = box && box.dataset.id;
      const m = msgs.find((x) => x.id === id);
      if (!m) return;
      if (btn.dataset.act === 'hide') { hidden.add(id); box.remove(); return; }
      const who = login(m);
      if (who && !blocked.includes(who)) {
        blocked = blocked.concat([who]);
        post('/api/config', { chat: { blocked } });
        render();
      }
    });

    $('[data-cp="blockedList"]').addEventListener('click', (e) => {
      const btn = e.target.closest('.cp-unblock');
      if (!btn) return;
      blocked = blocked.filter((n) => n !== btn.dataset.who);
      post('/api/config', { chat: { blocked } });
      render();
    });
  }

  /* ----------------------------------------------------------- the feed */

  function add(m) {
    if (!m || !m.id) return;
    msgs.push(m);
    if (msgs.length > CAP) msgs = msgs.slice(-CAP);
    if (el && !el.hidden && visible(m)) append(m);
  }

  function connectFeed() {
    clearTimeout(retry);
    if (!el || el.hidden || ws) return;
    const page = location.pathname.split('/').pop() || 'deck.html';
    try {
      ws = new WebSocket(`ws://${location.host}/ws/chat?page=${encodeURIComponent(page)}`);
    } catch (_) { ws = null; retry = setTimeout(connectFeed, 2000); return; }
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } add(m); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
    ws.onclose = () => { ws = null; if (el && !el.hidden) retry = setTimeout(connectFeed, 2000); };
  }

  function dropFeed() {
    clearTimeout(retry);
    retry = null;
    if (ws) { const s = ws; ws = null; s.onclose = null; try { s.close(); } catch (_) {} }
  }

  /* ------------------------------------------------------ open and close */

  function place() {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(440, innerWidth - 16);
    el.style.width = w + 'px';
    el.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    el.style.top = Math.min(r.bottom + 8, innerHeight - 160) + 'px';
    el.style.maxHeight = (innerHeight - Math.min(r.bottom + 8, innerHeight - 160) - 8) + 'px';
  }

  async function open(from) {
    mount();
    anchor = from || null;
    el.hidden = false;
    place();
    const cfg = await getJSON('/api/config');
    blocked = (((cfg || {}).chat || {}).blocked || []).filter((n) => typeof n === 'string');
    const kept = (cfg || {}).chat || {};
    saved = { twitch: String((kept.twitch || {}).channel || ''), tiktok: String((kept.tiktok || {}).channel || ''),
      show: (kept.tiktok || {}).show === true };
    $('[data-cp="ttshow"]').checked = saved.show;
    const st = await getJSON('/api/chat/status');
    if (st) { services = st.services || []; setMention(); }
    paintState();
    const back = await getJSON('/api/chat/recent?n=' + CAP);
    msgs = (back && back.messages) || [];
    paused = false;
    render();
    connectFeed();
    if (!docked) $('[data-cp="channel"]').focus();     // docked, it would steal the page's focus on load
  }

  function close(refocus) {
    if (docked || !el || el.hidden) return;
    el.hidden = true;
    dropFeed();
    if (refocus && anchor && anchor.isConnected) anchor.focus();
  }

  window.addEventListener('resize', () => { if (el && !el.hidden) place(); });
  document.addEventListener('pointerdown', (e) => {
    if (el && !el.hidden && !el.contains(e.target) && !(anchor && anchor.contains(e.target))) close(false);
  }, true);
  /* A tab that was hidden long enough for the socket to die comes back live. */
  document.addEventListener('visibilitychange', () => { if (!document.hidden && el && !el.hidden && !ws) connectFeed(); });
  window.addEventListener('pagehide', dropFeed);

  return {
    mount,
    open,
    close,
    toggle: (from) => (el && !el.hidden ? close(true) : open(from)),
    isOpen: () => !!el && !el.hidden,
    /* The page's state feed: which services are connected, and to what. */
    onState(st) {
      const next = ((st || {}).chat || {}).services || [];
      const same = JSON.stringify(next) === JSON.stringify(services);
      services = next;
      if (!same) { setMention(); if (el && !el.hidden) { paintState(); } }
    },
    /* For tests. */
    debug: () => ({
      open: !!el && !el.hidden,
      held: msgs.length,
      rendered: el ? el.querySelectorAll('.cp-msg').length : 0,
      commands: el ? el.querySelectorAll('.cp-msg.cmd').length : 0,
      mentions: el ? el.querySelectorAll('.cp-msg.mention').length : 0,
      paused,
      unseen,
      blocked: blocked.slice(),
      hidden: hidden.size,
      feed: !!ws && ws.readyState === 1,
      services: services.map((s) => [s.service, s.channel, s.state]),
    }),
  };
})();
