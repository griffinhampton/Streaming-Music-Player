/* Generated background artwork ("scenes").

   Every scene is drawn as SVG on the fly from a handful of parameters -
   three colours, a scale, a density, an opacity and a shuffle seed - so the
   look is yours to change and nothing is ever downloaded. Tiling scenes wrap
   at their edges so they repeat without a visible seam; "cover" scenes are a
   single picture that stretches to fill the window. */

function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f1 = (n) => Number(n).toFixed(1);

/* Draw at (x, y) and again across any edge the shape crosses, so the tile
   repeats seamlessly. r is the shape's reach from its centre. */
function wrapped(x, y, r, W, H, draw) {
  const xs = [x], ys = [y];
  if (x - r < 0) xs.push(x + W);
  if (x + r > W) xs.push(x - W);
  if (y - r < 0) ys.push(y + H);
  if (y + r > H) ys.push(y - H);
  let out = '';
  for (const xx of xs) for (const yy of ys) out += draw(xx, yy);
  return out;
}

/* Black or white, whichever can actually be read on `hex`. Buttons drawn in
   the accent need this, and the pop-outs need it as much as the deck does. */
function readableOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return L > 0.45 ? '#0a0a0c' : '#ffffff';
}

/* Mix a colour toward black (t<0) or white (t>0); hex in, hex out. */
function shade(hex, t) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v) => {
    const target = t < 0 ? 0 : 255;
    const k = Math.abs(t);
    return Math.round(v + (target - v) * k);
  };
  const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

// A cherry petal, tip up, about 13 units long, with the little notch.
const PETAL = 'M0,0 C-4.6,-2.6 -6.1,-9.1 -2.7,-12.6 C-1.7,-14 -0.9,-12.8 0,-11.2 ' +
              'C0.9,-12.8 1.7,-14 2.7,-12.6 C6.1,-9.1 4.6,-2.6 0,0 Z';
// A rounder, blobbier petal for the watercolour look.
const PETAL_SOFT = 'M0,0 C-6.2,-3.2 -8.4,-10.2 -3.4,-13.4 C-1.2,-14.8 1.2,-14.8 3.4,-13.4 ' +
                   'C8.4,-10.2 6.2,-3.2 0,0 Z';

/* ------------------------------------------------------------- scenes */

