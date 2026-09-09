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
 * @param {object} o
 * @param {HTMLElement} o.stage   element whose body drags the window
 * @param {HTMLElement} o.grip    bottom-right resize handle
 * @param {HTMLElement} o.close   close button
 * @param {string} o.api          e.g. '/api/window'
 */
function attachWindowControls({ stage, grip, close, api }) {
  // Batch deltas and flush a few times a second: one HTTP call per pointer
  // event would be far too chatty.
  function pump(endpoint, keys) {
    let active = false, pending = { [keys[0]]: 0, [keys[1]]: 0 }, last = null, timer = null;
    const flush = () => {
      if (!pending[keys[0]] && !pending[keys[1]]) return;
      const body = JSON.stringify(pending);
      pending = { [keys[0]]: 0, [keys[1]]: 0 };
      fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
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

  const mover = pump(api + '/nudge', ['dx', 'dy']);
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.close, .grip')) return;
    mover.start(e, stage);
  });
  stage.addEventListener('pointermove', (e) => mover.move(e));
  stage.addEventListener('pointerup', (e) => mover.end(e, stage));
  stage.addEventListener('pointercancel', (e) => mover.end(e, stage));

  if (grip) {
    const sizer = pump(api + '/resize', ['dw', 'dh']);
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      sizer.start(e, grip);
    });
    grip.addEventListener('pointermove', (e) => sizer.move(e));
    grip.addEventListener('pointerup', (e) => sizer.end(e, grip));
    grip.addEventListener('pointercancel', (e) => sizer.end(e, grip));
  }

  if (close) {
    close.addEventListener('click', () => {
      fetch(api + '/close', { method: 'POST' }).catch(() => {});
      setTimeout(() => window.close(), 200);
    });
  }
}
