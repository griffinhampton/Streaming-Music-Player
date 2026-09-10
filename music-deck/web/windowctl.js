/* Shared controls for the frameless pop-out windows.

   They have no title bar, so moving and resizing happen by forwarding pointer
   deltas to the server, which drives the host window with Win32 calls. Each
   pop-out passes the API prefix its window lives under. */

function reportWindowMetrics(api) {
  fetch(api + '/metrics', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inner_w: window.innerWidth,
      inner_h: window.innerHeight,
      dpr: window.devicePixelRatio,
    }),
  }).catch(() => {});
}

/**
 * Wire whole-window move, 8-direction resize, minimize and close onto a
 * frameless pop-out. Called only for real windows (not the deck preview).
 *
 * @param {object} o
 * @param {HTMLElement} o.stage   element whose body drags the window
 * @param {HTMLElement} o.close   close button
 * @param {string} o.api          e.g. '/api/window'
 * @param {Document|HTMLElement} [o.root]  where to look for handles/buttons
 */
function attachWindowControls({ stage, close, api, root = document }) {
  // Batch deltas and flush a few times a second: one HTTP call per pointer
  // event would be far too chatty. `extra` (e.g. {edge}) rides along on every
  // flush - including the final partial one - so the server knows which edge.
  function pump(endpoint, keys, extra) {
    let active = false, pending = { [keys[0]]: 0, [keys[1]]: 0 }, last = null, timer = null;
    const flush = () => {
      if (!pending[keys[0]] && !pending[keys[1]]) return;
      const payload = { [keys[0]]: pending[keys[0]], [keys[1]]: pending[keys[1]] };
      if (extra) Object.assign(payload, extra);
      pending = { [keys[0]]: 0, [keys[1]]: 0 };
      fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    };
    return {
      start(e, target) {
        active = true;
        last = { x: e.screenX, y: e.screenY };
        target.setPointerCapture(e.pointerId);
        timer = setInterval(flush, 40);
      },
      move(e) {
        if (!active) return;
        pending[keys[0]] += e.screenX - last.x;
        pending[keys[1]] += e.screenY - last.y;
        last = { x: e.screenX, y: e.screenY };
      },
      end(e, target) {
        if (!active) return;
        active = false;
        clearInterval(timer);
        flush();
        try { target.releasePointerCapture(e.pointerId); } catch (_) {}
      },
    };
  }

  // Whole-window move: a press anywhere on the body that is not a button or a
  // resize handle drags the window.
  const mover = pump(api + '/nudge', ['dx', 'dy']);
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.winbtn, .rz')) return;
    mover.start(e, stage);
  });
  stage.addEventListener('pointermove', (e) => mover.move(e));
  stage.addEventListener('pointerup', (e) => mover.end(e, stage));
  stage.addEventListener('pointercancel', (e) => mover.end(e, stage));

  // Eight resize handles. Each forwards accumulated screen-px deltas plus its
  // own edge; the server moves the opposite-anchored edges to match.
  root.querySelectorAll('.rz[data-edge]').forEach((h) => {
    const sizer = pump(api + '/edge', ['dx', 'dy'], { edge: h.dataset.edge });
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      sizer.start(e, h);
    });
    h.addEventListener('pointermove', (e) => sizer.move(e));
    h.addEventListener('pointerup', (e) => sizer.end(e, h));
    h.addEventListener('pointercancel', (e) => sizer.end(e, h));
  });

  // Minimize: hide from both desktop and stream; it comes back from the
  // taskbar. Never close the tab. Swallows 404s so it is inert until the
  // backend lands.
  const minBtn = root.querySelector ? root.querySelector('#minBtn') : document.getElementById('minBtn');
  if (minBtn) {
    minBtn.addEventListener('click', () => {
      fetch(api + '/minimize', { method: 'POST' }).catch(() => {});
    });
  }

  if (close) {
    close.addEventListener('click', () => {
      fetch(api + '/close', { method: 'POST' }).catch(() => {});
      setTimeout(() => window.close(), 200);
    });
  }

  // First-open nudge: show the "drag to move" hint for a few seconds.
  stage.classList.add('show-hint');
  setTimeout(() => stage.classList.remove('show-hint'), 4000);
}
