/* Awesome Music Streaming Deck - reading colors out of a picture.

   Two jobs. One: build a theme from an image, so a background you like can
   dress the rest of the app instead of clashing with it. Two: give the
   framing dialog somewhere to live, since both are about the same pictures.

   Everything happens in the browser on a canvas. The images are served from
   this same origin, so the canvas stays readable and nothing is uploaded
   anywhere to do it. */

const PALETTES = {};              // asset id -> derived theme, computed once

/** sRGB hex -> {h,s,l}, 0-1 except h in degrees. */
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/** The same, from channel bytes - no string in the middle. */
function rgbToHsl(r255, g255, b255) {
  const r = r255 / 255, g = g255 / 255, b = b255 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  return { h, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l };
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
                  : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

/** Relative luminance, for deciding what reads on what. */
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255);
}

/**
 * The handful of colors a picture is actually made of.
 *
 * Buckets pixels by hue and lightness rather than exact value - two pixels of
 * almost the same blue should count as the same color, or every photograph
 * comes back with a thousand of them.
 */
function extractColors(img, want = 6) {
  const N = 72;                                   // enough to judge by, cheap to read
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;

  // One pass over the pixels does both jobs: sorting them into color bins,
  // and recording the spread of brightness. Bin averages smooth away exactly
  // what the second job needs - a bin averaging light gray can still hold
  // near-black pixels, and text has to survive those, not the average.
  //
  // Brightness goes into a histogram rather than a list: we only ever read two
  // percentiles off it, and 256 buckets answers that without sorting several
  // thousand floats.
  const bins = new Map();
  const hist = new Uint32Array(256);
  let counted = 0;

  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;                // ignore transparent parts
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const { h, s, l } = rgbToHsl(r, g, b);
    // Near-neutral pixels have no meaningful hue, so keep them in one place.
    const key = s < 0.12 ? 'n' + Math.round(l * 5)
                         : Math.round(h / 24) + ':' + Math.round(l * 4);
    const bin = bins.get(key);
    if (bin) { bin.n++; bin.h += h; bin.s += s; bin.l += l; }
    else bins.set(key, { n: 1, h, s, l });

    const lu = 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
    hist[Math.min(255, Math.round(lu * 255))]++;
    counted++;
  }

  // Walk the histogram to whichever bucket holds the requested percentile.
  const at = (q) => {
    if (!counted) return 0.5;
    let want_ = q * counted, seen = 0;
    for (let i = 0; i < 256; i++) {
      seen += hist[i];
      if (seen >= want_) return i / 255;
    }
    return 1;
  };
  const range = { lo: at(0.05), hi: at(0.95) };

  const out = [...bins.values()]
    // Weight by how much of the picture it is, but let a small vivid area beat
    // a large flat one - that is what the eye picks out as "the color".
    .sort((a, b) => (b.n * (0.6 + 0.9 * (b.s / b.n))) - (a.n * (0.6 + 0.9 * (a.s / a.n))))
    .slice(0, want)
    .map((b) => ({
      hex: hslToHex(b.h / b.n, b.s / b.n, b.l / b.n),
      share: b.n,
      sat: b.s / b.n,
      light: b.l / b.n,
    }));
  out.range = range;
  return out;
}

