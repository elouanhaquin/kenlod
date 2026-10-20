// Public site: sticky header, mobile menu and the live-typing demo of the landing page.
const top = document.getElementById('top');
const menuBtn = top?.querySelector('.menu-btn');

if (top && !top.classList.contains('static')) {
  const onScroll = () => top.classList.toggle('solid', window.scrollY > 40 || top.classList.contains('open'));
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

menuBtn?.addEventListener('click', () => {
  const open = top.classList.toggle('open');
  menuBtn.setAttribute('aria-expanded', String(open));
  if (!top.classList.contains('static')) top.classList.toggle('solid', open || window.scrollY > 40);
});
top?.querySelectorAll('nav a').forEach((a) => a.addEventListener('click', () => {
  top.classList.remove('open');
  menuBtn?.setAttribute('aria-expanded', 'false');
}));

for (const el of document.querySelectorAll('[data-year]')) el.textContent = String(new Date().getFullYear());

// Types the demo sentence, pauses, erases it and starts again, like someone writing live.
const typed = document.querySelector('.typed[data-text]');
if (typed && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const text = typed.dataset.text;
  let i = 0;
  let dir = 1;
  const tick = () => {
    i += dir;
    typed.textContent = text.slice(0, i);
    let delay = 45 + Math.random() * 70;
    if (i >= text.length) { dir = -1; delay = 3200; }
    else if (i <= 0) { dir = 1; delay = 900; }
    else if (dir < 0) delay = 14;
    setTimeout(tick, delay);
  };
  setTimeout(tick, 900);
} else if (typed) {
  typed.textContent = typed.dataset.text;
}
