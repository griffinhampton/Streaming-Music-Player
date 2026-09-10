/* Awesome Streaming Deck - transport buttons inside a pop-out window.

   Shared by all three windows so a Next button behaves the same wherever you
   put it. The buttons drive whatever is playing through /api/transport, which
   sorts out Spotify-versus-local at the server; the window never needs to know.

   By default they are hidden until the mouse is over the window, because these
   are for the streamer to press on their own screen - not part of the picture
   the audience sees. */

const TRANSPORT_ICONS = {
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14L8 12zM6 5h2v14H6z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14l10-7zM16 5h2v14h-2z"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h4v15H7zM13 4.5h4v15h-4z"/></svg>',
};

/**
 * Draw (or clear) the transport row for one window.
 *
 * @param {HTMLElement} host      where the row lives
 * @param {object}      controls  the window's `controls` config block
 * @param {boolean}     playing   which way round the play/pause icon goes
 * @param {boolean}     enabled   false when the window is set to be inert
 * @param {object}      [refs]    parts of the window the row can line up with
 *                                instead of the window itself:
 *                                {progress: {box, line}, art: element}
 */
function renderTransport(host, controls, playing, enabled, refs) {
  if (!host) return;
  const c = controls || {};
  const on = !!c.show && enabled;
  host.hidden = !on;
  if (!on) {
    if (host.innerHTML) { host.innerHTML = ''; host.dataset.key = ''; host.dataset.buttons = ''; }
    return;
  }

  const want = [
    c.prev !== false && 'prev',
    c.play !== false && 'play',
    c.next !== false && 'next',
  ].filter(Boolean);

  // Nothing here changes between most ticks, and this runs on every state
  // broadcast, so compare first and do nothing when nothing moved. Rebuilding
  // the buttons would also kill the press animation mid-click.
  const shape = c.shape || 'round';
  const key = [want.join(','), playing ? 1 : 0, shape, c.place || 'card',
               c.align || 'right', c.size ?? 1, c.opacity ?? 0.9,
               c.hover_only === false ? 1 : 0,
               c.anchor || '', c.relative_to || '', c.offset?.x || 0, c.offset?.y || 0].join('|');
  if (host.dataset.key === key) {
    // Nothing about the buttons changed, but what they line up with may have
    // moved - the cover resized, the bar appeared - so place them again.
    placeRelative(host, c, refs);
    return;
  }
  const rebuild = host.dataset.buttons !== want.join(',') + '|' + (playing ? 1 : 0) + '|' + shape;
  host.dataset.key = key;

  if (rebuild) {
    host.dataset.buttons = want.join(',') + '|' + (playing ? 1 : 0) + '|' + shape;
    host.innerHTML = want.map((k) => {
      const icon = k === 'play' ? (playing ? TRANSPORT_ICONS.pause : TRANSPORT_ICONS.play)
                                : TRANSPORT_ICONS[k];
      const label = k === 'play' ? (playing ? 'Pause' : 'Play') : k === 'prev' ? 'Previous' : 'Next';
      return `<button class="tbtn tbtn-${k}" data-cmd="${k === 'play' ? 'playpause' : k}"
                      title="${label}" aria-label="${label}">${icon}</button>`;
    }).join('');
  }

  // Anchored placement pins the row to a window edge (fixed), independent of
  // where it sits in the DOM. Legacy place/align stay untouched when unset.
  const anchor = c.anchor || '';
  if (anchor) {
    // The ay-/ax- edge classes are placeRelative's to set: it knows whether
    // the row lines up with the window or with a part of it.
    host.className = 'transport-row anchored shape-' + shape +
                     (c.hover_only === false ? ' always' : '');
    host.style.setProperty('--t-dx', String((c.offset && c.offset.x) || 0));
    host.style.setProperty('--t-dy', String((c.offset && c.offset.y) || 0));
  } else {
    host.className = 'transport-row place-' + (c.place || 'card') +
                     ' align-' + (c.align || 'right') +
                     ' shape-' + shape +
                     (c.hover_only === false ? ' always' : '');
  }
  host.style.setProperty('--t-size', String(c.size ?? 1));
  host.style.setProperty('--t-opacity', String(c.opacity ?? 0.9));
  placeRelative(host, c, refs);
}

/* An anchored row lines up with the whole window by default, or with part of
   it: the progress bar, or the cover. The anchor grid keeps its meaning
   either way - left, center and right follow that part's own edges; for the
   bar, top and bottom sit just above and just below it, and middle sits on
   it; for the cover, all nine positions are inside it. Anything it cannot
   see (the bar switched off, no cover in this layout) falls back to the
   window, so the buttons never vanish. */
function placeRelative(host, c, refs) {
  const anchor = c.anchor || '';
  const edges = ['ay-t', 'ay-m', 'ay-b', 'ax-l', 'ax-c', 'ax-r'];
  if (!anchor) {
    host.classList.remove('rel');
    host.style.left = host.style.top = '';
    return;
  }
  const want = (refs && c.relative_to && refs[c.relative_to]) || null;
  const ref = want && (want.box || want);
  const box = ref && ref.offsetParent !== null ? ref.getBoundingClientRect() : null;
  if (!box || box.width < 4 || box.height < 2) {
    host.classList.remove('rel');
    host.style.left = host.style.top = '';
    edges.forEach((k) => host.classList.toggle(k, k === 'ay-' + anchor[0] || k === 'ax-' + anchor[1]));
    return;
  }
  host.classList.add('rel');
  edges.forEach((k) => host.classList.remove(k));

  const w = host.offsetWidth, h = host.offsetHeight;
  const gap = parseFloat(getComputedStyle(host).fontSize) * 0.45;
  const [v, u] = anchor;
  let x, y;
  if (c.relative_to === 'art') {
    x = u === 'l' ? box.left + gap : u === 'r' ? box.right - w - gap : box.left + (box.width - w) / 2;
    y = v === 't' ? box.top + gap : v === 'b' ? box.bottom - h - gap : box.top + (box.height - h) / 2;
  } else {
    const line = (want.line || ref).getBoundingClientRect();
    x = u === 'l' ? line.left : u === 'r' ? line.right - w : line.left + (line.width - w) / 2;
    y = v === 't' ? line.top - h - gap : v === 'b' ? box.bottom + gap : line.top + (line.height - h) / 2;
  }
  // The row is position: fixed, and a transformed ancestor would move where
  // "fixed" starts from. Place it, see where it actually landed, and correct
  // by the difference; the drag offset rides on top as a transform.
  const dx = +((c.offset && c.offset.x) || 0), dy = +((c.offset && c.offset.y) || 0);
  host.style.left = x + 'px';
  host.style.top = y + 'px';
  const got = host.getBoundingClientRect();
  const ex = got.left - dx - x, ey = got.top - dy - y;
  if (Math.abs(ex) > 0.5 || Math.abs(ey) > 0.5) {
    host.style.left = (x - ex) + 'px';
    host.style.top = (y - ey) + 'px';
  }
}

/** Wire a transport row once. `isEnabled` is asked afresh on every press. */
function wireTransport(host, isEnabled) {
  if (!host) return;
  host.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn || e.button !== 0) return;
    // The window drags by its body, so a press on a button must not start one.
    e.stopPropagation();
    e.preventDefault();
    if (!isEnabled()) return;
    btn.classList.add('busy');
    fetch('/api/transport', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: btn.dataset.cmd }),
    }).then((r) => r.json())
      .catch(() => {})
      .then(() => setTimeout(() => btn.classList.remove('busy'), 250));
  });
}