/** One sRGB channel, 0-255, linearised for luminance. */
function srgb(v) {
  v /= 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG contrast ratio between two hexes, 1 (identical) to 21 (black/white). */
function contrastRatio(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Keep a color's hue but move its lightness until it is legible on `ground`.
 *
 * A theme taken from a photograph has no reason to be readable by itself - a
 * pale sky gives pale text on a pale panel. This walks the color away from
 * the background until it clears the bar, so every generated theme is legible
 * whatever the picture was.
 */
function legibleOn(hex, ground, target) {
  const { h, s, l } = hexToHsl(hex);
  if (contrastRatio(hex, ground) >= target) return hex;

  // Try both directions rather than guessing one from the ground's lightness:
  // a mid-tone ground is darker than it looks to that test, and committing to
  // "go lighter" there walks all the way to white and still falls short, when
  // going the other way would have cleared it easily.
  let best = hex, bestRatio = contrastRatio(hex, ground);
  for (let i = 1; i <= 20; i++) {
    for (const dir of [1, -1]) {
      const cand = hslToHex(h, s, Math.max(0, Math.min(1, l + dir * i * 0.05)));
      const r = contrastRatio(cand, ground);
      if (r > bestRatio) { best = cand; bestRatio = r; }
      if (r >= target) return cand;
    }
  }
  if (bestRatio >= target) return best;
  // No shade of this hue reaches it; plain black or white always gets closest.
  const white = contrastRatio('#ffffff', ground), black = contrastRatio('#000000', ground);
  return Math.max(white, black) > bestRatio
    ? (white > black ? '#ffffff' : '#000000') : best;
}

/**
 * How opaque the veil between a picture and the text on top of it has to be.
 *
 * The veil is painted in the theme's own ground color, so laying it over the
 * picture at opacity a gives a luminance of pic*(1-a) + ground*a. We need that
 * far enough from the text to read - measured against the worst patch of the
 * picture, not its average.
 */
function veilFor(colors, groundHex, textHex, target = 3.2) {
  const lightText = lum(textHex) > 0.4;
  // The patch that fights this text hardest: brightest for light text, darkest
  // for dark text. Measured from the picture's real range, not bin averages.
  const worst = lightText ? colors.range.hi : colors.range.lo;
  const ground = lum(groundHex), text = lum(textHex);

  for (let a = 0; a <= 0.85; a += 0.05) {
    const seen = worst * (1 - a) + ground * a;
    const ratio = (Math.max(text, seen) + 0.05) / (Math.min(text, seen) + 0.05);
    if (ratio >= target) return +a.toFixed(2);
  }
  return 0.85;
}

/** Turn those colors into a theme the whole app can wear. */
function themeFromColors(colors) {
  if (!colors.length) return null;
  const byPop = [...colors];
  // The accent wants to be the most colorful thing present, not the biggest -
  // a photo is mostly sky, and a sky-blue accent on a sky background vanishes.
  const accent = [...colors].sort((a, b) =>
    (b.sat * Math.min(1, b.share / 40)) - (a.sat * Math.min(1, a.share / 40)))[0];
  const ground = byPop[0];
  const dark = lum(ground.hex) < 0.42;

  const g = hexToHsl(ground.hex);
  const a = hexToHsl(accent.hex);
  // A picture with no real color in it - a pencil drawing, dithered black and
  // white - has no hue worth amplifying. Forcing one just turns sensor noise
  // into a vivid accent nobody chose, so stay near-neutral instead.
  const colorful = colors.some((c) => c.sat > 0.18);
  const accentHex = colorful
    ? hslToHex(a.h, Math.max(0.55, a.s), dark ? 0.62 : 0.46)
    : hslToHex(a.h, 0.10, dark ? 0.86 : 0.24);

  const bg = hslToHex(g.h, Math.min(g.s, 0.5), dark ? 0.06 : 0.95);
  const panel = hslToHex(g.h, Math.min(g.s, 0.45), dark ? 0.10 : 1.0);

  // Everything that has to be read gets checked against what it sits on:
  // 4.5:1 for body text, 3:1 for secondary text and for the accent, which
  // carries buttons. These are the WCAG thresholds and they are the difference
  // between a theme that looks nice in a swatch and one you can actually use.
  const text = legibleOn(hslToHex(g.h, 0.12, dark ? 0.96 : 0.10), panel, 4.5);
  const muted = legibleOn(hslToHex(g.h, 0.15, dark ? 0.66 : 0.40), panel, 3);
  const accentOk = legibleOn(accentHex, panel, 3);

  return {
    accent: accentOk,
    bg,
    panel,
    line: hslToHex(g.h, Math.min(g.s, 0.35), dark ? 0.20 : 0.86),
    text,
    muted,
    surround: hslToHex(g.h, Math.min(g.s, 0.5), dark ? 0.03 : 0.97),
    // How hard the picture needs knocking back for that text to survive on top
    // of it. What matters is not the picture's average brightness but its
    // extreme: white text dies on one bright cloud in an otherwise dark photo,
    // and averaging hides exactly that. So solve for the worst patch.
    veil: veilFor(colors, bg, text),
    contrast: {
      text: +contrastRatio(text, panel).toFixed(2),
      muted: +contrastRatio(muted, panel).toFixed(2),
      accent: +contrastRatio(accentOk, panel).toFixed(2),
    },
    swatches: colors.map((c) => c.hex),
  };
}

/** Derive (and remember) the theme for one stored asset. */
function paletteFor(assetId) {
  return paletteForUrl('/asset/' + encodeURIComponent(assetId), assetId);
}

/**
 * The same, for any same-origin image URL - album art lives at /smtc/art or
 * /spotify/art, not under /asset/. `key` is what the result is cached under, so
 * a caller can dedupe by track rather than by cache-busted URL.
 *
 * `in`, not truthiness: an image we could not read caches as null, and that is
 * an answer worth remembering rather than retrying on every render.
 */
function paletteForUrl(url, key) {
  const id = key || url;
  if (id in PALETTES) return Promise.resolve(PALETTES[id]);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let out = null;
      try { out = themeFromColors(extractColors(img)); } catch (_) { out = null; }
      PALETTES[id] = out;
      resolve(out);
    };
    img.onerror = () => { PALETTES[id] = null; resolve(null); };
    img.src = url;
  });
}
