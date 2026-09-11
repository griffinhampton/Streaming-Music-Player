/* Endless CSS animations - the drifting decoration frame, a long title that
   slides back and forth, the equalizer bars - would otherwise redraw the
   window at the screen's refresh rate: 165 times a second on a gaming laptop,
   for motion of a pixel or two per frame. TikTok LIVE Studio captures 30 of
   those frames; the rest cost Chrome CPU for nothing.

   So every endlessly repeating animation gets a stepped timing that moves it
   30 times a second - same keyframes, easing and speed. It stays on Chrome's
   compositor, which skips the frames where nothing moved, and no script runs
   per frame. */
(() => {
  const FPS = 30;
  const stepped = new WeakMap();   // animation -> the duration its steps were counted for
  let queued = false;

  function stepAll() {
    queued = false;
    for (const anim of document.getAnimations()) {
      const fx = anim.effect;
      if (!fx) continue;
      const t = fx.getComputedTiming();
      const dur = Number(t.duration);
      if (t.iterations !== Infinity || !(dur > 0) || stepped.get(anim) === dur) continue;
      stepped.set(anim, dur);
      fx.updateTiming({ easing: `steps(${Math.max(1, Math.round(dur * FPS / 1000))})` });
    }
  }
  // New animations, and every new lap: a speed change shows up in the
  // duration there, and the step count is redone to stay at 30 a second.
  function queue() { if (!queued) { queued = true; setTimeout(stepAll, 0); } }
  document.addEventListener('animationstart', queue, true);
  document.addEventListener('animationiteration', queue, true);
  queue();
})();
