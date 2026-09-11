/* Embed mode for the component pages (?embed=1).

   Inside a scene a component page has no window of its own and no feed of
   its own: the scene page holds the one connection and relays every state
   snapshot here by postMessage. This runs before the page's own script,
   sets EMBED for it, hands snapshots to whatever the page registers, and
   turns the scene's transparency options into classes on <html>. */
(() => {
  const on = new URLSearchParams(location.search).has('embed');
  window.EMBED = on;
  const handlers = [];
  window.onEmbedState = (fn) => { handlers.push(fn); };
  if (!on) return;

  const root = document.documentElement;
  root.classList.add('embed');

  // What the scene lets through: the card's own background and frame, and
  // which parts of the page to leave out.
  const PARTS = ['art', 'progress', 'transport', 'label', 'header', 'times', 'kaomoji', 'source'];
  function applyOptions(o) {
    o = o || {};
    root.classList.toggle('no-card', o.card_bg === false);
    root.classList.toggle('no-frame', o.frame === false);
    root.classList.toggle('keep-bg', !!o.keep_bg);
    root.style.setProperty('--embed-card-alpha', String(o.card_alpha ?? 1));
    const hide = new Set(o.hide || []);
    for (const part of PARTS) root.classList.toggle('hide-' + part, hide.has(part));
  }

  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'state' && d.data) {
      for (const fn of handlers) { try { fn(d.data); } catch (_) { /* next snapshot */ } }
    } else if (d.type === 'embed') {
      applyOptions(d.options);
    }
  });
  // Once the page's script has registered, ask the host for the current state.
  window.addEventListener('load', () => {
    try { parent.postMessage({ type: 'embed:ready' }, '*'); } catch (_) { /* no host */ }
  });
})();
