/* New scenes and formats (P10): the template gallery; a scene laid out
   again for the other format - as a new scene ("Make a phone version") or in
   place (the Horizontal / Phone switch, one undo step); and what sits under
   TikTok's controls on a phone. The layout itself is the server's
   (scenes.convert), the one the unit tests hold to: never a layer off the
   canvas. */
'use strict';

const postJ = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then((r) => r.json()).catch(() => null);

/* ------------------------------------------------------------- the gallery */

let templates = null;
async function loadTemplates() {
  if (!templates) {
    try { templates = (await (await fetch('/api/scenes/templates', { cache: 'no-store' })).json()).templates || []; } catch (_) { templates = []; }
  }
  return templates;
}
const BLANKS = [
  { id: 'blank:horizontal', name: 'Blank', format: 'horizontal', width: 1920, height: 1080, background: { mode: 'solid', color: '#0f0f17' }, layers: [] },
  { id: 'blank:phone', name: 'Blank', format: 'phone', width: 1080, height: 1920, background: { mode: 'solid', color: '#0f0f17' }, layers: [] },
];

/* A template drawn from its boxes: cheap, instant, and exactly where things are. */
function thumbSVG(t, n) {
  const W = t.width, H = t.height, bg = t.background || {};
  let defs = '', fill = esc(bg.color || '#0f0f17');
  if (bg.mode === 'gradient') {
    const a = ((bg.angle ?? 135) * Math.PI) / 180, sx = Math.sin(a) / 2, cy = Math.cos(a) / 2;
    defs = `<linearGradient id="ndg${n}" x1="${0.5 - sx}" y1="${0.5 + cy}" x2="${0.5 + sx}" y2="${0.5 - cy}">` +
      `<stop offset="0" stop-color="${esc(bg.color || '#0f0f17')}"/><stop offset="1" stop-color="${esc(bg.color2 || '#241a3d')}"/></linearGradient>`;
    fill = `url(#ndg${n})`;
  } else if (bg.mode === 'scene') {
    defs = `<pattern id="ndp${n}" width="160" height="160" patternUnits="userSpaceOnUse"><rect width="160" height="160" fill="${esc(bg.color || '#1a0f1f')}"/>` +
      '<circle cx="40" cy="40" r="10" fill="rgba(255,190,220,.35)"/><circle cx="120" cy="110" r="7" fill="rgba(255,190,220,.28)"/></pattern>';
    fill = `url(#ndp${n})`;
  }
  const parts = [`<rect width="${W}" height="${H}" fill="${fill}"/>`];
  for (const l of t.layers || []) {
    const tr = l.transform || {}, p = l.props || {};
    const rot = tr.rotation ? ` transform="rotate(${tr.rotation} ${tr.x} ${tr.y})"` : '';
    const box = (extra) => `<rect x="${tr.x}" y="${tr.y}" width="${tr.w}" height="${tr.h}"${rot} ${extra}/>`;
    const label = (text, size) => `<text x="${tr.x + tr.w / 2}" y="${tr.y + tr.h / 2}" text-anchor="middle" dominant-baseline="middle" font-size="${size}" fill="rgba(255,255,255,.75)" font-family="Segoe UI, sans-serif">${esc(text)}</text>`;
    if (l.type === 'text') {
      const size = Math.max(20, Math.min(tr.h * 0.7, p.size || 48));
      parts.push(`<text x="${tr.x + 8}" y="${tr.y + tr.h / 2}" dominant-baseline="middle" font-size="${size}" font-weight="700" fill="#fff" font-family="Segoe UI, sans-serif">${esc(String(p.text || l.name).slice(0, 24))}</text>`);
    } else if (l.type === 'component') {
      parts.push(box('rx="18" fill="rgba(255,255,255,.14)" stroke="rgba(255,255,255,.45)" stroke-width="4"'),
        label(COMP_NAME[p.component] || 'Window', Math.min(48, tr.h * 0.3)));
    } else if (l.type === 'camera') {
      parts.push(p.mask === 'circle'
        ? `<ellipse cx="${tr.x + tr.w / 2}" cy="${tr.y + tr.h / 2}" rx="${tr.w / 2}" ry="${tr.h / 2}" fill="#5b5f73"/>`
        : box('rx="24" fill="#5b5f73"'), label('Camera', Math.min(44, tr.h * 0.18)));
    } else if (l.type === 'capture') {
      parts.push(box('fill="#1e2433" stroke="rgba(255,255,255,.25)" stroke-width="4"'), label(l.name || 'Screen', Math.min(72, tr.h * 0.15)));
    } else if (l.type === 'shape') {
      if (p.kind === 'frame') parts.push(box(`rx="30" fill="none" stroke="${esc(p.fill || 'rgba(255,255,255,.3)')}" stroke-width="${Math.max(6, p.pad || 12)}"`));
      else if (p.kind === 'ellipse') parts.push(`<ellipse cx="${tr.x + tr.w / 2}" cy="${tr.y + tr.h / 2}" rx="${tr.w / 2}" ry="${tr.h / 2}" fill="${esc(p.fill || 'rgba(255,255,255,.2)')}"/>`);
      else parts.push(box(`fill="${esc(p.fill || 'rgba(255,255,255,.2)')}"`));
    } else {
      parts.push(box('fill="#3b3f4f"'));
    }
  }
  if (t.format === 'phone') {
    for (const z of zonesOf({ format: 'phone' })) {
      parts.push(`<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="rgba(248,113,113,.16)" stroke="rgba(248,113,113,.55)" stroke-width="4" stroke-dasharray="16 12"/>`);
    }
  }
  return `<svg class="nd-thumb" viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs>${defs}</defs>${parts.join('')}</svg>`;
}

