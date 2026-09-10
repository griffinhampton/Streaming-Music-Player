/* Fonts people added in the deck, on every page.

   The server writes one @font-face rule per uploaded file into /fonts.css.
   This links that sheet before anything paints, and swaps in a fresh copy
   whenever the broadcast says the set changed, so a font added in the deck
   shows up in the live windows without reopening them. The old sheet stays
   until the new one has loaded, so text never flashes to a fallback. */
(function () {
  let current = document.createElement('link');
  current.rel = 'stylesheet';
  current.href = '/fonts.css';
  document.head.appendChild(current);

  let seen = null;
  window.syncUserFonts = function (version) {
    if (version == null || version === seen) return;
    seen = version;
    const next = document.createElement('link');
    next.rel = 'stylesheet';
    next.href = '/fonts.css?v=' + encodeURIComponent(version);
    next.onload = () => {
      if (current !== next) current.remove();
      current = next;
    };
    next.onerror = () => next.remove();
    document.head.appendChild(next);
  };
})();
