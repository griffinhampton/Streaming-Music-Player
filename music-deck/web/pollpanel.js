/* Polls (S14), from the Live view.

   Two faces, because a poll has two states and they want different things from
   you. Shut, it is a question and its choices and one button. Open, it is the
   bars filling up and one button to stop it.

   Whether a poll is open rides the state feed, so the button in the header can
   say so without anything polling; the counts do not, because they move on
   every vote - those are asked for only while this panel is on screen. Same
   split as the requests panel, and for the same reason.

   Closing is not undoable in the sense that matters: the poll stops taking
   votes and the result is what it was. That is why Close says what it will do
   rather than being the primary button. */
const PollPanel = (() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({ ok: false }));
  const getJSON = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);

  let el = null, anchor = null, timer = null;
  let current = null, past = [];
  // What starts a command, from /api/polls. The voting hint below is an
  // instruction, and an instruction naming the wrong symbol is worse than no
  // hint at all - people would type it and nothing would happen.
  let symbol = '!';

  const $ = (sel) => el.querySelector(sel);

  function paint() {
    const open = !!(current && current.open);
    // Written here rather than left in the template: it is an instruction, and
    // "type !1" stops being true the moment somebody switches to "/".
    const hint = $('[data-poll="votehint"]');
    const s = esc(symbol[0] || '!');
    if (hint) {
      hint.innerHTML = `People vote by typing <b>${s}1</b>, <b>${s}2</b> and so on in chat. `
        + 'One each - the first one they send is the one that counts.';
    }
    $('[data-poll="state"]').textContent = open ? 'Taking votes' : 'No poll open';
    $('[data-poll="state"]').dataset.state = open ? 'joined' : 'idle';
    $('[data-poll="setup"]').hidden = open;
    $('[data-poll="live"]').hidden = !open;

    if (open) {
      $('[data-poll="liveq"]').textContent = current.question || '';
      const total = Number(current.total) || 0;
      $('[data-poll="total"]').textContent = total === 1 ? '1 vote' : `${total} votes`;
      $('[data-poll="bars"]').innerHTML = (current.choices || []).map((label, i) => {
        const count = (current.counts || [])[i] || 0;
        const share = Math.round(((current.shares || [])[i] || 0) * 100);
        return `<div class="pl-row">
            <span class="pl-n">${i + 1}</span>
            <span class="pl-label"></span>
            <span class="pl-count">${count} &middot; ${share}%</span>
            <span class="pl-track"><i style="width:${share}%"></i></span>
          </div>`;
      }).join('');
      // Choices are words somebody typed: set as text, never as markup.
      $('[data-poll="bars"]').querySelectorAll('.pl-label').forEach((n, i) => {
        n.textContent = (current.choices || [])[i] || '';
      });
    }
    $('[data-poll="past"]').innerHTML = past.length ? past.slice().reverse().map((p) =>
      `<div class="pl-past"><b></b><span class="pl-by">${(p.total || 0)} vote(s)</span></div>`
    ).join('') : '<p class="lp-hint">Nothing yet.</p>';
    $('[data-poll="past"]').querySelectorAll('.pl-past > b').forEach((n, i) => {
      const p = past.slice().reverse()[i];
      const best = (p.counts || []).indexOf(Math.max(...((p.counts || []).length ? p.counts : [0])));
      n.textContent = `${p.question} - ${(p.choices || [])[best] || 'no votes'}`;
    });
  }

  function mount() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'lp poll';
    el.id = 'pollPanel';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Poll');
    el.innerHTML = `
      <div class="lp-head">
        <h2>Poll</h2>
        <span class="lp-pill" data-poll="state">No poll open</span>
        <button type="button" class="lp-x" data-poll="close" aria-label="Close">&times;</button>
      </div>
      <p class="lp-error" data-poll="error" hidden></p>

      <div data-poll="setup">
        <label class="lp-field"><span>The question</span>
          <input class="lp-input" data-poll="q" placeholder="Which song next?" spellcheck="false"></label>
        <div class="lp-field"><span>The choices</span><div data-poll="choices"></div></div>
        <div class="lp-row">
          <button type="button" class="lp-btn" data-poll="add">Another choice</button>
          <button type="button" class="lp-btn primary" data-poll="open">Open the poll</button>
        </div>
        <p class="lp-hint" data-poll="votehint">People vote by typing <b>!1</b>, <b>!2</b> and so on in
          chat. One each - the first one they send is the one that counts.</p>
      </div>

      <div data-poll="live" hidden>
        <b data-poll="liveq"></b>
        <p class="lp-hint" data-poll="total">0 votes</p>
        <div data-poll="bars"></div>
        <div class="lp-row">
          <button type="button" class="lp-btn danger" data-poll="stop">Close the poll</button>
        </div>
        <p class="lp-hint">Closing stops the counting and keeps the result.</p>
      </div>

      <fieldset class="lp-group">
        <legend>Polls before this one</legend>
        <div data-poll="past"></div>
      </fieldset>`;
    document.body.appendChild(el);
    wire();
    setChoices(['', '']);
  }

  function setChoices(values) {
    $('[data-poll="choices"]').innerHTML = values.map((v, i) => `
      <div class="lp-row pl-choice">
        <span class="pl-n">${i + 1}</span>
        <input class="lp-input" data-poll="choice" value="${esc(v)}" placeholder="Choice ${i + 1}" spellcheck="false">
        <button type="button" class="lp-btn ghost" data-poll="drop" aria-label="Remove choice ${i + 1}">&times;</button>
      </div>`).join('');
  }
  const choiceValues = () => [...el.querySelectorAll('[data-poll="choice"]')].map((n) => n.value);

  function wire() {
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } });
    $('[data-poll="close"]').addEventListener('click', () => close(true));
    $('[data-poll="add"]').addEventListener('click', () => {
      const now = choiceValues();
      if (now.length >= 8) return;                 // !1 to !8; more than that nobody reads
      setChoices(now.concat(['']));
    });
    $('[data-poll="choices"]').addEventListener('click', (e) => {
      if (!e.target.closest('[data-poll="drop"]')) return;
      const now = choiceValues();
      if (now.length <= 2) return;                 // a poll needs two things to choose between
      const i = [...el.querySelectorAll('.pl-choice')].indexOf(e.target.closest('.pl-choice'));
      setChoices(now.filter((_, n) => n !== i));
    });
    $('[data-poll="open"]').addEventListener('click', async () => {
      const err = $('[data-poll="error"]');
      const d = await post('/api/polls/open', { question: $('[data-poll="q"]').value, choices: choiceValues() });
      if (!d || !d.ok) { err.hidden = false; err.textContent = (d && d.reason) || 'Could not open that poll'; return; }
      err.hidden = true;
      await load();
    });
    $('[data-poll="stop"]').addEventListener('click', async () => {
      await post('/api/polls/close');
      await load();
    });
  }

  async function load() {
    const d = await getJSON('/api/polls');
    if (d) { current = d.current; past = d.recent || []; symbol = d.symbol || symbol; }
    if (el && !el.hidden) paint();
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
    const w = Math.min(480, innerWidth - 16);
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
    paint();
    tick();
    ($('[data-poll="q"]') || $('[data-poll="close"]')).focus();
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
      poll: current && { question: current.question, counts: current.counts, total: current.total, live: current.open },
      bars: el ? [...el.querySelectorAll('.pl-track > i')].map((i) => i.style.width) : [],
      past: past.length,
    }),
  };
})();