const SCENES = {
  stipple: {
    label: 'Stippled stars',
    tile: 520,
    defaults: { c1: '#0b0f1c', c2: '#cfd8ff', c3: '#7f8fd6', scale: 1, density: 1, seed: 12 },
    build(p, rnd) {
      const W = 520, H = 520;
      // Dither: a field of dots whose chance of existing rises toward the top,
      // so the sky thins out the way a printed gradient does.
      let out = `<rect width="${W}" height="${H}" fill="${p.c1}"/>`;
      const step = Math.max(4, 9 / p.scale);
      const bias = 1.15 * p.density;
      for (let y = 0; y < H; y += step) {
        const fall = 1 - (y / H);                    // denser at the top
        for (let x = 0; x < W; x += step) {
          if (rnd() > fall * fall * bias * 0.55) continue;
          const jx = x + (rnd() - 0.5) * step, jy = y + (rnd() - 0.5) * step;
          const r = (rnd() < 0.12 ? 1.9 : 0.9) * p.scale;
          const col = rnd() < 0.25 ? p.c3 : p.c2;
          out += `<circle cx="${f1(jx)}" cy="${f1(jy)}" r="${f1(r)}" fill="${col}" fill-opacity="${f1(0.35 + rnd() * 0.6)}"/>`;
        }
      }
      // A few proper four-pointed stars so it is not only noise.
      const stars = Math.max(1, Math.round(7 * p.density));
      for (let i = 0; i < stars; i++) {
        const x = rnd() * W, y = rnd() * H * 0.8;
        const s = (5 + rnd() * 7) * p.scale;
        out += wrapped(x, y, s * 2, W, H, (xx, yy) =>
          `<path d="M0,-1 C.18,-.28 .28,-.18 1,0 C.28,.18 .18,.28 0,1 C-.18,.28 -.28,.18 -1,0 C-.28,-.18 -.18,-.28 0,-1 Z"
                 transform="translate(${f1(xx)} ${f1(yy)}) scale(${f1(s)})" fill="${p.c2}" fill-opacity=".9"/>`);
      }
      return out;
    },
  },

  goo: {
    label: 'Pooled goo',
    tile: 600,
    defaults: { c1: '#050510', c2: '#3d6cf0', c3: '#8ad7ff', scale: 1, density: 1, seed: 21 },
    build(p, rnd) {
      const W = 600, H = 600;
      // Blobs blurred hard and then pushed through a steep contrast curve, which
      // is what makes separate circles read as one liquid mass.
      let out = `<defs>
        <filter id="gooey" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="${f1(13 * p.scale)}" result="b"/>
          <feColorMatrix in="b" type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -12"/>
        </filter>
        <linearGradient id="gooSheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${p.c2}"/>
          <stop offset="1" stop-color="${p.c3}"/>
        </linearGradient>
      </defs><rect width="${W}" height="${H}" fill="${p.c1}"/>`;

      const blobs = Math.max(3, Math.round(9 * p.density));
      let g = '';
      for (let i = 0; i < blobs; i++) {
        const x = rnd() * W, y = rnd() * H;
        const r = (48 + rnd() * 70) * p.scale;
        g += wrapped(x, y, r * 1.6, W, H, (xx, yy) =>
          `<circle cx="${f1(xx)}" cy="${f1(yy)}" r="${f1(r)}" fill="url(#gooSheen)"/>`);
      }
      out += `<g filter="url(#gooey)">${g}</g>`;

      // Highlights, so it reads as wet rather than flat.
      for (let i = 0; i < blobs; i++) {
        const x = rnd() * W, y = rnd() * H;
        const r = (7 + rnd() * 13) * p.scale;
        out += wrapped(x, y, r * 2, W, H, (xx, yy) =>
          `<ellipse cx="${f1(xx)}" cy="${f1(yy)}" rx="${f1(r)}" ry="${f1(r * 0.55)}"
                    fill="${shade(p.c3, 0.55)}" fill-opacity=".5"
                    transform="rotate(-28 ${f1(xx)} ${f1(yy)})"/>`);
      }
      return out;
    },
  },

  watercolor: {
    label: 'Watercolour blossoms',
    tile: 560,
    defaults: { c1: '#f6d9dc', c2: '#e39aa8', c3: '#8d4a58', scale: 1, density: 1, seed: 7 },
    build(p, rnd) {
      const W = 560, H = 560;
      const dark = shade(p.c2, -0.35);
      let out = `<defs>
        <filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.4"/></filter>
      </defs><rect width="${W}" height="${H}" fill="${p.c1}"/>`;

      // big soft blossoms, two translucent layers each so the overlaps darken
      const blossoms = Math.max(2, Math.round(4 * p.density));
      for (let i = 0; i < blossoms; i++) {
        const x = rnd() * W, y = rnd() * H;
        const r = (i === 0 ? 118 : 70 + rnd() * 60) * p.scale;
        const rot = rnd() * 360, s = r / 13;
        out += wrapped(x, y, r * 1.25, W, H, (xx, yy) => {
          let g = `<g transform="translate(${f1(xx)} ${f1(yy)}) rotate(${f1(rot)}) scale(${f1(s)})" filter="url(#soft)">`;
          for (let k = 0; k < 5; k++) g += `<path d="${PETAL_SOFT}" fill="${p.c2}" fill-opacity=".5" transform="rotate(${k * 72}) scale(1.12)"/>`;
          for (let k = 0; k < 5; k++) g += `<path d="${PETAL_SOFT}" fill="${p.c2}" fill-opacity=".42" transform="rotate(${k * 72 + 9}) scale(.92)"/>`;
          // Stamens and centre in the detail colour.
          g += `</g><g transform="translate(${f1(xx)} ${f1(yy)}) rotate(${f1(rot)}) scale(${f1(s)})" fill="none" stroke="${p.c3}" stroke-opacity=".8" stroke-width=".4" stroke-linecap="round">`;
          for (let k = 0; k < 7; k++) {
            const a = k * 51 + 12, L = 2.4 + (k % 3) * .7;
            const ex = Math.sin(a * Math.PI / 180) * L, ey = -Math.cos(a * Math.PI / 180) * L;
            g += `<path d="M${f1(ex * .3)},${f1(ey * .3)} Q${f1(ex * .8 + .4)},${f1(ey * .8)} ${f1(ex)},${f1(ey)}"/>`;
          }
          g += '</g>';
          g += `<g transform="translate(${f1(xx)} ${f1(yy)}) rotate(${f1(rot)}) scale(${f1(s)})" fill="${p.c3}">`;
          for (let k = 0; k < 7; k++) {
            const a = k * 51 + 12, L = 2.4 + (k % 3) * .7;
            const ex = Math.sin(a * Math.PI / 180) * L, ey = -Math.cos(a * Math.PI / 180) * L;
            g += `<circle cx="${f1(ex)}" cy="${f1(ey)}" r=".5"/>`;
          }
          return g + `<circle r=".9" fill-opacity=".7"/></g>`;
        });
      }
      return out;
    },
  },

  sakura: {
    label: 'Cherry blossoms',
    tile: 560,
    defaults: { c1: '#fbeff1', c2: '#f2a4bd', c3: '#e2a83c', scale: 1, density: 1, seed: 3 },
    build(p, rnd) {
      const W = 560, H = 560;
      const tip = shade(p.c2, -0.12), vein = shade(p.c2, -0.3);
      let out = `<defs>
        <radialGradient id="pg" cx="50%" cy="92%" r="88%">
          <stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="${shade(p.c2, .45)}"/><stop offset="1" stop-color="${tip}"/>
        </radialGradient>
        <radialGradient id="wash" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="${p.c2}" stop-opacity=".16"/><stop offset="1" stop-color="${p.c2}" stop-opacity="0"/>
        </radialGradient>
      </defs><rect width="${W}" height="${H}" fill="${p.c1}"/>`;
      for (let i = 0; i < 4; i++) {
        const x = rnd() * W, y = rnd() * H, r = 90 + rnd() * 120;
        out += wrapped(x, y, r, W, H, (xx, yy) => `<circle cx="${f1(xx)}" cy="${f1(yy)}" r="${f1(r)}" fill="url(#wash)"/>`);
      }

      const blossom = (xx, yy, r, rot) => {
        const s = r / 13;
        let g = `<g transform="translate(${f1(xx)} ${f1(yy)}) rotate(${f1(rot)}) scale(${f1(s)})">`;
        for (let k = 0; k < 5; k++) {
          g += `<path d="${PETAL}" fill="url(#pg)" stroke="${tip}" stroke-opacity=".5" stroke-width=".3" transform="rotate(${k * 72})"/>`;
          g += `<path d="M0,-2.4 C.25,-5.5 .25,-8.5 0,-11" fill="none" stroke="${vein}" stroke-opacity=".28" stroke-width=".26" transform="rotate(${k * 72})"/>`;
        }
        for (let k = 0; k < 10; k++) {
          const a = k * 36 + 8, L = 3 + (k % 3) * .7;
          const ex = Math.sin(a * Math.PI / 180) * L, ey = -Math.cos(a * Math.PI / 180) * L;
          g += `<line x1="0" y1="0" x2="${f1(ex)}" y2="${f1(ey)}" stroke="${shade(p.c3, -0.25)}" stroke-width=".22" stroke-opacity=".9"/>`;
          g += `<circle cx="${f1(ex)}" cy="${f1(ey)}" r=".5" fill="${p.c3}"/>`;
        }
        return g + `<circle r=".9" fill="${shade(p.c2, -0.4)}" opacity=".55"/></g>`;
      };

      const n = Math.max(3, Math.round(6 * p.density));
      for (let i = 0; i < n; i++) {
        const x = rnd() * W, y = rnd() * H, r = (48 + rnd() * 34) * p.scale, rot = rnd() * 360;
        out += wrapped(x, y, r * 1.15, W, H, (xx, yy) => blossom(xx, yy, r, rot));
      }
      // loose petals drifting between them
      const petals = Math.round(10 * p.density);
      for (let i = 0; i < petals; i++) {
        const x = rnd() * W, y = rnd() * H, r = (14 + rnd() * 12) * p.scale, rot = rnd() * 360, s = r / 13;
        out += wrapped(x, y, r, W, H, (xx, yy) =>
          `<path d="${PETAL}" fill="url(#pg)" stroke="${tip}" stroke-opacity=".45" stroke-width=".3" transform="translate(${f1(xx)} ${f1(yy)}) rotate(${f1(rot)}) scale(${f1(s)})"/>`);
      }
      return out;
    },
  },

  doodle: {
    label: 'Cute doodles',
    tile: 520,
    defaults: { c1: '#f7b8d0', c2: '#ffffff', c3: '#f27fb0', scale: 1, density: 1, seed: 11 },
    build(p, rnd) {
      const W = 520, H = 520;
      let out = `<rect width="${W}" height="${H}" fill="${p.c1}"/>`;
      const stroke = `fill="none" stroke="${p.c2}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"`;

      const star = (r) => {
        let d = '';
        for (let k = 0; k < 5; k++) {
          const a = (k * 144 - 90) * Math.PI / 180;   // pentagram order
          d += (k ? 'L' : 'M') + f1(Math.cos(a) * r) + ',' + f1(Math.sin(a) * r);
        }
        return `<path d="${d}Z" ${stroke}/>`;
      };
      const heart = (r) => `<path d="M0,${f1(r * .35)} C${f1(-r * .9)},${f1(-r * .45)} ${f1(-r * 1.1)},${f1(r * .55)} 0,${f1(r)} C${f1(r * 1.1)},${f1(r * .55)} ${f1(r * .9)},${f1(-r * .45)} 0,${f1(r * .35)} Z" ${stroke}/>`;
      const moon = (r) => `<path d="M0,${f1(-r)} A${f1(r)},${f1(r)} 0 1,1 0,${f1(r)} A${f1(r * .72)},${f1(r * .72)} 0 1,0 0,${f1(-r)} Z" fill="${p.c2}"/>`;
      const swirl = (r) => `<path d="M${f1(-r)},0 a${f1(r)},${f1(r)} 0 1,1 ${f1(r)},${f1(r)} a${f1(r * .5)},${f1(r * .5)} 0 1,1 ${f1(-r * .5)},${f1(-r * .5)}" ${stroke}/>`;
      const bunny = (r) => {
        const eye = (x) => `<path d="M${f1(x - r * .16)},0 L${f1(x + r * .16)},0 M${f1(x)},${f1(-r * .16)} L${f1(x)},${f1(r * .16)} M${f1(x - r * .11)},${f1(-r * .11)} L${f1(x + r * .11)},${f1(r * .11)} M${f1(x + r * .11)},${f1(-r * .11)} L${f1(x - r * .11)},${f1(r * .11)}" stroke="${p.c3}" stroke-width="${f1(r * .09)}" stroke-linecap="round" fill="none" transform="translate(0 ${f1(-r * .05)})"/>`;
        return `<g>
          <ellipse cx="${f1(-r * .45)}" cy="${f1(-r * 1.25)}" rx="${f1(r * .34)}" ry="${f1(r * .95)}" fill="${p.c2}" transform="rotate(-10 ${f1(-r * .45)} ${f1(-r * 1.25)})"/>
          <ellipse cx="${f1(r * .45)}" cy="${f1(-r * 1.25)}" rx="${f1(r * .34)}" ry="${f1(r * .95)}" fill="${p.c2}" transform="rotate(10 ${f1(r * .45)} ${f1(-r * 1.25)})"/>
          <circle r="${f1(r)}" fill="${p.c2}"/>
          ${eye(-r * .4)}${eye(r * .4)}
          <path d="M${f1(-r * .18)},${f1(r * .38)} q${f1(r * .18)},${f1(r * .18)} ${f1(r * .36)},0" fill="none" stroke="${p.c3}" stroke-width="${f1(r * .08)}" stroke-linecap="round"/>
        </g>`;
      };
      const word = (size) => `<text font-family="Segoe Script, Ink Free, Comic Sans MS, cursive" font-size="${f1(size)}" fill="${p.c2}" text-anchor="middle" dominant-baseline="middle">cute</text>` +
        `<path d="M${f1(size * 1.15)},${f1(-size * .35)} c-.3,-.4 -.9,-.2 -.8,.3 c.1,.4 .6,.6 .8,.9 c.2,-.3 .7,-.5 .8,-.9 c.1,-.5 -.5,-.7 -.8,-.3 z" fill="${p.c2}" transform="scale(${f1(size * .12)})"/>`;

      const kinds = ['bunny', 'star', 'heart', 'moon', 'swirl', 'word', 'star', 'heart', 'bunny', 'tiny'];
      const n = Math.round(24 * p.density);
      for (let i = 0; i < n; i++) {
        const kind = kinds[Math.floor(rnd() * kinds.length)];
        const x = rnd() * W, y = rnd() * H, rot = (rnd() - .5) * 50;
        let r, body;
        if (kind === 'bunny')      { r = (16 + rnd() * 10) * p.scale; body = bunny(r); }
        else if (kind === 'star')  { r = (10 + rnd() * 12) * p.scale; body = star(r); }
        else if (kind === 'heart') { r = (8 + rnd() * 9) * p.scale;   body = heart(r); }
        else if (kind === 'moon')  { r = (9 + rnd() * 6) * p.scale;   body = moon(r); }
        else if (kind === 'swirl') { r = (5 + rnd() * 4) * p.scale;   body = swirl(r); }
        else if (kind === 'word')  { r = (20 + rnd() * 8) * p.scale;  body = word(r); }
        else                       { r = 4 * p.scale; body = `<circle r="${f1(r * .5)}" fill="${p.c2}"/>`; }
        const reach = kind === 'bunny' ? r * 2.4 : kind === 'word' ? r * 1.6 : r * 1.2;
        out += wrapped(x, y, reach, W, H, (xx, yy) =>
          `<g transform="translate(${f1(xx)} ${f1(yy)}) rotate(${f1(rot)})" opacity=".92">${body}</g>`);
      }
      return out;
    },
  },

  moon: {
    label: 'Red moon',
    cover: true, tile: 1000,
    defaults: { c1: '#1a0a1f', c2: '#e8203e', c3: '#c0112e', scale: 1, density: 1, seed: 1 },
    build(p) {
      const W = 1000, H = 560;
      const r = 150 * p.scale, cx = 690, cy = 300;
      const ridge = [[-1.15, .55], [-.9, .05], [-.7, .28], [-.5, .0], [-.32, .18], [-.15, -.35],
                     [.05, -.05], [.22, -.2], [.4, .05], [.55, -.08], [.7, .12], [.85, .02], [1.15, .55]];
      const pts = ridge.map(([u, v]) => `${f1(cx + u * r)},${f1(cy + v * r)}`).join(' ');
      return `<rect width="${W}" height="${H}" fill="${p.c1}"/>
        <defs><clipPath id="disc"><circle cx="${cx}" cy="${cy}" r="${f1(r)}"/></clipPath></defs>
        <circle cx="${cx}" cy="${cy}" r="${f1(r)}" fill="${p.c2}"/>
        <circle cx="${f1(cx - r * .42)}" cy="${f1(cy - r * .4)}" r="${f1(r * .16)}" fill="${p.c3}"/>
        <polygon points="${pts} ${f1(cx + 1.2 * r)},${f1(cy + 1.3 * r)} ${f1(cx - 1.2 * r)},${f1(cy + 1.3 * r)}" fill="${p.c1}" clip-path="url(#disc)"/>`;
    },
  },

  embers: {
    label: 'Embers',
    cover: true, tile: 1600,
    defaults: { c1: '#0a0304', c2: '#4c0b0f', c3: '#ff2a3a', scale: 1, density: 1, seed: 5 },
    build(p, rnd) {
      const W = 1600, H = 900;
      let out = `<defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${p.c1}"/><stop offset=".55" stop-color="${p.c1}"/><stop offset="1" stop-color="${p.c2}"/>
        </linearGradient>
        <radialGradient id="glow" cx="18%" cy="100%" r="60%">
          <stop offset="0" stop-color="${p.c3}" stop-opacity=".38"/><stop offset="1" stop-color="${p.c3}" stop-opacity="0"/>
        </radialGradient>
        <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>`;
      const n = Math.round(190 * p.density);
      for (let i = 0; i < n; i++) {
        const y = H * (1 - Math.pow(rnd(), 1.7)), x = rnd() * W;
        const s = (1.5 + rnd() * 6) * p.scale, a = rnd() * 360, o = .45 + rnd() * .55;
        const shape = rnd() < .3
          ? `<polygon points="0,${f1(-s)} ${f1(s * .9)},${f1(s * .5)} ${f1(-s * .7)},${f1(s * .6)}"/>`
          : `<polygon points="${f1(-s)},0 ${f1(-s * .3)},${f1(-s * .55)} ${f1(s)},${f1(-s * .1)} ${f1(s * .2)},${f1(s * .6)}"/>`;
        const glowy = rnd() < .18;
        out += `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(a)})" fill="${p.c3}" fill-opacity="${f1(o)}"${glowy ? ' filter="url(#blur)"' : ''}>${shape}</g>`;
      }
      return out;
    },
  },
};

