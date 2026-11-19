/*
  What runs inside a deck's page (kit.css gives it the look). It is the only script that runs there: the page's
  content security policy lets nothing else run.

  A slide is a <section class="slide">. Steps are what a click does inside a slide:
    data-step="n"       the element shows from step n on
    data-focus="…"      on a table block (the focus="…" of its lemma-block tag): steps separated by ";", each a CSS selector
                        for the part of the table in focus (cells, or a whole row); the rest goes grey, and one band
                        moves over what is in focus
  Between slides the old one goes out and the new one comes in (the View Transitions API; without it, a plain change).

  Messages: the page tells its parent {type:'ready'|'state'|'close'|'printed'} and listens for
  {type:'goto', slide, step} and {type:'print'}.
*/
(() => {
  'use strict';
  const root = document.documentElement;
  const body = document.body;
  const mode = body.dataset.mode || 'present';
  const stage = document.querySelector('.stage');
  const slides = Array.from(document.querySelectorAll('.slide'));
  if (!stage || slides.length === 0) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  const blocksOf = (slide) => Array.from(slide.querySelectorAll('.block.tbl'));
  const focusOf = (block) => (block.dataset.focus || '').split(';').map((text) => text.trim()).filter(Boolean);
  /** How many steps a slide has: the last data-step, or the number of focus steps of a table. */
  function stepsOf(index) {
    const slide = slides[index];
    let count = 0;
    slide.querySelectorAll('[data-step]').forEach((element) => {
      count = Math.max(count, Number(element.dataset.step) || 0);
    });
    blocksOf(slide).forEach((block) => {
      count = Math.max(count, focusOf(block).length);
    });
    return count;
  }

  /* ---- a table: what is in focus (its rules are the kit's) ---- */

  function bandOf(block) {
    let band = block.querySelector(':scope > .band');
    if (!band) {
      band = document.createElement('div');
      band.className = 'band';
      block.insertBefore(band, block.firstChild);
    }
    return band;
  }

  /** The band over a box, `pad` cqw wider on each side and taller above and below. */
  function place(block, band, box, pad, instant) {
    const unit = stage.clientWidth / 100;
    const origin = block.getBoundingClientRect();
    if (instant) band.style.transition = 'none';
    band.style.transform = `translate(${box.left - origin.left - pad[0] * unit}px,${box.top - origin.top - pad[1] * unit}px)`;
    band.style.width = `${box.width + 2 * pad[0] * unit}px`;
    band.style.height = `${box.height + 2 * pad[1] * unit}px`;
    if (instant) {
      void band.offsetWidth;
      band.style.transition = '';
    }
  }

  /** Puts the table's focus at `step`: step 0 and a step with nothing found show the table as it is. */
  function focusAt(block, step, instant) {
    const table = block.querySelector('table');
    if (!table) return;
    const steps = focusOf(block);
    const selector = step > 0 && steps.length > 0 ? steps[Math.min(step, steps.length) - 1] : '';
    table.querySelectorAll('.k').forEach((element) => element.classList.remove('k'));
    const band = bandOf(block);
    let found = [];
    if (selector) {
      try {
        found = Array.from(table.querySelectorAll(selector));
      } catch (error) {
        found = [];
      }
    }
    const keep = new Set();
    const boxes = [];
    let wholeRows = false;
    found.forEach((element) => {
      if (element.tagName === 'TR') {
        wholeRows = true;
        element.querySelectorAll('th, td').forEach((cell) => keep.add(cell));
        boxes.push(element.getBoundingClientRect());
      } else if (element.matches('th, td')) {
        keep.add(element);
        // The row's label and the header over the column stay readable with it.
        const label = element.closest('tr') && element.closest('tr').querySelector('th');
        if (label) keep.add(label);
        table.querySelectorAll(`thead th[data-c="${element.dataset.c}"]`).forEach((head) => keep.add(head));
        const inner = element.querySelector('.n') || element;
        const box = inner.getBoundingClientRect();
        if (box.width > 0) boxes.push(box);
      }
    });
    if (keep.size === 0) {
      table.removeAttribute('data-f');
      band.classList.remove('on');
      return;
    }
    table.setAttribute('data-f', '');
    keep.forEach((element) => element.classList.add('k'));
    if (boxes.length === 0) {
      band.classList.remove('on');
      return;
    }
    const left = Math.min(...boxes.map((box) => box.left));
    const topMost = Math.min(...boxes.map((box) => box.top));
    const united = { left, top: topMost, width: Math.max(...boxes.map((box) => box.right)) - left, height: Math.max(...boxes.map((box) => box.bottom)) - topMost };
    // The first time it shows, it fades in where it is instead of sliding in from the corner.
    place(block, band, united, wholeRows ? [0.6, 0.25] : [1, 0.35], instant || !band.classList.contains('on'));
    band.classList.add('on');
  }

  /* ---- where the talk is ---- */

  let current = 0;
  let now = 0;
  let want = { i: 0, s: 0 };
  let running = null;

  const post = (message) => {
    try {
      window.parent.postMessage(message, '*');
    } catch (error) {
      /* nobody to tell */
    }
  };

  function report() {
    post({ type: 'state', slide: current, step: now, slides: slides.length, steps: stepsOf(current) });
    if (mode === 'export') {
      try {
        window.history.replaceState(null, '', `#${current + 1}${now ? `.${now}` : ''}`);
      } catch (error) {
        /* a page that cannot change its address */
      }
    }
  }

  function render(index, step, instant) {
    const slide = slides[index];
    slide.dataset.now = String(step);
    slide.querySelectorAll('[data-step]').forEach((element) => {
      element.classList.toggle('shown', (Number(element.dataset.step) || 0) <= step);
    });
    blocksOf(slide).forEach((block) => focusAt(block, step, instant));
    report();
  }

  function go(index, step) {
    const i = clamp(index, 0, slides.length - 1);
    const s = clamp(step, 0, stepsOf(i));
    want = { i, s };
    if (i === current) {
      now = s;
      render(current, now, false);
      return;
    }
    if (running) running.skipTransition();
    const swap = () => {
      slides[current].classList.remove('on');
      current = want.i;
      now = clamp(want.s, 0, stepsOf(current));
      slides[current].classList.add('on');
      render(current, now, true);
    };
    if (!document.startViewTransition || reduce.matches || mode === 'print') {
      swap();
      return;
    }
    const transition = document.startViewTransition(swap);
    running = transition;
    const done = () => {
      if (running === transition) running = null;
    };
    transition.finished.then(done, done);
  }

  const next = () => (want.s < stepsOf(want.i) ? go(want.i, want.s + 1) : want.i < slides.length - 1 && go(want.i + 1, 0));
  const prev = () => (want.s > 0 ? go(want.i, want.s - 1) : want.i > 0 && go(want.i - 1, stepsOf(want.i - 1)));

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(key)) next();
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(key)) prev();
    else if (key === 'Home') go(0, 0);
    else if (key === 'End') go(slides.length - 1, 0);
    else if (key === 'Escape') post({ type: 'close' });
    else return;
    event.preventDefault();
  });
  if (mode === 'present' || mode === 'export') stage.addEventListener('click', next);

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data || {};
    if (message.type === 'goto') go(Number(message.slide) || 0, Number(message.step) || 0);
    else if (message.type === 'print') window.print();
  });
  window.addEventListener('afterprint', () => post({ type: 'printed' }));
  window.addEventListener('resize', () => render(current, now, true));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render(current, now, true));

  /* ---- start ---- */

  const hash = /^#(\d+)(?:\.(\d+))?$/.exec(window.location.hash);
  const given = (body.dataset.start || '').split('.').map(Number);
  let first = 0;
  let firstStep = 0;
  if (mode === 'export' && hash) {
    first = Number(hash[1]) - 1;
    firstStep = Number(hash[2] || 0);
  } else if (given.length === 2 && given.every(Number.isFinite)) {
    [first, firstStep] = given;
  }
  current = clamp(first, 0, slides.length - 1);
  now = clamp(firstStep, 0, stepsOf(current));
  want = { i: current, s: now };
  slides[current].classList.add('on');
  render(current, now, true);
  post({ type: 'ready' });
})();
