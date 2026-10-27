/* Pulse v2 shared behaviour: glass nav, mobile menu, rippling logo mark, cursor ring, reveal. */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;

  // glass nav tightens once the page scrolls
  var nav = document.querySelector('.glass-nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('is-scrolled', window.scrollY > 24); };
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }

  // mobile menu
  var btn = document.querySelector('.menu-btn'), menu = document.getElementById('site-nav');
  if (btn && menu) {
    var setOpen = function (open) {
      menu.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    btn.addEventListener('click', function () { setOpen(!menu.classList.contains('is-open')); });
    menu.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  }

  // rippling Pulse mark behind hero bands
  var P = ['M416.203 235.545C418.208 235.545 419.833 224.99 419.833 211.97C419.833 198.95 418.208 188.395 416.203 188.395C414.199 188.395 412.573 198.95 412.573 211.97C412.573 224.99 414.199 235.545 416.203 235.545Z',
    'M400.127 259.898C402.418 259.898 404.276 237.86 404.276 210.675C404.276 183.489 402.418 161.451 400.127 161.451C397.836 161.451 395.979 183.489 395.979 210.675C395.979 237.86 397.836 259.898 400.127 259.898Z',
    'M382.499 275.442C385.649 275.442 388.203 246.444 388.203 210.674C388.203 174.904 385.649 145.907 382.499 145.907C379.349 145.907 376.795 174.904 376.795 210.674C376.795 246.444 379.349 275.442 382.499 275.442Z',
    'M361.497 285.286C365.363 285.286 368.497 252.229 368.497 211.452C368.497 170.674 365.363 137.617 361.497 137.617C357.631 137.617 354.497 170.674 354.497 211.452C354.497 252.229 357.631 285.286 361.497 285.286Z',
    'M337.387 288.913C342.255 288.913 346.201 254.116 346.201 211.192C346.201 168.268 342.255 133.471 337.387 133.471C332.518 133.471 328.572 168.268 328.572 211.192C328.572 254.116 332.518 288.913 337.387 288.913Z',
    'M307.83 301.867C314.703 301.867 320.274 261.155 320.274 210.934C320.274 160.712 314.703 120 307.83 120C300.957 120 295.385 160.712 295.385 210.934C295.385 261.155 300.957 301.867 307.83 301.867Z'];
  document.querySelectorAll('[data-ripple]').forEach(function (el, n) {
    var id = 'v2mg' + n, paths = P.map(function (d) { return '<path d="' + d + '"/>'; }).join('');
    var rings = [0, 1.73, 3.46].map(function (d) { return '<g class="ripple" style="animation-delay:' + d + 's" opacity=".5">' + paths + '</g>'; }).join('');
    var bars = P.map(function (d, i) { return '<path class="bar" style="animation-delay:' + (i * 0.12).toFixed(2) + 's" d="' + d + '"/>'; }).join('');
    el.innerHTML = '<svg viewBox="250 60 260 300" fill="url(#' + id + ')" aria-hidden="true" focusable="false"><defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#AA5B1E"/><stop offset=".5" stop-color="#E4A524"/><stop offset="1" stop-color="#FFD530"/></linearGradient></defs>' + rings + '<g opacity=".85">' + bars + '</g></svg>';
  });

  // gentle reveal for blocks below the fold
  var rev = document.querySelectorAll('.v2-reveal');
  if (rev.length) {
    if (reduce || !('IntersectionObserver' in window)) rev.forEach(function (el) { el.classList.add('is-in'); });
    else {
      var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }); }, { rootMargin: '0px 0px -8% 0px' });
      rev.forEach(function (el) { io.observe(el); });
    }
  }

  // gold cursor ring (mouse only)
  if (fine && !reduce) {
    var cur = document.createElement('div'); cur.id = 'pulse-cursor'; cur.setAttribute('aria-hidden', 'true'); document.body.appendChild(cur);
    var x = 0, y = 0, cx = 0, cy = 0, raf = 0;
    var loop = function () { cx += (x - cx) * 0.22; cy += (y - cy) * 0.22; cur.style.transform = 'translate(' + cx + 'px,' + cy + 'px)'; raf = (Math.abs(x - cx) + Math.abs(y - cy) > 0.3) ? requestAnimationFrame(loop) : 0; };
    document.addEventListener('mousemove', function (e) {
      x = e.clientX; y = e.clientY; cur.classList.add('is-on');
      cur.classList.toggle('is-link', !!e.target.closest('a,button,label,select,summary,input[type=submit]'));
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
    document.addEventListener('mouseleave', function () { cur.classList.remove('is-on'); });
  }
})();
