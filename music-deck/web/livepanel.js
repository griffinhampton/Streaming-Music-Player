/* The LIVE panel (P11), shared by the deck and the Canvas Builder.

   Everything going LIVE needs, in one place: the Server URL and stream key
   (masked - the key is stored encrypted and never shown again, only
   replaced or forgotten), the quality preset with what it asks of your
   upload, the scene that goes out, the microphone and desktop sound with
   their gains, mutes and meters, Start and Stop, and the stream's health.
   A key TikTok stops accepting mid-stream (LIVE Center issued a new one)
   says so and points at the key field.

   A page mounts it once (LivePanel.mount), opens it from a button
   (LivePanel.toggle(button)), and passes its state feed on
   (LivePanel.onState(snapshot)). While open it polls /api/live/status -
   once a second, twice while LIVE for the meters - and not at all when
   closed or hidden. Stop asks twice, so one stray click cannot end a show. */
const LivePanel = (() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({ ok: false, error: 'the app did not answer' }));
  const ON_AIR = ['connecting', 'live', 'reconnecting'];
  const STATE_TEXT = { idle: 'Off air', connecting: 'Connecting…', live: 'LIVE', reconnecting: 'Reconnecting…', failed: 'Stopped by an error', stopped: 'Off air' };

  let el = null, anchor = null, timer = null, stopArmed = 0, endArmed = 0;
  let status = { state: 'idle' }, snap = null, presets = {}, devices = null, cfg = {};
  // The TikTok tab: what the app holds (token, a live session) and what
  // Streamlabs last said about the account behind it.
  const TABS = ['Key', 'TikTok'];
  let tab = 'Key', tt = {}, acct = {}, shown = null;

  const $ = (sel) => el.querySelector(sel);
  const onAir = () => ON_AIR.includes(status.state);

  function mount() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'lp';
    el.id = 'livePanel';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-labelledby', 'lpTitle');
    el.innerHTML = `
      <div class="lp-head">
        <h2 id="lpTitle">Go LIVE</h2>
        <span class="lp-pill" data-lp="pill" aria-live="polite">Off air</span>
        <button type="button" class="lp-x" data-lp="close" aria-label="Close the LIVE panel">×</button>
      </div>
      <div class="lp-error" data-lp="error" role="alert" hidden></div>
      <dl class="lp-health" data-lp="health" hidden>
        <div><dt>On air</dt><dd data-lp="uptime">0:00</dd></div>
        <div><dt>Bitrate</dt><dd data-lp="kbps">-</dd></div>
        <div><dt>Frame rate</dt><dd data-lp="fps">-</dd></div>
        <div><dt>Dropped</dt><dd data-lp="dropped">0</dd></div>
        <div><dt>Reconnects</dt><dd data-lp="reconnects">0</dd></div>
        <div><dt>Delay</dt><dd data-lp="delay">-</dd></div>
      </dl>
      <label class="lp-field"><span>Scene on air</span><select class="lp-input" data-lp="scene"></select></label>
      <label class="lp-field"><span>Quality</span><select class="lp-input" data-lp="preset"></select></label>
      <p class="lp-hint" data-lp="presetHint"></p>
      <div class="lp-tabs" role="tablist" aria-label="How to go LIVE">
        <button type="button" role="tab" id="lpTabKey" aria-controls="lpPaneKey" aria-selected="true">Stream key</button>
        <button type="button" role="tab" id="lpTabTikTok" aria-controls="lpPaneTikTok" aria-selected="false" tabindex="-1">TikTok</button>
      </div>
      <section class="lp-pane" id="lpPaneKey" role="tabpanel" aria-labelledby="lpTabKey">
        <fieldset class="lp-group">
          <legend>Stream key</legend>
          <label class="lp-field"><span>Server URL</span>
            <input class="lp-input" type="text" data-lp="url" autocomplete="off" spellcheck="false" placeholder="rtmp://…"></label>
          <label class="lp-field"><span>Stream key</span>
            <input class="lp-input" type="password" data-lp="key" autocomplete="off" spellcheck="false"></label>
          <div class="lp-row">
            <button type="button" class="lp-btn" data-lp="paste">Paste the key</button>
            <button type="button" class="lp-btn" data-lp="save">Save</button>
            <button type="button" class="lp-btn ghost" data-lp="forget">Forget the key</button>
          </div>
          <p class="lp-hint" data-lp="keyHint">Both are in TikTok LIVE Center, under your stream key. The key is kept encrypted on this PC and never shown again.</p>
        </fieldset>
      </section>
      <section class="lp-pane" id="lpPaneTikTok" role="tabpanel" aria-labelledby="lpTabTikTok" hidden>
        <fieldset class="lp-group">
          <legend>Streamlabs</legend>
          <label class="lp-field"><span>Token</span>
            <div class="lp-row">
              <input class="lp-input" type="password" data-lp="ttToken" autocomplete="off" spellcheck="false" placeholder="Paste one, or load it below">
              <button type="button" class="lp-btn ghost" data-lp="ttEye" aria-pressed="false">Show</button>
            </div></label>
          <div class="lp-row">
            <button type="button" class="lp-btn" data-lp="ttLocal">Load from this PC</button>
            <button type="button" class="lp-btn" data-lp="ttWeb">Sign in</button>
            <button type="button" class="lp-btn ghost" data-lp="ttForget">Forget it</button>
          </div>
          <p class="lp-hint" data-lp="ttHint">Load from this PC reads the token Streamlabs already keeps here; Sign in opens Streamlabs in your browser. Either way it is kept encrypted on this PC and never shown again.</p>
        </fieldset>
        <dl class="lp-health" data-lp="ttAcct" hidden>
          <div><dt>Account</dt><dd data-lp="ttUser">-</dd></div>
          <div><dt>Application</dt><dd data-lp="ttStatus">-</dd></div>
          <div><dt>Can go live</dt><dd data-lp="ttCan">-</dd></div>
        </dl>
        <fieldset class="lp-group">
          <legend>This stream</legend>
          <label class="lp-field"><span>Title</span>
            <input class="lp-input" type="text" data-lp="ttTitle" maxlength="120" placeholder="What you are streaming"></label>
          <label class="lp-field"><span>Category</span>
            <input class="lp-input" type="text" data-lp="ttCat" list="lpTtCats" autocomplete="off" spellcheck="false" placeholder="Start typing a game">
            <datalist id="lpTtCats"></datalist></label>
          <label class="lp-check"><input type="checkbox" data-lp="ttMature"><span>Mature content</span></label>
        </fieldset>
        <div class="lp-row">
          <button type="button" class="lp-btn primary" data-lp="ttGo">Go LIVE</button>
          <button type="button" class="lp-btn danger" data-lp="ttEnd">End Live</button>
        </div>
        <p class="lp-hint" data-lp="ttHint2"></p>
        <fieldset class="lp-group" data-lp="ttOut" hidden>
          <legend>This live</legend>
          <label class="lp-field"><span>Server URL</span>
            <div class="lp-row">
              <input class="lp-input" type="text" data-lp="ttUrl" readonly spellcheck="false">
              <button type="button" class="lp-btn ghost" data-lp="ttCopyUrl">Copy</button>
            </div></label>
          <label class="lp-field"><span>Stream key</span>
            <div class="lp-row">
              <input class="lp-input" type="password" data-lp="ttKey" readonly spellcheck="false" value="****************">
              <button type="button" class="lp-btn ghost" data-lp="ttShowKey" aria-pressed="false">Show</button>
              <button type="button" class="lp-btn ghost" data-lp="ttCopyKey">Copy</button>
            </div></label>
          <p class="lp-hint">The deck is already streaming to these. They are here for a second app - OBS, or LIVE Studio - and TikTok stops accepting them when the live ends.</p>
        </fieldset>
      </section>
      <fieldset class="lp-group">
        <legend>Sound</legend>
        ${['mic', 'system'].map((s) => `
        <div class="lp-src" data-src="${s}">
          <label class="lp-check"><input type="checkbox" data-lp="${s}On"><span>${s === 'mic' ? 'Microphone' : 'Desktop sound'}</span></label>
          ${s === 'mic' ? '<select class="lp-input" data-lp="micDevice" aria-label="Which microphone"></select>' : ''}
          <div class="lp-meter" data-lp="${s}Meter" role="meter" aria-label="${s === 'mic' ? 'Microphone' : 'Desktop sound'} level" aria-valuemin="0" aria-valuemax="100"><i></i></div>
          <div class="lp-row">
            <input class="lp-range" type="range" min="0" max="400" step="5" data-lp="${s}Gain" aria-label="${s === 'mic' ? 'Microphone' : 'Desktop sound'} volume">
            <b class="lp-num" data-lp="${s}GainOut">100%</b>
            <button type="button" class="lp-btn ghost" data-lp="${s}Mute" aria-pressed="false">Mute</button>
          </div>
        </div>`).join('')}
        <p class="lp-hint" data-lp="soundHint">The meters move while you are LIVE. Which sources and which microphone count from the next start; volume and mute right away.</p>
      </fieldset>
      <div class="lp-foot">
        <button type="button" class="lp-btn primary" data-lp="go">Start</button>
        <span class="lp-hint" data-lp="goHint"></span>
      </div>`;
    document.body.appendChild(el);
    wire();
  }

  function wire() {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    });
    $('[data-lp="close"]').addEventListener('click', () => close(true));
    $('[data-lp="scene"]').addEventListener('change', async (e) => {
      const d = await post('/api/live/scene', { id: e.target.value });
      if (!d.ok) note(d.reason || 'That scene cannot go out now');
    });
    $('[data-lp="preset"]').addEventListener('change', async (e) => {
      cfg.preset = e.target.value;
      paintPresetHint();
      await post('/api/config', { live: { preset: e.target.value } });
    });
    $('[data-lp="paste"]').addEventListener('click', async () => {
      const key = $('[data-lp="key"]');
      try {
        const t = (await navigator.clipboard.readText()).trim();
        if (t) { key.value = t; note('Pasted - press Save to keep it'); } else note('The clipboard is empty');
      } catch (_) { note('Paste it into the field with Ctrl+V'); }
      key.focus();
    });
    $('[data-lp="save"]').addEventListener('click', saveKey);
    $('[data-lp="key"]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveKey(); } });
    $('[data-lp="forget"]').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Click again to forget it'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Forget the key'; }, 4000); return; }
      b.dataset.armed = '';
      b.textContent = 'Forget the key';
      await post('/api/live/key/forget');
      status.has_key = false;
      note('The key is gone from this PC');
      paint();
    });
    for (const s of ['mic', 'system']) {
      $(`[data-lp="${s}On"]`).addEventListener('change', (e) => post('/api/live/audio', { [s]: e.target.checked }).then((d) => { if (d.audio) cfg.audio = d.audio; }));
      $(`[data-lp="${s}Gain"]`).addEventListener('input', (e) => {
        $(`[data-lp="${s}GainOut"]`).textContent = e.target.value + '%';
        clearTimeout(e.target._t);
        e.target._t = setTimeout(() => post('/api/live/audio', { source: s, gain: Number(e.target.value) / 100 }).then((d) => { if (d.audio) cfg.audio = d.audio; }), 80);
      });
      $(`[data-lp="${s}Mute"]`).addEventListener('click', (e) => {
        const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
        e.currentTarget.setAttribute('aria-pressed', String(on));
        e.currentTarget.textContent = on ? 'Muted' : 'Mute';
        post('/api/live/audio', { source: s, mute: on }).then((d) => { if (d.audio) cfg.audio = d.audio; });
      });
    }
    $('[data-lp="micDevice"]').addEventListener('change', (e) => post('/api/live/audio', { mic_device: e.target.value }).then((d) => { if (d.audio) cfg.audio = d.audio; }));
    $('[data-lp="go"]').addEventListener('click', go);
    wireTabs();
    wireTikTok();
  }

  /* The two ways to go LIVE, one at a time: a key you pasted, or TikTok
     opening the live for you. Same keyboard shape as the editor's panels. */
  function wireTabs() {
    const tabs = $('.lp-tabs');
    tabs.addEventListener('click', (e) => {
      const t = e.target.closest('[role="tab"]');
      if (t) showTab(t.id.slice(5));
    });
    tabs.addEventListener('keydown', (e) => {
      const i = TABS.indexOf((document.activeElement.id || '').slice(5));
      if (i < 0 || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
      e.preventDefault();
      showTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length], true);
    });
  }

  function showTab(name, focus) {
    if (!TABS.includes(name)) return;
    tab = name;
    for (const t of TABS) {
      const btn = $('#lpTab' + t), on = t === name;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      $('#lpPane' + t).hidden = !on;
      if (on && focus) btn.focus();
    }
    if (name === 'TikTok') refreshTikTok();
    paint();
  }

  function wireTikTok() {
    const token = $('[data-lp="ttToken"]');
    $('[data-lp="ttEye"]').addEventListener('click', (e) => {
      const show = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(show));
      e.currentTarget.textContent = show ? 'Hide' : 'Show';
      token.type = show ? 'text' : 'password';
    });
    token.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useToken(); } });
    token.addEventListener('blur', () => { if (token.value.trim()) useToken(); });
    $('[data-lp="ttLocal"]').addEventListener('click', () => getToken('local', 'ttLocal', 'Searching…'));
    $('[data-lp="ttWeb"]').addEventListener('click', () => getToken('web', 'ttWeb', 'Waiting for the browser…'));
    $('[data-lp="ttForget"]').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Click again to forget it'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Forget it'; }, 4000); return; }
      b.dataset.armed = '';
      b.textContent = 'Forget it';
      await post('/api/tiktok/token/forget');
      tt = {}; acct = {};
      ttNote('The Streamlabs token is gone from this PC');
      await refreshTikTok();
    });
    // Categories come from Streamlabs as you type; a datalist keeps the
    // keyboard behaviour the browser already gives a text field.
    $('[data-lp="ttCat"]').addEventListener('input', (e) => {
      clearTimeout(e.target._t);
      const q = e.target.value.trim();
      if (!q || !tt.has_token) return;
      e.target._t = setTimeout(async () => {
        try {
          const d = await (await fetch('/api/tiktok/search?q=' + encodeURIComponent(q))).json();
          $('#lpTtCats').innerHTML = (d.categories || []).map((c) => `<option value="${esc(c.full_name)}"></option>`).join('');
        } catch (_) { /* type on; the field still takes anything */ }
      }, 250);
    });
    $('[data-lp="ttGo"]').addEventListener('click', ttGo);
    $('[data-lp="ttEnd"]').addEventListener('click', ttEnd);
    $('[data-lp="ttCopyUrl"]').addEventListener('click', () => copyOut('url'));
    $('[data-lp="ttCopyKey"]').addEventListener('click', () => copyOut('key'));
    $('[data-lp="ttShowKey"]').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      if (b.getAttribute('aria-pressed') === 'true') { shown = null; maskKey(); return; }
      const d = await post('/api/tiktok/reveal');
      if (!d.ok) { ttNote(d.error || 'There is no key to show yet'); return; }
      shown = d;
      const box = $('[data-lp="ttKey"]');
      box.type = 'text';
      box.value = d.key;
      b.setAttribute('aria-pressed', 'true');
      b.textContent = 'Hide';
    });
  }

  /* The key goes back behind the dots: when Hide is pressed, and by itself
     when the live ends and there is nothing left to show. */
  function maskKey() {
    const box = $('[data-lp="ttKey"]'), b = $('[data-lp="ttShowKey"]');
    box.type = 'password';
    box.value = '****************';
    b.setAttribute('aria-pressed', 'false');
    b.textContent = 'Show';
  }

  /* Copy without showing: the key is fetched for the clipboard alone if it was
     never revealed on screen. */
  async function copyOut(which) {
    const d = shown && shown.key ? shown : await post('/api/tiktok/reveal');
    if (!d.ok) { ttNote(d.error || 'There is nothing to copy yet'); return; }
    try {
      await navigator.clipboard.writeText(which === 'key' ? d.key : d.url);
      ttNote(which === 'key' ? 'Stream key copied' : 'Server URL copied');
    } catch (_) { ttNote('This page could not reach the clipboard'); }
  }

  async function useToken() {
    const box = $('[data-lp="ttToken"]');
    const token = box.value.trim();
    if (!token) return;
    const d = await post('/api/tiktok/token', { token });
    box.value = '';                                        // never kept on the page
    ttNote(d.ok ? 'Saved - the token is kept encrypted on this PC' : (d.error || 'Could not keep that token'));
    await refreshTikTok();
  }

  async function getToken(source, which, busy) {
    const b = $(`[data-lp="${which}"]`), was = b.textContent;
    b.disabled = true;
    b.textContent = busy;
    const d = await post('/api/tiktok/token', { source });
    if (!d.ok) { ttNote(d.error || 'That did not work'); b.disabled = false; b.textContent = was; await refreshTikTok(); return; }
    if (d.signing_in) {
      // The browser has up to five minutes; the poll picks the token up.
      ttNote('Finish signing in to Streamlabs in your browser');
      await refreshTikTok();
      return;
    }
    b.disabled = false;
    b.textContent = was;
    ttNote('Signed in - the token is kept encrypted on this PC');
    await refreshTikTok();
  }

  async function ttGo() {
    const b = $('[data-lp="ttGo"]');
    b.disabled = true;
    ttNote('Opening the live at TikTok…');
    const d = await post('/api/tiktok/start', {
      title: $('[data-lp="ttTitle"]').value.trim(),
      category: $('[data-lp="ttCat"]').value.trim(),
      mature: $('[data-lp="ttMature"]').checked,
      preset: $('[data-lp="preset"]').value,
    });
    if (!d.ok) ttNote(d.error || d.reason || 'Could not go live');
    await refreshTikTok();
    await refresh();
  }

  async function ttEnd() {
    const b = $('[data-lp="ttEnd"]');
    if (Date.now() - endArmed > 4000) {
      endArmed = Date.now();
      b.textContent = 'Click again to end it';
      setTimeout(() => { if (Date.now() - endArmed >= 4000) paint(); }, 4100);
      return;
    }
    endArmed = 0;
    b.disabled = true;
    await post('/api/tiktok/end');
    await refreshTikTok();
    await refresh();
  }

  function ttNote(text) {
    const h = $('[data-lp="ttHint2"]');
    h.textContent = text;
    clearTimeout(h._t);
    h._t = setTimeout(() => { h.textContent = ''; paint(); }, 6000);
  }

  async function saveKey() {
    const url = $('[data-lp="url"]').value.trim(), key = $('[data-lp="key"]').value.trim();
    if (!url && !key) { note('Paste the Server URL and the stream key first'); return; }
    const d = await post('/api/live/key', { url, key });
    $('[data-lp="key"]').value = '';                       // never kept on the page
    if (d.ok) { status.has_key = d.has_key; status.saved_url = d.url; note(key ? 'Saved - the key is kept encrypted on this PC' : 'Server URL saved'); }
    else note(d.error || 'Could not save that');
    paint();
  }

  async function go() {
    const b = $('[data-lp="go"]');
    if (onAir()) {
      if (Date.now() - stopArmed > 4000) {
        stopArmed = Date.now();
        b.textContent = 'Click again to stop';
        setTimeout(() => { if (Date.now() - stopArmed >= 4000) paint(); }, 4100);
        return;
      }
      stopArmed = 0;
      b.disabled = true;
      await post('/api/live/stop');
    } else {
      b.disabled = true;
      $('[data-lp="goHint"]').textContent = 'Starting…';
      const d = await post('/api/live/start', { preset: $('[data-lp="preset"]').value });
      if (!d.ok) note(d.error || d.reason || 'Could not start');
    }
    await refresh();
  }

  function note(text) {
    const h = $('[data-lp="goHint"]');
    h.textContent = text;
    clearTimeout(h._t);
    h._t = setTimeout(() => { h.textContent = ''; paint(); }, 6000);
  }

  const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
  function paintPresetHint() {
    const p = presets[$('[data-lp="preset"]').value];
    $('[data-lp="presetHint"]').textContent = p
      ? `${p.width} × ${p.height} at ${p.fps} fps, ${(p.kbps / 1000).toFixed(1)} Mb/s of video - your upload needs about ${(((p.kbps + 128) * 1.3) / 1000).toFixed(1)} Mb/s to spare.` +
        ' A phone scene streams at its own size at this rate.' + (onAir() ? ' Counts from the next start.' : '')
      : '';
  }

  /* Everything shown, from the status (and the feed's snapshot). */
  function paint() {
    if (!el || el.hidden) return;
    const st = status, s = st.stats || {}, n = st.native || {};
    const pill = $('[data-lp="pill"]');
    pill.dataset.state = st.state || 'idle';
    pill.textContent = (STATE_TEXT[st.state] || st.state || 'Off air') + (st.state === 'live' ? ' ' + mmss(s.uptime) : '');
    // Health, whenever a stream is (or was just) running.
    $('[data-lp="health"]').hidden = !onAir();
    $('[data-lp="uptime"]').textContent = mmss(s.uptime);
    // Measured over a few seconds: until then it says so, rather than a dash that looks broken.
    const wait = onAir() ? 'measuring…' : '-';
    $('[data-lp="kbps"]').textContent = s.kbps ? `${(s.kbps / 1000).toFixed(2)} Mb/s` : wait;
    $('[data-lp="fps"]').textContent = n.fps || s.vfps ? `${n.fps || s.vfps} fps` : wait;
    $('[data-lp="dropped"]').textContent = String((s.dropped || 0) + (n.dropped || 0));
    $('[data-lp="reconnects"]').textContent = String(s.reconnects || 0);
    $('[data-lp="delay"]').textContent = s.rtt_ms ? `${s.rtt_ms} ms` : s.delay_ms ? `${s.delay_ms} ms` : '-';
    // The error - and the one that means "TikTok gave you a new key".
    const err = $('[data-lp="error"]');
    const rotated = /refused the stream key/i.test(st.error || '');
    err.hidden = !st.error;
    err.innerHTML = rotated
      ? '<b>TikTok stopped accepting your stream key.</b> LIVE Center has probably issued a new one: copy it there, paste it below, Save, and Start again.'
      : esc(st.error || '');
    err.classList.toggle('rotated', rotated);
    // The key: never shown, only whether one is kept.
    const keyIn = $('[data-lp="key"]');
    keyIn.placeholder = st.has_key ? 'Saved - paste a new one to replace it' : 'Paste your stream key';
    const url = $('[data-lp="url"]');
    if (document.activeElement !== url) url.value = st.saved_url || st.url || url.value || '';
    $('[data-lp="forget"]').disabled = !st.has_key;
    // Scenes.
    const sel = $('[data-lp="scene"]');
    const scenes = (snap && snap.scenes) || [];
    const cur = ((snap && snap.canvas) || {}).live || '';
    const sig = JSON.stringify([scenes.map((x) => [x.id, x.name]), cur]);
    if (sel.dataset.sig !== sig && document.activeElement !== sel) {
      sel.dataset.sig = sig;
      sel.innerHTML = '<option value="">No scene yet</option>' + scenes.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} (${x.width} × ${x.height})</option>`).join('');
      sel.value = cur;
    }
    // Quality.
    const ps = $('[data-lp="preset"]');
    if (!ps.options.length && Object.keys(presets).length) {
      ps.innerHTML = Object.entries(presets).map(([k, p]) => `<option value="${esc(k)}">${esc(k)} - ${(p.kbps / 1000).toFixed(1)} Mb/s</option>`).join('');
    }
    if (document.activeElement !== ps && cfg.preset) ps.value = cfg.preset;
    paintPresetHint();
    // Sound.
    const a = cfg.audio || {}, live = st.audio || {};
    for (const src of ['mic', 'system']) {
      const on = $(`[data-lp="${src}On"]`);
      on.checked = src === 'mic' ? a.mic !== false : !!a.system;
      const g = $(`[data-lp="${src}Gain"]`);
      if (document.activeElement !== g) { g.value = String(Math.round(((a.gain || {})[src] ?? 1) * 100)); $(`[data-lp="${src}GainOut"]`).textContent = g.value + '%'; }
      const muted = !!(a.mute || {})[src];
      const mb = $(`[data-lp="${src}Mute"]`);
      mb.setAttribute('aria-pressed', String(muted));
      mb.textContent = muted ? 'Muted' : 'Mute';
      const level = live.running ? Math.round(((live.level || {})[src] || 0) * 100) : 0;
      const meter = $(`[data-lp="${src}Meter"]`);
      meter.firstElementChild.style.width = level + '%';
      meter.setAttribute('aria-valuenow', String(level));
      meter.classList.toggle('muted', muted);
    }
    const md = $('[data-lp="micDevice"]');
    if (devices && !md.options.length) {
      md.innerHTML = '<option value="">Windows default microphone</option>' + (devices.capture || []).map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    }
    if (document.activeElement !== md) md.value = a.mic_device || '';
    // Start / Stop - the pasted-key way, so it stands down on the TikTok tab,
    // which has its own pair and would otherwise be a second Start on screen.
    const foot = $('.lp-foot');
    foot.hidden = tab === 'TikTok';
    const b = $('[data-lp="go"]');
    const armed = Date.now() - stopArmed < 4000;
    b.textContent = onAir() ? (armed ? 'Click again to stop' : 'Stop') : 'Start';
    b.classList.toggle('primary', !onAir());
    b.classList.toggle('danger', onAir());
    const saved = st.saved_url || st.url;
    b.disabled = !onAir() && (!st.has_key || !saved || !cur);
    const h = $('[data-lp="goHint"]');
    if (!h._t) h.textContent = onAir() ? '' : !st.has_key || !saved ? 'Save the Server URL and the stream key first' : !cur ? 'Pick the scene to go out first' : '';
    paintTikTok(cur);
  }

  /* The TikTok tab. Which controls are live follows the same rule the rest of
     the panel uses: nothing is offered before the thing it needs exists. */
  function paintTikTok(scene) {
    if (tab !== 'TikTok') return;
    const has = !!tt.has_token, can = !!acct.can_be_live;
    $('[data-lp="ttForget"]').disabled = !has;
    $('[data-lp="ttToken"]').placeholder = has ? 'Kept - paste another to replace it' : 'Paste one, or load it below';
    $('[data-lp="ttWeb"]').disabled = !!tt.signing_in;
    // The account, once Streamlabs has told us about it.
    const box = $('[data-lp="ttAcct"]');
    box.hidden = !has || !acct.ok;
    if (!box.hidden) {
      $('[data-lp="ttUser"]').textContent = acct.username || 'Unknown';
      $('[data-lp="ttStatus"]').textContent = acct.status || 'Unknown';
      $('[data-lp="ttCan"]').textContent = can ? 'Yes' : 'No';
    }
    for (const f of ['ttTitle', 'ttCat', 'ttMature']) $(`[data-lp="${f}"]`).disabled = !can;
    // Go LIVE needs an account that may, and a scene to send. End Live needs
    // something to end - a session we opened, or a stream already running.
    const live = onAir() || !!tt.live_id;
    const go = $('[data-lp="ttGo"]'), end = $('[data-lp="ttEnd"]');
    go.disabled = live || !can || !scene;
    end.disabled = !live;
    end.textContent = Date.now() - endArmed < 4000 ? 'Click again to end it' : 'End Live';
    // What the live is going out on, the way the standalone generator showed
    // it: the address plain, the key behind Show, both copyable. It appears
    // when Streamlabs hands the pair over and goes when the live ends.
    const out = $('[data-lp="ttOut"]');
    out.hidden = !tt.has_session_key;
    if (out.hidden) { shown = null; maskKey(); }
    else $('[data-lp="ttUrl"]').value = tt.url || '';
    const h = $('[data-lp="ttHint2"]');
    if (!h._t) {
      h.textContent = tt.signing_in ? 'Finish signing in to Streamlabs in your browser'
        : !has ? 'Load the token from this PC, or sign in to Streamlabs'
        : !acct.ok ? (acct.error || tt.error || 'Streamlabs has not answered yet')
        // Why not, in TikTok's own words: never_applied is the common one and
        // the only one you can do anything about, so it says what to do.
        : !can ? (acct.status === 'never_applied'
          ? 'TikTok has not granted this account LIVE access yet - apply for it first, then come back'
          : `Streamlabs says this account cannot go live yet (${acct.status || 'no reason given'})`)
        : !scene ? 'Pick the scene to go out first'
        : live ? '' : 'Go LIVE opens the live at TikTok and starts streaming to it';
    }
  }

  async function refresh() {
    try {
      const d = await (await fetch('/api/live/status', { cache: 'no-store' })).json();
      status = d;
      cfg = Object.assign({}, d.config || {});
    } catch (_) { /* next time */ }
    paint();
  }

  /* What the app holds, and then - only if it holds a token - what Streamlabs
     says about the account. Asked for on the TikTok tab alone: it is a call
     out to the internet, not a local read like the rest of the panel. */
  async function refreshTikTok() {
    try {
      tt = await (await fetch('/api/tiktok/status', { cache: 'no-store' })).json();
    } catch (_) { return; }
    if (!tt.has_token) { acct = {}; paint(); return; }
    try {
      acct = await (await fetch('/api/tiktok/info', { cache: 'no-store' })).json();
    } catch (_) { acct = { ok: false, error: 'Streamlabs did not answer' }; }
    paint();
  }

  function poll() {
    clearTimeout(timer);
    if (!el || el.hidden) return;
    const next = () => { timer = setTimeout(poll, onAir() ? 500 : 1500); };
    if (document.hidden) { next(); return; }
    // While a sign-in is out at the browser, watch for the token landing.
    const also = tab === 'TikTok' && tt.signing_in ? refreshTikTok() : Promise.resolve();
    Promise.all([refresh(), also]).finally(next);
  }

  async function open(from) {
    mount();
    anchor = from || null;
    el.hidden = false;
    place();
    if (!Object.keys(presets).length) {
      try { presets = (await (await fetch('/api/live/presets')).json()).presets || {}; } catch (_) { presets = {}; }
    }
    if (!devices) { try { devices = await (await fetch('/api/live/devices')).json(); } catch (_) { devices = { capture: [] }; } }
    await refresh();
    poll();
    const first = el.querySelector(status.has_key ? '[data-lp="go"]:not(:disabled), [data-lp="scene"]' : '[data-lp="url"]');
    (first || $('[data-lp="close"]')).focus();
    if (/refused the stream key/i.test(status.error || '')) $('[data-lp="key"]').focus();
  }
  function close(refocus) {
    if (!el || el.hidden) return;
    el.hidden = true;
    clearTimeout(timer);
    if (refocus && anchor && anchor.isConnected) anchor.focus();
  }
  function place() {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(420, innerWidth - 16);
    el.style.width = w + 'px';
    el.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    el.style.top = Math.min(r.bottom + 8, innerHeight - 120) + 'px';
    el.style.maxHeight = (innerHeight - Math.min(r.bottom + 8, innerHeight - 120) - 8) + 'px';
  }
  window.addEventListener('resize', () => { if (el && !el.hidden) place(); });
  document.addEventListener('pointerdown', (e) => {
    if (el && !el.hidden && !el.contains(e.target) && !(anchor && anchor.contains(e.target))) close(false);
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  return {
    mount,
    open, close,
    toggle: (from) => (el && !el.hidden ? close(true) : open(from)),
    isOpen: () => !!el && !el.hidden,
    /* The page's state feed: the scenes, the live scene, and the stream's state as it changes. */
    onState(st) {
      snap = st;
      if (st.live) status = Object.assign({}, status, st.live);
      paint();
    },
    status: () => ({ ...status }),
  };
})();