let ndChoice = null, ndReturn = null, ndList = [];
async function openNewDialog() {
  ndReturn = document.activeElement;
  ndList = [...BLANKS, ...(await loadTemplates())];
  const fmt = store.scene ? store.scene.format : 'horizontal';
  if (!ndList.some((t) => t.id === ndChoice)) ndChoice = 'blank:' + fmt;
  let n = 0;
  $('newGrid').innerHTML = ['horizontal', 'phone'].map((f) =>
    `<div class="nd-group"><h3>${f === 'phone' ? 'Phone · 1080 × 1920' : 'Horizontal · 1920 × 1080'}</h3><div class="nd-cards">` +
    ndList.filter((t) => t.format === f).map((t) =>
      `<button type="button" role="radio" class="nd-card ${t.format}" data-t="${esc(t.id)}" aria-checked="false" tabindex="-1"` +
      ` aria-label="${esc(t.name)}, ${t.format === 'phone' ? 'phone' : 'horizontal'}${t.layers.length ? ', ' + t.layers.length + ' layers' : ''}">` +
      `${thumbSVG(t, n++)}<span class="nd-name">${esc(t.name)}</span></button>`).join('') + '</div></div>').join('');
  $('newName').value = '';
  $('newDialog').hidden = false;
  paintChoice(true);
}
function paintChoice(focus) {
  const cards = [...$('newGrid').querySelectorAll('.nd-card')];
  for (const c of cards) {
    const on = c.dataset.t === ndChoice;
    c.setAttribute('aria-checked', String(on));
    c.tabIndex = on ? 0 : -1;
    if (on && focus) c.focus();
  }
  const t = ndList.find((x) => x.id === ndChoice);
  $('newHint').textContent = t ? (t.layers.length ? `${t.name}: ${t.layers.length} layers to start from, ${t.width} × ${t.height}` : `An empty ${t.format === 'phone' ? 'phone' : 'horizontal'} scene`) : '';
}
function closeNewDialog(refocus) {
  $('newDialog').hidden = true;
  if (refocus) (ndReturn && ndReturn.isConnected ? ndReturn : vp).focus({ preventScroll: true });
}
async function createFromDialog() {
  const name = $('newName').value.trim();
  const t = ndChoice;
  closeNewDialog(false);
  const d = t.startsWith('blank:')
    ? await postJ('/api/scenes', { name: name || 'Untitled scene', format: t.slice(6) })
    : await postJ('/api/scenes', { template: t, name: name || undefined });
  if (!d || !d.ok) { toast('Could not make that scene'); vp.focus(); return null; }
  await refreshScenes();
  await loadScene(d.scene.id);
  vp.focus({ preventScroll: true });
  announce(`Made the scene ${d.scene.name}`);
  return d.scene.id;
}
$('newGrid').addEventListener('click', (e) => {
  const c = e.target.closest('.nd-card');
  if (!c) return;
  ndChoice = c.dataset.t;
  paintChoice(false);
});
$('newGrid').addEventListener('dblclick', (e) => { if (e.target.closest('.nd-card')) createFromDialog(); });
$('newCreate').addEventListener('click', createFromDialog);
$('newCancel').addEventListener('click', () => closeNewDialog(true));
$('newDialog').addEventListener('click', (e) => { if (e.target === $('newDialog')) closeNewDialog(true); });
$('newDialog').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); closeNewDialog(true); return; }
  const card = e.target.closest && e.target.closest('.nd-card');
  if (e.key === 'Enter' && (card || e.target.id === 'newName')) { e.preventDefault(); createFromDialog(); return; }
  if (card && ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const ids = ndList.map((t) => t.id).filter((id) => $('newGrid').querySelector(`.nd-card[data-t="${CSS.escape(id)}"]`));
    const order = [...$('newGrid').querySelectorAll('.nd-card')].map((c) => c.dataset.t);
    const i = order.indexOf(ndChoice);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1
      : (i + ((e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : order.length - 1)) % order.length;
    ndChoice = order[j] || ids[0];
    paintChoice(true);
    return;
  }
  if (e.key === 'Tab') {
    // Focus stays in the dialog: name, the chosen card, Cancel, Make.
    const stops = [$('newName'), $('newGrid').querySelector('.nd-card[tabindex="0"]'), $('newCancel'), $('newCreate')].filter(Boolean);
    const i = stops.indexOf(document.activeElement.closest('.nd-card') || document.activeElement);
    e.preventDefault();
    stops[(i + (e.shiftKey ? stops.length - 1 : 1)) % stops.length].focus();
  }
});

