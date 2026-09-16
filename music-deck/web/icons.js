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
  // A layer under TikTok's controls. Solid with the mark punched out of it:
  // at 13 px on an amber chip an outlined triangle holding a separate
  // exclamation turns to mush, where a hole stays a hole.
  warn:      'M12 2.9 22.6 20.6H1.4Z M11 8.9h2v5.6h-2z M11 16.1h2v2.1h-2z',
  // "You, talking" - the PNGtuber layer, in the Add list and the layer list.
  // Somebody with sound coming off them: the head and shoulders read at 14 px
  // where a face with a mouth in it does not, and the two arcs are what says
  // this one is about talking rather than being another camera.
  talk:      'M9.5 4.4a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z M3.4 19.6c0-3.2 2.7-4.9 6.1-4.9s6.1 1.7 6.1 4.9 M17.6 9.4a4 4 0 0 1 0 5.2 M20.2 7.2a7.2 7.2 0 0 1 0 9.6',
  // The audio panel's button, and the microphone layer's mark in the layer
  // list: the capsule, its cradle and the stand, which is the shape everybody
  // already reads as a microphone at 14 px.
  mic:       'M12 3.2a2.6 2.6 0 0 0-2.6 2.6v4.9a2.6 2.6 0 0 0 5.2 0V5.8A2.6 2.6 0 0 0 12 3.2z M7 10.4a5 5 0 0 0 10 0 M12 15.4v3.2 M9.2 18.6h5.6',
  // Undo and redo: the editor's top bar had the bare characters U+21BA and
  // U+21BB, whose only explanation was a hover tooltip - and which are the same
  // family of typed glyph this file exists to get rid of.
  undo:      'M5 9h8.5a5.5 5.5 0 1 1 0 11H9 M5 9l4-4 M5 9l4 4',
  redo:      'M19 9h-8.5a5.5 5.5 0 1 0 0 11H15 M19 9l-4-4 M19 9l-4 4',
  // "Back to the theme color", beside a color swatch. The deck has drawn this
  // for a while, but as a CSS mask in deck.css - which the Canvas Builder does
  // not load, so its cloned copies of those buttons showed the raw character.
  // Same artwork, in the one place glyphs are meant to live.
  reset:     'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  // The layer list's kinds. These were the typed characters T, and then a run
  // of geometric shapes and dingbats - two of which meant the same thing in
  // different columns, and none of which said what it was. Outlines, because
  // this list draws them at 14 px.
  tText:     'M5 6.5h14 M12 6.5v11',
  tImage:    'M3.5 5.5h17v13h-17z M3.5 15.5l5-5 4 4 3-3 5 5 M9.4 9.6a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0',
  tShape:    'M3.5 9.5h8.5v8.5H3.5z M14.6 4.6a4.9 4.9 0 1 1 0 9.8 4.9 4.9 0 0 1 0-9.8',
  tWindow:   'M3.5 5.5h17v13h-17z M3.5 9.6h17 M6 7.5h.01 M8.4 7.5h.01',
  tCamera:   'M3.5 7.5h11v9h-11z M14.5 11.2l6-3v7.6l-6-3 M7 12a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 0 0-3.8 0',
  tScreen:   'M3.5 5.5h17v10h-17z M12 15.5v3.4 M8.6 18.9h6.8',
  tFill:     'M3.5 5.5h17v13h-17z M3.5 18.5 20.5 5.5 M3.5 12 10 5.5 M10 18.5l10.5-10.5',
};

// Outlines, not solid shapes: at the size the layer list uses, a filled eye or
// padlock turns into a blob. `close` keeps the heavier stroke it always had.
// (`mic` belongs here and was left out when it was added in S7, so the layer
// list drew a filled blob where a microphone was meant to be.)
const STROKED = new Set(['close', 'eye', 'eyeOff', 'lock', 'unlock', 'talk', 'mic', 'undo', 'redo',
                         'tText', 'tImage', 'tShape', 'tWindow', 'tCamera', 'tScreen', 'tFill']);
// Filled, but with the inner shapes cut out rather than drawn over the top -
// so a warning keeps its mark whatever color it is laid on.
const EVENODD = new Set(['warn']);

/** An <svg> string for one glyph, sized to fill its button. */
function svgIcon(name, opts) {
  const d = ICONS[name];
  if (!d) return '';
  const stroke = STROKED.has(name);
  const attrs = stroke
    ? `fill="none" stroke="currentColor" stroke-width="${name === 'close' ? 2 : 1.7}" ` +
      'stroke-linecap="round" stroke-linejoin="round"'
    : `fill="currentColor"${EVENODD.has(name) ? ' fill-rule="evenodd"' : ''}`;
  return `<svg viewBox="0 0 24 24" class="glyph${opts && opts.cls ? ' ' + opts.cls : ''}" ` +
         `aria-hidden="true" ${attrs}><path d="${d}"/></svg>`;
}
