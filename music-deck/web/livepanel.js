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

  let el = null, anchor = null, timer = null, stopArmed = 0;
  let status = { state: 'idle' }, snap = null, presets = {}, devices = null, cfg = {};

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
    // Start / Stop.
    const b = $('[data-lp="go"]');
    const armed = Date.now() - stopArmed < 4000;
    b.textContent = onAir() ? (armed ? 'Click again to stop' : 'Stop') : 'Start';
    b.classList.toggle('primary', !onAir());
    b.classList.toggle('danger', onAir());
    const saved = st.saved_url || st.url;
    b.disabled = !onAir() && (!st.has_key || !saved || !cur);
    const h = $('[data-lp="goHint"]');
    if (!h._t) h.textContent = onAir() ? '' : !st.has_key || !saved ? 'Save the Server URL and the stream key first' : !cur ? 'Pick the scene to go out first' : '';
  }

  async function refresh() {
    try {
      const d = await (await fetch('/api/live/status', { cache: 'no-store' })).json();
      status = d;
      cfg = Object.assign({}, d.config || {});
    } catch (_) { /* next time */ }
    paint();
  }
  function poll() {
    clearTimeout(timer);
    if (!el || el.hidden) return;
    const next = () => { timer = setTimeout(poll, onAir() ? 500 : 1500); };
    if (document.hidden) { next(); return; }
    refresh().finally(next);
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
