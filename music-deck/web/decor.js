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
  root.classList.toggle('decor-animate', on && !!d.animate);
  // Underlay by default: the frame sits behind the card and reads as a soft
  // watermark rather than something pasted over the artwork.
  const over = d.layer === 'over';
  root.classList.toggle('decor-over', on && over);
  root.classList.toggle('decor-under', on && !over);
  if (!on) return;

  const rootPx = parseFloat(getComputedStyle(root).fontSize) || 16;
  const size = d.size ?? 0.62;
  const bandPx = motif ? size * rootPx : size * rootPx * 1.55 + 4;

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
      // Tiles are square, so lock the cross-axis to the strip; `gap` then
      // stretches the repeat axis to space the motifs out. Resolved to px:
      // background-size rejects a calc() that references a variable.
      const tile = (bandPx * (1 + Math.max(0, d.gap ?? 0.5))).toFixed(1) + 'px';
      const size = vertical ? `100% ${tile}` : `${tile} 100%`;
      const url = `url("${motif.file}")`;

      // The pattern goes on the inner span, not the strip. The span is twice
      // the length of the strip, so sliding it half its length scrolls the
      // motifs seamlessly - and that works whether the pattern is a background
      // or a mask. Animating background-position would do nothing when tinted,
      // because then the shapes come from the mask.
      const span = strip.querySelector('span');
      if (!span) return;
      span.textContent = '';
      const st = span.style;
      strip.style.backgroundImage = 'none';
      strip.style.backgroundColor = 'transparent';
      st.width = vertical ? '100%' : '200%';
      st.height = vertical ? '200%' : '100%';
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
    });
  } else {
    // Repeat enough to overrun the longest edge; uniform repetition also lets
    // the drift animation loop without a visible seam.
    const text = chars.repeat(60);
    strips.forEach((strip) => {
      strip.style.backgroundImage = '';
      strip.style.backgroundColor = 'transparent';
      const span = strip.querySelector('span');
      if (!span) return;
      const st = span.style;
      st.backgroundImage = 'none';
      st.backgroundColor = 'transparent';
      st.webkitMaskImage = 'none'; st.maskImage = 'none';
      st.width = ''; st.height = '';
      span.textContent = text;
    });
  }

  // Custom properties inherit, so set them on the root. --decor-size stays in
  // em for the character strips (which are sized by font-size), while
  // --decor-px is the same value already resolved against the root font size:
  // an em band inside an em-sized container would otherwise compound.
  // Motif tiles fill a band exactly `size` em thick; character strips use
  // `size` as their font size and get a roomier box, since symbol and emoji
  // ink runs well past a one-line box and would otherwise be clipped.
  const style = root.style;
  style.setProperty('--decor-size', size + 'em');
  style.setProperty('--decor-font', size + 'em');
  style.setProperty('--decor-px', bandPx.toFixed(1) + 'px');
  style.setProperty('--decor-opacity', String(d.opacity ?? 0.85));
  style.setProperty('--decor-gap', (d.gap ?? 0.5) + 'em');
  style.setProperty('--decor-color', d.color || fallbackColor || 'currentColor');
  container.style.filter = (d.blur > 0) ? 'blur(' + d.blur + 'px)' : '';
  style.setProperty('--decor-inset', String(d.inset ?? 1.0));
  // Seconds for one full pass around an edge. Higher speed = shorter time.
  const speed = Math.max(0.05, Number(d.speed ?? 1));
  style.setProperty('--decor-time', (24 / speed).toFixed(2) + 's');
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
