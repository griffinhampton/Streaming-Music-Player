/* The Sound panel (S7), shared by the deck and the Canvas Builder.

   The mixer already existed - live.py has mixed the microphone and the desktop
   into the stream since P4 - but the only way to see any of it was to open
   the LIVE panel, and the only way to make its meters move was to be
   streaming. This is that mixer with the door left open: which microphone,
   how loud, muted or not, a meter that moves whether or not you are live,
   hearing yourself, and the one number that decides what counts as talking.

   Two things are worth knowing about the meters:

   * The microphone's meter works at any time, because voice.py opens the
     microphone on a lease of its own and reports a level. This panel takes
     that lease while it is open and gives it back when it closes - without
     it the monitor never starts and the meter is a painted-on zero.
   * The desktop meter only moves while you are LIVE. Windows hands the app
     the mixed desktop sound through the native mixer, and that only runs
     while streaming. The panel says so rather than showing a dead bar.

   A page mounts it once (AudioPanel.mount) and opens it from a button
   (AudioPanel.toggle(button)), exactly as LivePanel is used. */
const AudioPanel = (() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({ ok: false }));
  const getJSON = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);

  let el = null, anchor = null, fast = null, slow = null, docked = false;
  let devices = null, cfg = {}, live = { running: false }, voice = {};
  let token = null, lease = null;                 // the voice lease while open
  // A gain being changed wins over the poll. paint() writes every slider back
  // from the server's copy, and the poll runs every 150 ms - so a reply landing
  // inside the debounce reset the slider, and the debounce then sent the value
  // it had just been reset to. The inspector's threshold has the same guard.
  const pendingGain = { mic: false, system: false };
  let monStream = null, monEl = null;
  // A threshold being dragged wins over the poll: a reply landing inside the
  // debounce used to put the old value back, and the timer then saved that.
  let thrEdits = 0, thrSaving = false, thrFirst = true, thrTimer = null;

  const $ = (sel) => el.querySelector(sel);
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  const channel = (key, label, withDevice) => `
    <fieldset class="lp-group">
      <legend>${esc(label)}</legend>
      <label class="lp-check"><input type="checkbox" data-ap="${key}On"><span>Send it to the stream</span></label>
      ${withDevice ? '<select class="lp-input" data-ap="micDevice" aria-label="Which microphone"></select>' : ''}
      <div class="lp-meter" data-ap="${key}Meter" role="meter" aria-label="${esc(label)} level" aria-valuemin="0" aria-valuemax="100"><i></i>${withDevice ? '<s data-ap="thrMark"></s>' : ''}</div>
      <div class="lp-row">
        <input class="lp-range" type="range" min="0" max="400" step="5" data-ap="${key}Gain" aria-label="${esc(label)} volume">
        <b class="lp-num" data-ap="${key}GainOut">100%</b>
        <button type="button" class="lp-btn ghost" data-ap="${key}Mute" aria-pressed="false">Mute</button>
      </div>
      <p class="lp-hint" data-ap="${key}Note"></p>
    </fieldset>`;

  function mount(host) {
    if (el) return;
    el = document.createElement('div');
    el.className = 'lp ap';
    el.id = 'audioPanel';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Sound');
    el.innerHTML = `
      <div class="lp-head">
        <h2>Sound</h2>
        <button type="button" class="lp-x" data-ap="close" aria-label="Close">&times;</button>
      </div>
      ${channel('mic', 'Microphone', true)}
      ${channel('system', 'Desktop sound', false)}
      <fieldset class="lp-group">
        <legend>Hear yourself</legend>
        <label class="lp-check"><input type="checkbox" data-ap="monOn"><span>Play my microphone back to me</span></label>
        <div class="lp-row">
          <input class="lp-range" type="range" min="0" max="100" step="5" value="40" data-ap="monVol" aria-label="How loud to play it back">
          <b class="lp-num" data-ap="monVolOut">40%</b>
        </div>
        <p class="lp-hint">Use headphones. Through speakers this goes round: the microphone hears itself and howls.</p>
      </fieldset>
      <fieldset class="lp-group">
        <legend>Counts as talking</legend>
        <div class="lp-row">
          <input class="lp-range" type="range" min="1" max="60" data-ap="thr" aria-label="How loud counts as talking">
          <b class="lp-num" data-ap="thrOut">8%</b>
        </div>
        <p class="lp-hint" data-ap="thrNote">One number, for every "You, talking" layer and every voice trigger. The mark on the microphone meter above is where it sits.</p>
      </fieldset>`;
    // Docked (the Live view, S9): the same panel in a page rather than over
    // one. It is then never closed, so it holds the voice lease for as long as
    // that window lives - which is what you want of a meter you are watching
    // while you stream. close() is a no-op docked, and with it Escape and
    // click-away, which both go through it.
    (host || document.body).appendChild(el);
    if (host) { docked = true; el.classList.add('docked'); el.setAttribute('role', 'region'); }
    wire();
  }

  function wire() {
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } });
    $('[data-ap="close"]').addEventListener('click', () => close(true));

    for (const key of ['mic', 'system']) {
      $(`[data-ap="${key}On"]`).addEventListener('change', (e) => {
        post('/api/live/audio', { [key]: e.target.checked }).then((d) => { if (d.audio) cfg = d.audio; });
      });
      $(`[data-ap="${key}Gain"]`).addEventListener('input', (e) => {
        $(`[data-ap="${key}GainOut"]`).textContent = e.target.value + '%';
        pendingGain[key] = true;                  // hands off until the server has it
        clearTimeout(e.target._t);
        e.target._t = setTimeout(() => {
          post('/api/live/audio', { source: key, gain: Number(e.target.value) / 100 })
            .then((d) => { if (d.audio) cfg = d.audio; })
            .finally(() => { pendingGain[key] = false; });
        }, 80);
      });
      $(`[data-ap="${key}Mute"]`).addEventListener('click', (e) => {
        const now = e.currentTarget.getAttribute('aria-pressed') !== 'true';
        post('/api/live/audio', { source: key, mute: now }).then((d) => { if (d.audio) cfg = d.audio; paint(); });
      });
    }
    $('[data-ap="micDevice"]').addEventListener('change', (e) => {
      post('/api/live/audio', { mic_device: e.target.value }).then((d) => { if (d.audio) cfg = d.audio; });
      if (monStream) { stopMonitor(); startMonitor(); }        // follow the choice at once
    });

    $('[data-ap="monOn"]').addEventListener('change', (e) => { if (e.target.checked) startMonitor(); else stopMonitor(); });
    $('[data-ap="monVol"]').addEventListener('input', (e) => {
      $('[data-ap="monVolOut"]').textContent = e.target.value + '%';
      if (monEl) monEl.volume = Number(e.target.value) / 100;
    });

    const thr = $('[data-ap="thr"]');
    thr.addEventListener('input', () => {
      const n = ++thrEdits, value = Number(thr.value);
      thrSaving = true;
      $('[data-ap="thrOut"]').textContent = value + '%';
      const mark = $('[data-ap="thrMark"]');
      if (mark) mark.style.left = value + '%';
      clearTimeout(thrTimer);
      thrTimer = setTimeout(() => {
        const done = () => { if (n === thrEdits) thrSaving = false; };
        post('/api/voice', { threshold: value / 100 }).then((d) => { done(); voice = d || voice; paint(n); }).catch(done);
      }, 120);
    });
  }

  /* ---------------------------------------------------------- monitoring */

  async function startMonitor() {
    stopMonitor();
    try {
      const want = (cfg.mic_device || '').toLowerCase();
      let deviceId;
      if (want) {
        const list = await navigator.mediaDevices.enumerateDevices();
        const hit = list.find((d) => d.kind === 'audioinput' && (d.label || '').toLowerCase().includes(want));
        if (hit) deviceId = { exact: hit.deviceId };
      }
      monStream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId } : true, video: false });
      monEl = document.createElement('audio');
      monEl.autoplay = true;
      monEl.srcObject = monStream;
      monEl.volume = Number($('[data-ap="monVol"]').value) / 100;
      el.appendChild(monEl);
    } catch (exc) {
      stopMonitor();
      const box = $('[data-ap="monOn"]');
      if (box) box.checked = false;
      note('micNote', 'Windows would not hand over the microphone: ' + (exc && exc.name ? exc.name : 'no'));
    }
  }
  function stopMonitor() {
    if (monStream) { monStream.getTracks().forEach((t) => t.stop()); monStream = null; }
    if (monEl) { monEl.srcObject = null; monEl.remove(); monEl = null; }
  }

  /* ------------------------------------------------------- the voice lease
     voice.py opens the microphone only while somebody holds a lease. Without
     one this panel's meter would be a painted-on zero. */
  function holdVoice() {
    const renew = () => post('/api/voice/hold', { token }).then((d) => { if (d && d.token) token = d.token; });
    renew();
    clearInterval(lease);
    lease = setInterval(renew, 20000);
  }
  function releaseVoice() {
    clearInterval(lease);
    lease = null;
    if (token) { post('/api/voice/release', { token }); token = null; }
  }
  window.addEventListener('pagehide', () => {
    if (token) navigator.sendBeacon('/api/voice/release', new Blob([JSON.stringify({ token })], { type: 'application/json' }));
  });

  /* ------------------------------------------------------------- painting */

  function note(which, text) { const n = $(`[data-ap="${which}"]`); if (n) n.textContent = text; }

  function paint(asked = thrEdits) {
    if (!el || el.hidden) return;
    const gain = cfg.gain || {}, mute = cfg.mute || {};
    for (const key of ['mic', 'system']) {
      const on = $(`[data-ap="${key}On"]`);
      if (document.activeElement !== on) on.checked = cfg[key] !== false;
      const g = Math.round(num(gain[key], 1) * 100);
      const slider = $(`[data-ap="${key}Gain"]`);
      if (!pendingGain[key] && document.activeElement !== slider) {
        slider.value = String(g);
        $(`[data-ap="${key}GainOut"]`).textContent = g + '%';
      }
      const muted = !!mute[key];
      const mb = $(`[data-ap="${key}Mute"]`);
      mb.setAttribute('aria-pressed', String(muted));
      mb.textContent = muted ? 'Muted' : 'Mute';
      // The microphone has a level whether or not a stream is running; the
      // desktop only has one while the native mixer is up.
      const fromLive = live.running ? num((live.level || {})[key], 0) : null;
      const level = key === 'mic'
        ? Math.round((fromLive === null ? num(voice.level, 0) : fromLive) * 100)
        : Math.round((fromLive === null ? 0 : fromLive) * 100);
      const meter = $(`[data-ap="${key}Meter"]`);
      meter.firstElementChild.style.width = level + '%';
      meter.setAttribute('aria-valuenow', String(level));
      meter.classList.toggle('muted', muted);
    }
    meterNotes();

    const thr = Math.round(num(voice.threshold, 0.08) * 100);
    const current = !thrSaving && asked === thrEdits;
    const mark = $('[data-ap="thrMark"]');
    if (current && mark) mark.style.left = thr + '%';
    const slider = $('[data-ap="thr"]');
    if (current && (thrFirst || document.activeElement !== slider)) {
      slider.value = String(thr);
      $('[data-ap="thrOut"]').textContent = thr + '%';
    }
    thrFirst = false;
    $('[data-ap="micMeter"]').classList.toggle('talking', !!voice.speaking);
  }

  function meterNotes() {
    note('systemNote', live.running
      ? 'The mixer is running: this is what is going out.'
      : 'This meter only moves while you are LIVE - Windows hands the app the mixed desktop sound only then.');
    const src = voice.source;
    note('micNote', live.running ? 'The mixer is running: this is what is going out.'
      : src === 'captions' ? 'Captions are listening, so their own speech detector decides what counts as talking.'
      : src === 'override' ? 'A test is holding the microphone state.'
      : voice.error ? String(voice.error)
      : 'Live now, whether or not you are streaming.');
  }

  /* -------------------------------------------------------------- polling */

  function tickFast() {
    clearTimeout(fast);
    if (!el || el.hidden) return;
    const step = () => { fast = setTimeout(tickFast, window.isUltra && window.isUltra() ? 1000 : 150); };
    if (document.hidden) { step(); return; }
    const asked = thrEdits;
    getJSON('/api/voice').then((d) => { if (d) { voice = d; paint(asked); } }).finally(step);
  }
  function tickSlow() {
    clearTimeout(slow);
    if (!el || el.hidden) return;
    const step = () => { slow = setTimeout(tickSlow, 1200); };
    if (document.hidden) { step(); return; }
    getJSON('/api/live/status').then((d) => {
      if (d) { live = d.audio || { running: false }; cfg = (d.config || {}).audio || cfg; paint(); }
    }).finally(step);
  }

  /* ------------------------------------------------------- open and close */

  function place() {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(400, innerWidth - 16);
    el.style.width = w + 'px';
    el.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    el.style.top = Math.min(r.bottom + 8, innerHeight - 120) + 'px';
    el.style.maxHeight = (innerHeight - Math.min(r.bottom + 8, innerHeight - 120) - 8) + 'px';
  }

  async function open(from) {
    mount();
    anchor = from || null;
    el.hidden = false;
    place();
    if (!devices) {
      devices = await getJSON('/api/live/devices') || { capture: [] };
      const sel = $('[data-ap="micDevice"]');
      sel.innerHTML = ['<option value="">Windows default microphone</option>']
        .concat((devices.capture || []).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)).join('');
    }
    const st = await getJSON('/api/live/status');
    if (st) { live = st.audio || { running: false }; cfg = (st.config || {}).audio || {}; }
    const sel = $('[data-ap="micDevice"]');
    if (document.activeElement !== sel) sel.value = cfg.mic_device || '';
    holdVoice();
    const v = await getJSON('/api/voice');
    if (v) voice = v;
    paint();
    tickFast();
    tickSlow();
    if (!docked) ($('[data-ap="micDevice"]') || $('[data-ap="close"]')).focus();
  }

  function close(refocus) {
    if (docked || !el || el.hidden) return;
    el.hidden = true;
    clearTimeout(fast);
    clearTimeout(slow);
    stopMonitor();
    releaseVoice();
    const box = el.querySelector('[data-ap="monOn"]');
    if (box) box.checked = false;
    if (refocus && anchor && anchor.isConnected) anchor.focus();
  }

  window.addEventListener('resize', () => { if (el && !el.hidden) place(); });
  document.addEventListener('pointerdown', (e) => {
    if (el && !el.hidden && !el.contains(e.target) && !(anchor && anchor.contains(e.target))) close(false);
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && el && !el.hidden) { tickFast(); tickSlow(); } });

  return {
    mount,
    open,
    close,
    toggle: (from) => (el && !el.hidden ? close(true) : open(from)),
    isOpen: () => !!el && !el.hidden,
    /* For tests. */
    debug: () => ({
      open: !!el && !el.hidden,
      level: Math.round(num(voice.level, 0) * 100),
      speaking: !!voice.speaking,
      source: voice.source || '',
      threshold: Math.round(num(voice.threshold, 0.08) * 100),
      micWidth: el ? el.querySelector('[data-ap="micMeter"] i').style.width : '',
      systemWidth: el ? el.querySelector('[data-ap="systemMeter"] i').style.width : '',
      running: !!live.running,
      cfg,
    }),
  };
})();
