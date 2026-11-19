/*
  What runs inside a deck's page (kit.css gives it the look). It is the only script that runs there: the page's
  content security policy lets nothing else run.

  A slide is a <section class="slide">. Steps are what a click does inside a slide:
    data-step="n"       the element shows from step n on
    data-focus="…"      on a table block (the focus="…" of its lemma-block tag): steps separated by ";", each a CSS selector
                        for the part of the table in focus (cells, or a whole row); the rest goes grey, and one band
                        moves over what is in focus
  Between slides the old one goes out and the new one comes in (the View Transitions API; without it, a plain change).
  A chart's bars grow when its slide comes in going forward; between a table and a chart of it on the next slide,
  the numbers marked data-move travel from their cells into the chart (and back).

  A slide's <aside class="notes"> is not shown: its text goes to the parent with the state, for the speaker.
  The overview (O, or a message) shows every slide at once; a click opens one (or, in the editor, picks it).
  On load the page checks each slide's layout: what spills over the slide or its content area (overflow), and a
  title or the foot running into the content (overlap).

  Messages: the page tells its parent {type:'ready'|'close'|'printed'}, {type:'state', slide, step, slides, steps,
  notes, overview}, {type:'problems', slides:[{slide, kinds}]}, {type:'pick', slide} and {type:'key', key} (P, for
  the speaker's view), and listens for {type:'goto', slide, step}, {type:'overview', on} and {type:'print'}.
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

  /* ---- a table and a chart of it on the slide next to it: the numbers they share travel between them ---- */

  const speed = () => parseFloat(getComputedStyle(root).getPropertyValue('--speed')) || 1;

  /**
   * The pairs of numbers (one on each slide: a table's cell and a chart's value) that travel between two slides side
   * by side, as [on the slide left, on the slide arrived at]. A pair shares one name, but never both at once: the
   * browser refuses a change where two elements have the same name, even one on a hidden slide.
   */
  function movesBetween(from, to) {
    const pairs = [];
    [from, to].forEach((slide) => {
      const other = slide === from ? to : from;
      slide.querySelectorAll('.block.chart').forEach((chart) => {
        const table = Array.from(other.querySelectorAll('.block.tbl')).find((block) => block.dataset.ref === chart.dataset.ref);
        if (!table) return;
        chart.querySelectorAll('.val[data-move]').forEach((value) => {
          const cell = Array.from(table.querySelectorAll('td, th')).find((item) => item.dataset.row === value.dataset.row && item.dataset.col === value.dataset.col);
          if (!cell) return;
          const number = cell.querySelector('.n') || cell;
          pairs.push(slide === from ? [value, number] : [number, value]);
        });
      });
    });
    return pairs.slice(0, 4);
  }

  const nameAll = (elements, named) =>
    elements.forEach((element, index) => {
      element.style.viewTransitionName = named ? `move-${index}` : '';
    });

  /* ---- where the talk is ---- */

  let current = 0;
  let now = 0;
  let overviewOn = false;
  /** In the overview, the slide a click or Enter would open. */
  let picked = 0;
  let want = { i: 0, s: 0 };
  let running = null;

  const post = (message) => {
    try {
      window.parent.postMessage(message, '*');
    } catch (error) {
      /* nobody to tell */
    }
  };

  const notesOf = (slide) =>
    Array.from(slide.querySelectorAll('.notes'))
      .map((element) => element.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim())
      .filter(Boolean)
      .join('\n\n');

  function report() {
    post({ type: 'state', slide: current, step: now, slides: slides.length, steps: stepsOf(current), notes: notesOf(slides[current]), overview: overviewOn });
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
    const forward = i > current;
    const motion = Boolean(document.startViewTransition) && !reduce.matches && mode !== 'print';
    const charts = Array.from(slides[i].querySelectorAll('.block.chart'));
    const pairs = motion && Math.abs(i - current) === 1 ? movesBetween(slides[current], slides[i]) : [];
    // The numbers that travel are named on the slide left before the change, and on the slide arrived at in it.
    nameAll(pairs.map((pair) => pair[0]), true);
    const swap = () => {
      nameAll(pairs.map((pair) => pair[0]), false);
      nameAll(pairs.map((pair) => pair[1]), true);
      slides[current].classList.remove('on');
      current = want.i;
      now = clamp(want.s, 0, stepsOf(current));
      // Going forward the bars start at nothing; going back the chart is there as it was left.
      charts.forEach((chart) => chart.setAttribute('data-grow', motion && forward && current === i ? '0' : '1'));
      slides[current].classList.add('on');
      render(current, now, true);
    };
    const grow = () =>
      requestAnimationFrame(() => {
        if (current === i) charts.forEach((chart) => chart.setAttribute('data-grow', '1'));
      });
    if (!motion) {
      swap();
      return;
    }
    const transition = document.startViewTransition(swap);
    running = transition;
    // The bars start while the slide is still arriving, not after it.
    transition.ready.then(() => setTimeout(grow, 120 * speed()), grow);
    const done = () => {
      pairs.forEach((pair) => nameAll(pair, false));
      if (running === transition) running = null;
    };
    transition.finished.then(done, done);
  }

  const next = () => (want.s < stepsOf(want.i) ? go(want.i, want.s + 1) : want.i < slides.length - 1 && go(want.i + 1, 0));
  const prev = () => (want.s > 0 ? go(want.i, want.s - 1) : want.i > 0 && go(want.i - 1, stepsOf(want.i - 1)));

  /* ---- every slide at once ---- */

  function mark() {
    slides.forEach((slide, index) => slide.classList.toggle('picked', overviewOn && index === picked));
  }

  function overview(on) {
    if (mode === 'print' || on === overviewOn) return;
    overviewOn = on;
    picked = current;
    body.classList.toggle('overview', on);
    mark();
    if (on) slides[picked].scrollIntoView({ block: 'nearest' });
    else render(current, now, true);
    report();
  }

  function open(index) {
    if (mode === 'preview') {
      post({ type: 'pick', slide: index });
      return;
    }
    overview(false);
    go(index, 0);
  }

  stage.addEventListener(
    'click',
    (event) => {
      if (!overviewOn) return;
      const tile = event.target.closest && event.target.closest('.slide');
      event.stopImmediatePropagation();
      if (tile) open(slides.indexOf(tile));
    },
    true,
  );

  /* ---- what does not fit ---- */

  const SPILL = 'h1, h2, h3, p, li, dt, dd, table, img, svg, figure, .block, .caption, .lab, .val, .gainlab, .marker em';
  const beyond = (inner, outer) => inner.right > outer.right + 1 || inner.bottom > outer.bottom + 1 || inner.left < outer.left - 1 || inner.top < outer.top - 1;
  const meets = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const shown = (element) => !element.closest('.notes, .foot') && element.getClientRects().length > 0;

  /** What is wrong with a slide's layout: 'overflow' (spills over the slide or its content area), 'overlap'. */
  function problemsOf(slide) {
    const kinds = new Set();
    const box = slide.getBoundingClientRect();
    slide.querySelectorAll(SPILL).forEach((element) => {
      if (shown(element) && beyond(element.getBoundingClientRect(), box)) kinds.add('overflow');
    });
    const content = slide.querySelector(':scope > .content');
    if (content) {
      if (content.scrollHeight > content.clientHeight + 2) kinds.add('overflow');
      const area = content.getBoundingClientRect();
      content.querySelectorAll('table').forEach((table) => {
        if (beyond(table.getBoundingClientRect(), area)) kinds.add('overflow');
      });
      const parts = Array.from(content.children).filter(shown).map((element) => element.getBoundingClientRect());
      const title = slide.querySelector(':scope > .title');
      const foot = slide.querySelector(':scope > .foot');
      [title, foot].forEach((element) => {
        if (element && element.getClientRects().length > 0 && parts.some((part) => meets(part, element.getBoundingClientRect()))) kinds.add('overlap');
      });
    }
    return Array.from(kinds);
  }

  /** Checks every slide, each laid out as it shows (with all its steps), and tells the parent. */
  function check() {
    if (mode === 'print') return;
    const found = [];
    slides.forEach((slide, index) => {
      const hidden = !slide.classList.contains('on') && !overviewOn;
      if (hidden) {
        slide.style.visibility = 'hidden';
        slide.classList.add('on');
      }
      const kinds = problemsOf(slide);
      if (hidden) {
        slide.classList.remove('on');
        slide.style.visibility = '';
      }
      // Marked in the editor's overview only: an audience never sees the marks.
      if (kinds.length > 0 && mode === 'preview') slide.setAttribute('data-problem', kinds.join(' '));
      else slide.removeAttribute('data-problem');
      if (kinds.length > 0) found.push({ slide: index, kinds });
    });
    post({ type: 'problems', slides: found });
  }

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (overviewOn) {
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(key)) {
        picked = clamp(picked + (key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1), 0, slides.length - 1);
        mark();
        slides[picked].scrollIntoView({ block: 'nearest' });
      } else if (key === 'Enter' || key === ' ') open(picked);
      else if (key === 'Escape' || key === 'o' || key === 'O') overview(false);
      else return;
      event.preventDefault();
      return;
    }
    if ((key === 'o' || key === 'O') && mode !== 'preview') overview(true);
    else if (key === 'p' || key === 'P') post({ type: 'key', key: 'p' });
    else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(key)) next();
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
    if (message.type === 'goto') {
      if (overviewOn && mode === 'preview') {
        picked = clamp(Number(message.slide) || 0, 0, slides.length - 1);
        mark();
        slides[picked].scrollIntoView({ block: 'nearest' });
      }
      go(Number(message.slide) || 0, Number(message.step) || 0);
    } else if (message.type === 'overview') overview(Boolean(message.on));
    else if (message.type === 'print') window.print();
  });
  window.addEventListener('afterprint', () => post({ type: 'printed' }));
  window.addEventListener('resize', () => {
    render(current, now, true);
    check();
  });
  if (document.fonts && document.fonts.ready)
    document.fonts.ready.then(() => {
      render(current, now, true);
      check();
    });

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
  check();
})();
