/* The host side of embed mode: component pages inside a scene.

   A scene holds ONE state feed and passes every snapshot on to its embedded
   component pages by postMessage - Chrome allows six connections per host,
   and four components with a feed each would spend them. A child says when
   it is ready and gets the latest snapshot at once. A component can follow
   the deck's global design or carry a design of its own for this scene. */
const EmbedHost = (() => {
  const PAGES = { np: 'nowplaying.html', lyrics: 'lyrics.html', queue: 'queue.html', captions: 'captions.html' };
  // Which snapshot field each component reads its design from.
  const DESIGN_KEY = { np: 'nowplaying', lyrics: 'lyrics_cfg', queue: 'queue_cfg', captions: 'captions_cfg' };
  const hosts = new Set();
  let last = null;

  function merge(base, over) {
    if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
    const out = Object.assign({}, base || {});
    for (const k of Object.keys(over)) out[k] = merge(base ? base[k] : undefined, over[k]);
    return out;
  }

  function create(container, spec) {
    const page = PAGES[spec.component];
    if (!page) return null;
    const frame = document.createElement('iframe');
    frame.className = 'embed';
    frame.setAttribute('allow', 'autoplay');
    frame.src = '/' + page + '?embed=1';
    container.appendChild(frame);
    const h = {
      frame, spec: Object.assign({}, spec), ready: false,
      send(msg) { try { frame.contentWindow.postMessage(msg, '*'); } catch (_) { /* gone */ } },
      push(state) {
        const key = DESIGN_KEY[h.spec.component];
        const design = h.spec.design || {};
        const out = design.mode === 'custom' && design.custom
          ? Object.assign({}, state, { [key]: merge(state[key], design.custom) })
          : state;
        h.send({ type: 'state', data: out });
      },
      setOptions(options) { h.spec.options = options; h.send({ type: 'embed', options: options || {} }); },
      setDesign(design) { h.spec.design = design; if (last && h.ready) h.push(last); },
      destroy() { hosts.delete(h); frame.remove(); },
    };
    hosts.add(h);
    return h;
  }

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'embed:ready') return;
    for (const h of hosts) {
      if (h.frame.contentWindow !== e.source) continue;
      h.ready = true;
      h.send({ type: 'embed', options: h.spec.options || {} });
      if (last) h.push(last);
    }
  });

  function broadcast(state) {
    last = state;
    for (const h of hosts) if (h.ready) h.push(state);
  }

  return { create, broadcast, count: () => hosts.size };
})();
