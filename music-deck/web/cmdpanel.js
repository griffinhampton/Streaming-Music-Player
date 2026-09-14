/* The command editor (S12), opened from the Live view.

   S12 asks for the editor to be in the Live view, and the Live view is already
   three full columns, so this is a dialog on the shared .lp pattern rather than
   a fourth thing squeezed into the page - the same box the LIVE, Sound and chat
   panels use.

   What it edits is a plain list in config, and the server cleans it: a name is
   normalised, an unusable entry is dropped rather than half-kept, and cooldowns
   are clamped. Save therefore redraws from what came back, not from what was
   typed - so if the server refused or changed something, that is what you see
   rather than a form that quietly disagrees with the app.

   The log is polled while this is open and never rides the state feed: it
   changes whenever anybody types, which is the wrong cadence for a whole-state
   broadcast to every page in the app.

   Nothing here can make the app speak in chat - it cannot. A response is
   recorded and shown; sending one into Twitch needs an account and an OAuth
   token, which is the user's decision to take. The hint at the bottom says so,
   because an editor with a "response" box that silently never reaches anyone
   would be a lie told in a text field. */
const CmdPanel = (() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({ ok: false }));
  const getJSON = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);

  let el = null, anchor = null, timer = null;
  let roles = ['everyone', 'subscriber', 'vip', 'mod', 'broadcaster'];
  let actions = ['say', 'scene'];
  let rows = [];              // what is on screen, saved or not
  // What starts a command, as the server last accepted it. Every label here
  // is built from this rather than from a literal "!", so the editor cannot
  // sit there saying "!gif" while chat is answering to "/gif".
  let symbol = '!';
  let dirty = false;

  const $ = (sel) => el.querySelector(sel);
  const blank = () => ({ name: '', action: 'say', role: 'everyone', response: '', target: '', cooldown: 0, user_cooldown: 0, enabled: true });
  // Which field an action keeps its argument in. row() and readRows() both ask
  // this one question rather than each carrying its own copy of the rule: when
  // the two disagree, a command saves its argument into a field nothing reads
  // and the setting silently does not stick.
  const fieldOf = (a) => ((a === 'scene' || a === 'gif' || a === 'sound' || a === 'stop') ? 'target' : 'response');
  const picksAsset = (a) => (a === 'gif' || a === 'sound');
  let pics = [];              // the pictures a gif command can choose from

  function row(c, i) {
    return `
      <fieldset class="lp-group cmd-row" data-i="${i}">
        <legend>${esc(symbol[0] || '!')}${esc(c.name || 'new')}</legend>
        <div class="lp-row">
          <input class="lp-input cmd-name" data-cmd="name" value="${esc(c.name)}" placeholder="name" aria-label="Command name" spellcheck="false">
          <select class="lp-input cmd-sm" data-cmd="action" aria-label="What it does">
            ${actions.map((a) => `<option value="${esc(a)}"${a === c.action ? ' selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
          <select class="lp-input cmd-sm" data-cmd="role" aria-label="Who may run it">
            ${roles.map((r) => `<option value="${esc(r)}"${r === c.role ? ' selected' : ''}>${esc(r)}</option>`).join('')}
          </select>
          <label class="lp-check"><input type="checkbox" data-cmd="enabled"${c.enabled !== false ? ' checked' : ''}><span>On</span></label>
          <button type="button" class="lp-btn ghost cmd-del" data-cmd="remove" aria-label="Remove !${esc(c.name)}">Remove</button>
        </div>
        ${picksAsset(c.action) ? `
        <label class="lp-field"><span>${c.action === 'sound' ? 'Which sound' : 'Which picture'}</span>
          <select class="lp-input" data-cmd="target">
            <option value=""${c.target ? '' : ' selected'}>Whatever the Effect layer is set to</option>
            ${pics.filter((a) => (c.action === 'sound' ? a.kind === 'audio' : a.kind !== 'audio'))
              .map((a) => `<option value="${esc(a.id)}"${a.id === c.target ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select></label>
        <p class="lp-hint">Used by any Effect layer on the live scene that is listening for
          ${c.action === 'sound' ? 'sounds' : 'gifs'}.</p>` : c.action === 'stop' ? `
        <label class="lp-field"><span>What it does</span>
          <select class="lp-input" data-cmd="target">
            <option value=""${c.target === 'resume' ? '' : ' selected'}>Clear the stream and pause commands</option>
            <option value="resume"${c.target === 'resume' ? ' selected' : ''}>Resume commands</option>
          </select></label>
        <p class="lp-hint">The Live view's Stop effects button, for your moderators. It still works while
          commands are paused - that is how a resume gets through.</p>` : `
        <label class="lp-field"><span>${c.action === 'scene' ? 'Which scene (blank: whatever was typed after the command)' : 'What it says back'}</span>
          <input class="lp-input" data-cmd="${fieldOf(c.action)}"
                 value="${esc(c.action === 'scene' ? c.target : c.response)}"
                 placeholder="${c.action === 'scene' ? 'Just chatting' : 'hi {user}'}" spellcheck="false"></label>`}
        <div class="lp-row">
          <label class="cmd-cool">Every <input class="lp-input cmd-num" type="number" min="0" max="3600" data-cmd="cooldown" value="${Number(c.cooldown) || 0}" aria-label="Cooldown for everyone, in seconds"> s, for anyone</label>
          <label class="cmd-cool">and <input class="lp-input cmd-num" type="number" min="0" max="3600" data-cmd="user_cooldown" value="${Number(c.user_cooldown) || 0}" aria-label="Cooldown per person, in seconds"> s, per person</label>
        </div>
      </fieldset>`;
  }

  function paintRows() {
    $('[data-cmd="rows"]').innerHTML = rows.length ? rows.map(row).join('')
      : '<p class="lp-hint">No commands yet. Add one, and anything typed in chat that starts with ! will be matched against it.</p>';
    $('[data-cmd="save"]').disabled = !dirty;
    $('[data-cmd="count"]').textContent = rows.length === 1 ? '1 command' : `${rows.length} commands`;
  }

  function readRows() {
    rows = [...el.querySelectorAll('.cmd-row')].map((box, i) => {
      const get = (k) => { const f = box.querySelector(`[data-cmd="${k}"]`); return f ? f.value : ''; };
      const on = box.querySelector('[data-cmd="enabled"]');
      const action = get('action') || 'say';
      return Object.assign({}, rows[i] || blank(), {
        name: get('name'), action, role: get('role') || 'everyone',
        enabled: !on || on.checked,
        cooldown: Number(get('cooldown')) || 0,
        user_cooldown: Number(get('user_cooldown')) || 0,
        [fieldOf(action)]: get(fieldOf(action)),
      });
    });
  }

  function paintLog(items) {
    const box = $('[data-cmd="log"]');
    box.innerHTML = (items || []).length ? items.slice().reverse().map((e) => `
      <div class="cmd-fired" data-outcome="${esc(e.outcome)}">
        <span class="cmd-when">${esc(new Date((e.at || 0) * 1000).toLocaleTimeString())}</span>
        <b>${esc(symbol[0] || '!')}${esc(e.command)}</b>
        <span class="cmd-who">${esc(e.user)}</span>
        <span class="cmd-out">${esc(e.outcome)}</span>
        <span class="cmd-resp">${esc(e.response)}</span>
      </div>`).join('') : '<p class="lp-hint">Nothing has fired yet.</p>';
  }

  function mount() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'lp cmd';
    el.id = 'cmdPanel';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Commands');
    el.innerHTML = `
      <div class="lp-head">
        <h2>Commands</h2>
        <span class="lp-pill" data-cmd="count">0 commands</span>
        <button type="button" class="lp-x" data-cmd="close" aria-label="Close">&times;</button>
      </div>
      <p class="lp-error" data-cmd="error" hidden></p>
      <fieldset class="lp-group">
        <legend>What starts a command</legend>
        <div class="lp-row">
          <input class="lp-input cmd-sm" data-cmd="symbol" value="!" maxlength="4" spellcheck="false"
                 aria-label="The symbol that starts a command">
          <span class="lp-hint">Saved with the commands below. <b>/</b> or <b>@</b> work as well, and
            <b>!/</b> means either - handy for a week after you switch. Letters and digits are
            refused: with <b>a</b>, "apple" would run the command "pple".</span>
        </div>
      </fieldset>
      <fieldset class="lp-group">
        <legend>How many effects at once</legend>
        <div class="lp-row">
          <label class="cmd-cool">At most <input class="lp-input cmd-num" type="number" min="1" max="60" data-cmd="bcount" value="5"
            aria-label="How many pictures or sounds"> pictures or sounds every
            <input class="lp-input cmd-num" type="number" min="0" max="600" data-cmd="bseconds" value="30"
            aria-label="In how many seconds"> s</label>
        </div>
        <p class="lp-hint">From every command together, on top of each one's own wait - ten commands with
          a ten-second wait are still one a second between them. 0 s means no limit.</p>
      </fieldset>
      <p class="lp-hint cmd-paused" data-cmd="paused" hidden>Chat commands are paused. Nothing below will run until
        you press Resume commands at the top of the Live view.</p>
      <div data-cmd="rows"></div>
      <div class="lp-row">
        <button type="button" class="lp-btn" data-cmd="add">Add a command</button>
        <button type="button" class="lp-btn primary" data-cmd="save" disabled>Save</button>
      </div>
      <fieldset class="lp-group" data-cmd="layersbox" hidden>
        <legend>On the scene on air</legend>
        <div data-cmd="layers"></div>
        <p class="lp-hint">These belong to layers on the canvas. Change them in the Canvas Builder, on the layer -
          deleting the layer deletes its command.</p>
      </fieldset>
      <fieldset class="lp-group">
        <legend>What has fired</legend>
        <div class="cmd-log" data-cmd="log"></div>
      </fieldset>
      <p class="lp-hint">A response is written down and shown here - this app cannot speak in chat, because it
        signs in without an account so it holds no password of yours. Putting replies back into chat needs one.</p>`;
    document.body.appendChild(el);
    wire();
  }

  function wire() {
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } });
    $('[data-cmd="close"]').addEventListener('click', () => close(true));
    $('[data-cmd="add"]').addEventListener('click', () => {
      readRows();
      rows.push(blank());
      dirty = true;
      paintRows();
      const last = el.querySelector('.cmd-row:last-of-type [data-cmd="name"]');
      if (last) last.focus();
    });
    $('[data-cmd="rows"]').addEventListener('click', (e) => {
      const del = e.target.closest('[data-cmd="remove"]');
      if (!del) return;
      readRows();
      rows.splice(Number(del.closest('.cmd-row').dataset.i), 1);
      dirty = true;
      paintRows();
    });
    // An action change swaps which field is shown (a scene has a target, a say
    // has a response), so that one redraws; everything else just marks dirty.
    $('[data-cmd="rows"]').addEventListener('change', (e) => {
      dirty = true;
      if (e.target.dataset.cmd === 'action') {
        readRows();
        // A stop anybody can run is a way for one viewer to switch every
        // command off, so it starts at mod. Still a choice - just not the
        // dangerous one by default.
        const r = rows[Number(e.target.closest('.cmd-row').dataset.i)];
        if (r && r.action === 'stop' && r.role === 'everyone') r.role = 'mod';
        paintRows();
      }
      else $('[data-cmd="save"]').disabled = false;
    });
    $('[data-cmd="rows"]').addEventListener('input', () => { dirty = true; $('[data-cmd="save"]').disabled = false; });
    // The symbol field sits outside the rows, so it needs its own listener -
    // the delegated ones above never see it.
    $('[data-cmd="symbol"]').addEventListener('input', () => { dirty = true; $('[data-cmd="save"]').disabled = false; });
    for (const k of ['bcount', 'bseconds']) {
      $(`[data-cmd="${k}"]`).addEventListener('input', () => { dirty = true; $('[data-cmd="save"]').disabled = false; });
    }
    $('[data-cmd="save"]').addEventListener('click', save);
  }

  async function save() {
    readRows();
    const d = await post('/api/commands/save', {
      commands: rows, symbol: $('[data-cmd="symbol"]').value,
      budget: { count: Number($('[data-cmd="bcount"]').value), seconds: Number($('[data-cmd="bseconds"]').value) },
    });
    const err = $('[data-cmd="error"]');
    if (!d || !d.ok) {
      err.hidden = false;
      err.textContent = (d && d.error) || 'Could not save those';
      return;
    }
    err.hidden = true;
    // What came back, not what was typed: the server drops what it cannot use
    // and clamps what is out of range, and the form has to admit that.
    const before = rows.length;
    const asked = $('[data-cmd="symbol"]').value;
    rows = d.commands || [];
    // The symbol the same way: set_symbols drops what it cannot use, so the
    // field shows what is in force rather than what was typed at it.
    symbol = d.symbol || symbol;
    $('[data-cmd="symbol"]').value = symbol;
    paintBudget(d.budget);                 // clamped by the server, shown as kept
    // A name added or removed here changes which layer commands conflict.
    getJSON('/api/commands').then((x) => { if (x) paintLayers(x.layers); });
    if (asked !== symbol) {
      err.hidden = false;
      err.textContent = `Kept "${symbol}" - a letter, a digit or a space cannot start a command.`;
    }
    dirty = false;
    paintRows();
    if (rows.length < before) {
      err.hidden = false;
      err.textContent = `${before - rows.length} of those could not be used and were dropped - a name has to be letters, numbers, _ or -.`;
    }
  }

  /* T11: what answers in chat without being in the list above, so every
     command the stream responds to can be seen in one place. Read-only: the
     layer is where these are set up, and a second place to edit them would
     be a second place for them to disagree. */
  function paintLayers(list) {
    const items = list || [];
    $('[data-cmd="layersbox"]').hidden = !items.length;
    const why = (c) => (c.conflict === 'list' ? 'the command above with this name answers instead'
      : c.conflict === 'layer' ? 'another layer took this name first'
      : [c.role === 'everyone' ? 'anyone' : c.role + ' and up',
         c.cooldown ? `every ${c.cooldown} s` : '', c.user_cooldown ? `${c.user_cooldown} s per person` : '']
        .filter(Boolean).join(', '));
    $('[data-cmd="layers"]').innerHTML = items.map((c) => `
      <div class="cmd-layer" data-conflict="${esc(c.conflict || '')}">
        <b>${esc(symbol[0] || '!')}${esc(c.name)}</b>
        <span class="cmd-who">${esc(c.layer || 'Effect layer')}</span>
        <span class="cmd-resp">${esc(why(c))}</span>
      </div>`).join('');
  }

  function paintBudget(b) {
    if (!b) return;
    $('[data-cmd="bcount"]').value = String(b.count);
    $('[data-cmd="bseconds"]').value = String(b.seconds);
  }

  /* From the Live view's state feed, so the note appears and goes the moment
     anybody stops or resumes - a moderator in chat included - rather than
     when this panel is next opened. */
  function onState(s) {
    if (!el) return;
    $('[data-cmd="paused"]').hidden = !((s && s.commands) || {}).paused;
  }

  function tick() {
    clearTimeout(timer);
    if (!el || el.hidden) return;
    const step = () => { timer = setTimeout(tick, window.isUltra && window.isUltra() ? 4000 : 2000); };
    if (document.hidden) { step(); return; }
    getJSON('/api/commands/recent?n=50').then((d) => { if (d) paintLog(d.log); }).finally(step);
  }

  function place() {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(560, innerWidth - 16);
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
    // Before the rows are painted: a gif row draws a list of these.
    pics = ((await getJSON('/api/assets')) || {}).assets || [];
    const d = await getJSON('/api/commands');
    if (d) {
      roles = d.roles || roles;
      actions = d.actions || actions;
      rows = d.commands || [];
      symbol = d.symbol || symbol;
      $('[data-cmd="symbol"]').value = symbol;
      paintBudget(d.budget);
      paintLayers(d.layers);
      onState({ commands: { paused: !!d.paused } });
    }
    dirty = false;
    paintRows();
    const log = await getJSON('/api/commands/recent?n=50');
    paintLog(log && log.log);
    tick();
    ($('[data-cmd="add"]') || $('[data-cmd="close"]')).focus();
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
    onState,
    /* For tests. */
    debug: () => ({
      open: !!el && !el.hidden,
      rows: rows.map((c) => ({ name: c.name, action: c.action, role: c.role, cooldown: c.cooldown, user_cooldown: c.user_cooldown })),
      dirty,
      fired: el ? [...el.querySelectorAll('.cmd-fired')].map((f) => f.dataset.outcome) : [],
    }),
  };
})();