/* ------------------------------------------------------------- formats */

/** The Horizontal / Phone switch: this scene, laid out again, as one undo step. */
async function switchFormat(fmt) {
  const s = store.scene;
  if (!s || s.format === fmt) return false;
  const sent = JSON.stringify(s);
  const d = await postJ('/api/scenes/convert', { scene: s, format: fmt });
  if (!d || !d.ok) { toast('Could not lay the scene out for that format'); return false; }
  if (!store.scene || JSON.stringify(store.scene) !== sent) { toast('The scene changed meanwhile - try the switch again'); return false; }
  const c = d.scene;
  exec(fmt === 'phone' ? 'switch to phone' : 'switch to horizontal', (x) => {
    Object.assign(x, { format: c.format, width: c.width, height: c.height, layers: c.layers, guides: c.guides });
  });
  zoomFit();
  const under = c.layers.filter((l) => zoneHits(l).length).length;
  announce(`Laid out for ${fmt === 'phone' ? 'a phone' : 'a horizontal screen'}` + (under ? `; ${under} under TikTok's controls` : ''));
  return true;
}
/** "Make a phone version": a new scene; this one stays as it is. */
async function makeVersion(fmt) {
  if (!store.scene) return null;
  await flush();
  const d = await postJ(`/api/scenes/${encodeURIComponent(store.scene.id)}/convert`, { format: fmt });
  if (!d || !d.ok) { toast('Could not make that version'); return null; }
  await refreshScenes();
  await loadScene(d.scene.id);
  const under = d.scene.layers.filter((l) => zoneHits(l).length);
  toast(`Made “${d.scene.name}”.` + (under.length ? ` ${under.length} layer${under.length > 1 ? 's sit' : ' sits'} under TikTok's controls - marked ⚠.` : ' Everything is clear of TikTok\'s controls.'));
  return d.scene.id;
}

function sceneFormatSection() {
  const s = store.scene, other = s.format === 'phone' ? 'horizontal' : 'phone';
  return section('scene-format', s.format === 'phone' ? 'Phone and TikTok' : 'Format', `
    ${s.format === 'phone' ? '<p class="hint" data-under-count></p>' : ''}
    <button type="button" class="btn" data-make-version="${other}">Make a ${other === 'phone' ? 'phone' : 'horizontal'} version</button>
    <p class="hint">A new scene with these layers laid out for ${other === 'phone' ? 'a phone, between TikTok\'s top bar and its comments' : 'a horizontal screen'}
      - a start to fix by hand. This scene stays as it is. The Horizontal / Phone switch at the top lays out this scene itself instead.</p>`);
}
/* What sits under TikTok's controls: the scene's count, the layer's own line. */
function paintZoneNotes(root) {
  const s = store.scene;
  if (!s) return;
  const count = root.querySelector('[data-under-count]');
  if (count) {
    const under = s.layers.filter((l) => zoneHits(l).length);
    count.className = under.length ? 'insp-warn' : 'hint';
    count.textContent = under.length ? `${under.length} layer${under.length > 1 ? 's sit' : ' sits'} under TikTok's controls: ${under.map((l) => l.name).join(', ')}.`
      : "Nothing sits under TikTok's controls.";
  }
  const note = root.querySelector('[data-zone-note]');
  if (note) {
    const l = oneLayer();
    const hits = l ? zoneHits(l) : [];
    note.hidden = !hits.length;
    note.textContent = hits.length ? `Under TikTok's ${hits.join(' and ')}: people watching on a phone may not see all of it.` : '';
  }
}
$('inspector').addEventListener('click', (e) => {
  const b = e.target.closest('[data-make-version]');
  if (b) makeVersion(b.dataset.makeVersion);
});

/* For tests. */
Object.assign(window.Editor, {
  newDialog: openNewDialog,
  newChoice: () => ndChoice,
  switchFormat, makeVersion,
  underUI: () => Object.fromEntries((store.scene ? store.scene.layers : []).map((l) => [l.id, zoneHits(l)]).filter(([, h]) => h.length)),
});
