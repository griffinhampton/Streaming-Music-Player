/* Song requests (S13), opened from the Live view.

   Moderation is a job for whoever is running the show, so it lives here rather
   than on the canvas. The button that opens this carries a count, because a
   pending list you have to remember to look at is a pending list that fills up
   - the count comes free off the state feed, which already carries how many are
   waiting (never the list itself, which changes far too often for a whole-state
   broadcast).

   Approve is a one-way door. Spotify's Web API can append to a queue but has no
   endpoint to reorder or remove, so once a request is let through this app
   cannot take it back. That is why the button says so, why it is not the
   primary-colored one, and why moderation is on by default. */
const ReqPanel = (() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({ ok: false }));
  const getJSON = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);

  let el = null, anchor = null, timer = null;
  let pending = [], history = [], rules = {};

  const $ = (sel) => el.querySelector(sel);
  const mmss = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.round((s || 0) % 60)).padStart(2, '0')}`;

  function paintPending() {
    $('[data-req="count"]').textContent = pending.length === 1 ? '1 waiting' : `${pending.length} waiting`;
    $('[data-req="pending"]').innerHTML = pending.length ? pending.map((r) => {
      const t = r.track || {};
      return `
        <div class="req-row" data-id="${esc(r.id)}">
          <div class="req-what">
            <b>${esc(t.title || r.text)}</b>
            <span class="req-by">${esc(t.artist || '')}${t.duration ? ' &middot; ' + mmss(t.duration) : ''}</span>
            <span class="req-who">asked by ${esc(r.user)}</span>
          </div>
          <button type="button" class="lp-btn" data-req="approve" title="Put it in the Spotify queue. This cannot be undone - Spotify has no way to take a track back out.">Let it through</button>
          <button type="button" class="lp-btn ghost" data-req="skip">Skip</button>
        </div>`;
    }).join('') : '<p class="lp-hint">Nothing waiting.</p>';
  }

  function paintHistory() {
    $('[data-req="log"]').innerHTML = history.length ? history.slice().reverse().map((r) => {
      const t = r.track || {};
      return `<div class="req-past" data-state="${esc(r.state)}">
        <span class="req-when">${esc(new Date((r.at || 0) * 1000).toLocaleTimeString())}</span>
        <span class="req-state">${esc(r.state)}</span>
        <b>${esc(t.title || r.text)}</b>
        <span class="req-by">${esc(r.user)}</span>
        <span class="req-why">${esc(r.reason || '')}</span>
      </div>`;
    }).join('') : '<p class="lp-hint">Nothing yet.</p>';
  }

  function paintRules() {
    const mod = $('[data-req="moderated"]');
    if (document.activeElement !== mod) mod.checked = rules.moderated !== false;
    const cap = $('[data-req="cap"]');
    if (document.activeElement !== cap) cap.value = String(Math.round((rules.max_seconds || 0) / 60));
    $('[data-req="blocked"]').textContent = (rules.blocked || []).length
      ? `${(rules.blocked || []).length} blocked word(s), edited in the deck's settings`
      : 'No blocked words yet.';
  }

  function mount(host) {
    if (el) return;
    el = document.createElement('div');
    el.className = 'lp req';
    el.id = 'reqPanel';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Song requests');
    el.innerHTML = `
      <div class="lp-head">
        <h2>Song requests</h2>
        <span class="lp-pill" data-req="count">0 waiting</span>
        <button type="button" class="lp-x" data-req="close" aria-label="Close">&times;</button>
      </div>
      <div data-req="pending"></div>
      <fieldset class="lp-group">
        <legend>Rules</legend>
        <label class="lp-check"><input type="checkbox" data-req="moderated"><span>Ask me before anything goes in the queue</span></label>
        <div class="lp-row">
          <label class="req-cap">Nothing longer than
            <input class="lp-input req-num" type="number" min="0" max="60" data-req="cap" aria-label="Longest track, in minutes"> minutes</label>
        </div>
        <p class="lp-hint" data-req="blocked"></p>
        <p class="lp-hint">Letting one through cannot be undone: Spotify can be added to, but has no way to
          take a track back out of a queue.</p>
      </fieldset>
      <fieldset class="lp-group">
        <legend>What has been asked for</legend>
        <div class="req-log" data-req="log"></div>
      </fieldset>`;
    (host || document.body).appendChild(el);
    wire();
  }

  function wire() {
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } });
    $('[data-req="close"]').addEventListener('click', () => close(true));
    $('[data-req="pending"]').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-req="approve"], [data-req="skip"]');
      if (!btn) return;
      const id = btn.closest('.req-row').dataset.id;
      btn.disabled = true;                       // one press, one call
      const which = btn.dataset.req === 'approve' ? 'approve' : 'skip';
      await post(`/api/requests/${which}`, { id });
      await load();
    });
    $('[data-req="moderated"]').addEventListener('change', (e) => {
      post('/api/config', { requests: { moderated: e.target.checked } }).then(load);
    });
    $('[data-req="cap"]').addEventListener('change', (e) => {
      const mins = Math.max(0, Math.min(60, Number(e.target.value) || 0));
      post('/api/config', { requests: { max_seconds: mins * 60 } }).then(load);
    });
  }

  async function load() {
    const d = await getJSON('/api/requests');
    if (d) {
      pending = d.pending || [];
      rules = (d.status || {}).rules || {};
    }
    const log = await getJSON('/api/requests/recent?n=50');
    history = (log && log.log) || [];
    if (el && !el.hidden) { paintPending(); paintRules(); paintHistory(); }
  }

  function tick() {
    clearTimeout(timer);
    if (!el || el.hidden) return;
    const step = () => { timer = setTimeout(tick, window.isUltra && window.isUltra() ? 4000 : 2000); };
    if (document.hidden) { step(); return; }
    load().finally(step);
  }

  function place() {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(520, innerWidth - 16);
    el.style.width = w + 'px';
    el.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    el.style.top = Math.min(r.bottom + 8, innerHeight - 180) + 'px';
    el.style.maxHeight = (innerHeight - Math.min(r.bottom + 8, innerHeight - 180) - 8) + 'px';
  }

  async function open(from) {
    mount();
    anchor = from || null;
    el.hidden = false;
    place();
    await load();
    paintPending();
    paintRules();
    paintHistory();
    tick();
    ($('[data-req="close"]')).focus();
  }

  function close(refocus) {
    if (!el || el.hidden) return;
    el.hidden = true;
    clearTimeout(timer);
    if (refocus && anchor && anchor.isConnected) anchor.focus();
  }

  window.addEventListener('resize', () => { if (el && !el.hidden) place(); });
  document.addEventListener('pointerdown', (e) => {
    if (el && !el.hidden && !el.contains(e.target) && !(anchor && anchor.contains(e.target))) close(false);
  }, true);

  return {
    mount,
    open,
    close,
    toggle: (from) => (el && !el.hidden ? close(true) : open(from)),
    isOpen: () => !!el && !el.hidden,
    /* For tests. */
    debug: () => ({
      open: !!el && !el.hidden,
      pending: pending.map((r) => ({ id: r.id, user: r.user, title: (r.track || {}).title || r.text })),
      history: history.map((r) => [r.state, (r.track || {}).title || r.text]),
      rules,
    }),
  };
})();
