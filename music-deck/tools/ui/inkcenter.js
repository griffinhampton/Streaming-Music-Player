// Is every mark in a button actually in the middle of it?
//   node inkcenter.js <devtools port> [rig port] [tolerance px]
//
// Measuring the icon element against the button only catches layout: a glyph
// sits in a line box that is itself perfectly centered while the ink inside
// that box is not, which is exactly how an emoji looks wrong in a centered
// circle. So this measures ink. Each mark is screenshotted, the dominant color
// in the shot is taken as its own fill, and everything far enough from that is
// ink; the middle of the ink is compared with the middle of the box.
//
// The clip is inset by the computed border width, or an element's own border
// counts as ink and every reading comes out perfect.
//
// The first version of this selected `button, [role="button"], summary` and
// reported 21 of 21 centered - a false all-clear. The two marks it was written
// to catch are a <div class="zone-badge"> and a <span class="row-warn">, and
// neither is a button; both also only exist on a phone scene with a layer under
// TikTok's comments, the reset dots live inside a collapsed <details>, and the
// align bar needs a layer selected. So marks are chosen by shape rather than by
// tag, the page is arranged so they exist, and coverage is printed - a narrow
// sweep must not be able to look like a pass.
const zlib = require('zlib');
const [port, rigPort = '8799', tolArg] = process.argv.slice(2);
const TOL = Number(tolArg || 1);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 300000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, body) => (await fetch(RIG + path, body
  ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  : undefined)).json();

async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const page = { ws, id: 0, pending: new Map() };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && page.pending.has(m.id)) { page.pending.get(m.id)(m); page.pending.delete(m.id); }
  };
  page.send = (method, params = {}) => new Promise((r) => { const i = ++page.id; page.pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  page.ev = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0]);
    return r.result.result.value;
  };
  await page.send('Runtime.enable');
  return page;
}

/* A PNG to {w, h, ch, px}. zlib is in node; nothing here decodes images. */
function decode(b64) {
  const data = Buffer.from(b64, 'base64');
  let pos = 8, idat = [], w = 0, h = 0, ct = 6;
  while (pos < data.length) {
    const ln = data.readUInt32BE(pos);
    const typ = data.toString('ascii', pos + 4, pos + 8);
    if (typ === 'IHDR') { w = data.readUInt32BE(pos + 8); h = data.readUInt32BE(pos + 12); ct = data[pos + 17]; }
    else if (typ === 'IDAT') idat.push(data.subarray(pos + 8, pos + 8 + ln));
    pos += 12 + ln;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++];
    const line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    if (f === 1) for (let x = ch; x < stride; x++) line[x] = (line[x] + line[x - ch]) & 255;
    else if (f === 2) for (let x = 0; x < stride; x++) line[x] = (line[x] + prev[x]) & 255;
    else if (f === 3) for (let x = 0; x < stride; x++) line[x] = (line[x] + (((x >= ch ? line[x - ch] : 0) + prev[x]) >> 1)) & 255;
    else if (f === 4) for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, bb = prev[x], c = x >= ch ? prev[x - ch] : 0;
      const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c);
      line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255;
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, ch, px: out };
}

/* The middle of the ink, against the middle of the picture. */
function inkCenter(img) {
  const { w, h, ch, px } = img;
  const counts = new Map();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * ch;
    const k = (px[p] << 16) | (px[p + 1] << 8) | px[p + 2];
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let bg = 0, best = -1;
  for (const [k, n] of counts) if (n > best) { best = n; bg = k; }
  const br = (bg >> 16) & 255, bgc = (bg >> 8) & 255, bb = bg & 255;
  let minx = w, maxx = -1, miny = h, maxy = -1, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * ch;
    const d = Math.max(Math.abs(px[p] - br), Math.abs(px[p + 1] - bgc), Math.abs(px[p + 2] - bb));
    if (d > 40) { n++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  }
  if (!n) return null;
  return { dx: (minx + maxx) / 2 - (w - 1) / 2, dy: (miny + maxy) / 2 - (h - 1) / 2,
           ink: `${maxx - minx + 1}x${maxy - miny + 1}`, box: `${w}x${h}`, cover: n / (w * h) };
}

/* A mark is chosen by shape, not by tag: one lone svg, or one or two
   characters that are not words. Leaf-ish, so a wrapper holding a glyph is not
   counted twice. */