/* ------------------------------------------------------------- render */

const _sceneCache = new Map();

/**
 * @returns {{image, size, repeat, base}|null} CSS pieces for the background
 */
function renderScene(id, params) {
  const scene = SCENES[id];
  if (!scene) return null;
  const p = Object.assign({}, scene.defaults, params || {});
  const key = id + JSON.stringify(p);
  if (_sceneCache.has(key)) return _sceneCache.get(key);

  const rnd = mulberry32((Number(p.seed) || 1) * 7919);
  const W = scene.cover ? (id === 'moon' ? 1000 : 1600) : scene.tile;
  const H = scene.cover ? (id === 'moon' ? 560 : 900) : scene.tile;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${scene.build(p, rnd)}</svg>`;
  const out = {
    image: `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`,
    size: scene.cover ? 'cover' : `${Math.round(scene.tile * (p.tile_scale || 1))}px ${Math.round(scene.tile * (p.tile_scale || 1))}px`,
    repeat: scene.cover ? 'no-repeat' : 'repeat',
    base: p.c1,
  };
  if (_sceneCache.size > 40) _sceneCache.clear();
  _sceneCache.set(key, out);
  return out;
}

/** Apply a scene to an element as its background. */
function paintScene(el, id, params) {
  const r = renderScene(id, params);
  if (!r) return false;
  el.style.backgroundImage = r.image;
  el.style.backgroundSize = r.size;
  el.style.backgroundRepeat = r.repeat;
  el.style.backgroundPosition = 'center';
  el.style.backgroundColor = r.base;
  return true;
}


/** Config -> render params, leaving blanks so the scene's own colours apply. */
function sceneParams(cfg) {
  const p = {};
  const c = cfg || {};
  for (const k of ['c1', 'c2', 'c3']) if (c[k]) p[k] = c[k];
  for (const k of ['scale', 'density', 'tile_scale', 'seed']) {
    if (c[k] !== undefined && c[k] !== null && c[k] !== '') p[k] = Number(c[k]);
  }
  return p;
}

/**
 * Paint the same background config inside the card instead of the stage - used
 * when a solid "surround" colour fills the window around the card.
 */
function applyBackgroundInside(stage, cardBg, bg) {
  applyBackground(stage, cardBg, bg, (k, v) => {
    if (k !== '--bg') return;
    cardBg.style.background = v;
    // Also publish it, so the dimming veil can be this theme's own ground
    // colour rather than flat black.
    stage.style.setProperty('--bg', v);
  });
  stage.classList.remove('has-bg-image');   // artwork lives in the card now
  stage.style.setProperty('--bg-dim', String((bg || {}).dim ?? 0));
}

/* Natural proportions of each picture, measured once. Zooming past "cover"
   needs to know whether the picture is wider or taller than the box it is
   going into, and that is the only way to find out. */
const IMG_AR = {};
function imageAspect(id) {
  if (IMG_AR[id] !== undefined) return IMG_AR[id];
  IMG_AR[id] = null;                              // in flight
  const im = new Image();
  im.onload = () => { IMG_AR[id] = im.naturalWidth / Math.max(1, im.naturalHeight); };
  im.onerror = () => { IMG_AR[id] = 1; };
  im.src = '/asset/' + encodeURIComponent(id);
  return null;
}

/**
 * Paint a background config (solid / gradient / image / scene) onto a stage:
 * --bg carries the flat colour or gradient, `layer` carries any artwork.
 */
function applyBackground(stage, layer, bg, setVar) {
  bg = bg || {};
  const isScene = bg.mode === 'scene' && bg.scene && bg.scene.id && SCENES[bg.scene.id];
  const isImage = bg.mode === 'image' && !!bg.image;

  if (bg.mode === 'gradient') {
    setVar('--bg', `linear-gradient(${bg.angle ?? 135}deg, ${bg.color || '#0f0f17'}, ${bg.color2 || '#241a3d'})`);
  } else if (isScene) {
    setVar('--bg', renderScene(bg.scene.id, sceneParams(bg.scene)).base);
  } else {
    setVar('--bg', bg.color || '#0f0f17');
  }

  stage.classList.toggle('has-bg-image', !!(isScene || isImage));
  if (isScene) {
    paintScene(layer, bg.scene.id, sceneParams(bg.scene));
  } else if (isImage) {
    // Measure before writing: reading layout straight after a style write on
    // the same element forces a synchronous reflow, and this runs on every
    // frame while a slider is dragged.
    const box = layer.getBoundingClientRect();
    layer.style.backgroundColor = '';
    const url = `url("/asset/${encodeURIComponent(bg.image)}")`;
    const fit = bg.fit || 'cover';
    let size = fit === 'stretch' ? '100% 100%' : fit === 'tile' ? 'auto' : fit;
    // Zoom only means anything on top of cover/contain, where the picture is
    // scaled to the box: past 1 it crops in, which is what the framing dialog
    // is for.
    const z = Math.max(1, Number(bg.zoom) || 1);
    if (z > 1 && (fit === 'cover' || fit === 'contain')) {
      const ar = imageAspect(bg.image);
      const boxAR = box.width / Math.max(1, box.height);
      const pct = (z * 100).toFixed(1) + '%';
      if (ar === null) size = fit;                // repaint once it is measured
      else if ((ar > boxAR) === (fit === 'cover')) size = 'auto ' + pct;
      else size = pct + ' auto';
    }
    const repeat = bg.fit === 'tile' ? 'repeat' : 'no-repeat';
    // Which part of the picture ends up on screen; each window can differ.
    const pos = `${bg.pos_x ?? 50}% ${bg.pos_y ?? 50}%`;

    const tint = bg.tint || {};
    if (tint.on) {
      // A duotone, the way a two-ink print works: the picture keeps its light
      // and shade, the gradient supplies the colour. `background-blend-mode:
      // color` does exactly that in one element, so it works the same whether
      // the picture is on the stage or inside the card.
      const k = Math.max(0, Math.min(1, tint.strength ?? 1));
      const ink = (c, fallback) =>
        `color-mix(in srgb, ${c || fallback} ${(k * 100).toFixed(0)}%, transparent)`;
      layer.style.backgroundImage =
        `linear-gradient(${tint.angle ?? 135}deg, ` +
        `${ink(tint.c1, '#2a2a3a')}, ${ink(tint.c2, '#8b5cf6')}), ${url}`;
      layer.style.backgroundSize = `100% 100%, ${size}`;
      layer.style.backgroundRepeat = `no-repeat, ${repeat}`;
      layer.style.backgroundPosition = `0 0, ${pos}`;
      layer.style.backgroundBlendMode = 'color, normal';
    } else {
      layer.style.backgroundImage = url;
      layer.style.backgroundSize = size;
      layer.style.backgroundRepeat = repeat;
      layer.style.backgroundPosition = pos;
      layer.style.backgroundBlendMode = '';
    }
  } else {
    layer.style.backgroundBlendMode = '';
  }
  // Blur samples past the edges, so grow the layer to avoid soft borders.
  layer.style.filter = bg.blur ? `blur(${bg.blur}px)` : 'none';
  layer.style.inset = bg.blur ? `-${Math.ceil(bg.blur * 2)}px` : '0';
}
