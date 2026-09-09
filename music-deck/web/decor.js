/* Decorative borders, shared by the overlay and the app.

   Two kinds:
     motifs      repeating SVG tiles (the pretty ones - pastel sakura and
                 friends). Drawn as a tiled background on each edge strip.
     characters  a short string repeated around the edge. Cheap, recolours
                 with the theme, good for terminal/arcade looks.

   Motif ids are prefixed "motif:" in the config so one field covers both. */

const BORDER_MOTIFS = {
  hand:     { label: 'Cherry blossom (hand drawn)', file: 'motif-sakura-hand.svg', tile: 104 },
  handd:    { label: 'Cherry blossom (dense)', file: 'motif-sakura-hand-dense.svg', tile: 74 },
  sakura:   { label: 'Cherry blossom (small)', file: 'motif-sakura.svg', tile: 48 },
  petals:   { label: 'Falling petals', file: 'motif-petals.svg',   tile: 48 },
  seigaiha: { label: 'Wave (seigaiha)', file: 'motif-seigaiha.svg', tile: 48 },
};

const BORDER_PATTERNS = {
  sparkle:  '✧ ⋆ ˚ ✦ ',
  stars:    '★ ☆ ⋆ ',
  hearts:   '♡ ˖ ᰔ ˖ ',
  moon:     '☾ ⋆ ✧ ',
  music:    '♪ ♫ ♬ ',
  dots:     '· • · ',
  dashes:   '─ · ',
  blocks:   '▚ ▞ ',
  arrows:   '➤ ˖ ',
  crosses:  '✕ ˖ ',
};

const KAOMOJI = [
  '', '(◕‿◕)', '(｡•̀ᴗ-)✧', '♡(˃͈ દ ˂͈ )', '(づ｡◕‿‿◕｡)づ', 'ʕ•ᴥ•ʔ',
  '٩(◕‿◕)۶', '(⁄ ⁄•⁄ω⁄•⁄ ⁄)', '(*ﾉ▽ﾉ)', '≧◡≦', '(￣ω￣)', '(╯°□°)╯',
  'ヽ(•‿•)ノ', '(ᵔᴥᵔ)', '☆*:.｡.o(≧▽≦)o.｡.:*☆',
];

/**
 * Paint a decorative frame.
 * @param {HTMLElement} root      carries the has-decor / decor-* classes
 * @param {HTMLElement} container holds the four .decor-strip nodes
 * @param {object} decor          {border, custom, sides, size, opacity, color, gap}
 * @param {string} fallbackColor  used when decor.color is blank
 */
function renderDecor(root, container, decor, fallbackColor) {
  if (!root || !container) return;
  const d = decor || {};
  const sides = d.sides || 'none';
  const custom = (d.custom || '').trim();

  const motifKey = (d.border || '').startsWith('motif:') ? d.border.slice(6) : '';
  const motif = !custom && BORDER_MOTIFS[motifKey];
  const chars = custom || (motif ? '' : BORDER_PATTERNS[d.border] || '');

  const on = (!!motif || !!chars) && sides !== 'none';
  root.classList.toggle('has-decor', on);
  root.classList.toggle('decor-motif', on && !!motif);
  for (const side of ['top', 'bottom', 'left', 'right']) {
    let show = false;
    if (on) {
      if (sides === 'all') show = true;
      else if (sides === 'tb') show = side === 'top' || side === 'bottom';
      else show = sides === side;
    }
    root.classList.toggle('decor-' + side, show);
  }
  root.classList.toggle('decor-animate', on && !!d.animate && !motif);
  // Underlay by default: the frame sits behind the card and reads as a soft
  // watermark rather than something pasted over the artwork.
  const over = d.layer === 'over';
  root.classList.toggle('decor-over', on && over);
  root.classList.toggle('decor-under', on && !over);
  if (!on) return;

  const strips = container.querySelectorAll('.decor-strip');
  if (motif) {
    // Tinted: draw the tile as a mask so the shapes take --decor-color.
    // Otherwise use the artwork's own colours.
    const tint = d.tint !== false;
    const colour = d.color || fallbackColor || '#ffffff';
    strips.forEach((strip) => {
      const vertical = strip.classList.contains('decor-left') ||
                       strip.classList.contains('decor-right');
      const repeat = vertical ? 'repeat-y' : 'repeat-x';
      // Tiles are square, so lock the cross-axis to the strip and let the
      // repeat axis follow, which keeps the blossoms round rather than oval.
      const size = vertical ? '100% auto' : 'auto 100%';
      const url = `url("${motif.file}")`;
      const st = strip.style;
      if (tint) {
        st.backgroundImage = 'none';
        st.backgroundColor = colour;
        st.webkitMaskImage = url;  st.maskImage = url;
        st.webkitMaskRepeat = repeat; st.maskRepeat = repeat;
        st.webkitMaskSize = size;  st.maskSize = size;
        st.webkitMaskPosition = 'center'; st.maskPosition = 'center';
      } else {
        st.backgroundColor = 'transparent';
        st.webkitMaskImage = 'none'; st.maskImage = 'none';
        st.backgroundImage = url;
        st.backgroundRepeat = repeat;
        st.backgroundSize = size;
        st.backgroundPosition = 'center';
      }
      const span = strip.querySelector('span');
      if (span) span.textContent = '';
    });
  } else {
    // Repeat enough to overrun the longest edge; uniform repetition also lets
    // the drift animation loop without a visible seam.
    const text = chars.repeat(60);
    strips.forEach((strip) => {
      const st = strip.style;
      st.backgroundImage = '';
      st.backgroundColor = 'transparent';
      st.webkitMaskImage = 'none'; st.maskImage = 'none';
      const span = strip.querySelector('span');
      if (span) span.textContent = text;
    });
  }

  // Custom properties inherit, so set them on the root. --decor-size stays in
  // em for the character strips (which are sized by font-size), while
  // --decor-px is the same value already resolved against the root font size:
  // an em band inside an em-sized container would otherwise compound.
  const rootPx = parseFloat(getComputedStyle(root).fontSize) || 16;
  const size = d.size ?? 0.62;
  // Motif tiles fill a band exactly `size` em thick. Character strips use
  // `size` as their font size and get a roomier box, since symbol and emoji
  // ink runs well past a one-line box and would otherwise be clipped.
  const bandPx = motif ? size * rootPx : size * rootPx * 1.55 + 4;
  const style = root.style;
  style.setProperty('--decor-size', size + 'em');
  style.setProperty('--decor-font', size + 'em');
  style.setProperty('--decor-px', bandPx.toFixed(1) + 'px');
  style.setProperty('--decor-opacity', String(d.opacity ?? 0.85));
  style.setProperty('--decor-gap', (d.gap ?? 0.5) + 'em');
  style.setProperty('--decor-color', d.color || fallbackColor || 'currentColor');
  container.style.filter = (d.blur > 0) ? 'blur(' + d.blur + 'px)' : '';
  style.setProperty('--decor-inset', String(d.inset ?? 1.0));
}

/** Options for a <select>, motifs first since they look better. */
function decorOptions(escFn) {
  const e = escFn || ((x) => x);
  const out = ['<option value="">- none -</option>'];
  for (const [key, m] of Object.entries(BORDER_MOTIFS)) {
    out.push(`<option value="motif:${key}">${e(m.label)}</option>`);
  }
  for (const key of Object.keys(BORDER_PATTERNS)) {
    out.push(`<option value="${key}">${e(key)} &nbsp; ${e(BORDER_PATTERNS[key].trim())}</option>`);
  }
  return out.join('');
}
