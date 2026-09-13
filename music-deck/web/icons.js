/* Awesome Streaming Deck - one set of SVG glyphs for the whole app.

   Emoji render differently on every machine and font, and look by turns
   childish and broken; a streamer's overlay should not depend on which emoji
   set Windows shipped that year. These are plain paths on a 24x24 grid,
   centerd, taking `currentColor` so they follow whatever the button's text
   color is.

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
  // The layer list. These were a filled circle, a dotted circle and two
  // padlock emoji: nobody reads a dotted circle as "hidden", and the emoji
  // are exactly what the note at the top of this file warns about.
  eye:       'M2.6 12S6.6 5.8 12 5.8 21.4 12 21.4 12 17.4 18.2 12 18.2 2.6 12 2.6 12z M12 9.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z',
  eyeOff:    'M4 4l16 16 M9.9 6.1A8.9 8.9 0 0 1 12 5.8c5.4 0 9.4 6.2 9.4 6.2a17.5 17.5 0 0 1-3.5 3.9 M6.6 8.1A17.4 17.4 0 0 0 2.6 12S6.6 18.2 12 18.2c1 0 1.9-.2 2.7-.5 M10.3 10.4a2.7 2.7 0 0 0 3.5 3.5',
  lock:      'M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5 M5.8 10.5h12.4v9H5.8z',
  unlock:    'M7.5 10.5V8a4.5 4.5 0 0 1 8.7-1.6 M5.8 10.5h12.4v9H5.8z',
};

// Outlines, not solid shapes: at the size the layer list uses, a filled eye or
// padlock turns into a blob. `close` keeps the heavier stroke it always had.
const STROKED = new Set(['close', 'eye', 'eyeOff', 'lock', 'unlock']);

/** An <svg> string for one glyph, sized to fill its button. */
function svgIcon(name, opts) {
  const d = ICONS[name];
  if (!d) return '';
  const stroke = STROKED.has(name);
  const attrs = stroke
    ? `fill="none" stroke="currentColor" stroke-width="${name === 'close' ? 2 : 1.7}" ` +
      'stroke-linecap="round" stroke-linejoin="round"'
    : 'fill="currentColor"';
  return `<svg viewBox="0 0 24 24" class="glyph${opts && opts.cls ? ' ' + opts.cls : ''}" ` +
         `aria-hidden="true" ${attrs}><path d="${d}"/></svg>`;
}
