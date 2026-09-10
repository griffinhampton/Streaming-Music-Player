/* Awesome Music Streaming Deck - one set of SVG glyphs for the whole app.

   Emoji render differently on every machine and font, and look by turns
   childish and broken; a streamer's overlay should not depend on which emoji
   set Windows shipped that year. These are plain paths on a 24x24 grid,
   centred, taking `currentColor` so they follow whatever the button's text
   colour is.

   Loaded before deck.js and before each window's own script, so `ICONS` and
   `svgIcon()` are available everywhere. */

const ICONS = {
  play:      'M8 5.14v13.72a1 1 0 0 0 1.54.84l10.76-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z',
  pause:     'M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z',
  prev:      'M7 6a1 1 0 0 1 2 0v4.4l8.5-5.24A1 1 0 0 1 19 6v12a1 1 0 0 1-1.5.84L9 13.6V18a1 1 0 0 1-2 0z',
  next:      'M17 6a1 1 0 0 0-2 0v4.4L6.5 5.16A1 1 0 0 0 5 6v12a1 1 0 0 0 1.5.84L15 13.6V18a1 1 0 0 0 2 0z',
  // Material Design's shuffle and repeat - the shapes people already know.
  shuffle:   'M10.6 8.7 6.4 4.5 5 5.9l4.2 4.2zM14.5 5l1.8 1.8L4 19.1 5.4 20.5 17.7 8.2 19.5 10V5zM14.1 13.3l-1.4 1.4 3.6 3.6L14.5 20h5v-5l-1.8 1.8z',
  repeat:    'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z',
  repeatOne: 'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2zm-4.6-2.5v-4.3h-.9l-1.5.6v1l1.3-.5v3.2z',
  volume:    'M4 9v6h3.5L12 19V5L7.5 9zm11.5 3a3.5 3.5 0 0 0-2-3.16v6.32A3.5 3.5 0 0 0 15.5 12zm-2-6.7v1.5a5.5 5.5 0 0 1 0 10.4v1.5a7 7 0 0 0 0-13.4z',
  up:        'M12 6l6 7h-4v5h-4v-5H6z',
  down:      'M12 18l-6-7h4V6h4v5h4z',
  close:     'M6 6l12 12M18 6L6 18',      // stroked, not filled
};

/** An <svg> string for one glyph, sized to fill its button. */
function svgIcon(name, opts) {
  const d = ICONS[name];
  if (!d) return '';
  const stroke = name === 'close';
  const attrs = stroke
    ? 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
    : 'fill="currentColor"';
  return `<svg viewBox="0 0 24 24" class="glyph${opts && opts.cls ? ' ' + opts.cls : ''}" ` +
         `aria-hidden="true" ${attrs}><path d="${d}"/></svg>`;
}
