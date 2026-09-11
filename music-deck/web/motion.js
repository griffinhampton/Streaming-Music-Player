/* Endless CSS animations - the drifting decoration frame, a long title that
   slides back and forth, the equalizer bars - would otherwise redraw the
   window at the screen's refresh rate: 165 times a second on a gaming laptop,
   for motion of a pixel or two per frame. TikTok LIVE Studio captures 30 of
   those frames; the rest cost Chrome's GPU process CPU for nothing.

   So every endlessly repeating animation on the page is taken over and
   advanced on a 30 fps clock instead - same keyframes, easing and speed, a
   fraction of the frames. Finite animations and transitions are left alone.
   While an element moves it gets its own compositor layer, so each step only
   shifts the layer instead of repainting it. Measured on Now Playing's
   drifting frame in headless Chrome: 75 % -> 16 % of one core. */
(() => {
  const FPS = 30;
  const LAYER_PROPS = new Set(['transform', 'translate', 'scale', 'rotate', 'opacity']);
  const NOT_PROPS = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const taken = new WeakMap();    // animation -> { from, layer, target, fresh }
  const layered = new Map();      // element -> the will-change value set on it here
  let timer = 0;

  // A layer only helps when every animated property is one the compositor
  // can move without repainting.
  function layerFor(effect) {
    const props = new Set();
    for (const frame of effect.getKeyframes()) {
      for (const p of Object.keys(frame)) if (!NOT_PROPS.has(p)) props.add(p);
    }
    const list = [...props];
    return list.length && list.every((p) => LAYER_PROPS.has(p)) ? list.join(', ') : '';
  }

  function step() {
    timer = 0;
    if (document.hidden) return;              // nothing is drawn; visibilitychange wakes us
    const now = performance.now();
    // Read everything first, then write. Any animation getter right after a
    // currentTime write forces a style pass, so interleaving the two cost one
    // pass per animation per step instead of one per step.
    const work = [];
    for (const anim of document.getAnimations()) {
      let t = taken.get(anim);
      if (!t) {
        const fx = anim.effect;
        if (!fx || fx.getTiming().iterations !== Infinity) continue;
        if (anim.playState !== 'running') continue;    // paused on purpose: leave it
        t = { from: now - (anim.currentTime || 0), layer: layerFor(fx),
              target: fx.pseudoElement ? null : fx.target, fresh: true };
        taken.set(anim, t);
      }
      work.push([anim, t]);
    }
    const moving = new Map();
    for (const [anim, t] of work) {
      if (t.fresh) { anim.pause(); t.fresh = false; }
      anim.currentTime = now - t.from;
      if (t.layer && t.target) moving.set(t.target, t.layer);
    }
    for (const [el, value] of moving) {
      if (layered.get(el) !== value) { el.style.willChange = value; layered.set(el, value); }
    }
    for (const el of [...layered.keys()]) {
      if (!moving.has(el)) { el.style.removeProperty('will-change'); layered.delete(el); }
    }
    if (work.length) timer = setTimeout(step, 1000 / FPS);
  }

  function wake() { if (!timer) timer = setTimeout(step, 0); }
  document.addEventListener('animationstart', wake, true);
  document.addEventListener('visibilitychange', wake);
  wake();
})();
