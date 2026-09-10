/* Awesome Music Streaming Deck - transport buttons inside a pop-out window.

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
 */
function renderTransport(host, controls, playing, enabled) {
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
               c.hover_only === false ? 1 : 0].join('|');
  if (host.dataset.key === key) return;
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

  host.className = 'transport-row place-' + (c.place || 'card') +
                   ' align-' + (c.align || 'right') +
                   ' shape-' + (c.shape || 'round') +
                   (c.hover_only === false ? ' always' : '');
  host.style.setProperty('--t-size', String(c.size ?? 1));
  host.style.setProperty('--t-opacity', String(c.opacity ?? 0.9));
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