const FIND = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const kids = el.children;
    const text = (el.textContent || '').trim();
    const lone = kids.length === 1 && kids[0].tagName.toLowerCase() === 'svg' && text.length === 0;
    const glyph = kids.length === 0 && text.length > 0 && text.length <= 2 && !/[a-zA-Z0-9]/.test(text);
    if (!lone && !glyph) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.width > 90 || r.height > 90) continue;
    // Wholly on screen, or the clip lands outside the viewport and the shot
    // comes back empty - which reads as "nothing is drawn in it". That cost
    // three wrong readings of the deck's reset dots, which sit far down a
    // scrolling panel and are drawn perfectly well.
    if (r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.2) continue;
    out.push({
      what: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
            (el.className && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
      label: el.getAttribute('aria-label') || el.getAttribute('title') || '',
      kind: lone ? 'svg' : 'glyph', text,
      x: r.x, y: r.y, w: r.width, h: r.height,
      bt: parseFloat(cs.borderTopWidth) || 0, br: parseFloat(cs.borderRightWidth) || 0,
      bb: parseFloat(cs.borderBottomWidth) || 0, bl: parseFloat(cs.borderLeftWidth) || 0,
    });
  }
  return out;
})()`;

async function sweep(page, pageName) {
  const items = await page.ev(FIND);
  const rows = [];
  for (const it of items) {
    const clip = { x: Math.round(it.x + it.bl), y: Math.round(it.y + it.bt),
                   width: Math.max(1, Math.round(it.w - it.bl - it.br)),
                   height: Math.max(1, Math.round(it.h - it.bt - it.bb)), scale: 1 };
    if (clip.width < 4 || clip.height < 4) continue;
    let shot;
    try { shot = (await page.send('Page.captureScreenshot', { format: 'png', clip })).result.data; } catch (_) { continue; }
    const c = inkCenter(decode(shot));
    if (!c) { rows.push({ page: pageName, ...it, blank: true }); continue; }
    rows.push({ page: pageName, ...it, ...c });
  }
  return rows;
}

(async () => {
  // A phone scene with a layer under TikTok's comments: without one, neither
  // the canvas badge nor the layer row's warning exists to be measured.
  const tpl = (await api('/api/scenes/templates')).templates || [];
  const phone = tpl.find((t) => (t.height || 0) > (t.width || 0)) || tpl[0];
  const made = await api('/api/scenes', { template: phone.id || phone.key || phone.name, name: 'Ink check' });
  const sid = made.scene.id;
  const scene = await api(`/api/scenes/${sid}`);
  const zone = (scene.layers || [])[0];
  if (zone) {
    zone.transform.y = Math.round(scene.height * 0.78);      // down among the comments
    zone.transform.x = 40;
    await api(`/api/scenes/${sid}`, { scene, expect_rev: scene.rev });
  }

  const PREP_CANVAS = `(() => {
    document.querySelectorAll('details').forEach((d) => { d.open = true; });
    const s = window.Editor && Editor.scene();
    if (s && s.layers.length) Editor.select([s.layers[s.layers.length - 1].id]);
    return true;
  })()`;
  const PREP_DECK = `(() => { document.querySelectorAll('details').forEach((d) => { d.open = true; }); return true; })()`;

  const all = [];
  for (const [name, url, prep] of [
    ['deck', `${RIG}/deck.html`, PREP_DECK],
    ['canvas', `${RIG}/canvas.html?scene=${sid}`, PREP_CANVAS],
  ]) {
    const page = await open(url);
    for (let i = 0; i < 40; i++) { await sleep(150); if (await page.ev('document.readyState === "complete"')) break; }
    await sleep(1500);
    try { await page.ev(prep); } catch (e) { console.log(`  (prep on ${name}: ${e.message})`); }
    await sleep(700);
    all.push(...await sweep(page, name));
  }
  try { await api(`/api/scenes/${sid}/delete`, {}); } catch (_) {}

  // Coverage first: a sweep that missed the marks must not look like a pass.
  console.log(`\n${all.length} marks measured across 2 pages\n`);
  for (const pageName of ['deck', 'canvas']) {
    const mine = all.filter((r) => r.page === pageName);
    const by = new Map();
    for (const r of mine) {
      const k = r.kind === 'glyph' ? `${r.what} ${JSON.stringify(r.text)}` : r.what;
      by.set(k, (by.get(k) || 0) + 1);
    }
    console.log(`  ${pageName} (${mine.length}):`);
    for (const [k, n] of [...by].sort()) console.log(`     ${String(n).padStart(3)}x  ${k}`);
  }

  const measured = all.filter((r) => !r.blank);
  const bad = measured.filter((r) => Math.abs(r.dx) > TOL || Math.abs(r.dy) > TOL);
  console.log('');
  for (const r of bad.sort((a, b) => Math.hypot(b.dx, b.dy) - Math.hypot(a.dx, a.dy))) {
    console.log(`OFF  ${r.page.padEnd(6)} dx ${r.dx.toFixed(1).padStart(5)}  dy ${r.dy.toFixed(1).padStart(5)}  ` +
                `${r.kind.padEnd(5)} ${r.text ? JSON.stringify(r.text).padEnd(6) : '      '} ` +
                `box ${r.box.padEnd(7)} ink ${r.ink.padEnd(7)} ${r.what}  ${r.label ? '- ' + r.label : ''}`);
  }
  const blanks = all.filter((r) => r.blank);
  for (const r of blanks) console.log(`BLANK ${r.page} ${r.what} ${JSON.stringify(r.text)} - nothing drawn in it`);
  console.log(`\n${measured.length - bad.length} of ${measured.length} centered within ${TOL}px` +
              (blanks.length ? `, ${blanks.length} blank` : ''));
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
