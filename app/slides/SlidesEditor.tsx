import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, Bold, Copy, Heading, Maximize2, Minus, Plus, Trash2, Type } from 'lucide-react';
import type { ReadFile } from '../../editor/results/actions';
import { blockNumber } from '../../lib/headings';
import { useT } from '../../lib/phrases/app';
import { ResultBlock, ResultPaper, Slide, SlideDeck, SlideElement, SlideText } from '../../types';
import Menu, { MenuItem } from '../Menu';
import {
  CONTENT_BOX,
  Corner,
  Layout,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  aspectOf,
  blockElement,
  bodyText,
  captionOf,
  fit,
  moved,
  newId,
  newSlide,
  plain,
  resized,
  snapped,
  titleText,
} from './deck';
import SlideView, { BODY_FONT, BlockPicture, TITLE_FONT } from './SlideView';

interface Props {
  paper: ResultPaper;
  deck: SlideDeck;
  readFile: ReadFile;
  /** Every change, as the whole deck; the caller saves it. */
  onChange: (deck: SlideDeck) => void;
  current: number;
  onCurrent: (index: number) => void;
  /** Whether the editor's keys work: not while it is hidden or the deck is being presented over it. */
  active: boolean;
  /** Set to a function that puts what is being typed (notes, a text box) into the deck, for before leaving. */
  drafts?: React.MutableRefObject<(() => void) | null>;
}

interface Drag {
  id: string;
  mode: 'move' | Corner;
  start: { x: number; y: number };
  origin: SlideElement;
}

const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];
const replaceSlide = (deck: SlideDeck, index: number, slide: Slide): SlideDeck => ({ ...deck, slides: deck.slides.map((item, at) => (at === index ? slide : item)) });
const replaceElement = (slide: Slide, element: SlideElement): Slide => ({ ...slide, elements: slide.elements.map((item) => (item.id === element.id ? element : item)) });

/** What a block is called in the insert list: "表 1  Caption", "图 2", or a text block's first words. */
function blockName(paper: ResultPaper, block: ResultBlock, index: number, label: (kind: 'figure' | 'table', number?: string) => string, textName: string): string {
  if (block.kind === 'figure' || block.kind === 'table') {
    const caption = captionOf(block.source);
    const name = label(block.kind, blockNumber(paper.blocks, index));
    return caption ? `${name}  ${caption}` : name;
  }
  const words = plain((block.source ?? '').replace(/\\(?:sub)*section\*?\{([^}]*)\}/, '$1:'));
  return words ? words.slice(0, 48) : textName;
}

/**
 * The visual slide editor: the deck's slides on the left, the slide being edited in the middle (drag to move,
 * corners to resize, double click to type, guides at the center and margins), and on the right what can go on
 * it: titles, text and the paper's own blocks, which stay vector and follow the paper when it changes.
 */
const SlidesEditor: React.FC<Props> = ({ paper, deck, readFile, onChange, current, onCurrent, active, drafts }) => {
  const t = useT();
  const index = Math.min(current, deck.slides.length - 1);
  const slide = deck.slides[index];
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [draft, setDraft] = useState<SlideElement | null>(null);
  const draftRef = useRef<SlideElement | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const drag = useRef<Drag | null>(null);
  const history = useRef<{ past: SlideDeck[]; future: SlideDeck[] }>({ past: [], future: [] });
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 800, height: 450 });
  const [notes, setNotes] = useState(slide?.notes ?? '');
  const notesBox = useRef<HTMLTextAreaElement>(null);
  const notesOf = useRef(slide?.id);

  // Another slide's notes, or this slide's changed by undo or redo, unless they are being typed.
  useEffect(() => {
    if (notesOf.current !== slide?.id || document.activeElement !== notesBox.current) setNotes(slide?.notes ?? '');
    notesOf.current = slide?.id;
  }, [slide?.id, slide?.notes]);
  useEffect(() => {
    setSelected(null);
    setEditing(null);
  }, [index]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const measure = () => setRoom({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const width = Math.max(320, Math.min(room.width - 48, ((room.height - 32) * SLIDE_WIDTH) / SLIDE_HEIGHT));
  const scale = width / SLIDE_WIDTH;

  const commit = useCallback(
    (next: SlideDeck) => {
      history.current = { past: [...history.current.past.slice(-99), deck], future: [] };
      onChange(next);
    },
    [deck, onChange],
  );
  const undo = useCallback(() => {
    const previous = history.current.past.pop();
    if (!previous) return;
    history.current.future.push(deck);
    onChange(previous);
  }, [deck, onChange]);
  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(deck);
    onChange(next);
  }, [deck, onChange]);

  const updateSlide = (next: Slide) => commit(replaceSlide(deck, index, next));
  const element = slide?.elements.find((item) => item.id === selected) ?? null;
  const shown = useMemo(() => (slide && draft ? replaceElement(slide, draft) : slide), [slide, draft]);

  const remove = useCallback(
    (id: string) => {
      if (!slide) return;
      commit(replaceSlide(deck, index, { ...slide, elements: slide.elements.filter((item) => item.id !== id) }));
      setSelected(null);
    },
    [slide, deck, index, commit],
  );
  const duplicate = useCallback(
    (id: string) => {
      const original = slide?.elements.find((item) => item.id === id);
      if (!slide || !original) return;
      const copy = { ...moved(original, 20, 20), id: newId('el') };
      commit(replaceSlide(deck, index, { ...slide, elements: [...slide.elements, copy] }));
      setSelected(copy.id);
    },
    [slide, deck, index, commit],
  );

  // Keys work on the slide while the editor is in view, unless the owner is typing somewhere or another part of
  // the page has taken the key.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.defaultPrevented || editing || document.querySelector('[aria-modal="true"]') || target?.closest('input, textarea, [contenteditable="true"], .cm-editor, [role="dialog"]')) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (!element || !slide) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        remove(element.id);
      } else if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicate(element.id);
      } else if (event.key === 'Escape') setSelected(null);
      else if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        const step = event.shiftKey ? 50 : 10;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        updateSlide(replaceElement(slide, moved(element, dx, dy)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** A block's shape as its block is compiled now (it may have changed since it was placed); text has none. */
  const shapeOf = (item: SlideElement): number | undefined => {
    if (item.type !== 'block') return undefined;
    const block = paper.blocks.find((candidate) => candidate.id === item.blockId);
    return block?.output ? aspectOf(block) : item.w / item.h;
  };

  const toUnits = (event: React.PointerEvent): { x: number; y: number } => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale };
  };
  const hit = (point: { x: number; y: number }): SlideElement | undefined =>
    [...(slide?.elements ?? [])].reverse().find((item) => point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h);

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (editing || event.button !== 0) return;
    const point = toUnits(event);
    const corner = (event.target as HTMLElement).dataset.corner as Corner | undefined;
    const target = corner && element ? element : hit(point);
    if (!target) {
      setSelected(null);
      return;
    }
    setSelected(target.id);
    drag.current = { id: target.id, mode: corner ?? 'move', start: point, origin: target };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks; the drag still follows moves over the slide.
    }
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragging = drag.current;
    if (!dragging) return;
    const point = toUnits(event);
    const dx = point.x - dragging.start.x;
    const dy = point.y - dragging.start.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    let next: SlideElement;
    if (dragging.mode === 'move') {
      const shifted = moved(dragging.origin, dx, dy);
      const x = snapped(shifted.x, shifted.w, SLIDE_WIDTH);
      const y = snapped(shifted.y, shifted.h, SLIDE_HEIGHT);
      setGuides({ x: x.guide, y: y.guide });
      next = moved({ ...shifted, x: x.value, y: y.value }, 0, 0);
    } else {
      next = resized(dragging.origin, dragging.mode, dx, dy, shapeOf(dragging.origin));
    }
    // Kept at once too: the pointer can be let go before React draws the move.
    draftRef.current = next;
    setDraft(next);
  };
  const pointerUp = () => {
    const finished = draftRef.current;
    draftRef.current = null;
    drag.current = null;
    setGuides({});
    setDraft(null);
    if (finished && slide) updateSlide(replaceElement(slide, finished));
  };

  // What is being typed and not yet put into the deck (it is when the field loses focus), on request; nothing
  // once the editor is gone (the deck may have been dropped or replaced since).
  useEffect(
    () => () => {
      if (drafts) drafts.current = null;
    },
    [drafts],
  );
  if (drafts) {
    drafts.current = () => {
      if (!slide) return;
      let next = slide;
      const original = editing ? slide.elements.find((item) => item.id === editing.id) : undefined;
      if (editing && original?.type === 'text' && original.text !== editing.text) next = replaceElement(next, { ...original, text: editing.text });
      if (notes !== (slide.notes ?? '')) next = { ...next, notes };
      if (next !== slide) updateSlide(next);
    };
  }

  const startEditing = (target: SlideElement | undefined) => {
    if (target?.type === 'text') setEditing({ id: target.id, text: target.text });
  };
  const finishEditing = () => {
    if (!editing || !slide) return;
    const original = slide.elements.find((item) => item.id === editing.id);
    if (original?.type === 'text' && original.text !== editing.text) updateSlide(replaceElement(slide, { ...original, text: editing.text }));
    setEditing(null);
  };

  const add = (next: SlideElement, edit = false) => {
    if (!slide) return;
    updateSlide({ ...slide, elements: [...slide.elements, next] });
    setSelected(next.id);
    if (edit && next.type === 'text') setEditing({ id: next.id, text: next.text });
  };
  const hasTitle = slide?.elements.some((item) => item.type === 'text' && item.role === 'title') ?? false;
  const insertBlock = (block: ResultBlock) => add(blockElement(block, newId('el'), hasTitle ? CONTENT_BOX : { x: 80, y: 60, w: SLIDE_WIDTH - 160, h: SLIDE_HEIGHT - 120 }));

  const addSlide = (layout: Layout) => {
    const made = newSlide(layout);
    const slides = [...deck.slides.slice(0, index + 1), made, ...deck.slides.slice(index + 1)];
    commit({ ...deck, slides });
    onCurrent(index + 1);
  };
  const moveSlide = (step: -1 | 1) => {
    const to = index + step;
    if (to < 0 || to >= deck.slides.length) return;
    const slides = [...deck.slides];
    [slides[index], slides[to]] = [slides[to], slides[index]];
    commit({ ...deck, slides });
    onCurrent(to);
  };
  const deleteSlide = () => {
    if (deck.slides.length <= 1) return;
    commit({ ...deck, slides: deck.slides.filter((_, at) => at !== index) });
    onCurrent(Math.max(0, index - 1));
  };
  const duplicateSlide = () => {
    if (!slide) return;
    const copy: Slide = { ...slide, id: newId('slide'), elements: slide.elements.map((item) => ({ ...item, id: newId('el') })) };
    commit({ ...deck, slides: [...deck.slides.slice(0, index + 1), copy, ...deck.slides.slice(index + 1)] });
    onCurrent(index + 1);
  };

  const label = (kind: 'figure' | 'table', number?: string) => (kind === 'figure' ? (number ? t('图 {n}', { n: number }) : t('图')) : number ? t('表 {n}', { n: number }) : t('表格'));
  const blocks = paper.blocks.flatMap((block, at) => (block.output ? [{ block, name: blockName(paper, block, at, label, t('文字')) }] : []));
  const editingElement = editing ? (slide?.elements.find((item) => item.id === editing.id) as SlideText | undefined) : undefined;
  const tool = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900 disabled:opacity-40';
  const textElement = element?.type === 'text' ? element : null;
  const setText = (change: Partial<SlideText>) => textElement && slide && updateSlide(replaceElement(slide, { ...textElement, ...change }));

  if (!slide) return null;

  return (
    <div className="flex h-full min-h-0">
      {/* The deck's slides. */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-black/[0.06] bg-[#f5f5f7]">
        <div className="flex items-center gap-0.5 border-b border-black/[0.06] px-2 py-2">
          <Menu label={t('新幻灯片')} align="left" className={tool} trigger={<><Plus size={14} />{t('新幻灯片')}</>}>
            {(close) => (
              <>
                <MenuItem onSelect={() => { addSlide('title-content'); close(); }}>{t('标题和内容')}</MenuItem>
                <MenuItem onSelect={() => { addSlide('title'); close(); }}>{t('只有标题')}</MenuItem>
                <MenuItem onSelect={() => { addSlide('blank'); close(); }}>{t('空白')}</MenuItem>
              </>
            )}
          </Menu>
          <span className="ml-auto flex">
            <button type="button" onClick={() => moveSlide(-1)} disabled={index === 0} aria-label={t('上移')} title={t('上移')} className={tool}>
              <ArrowUp size={14} />
            </button>
            <button type="button" onClick={() => moveSlide(1)} disabled={index === deck.slides.length - 1} aria-label={t('下移')} title={t('下移')} className={tool}>
              <ArrowDown size={14} />
            </button>
            <button type="button" onClick={duplicateSlide} aria-label={t('复制这一页')} title={t('复制这一页')} className={tool}>
              <Copy size={14} />
            </button>
            <button type="button" onClick={deleteSlide} disabled={deck.slides.length <= 1} aria-label={t('删除这一页')} title={t('删除这一页')} className={tool}>
              <Trash2 size={14} />
            </button>
          </span>
        </div>
        <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {deck.slides.map((item, at) => (
            <li key={item.id} className="flex gap-2">
              <span className="w-4 pt-1 text-right text-xs tabular-nums text-gray-400">{at + 1}</span>
              <button
                type="button"
                onClick={() => onCurrent(at)}
                aria-label={t('第 {n} 页', { n: at + 1 })}
                aria-current={at === index}
                className={`overflow-hidden rounded-md transition-shadow duration-150 ${at === index ? 'ring-2 ring-violet-500 ring-offset-1' : 'ring-1 ring-black/10 hover:ring-black/25'}`}
              >
                <SlideView slide={item} paper={paper} readFile={readFile} width={176} />
              </button>
            </li>
          ))}
        </ol>
      </aside>

      {/* The slide being edited, and its notes. */}
      <section className="flex min-w-0 flex-1 flex-col bg-[#e9e9ec]">
        <div ref={stage} className="flex min-h-0 flex-1 items-center justify-center">
          <div className="shadow-[0_2px_8px_rgba(0,0,0,0.12),0_24px_48px_-24px_rgba(0,0,0,0.35)]">
            <SlideView slide={shown ?? slide} paper={paper} readFile={readFile} width={width} skip={editing?.id}>
              <div
                className="absolute inset-0 touch-none"
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={pointerUp}
                onDoubleClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  startEditing(hit({ x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale }));
                }}
              >
                {(shown ?? slide).elements.map((item) => {
                  const chosen = item.id === selected;
                  if (!chosen && editing?.id !== item.id) return null;
                  return (
                    <div
                      key={item.id}
                      className={`pointer-events-none absolute ${chosen ? 'outline outline-2 outline-violet-500' : ''}`}
                      style={{ left: item.x * scale, top: item.y * scale, width: item.w * scale, height: item.h * scale }}
                    >
                      {chosen && !editing &&
                        CORNERS.map((corner) => (
                          <span
                            key={corner}
                            data-corner={corner}
                            className={`pointer-events-auto absolute h-3 w-3 rounded-sm border-2 border-violet-500 bg-white ${
                              { nw: '-left-1.5 -top-1.5 cursor-nwse-resize', ne: '-right-1.5 -top-1.5 cursor-nesw-resize', sw: '-bottom-1.5 -left-1.5 cursor-nesw-resize', se: '-bottom-1.5 -right-1.5 cursor-nwse-resize' }[corner]
                            }`}
                          />
                        ))}
                    </div>
                  );
                })}
                {guides.x !== undefined && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-violet-500/70" style={{ left: guides.x * scale }} />}
                {guides.y !== undefined && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 h-px bg-violet-500/70" style={{ top: guides.y * scale }} />}
                {editing && editingElement && (
                  <textarea
                    autoFocus
                    value={editing.text}
                    onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                    onBlur={finishEditing}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditing(null);
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) finishEditing();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    placeholder={editingElement.role === 'title' ? t('标题') : t('写点什么；以 - 开头的行是要点')}
                    className="absolute resize-none border border-dashed border-violet-400 bg-white/90 p-0 outline-none"
                    style={{
                      left: editingElement.x * scale,
                      top: editingElement.y * scale,
                      width: editingElement.w * scale,
                      height: editingElement.h * scale,
                      fontFamily: editingElement.role === 'title' ? TITLE_FONT : BODY_FONT,
                      fontSize: editingElement.size * scale,
                      fontWeight: editingElement.bold ? 700 : 400,
                      lineHeight: 1.3,
                      textAlign: editingElement.align ?? 'left',
                    }}
                  />
                )}
              </div>
            </SlideView>
          </div>
        </div>
        <label className="block shrink-0 border-t border-black/[0.06] bg-white px-4 py-2">
          <span className="text-xs text-gray-500">{t('演讲备注')}</span>
          <textarea
            ref={notesBox}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            onBlur={() => notes !== (slide.notes ?? '') && updateSlide({ ...slide, notes })}
            rows={2}
            placeholder={t('这一页要讲什么（导出 PowerPoint 时放进备注）')}
            className="mt-1 w-full resize-none rounded-md border border-black/10 px-2 py-1 text-sm outline-none focus:border-violet-400"
          />
        </label>
      </section>

      {/* What the selected element looks like, and what can go on the slide. */}
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-black/[0.06] bg-white">
        {element && (
          <div className="space-y-3 border-b border-black/[0.06] p-4">
            <p className="text-xs font-medium text-gray-500">{textElement ? t('文字') : t('论文里的块')}</p>
            {textElement && (
              <>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setText({ size: Math.max(14, textElement.size - 4) })} aria-label={t('字小一点')} title={t('字小一点')} className={tool}>
                    <Minus size={14} />
                  </button>
                  <span className="w-10 text-center text-sm tabular-nums">{Math.round(textElement.size * 0.6)}</span>
                  <button type="button" onClick={() => setText({ size: Math.min(160, textElement.size + 4) })} aria-label={t('字大一点')} title={t('字大一点')} className={tool}>
                    <Plus size={14} />
                  </button>
                  <span className="ml-2 text-xs text-gray-400">pt</span>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setText({ bold: !textElement.bold })} aria-pressed={Boolean(textElement.bold)} aria-label={t('加粗')} title={t('加粗')} className={`${tool} ${textElement.bold ? 'bg-violet-50 text-violet-700' : ''}`}>
                    <Bold size={14} />
                  </button>
                  <button type="button" onClick={() => setText({ role: textElement.role === 'title' ? 'body' : 'title' })} aria-pressed={textElement.role === 'title'} title={t('标题字体（衬线）')} className={`${tool} ${textElement.role === 'title' ? 'bg-violet-50 text-violet-700' : ''}`}>
                    <Heading size={14} />
                  </button>
                  <span className="mx-1 h-4 w-px bg-black/10" />
                  {(['left', 'center', 'right'] as const).map((align) => {
                    const Icon = { left: AlignLeft, center: AlignCenter, right: AlignRight }[align];
                    return (
                      <button key={align} type="button" onClick={() => setText({ align })} aria-pressed={(textElement.align ?? 'left') === align} aria-label={{ left: t('左对齐'), center: t('居中'), right: t('右对齐') }[align]} className={`${tool} ${(textElement.align ?? 'left') === align ? 'bg-violet-50 text-violet-700' : ''}`}>
                        <Icon size={14} />
                      </button>
                    );
                  })}
                </div>
                <button type="button" onClick={() => startEditing(textElement)} className={tool}>
                  <Type size={14} />
                  {t('编辑文字')}
                </button>
              </>
            )}
            {element.type === 'block' && (
              <button
                type="button"
                onClick={() => updateSlide(replaceElement(slide, { ...element, ...fit(shapeOf(element) ?? element.w / element.h, hasTitle ? CONTENT_BOX : { x: 80, y: 60, w: SLIDE_WIDTH - 160, h: SLIDE_HEIGHT - 120 }) }))}
                className={tool}
              >
                <Maximize2 size={14} />
                {t('放大到整个内容区')}
              </button>
            )}
            <div className="flex gap-1">
              <button type="button" onClick={() => duplicate(element.id)} className={tool}>
                <Copy size={14} />
                {t('复制')}
              </button>
              <button type="button" onClick={() => remove(element.id)} className={`${tool} text-red-600 hover:text-red-700`}>
                <Trash2 size={14} />
                {t('删除')}
              </button>
            </div>
          </div>
        )}
        <div className="space-y-3 p-4">
          <p className="text-xs font-medium text-gray-500">{t('插入')}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => add(titleText(t('标题'), newId('el')), true)} className={`${tool} border border-black/10`}>
              <Heading size={14} />
              {t('标题')}
            </button>
            <button type="button" onClick={() => add(bodyText('- ', newId('el'), { x: 80, y: 220, w: 700, h: 300 }), true)} className={`${tool} border border-black/10`}>
              <Type size={14} />
              {t('文本框')}
            </button>
          </div>
          <p className="pt-2 text-xs font-medium text-gray-500">{t('论文里的块')}</p>
          <p className="text-xs leading-relaxed text-gray-400">{t('点一下放到这一页；论文里的块改了，幻灯片里的也跟着变。')}</p>
          <ul className="space-y-2">
            {blocks.map(({ block, name }) => (
              <li key={block.id}>
                <button type="button" onClick={() => insertBlock(block)} className="group w-full rounded-lg border border-black/[0.08] p-2 text-left transition-colors duration-150 hover:border-violet-300 hover:bg-violet-50/40">
                  <span className="mb-1.5 block truncate text-xs text-gray-600 group-hover:text-violet-700">{name}</span>
                  <span className="block overflow-hidden rounded bg-white" style={{ aspectRatio: block.output ? `${block.output.width} / ${block.output.height}` : '4 / 3', maxHeight: 140 }}>
                    <SlideBlockPreview block={block} readFile={readFile} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {blocks.length === 0 && <p className="text-xs text-gray-400">{t('这篇论文还没有编译好的块。')}</p>}
        </div>
      </aside>
    </div>
  );
};

/** A small picture of a block for the insert list. */
const SlideBlockPreview: React.FC<{ block: ResultBlock; readFile: ReadFile }> = ({ block, readFile }) =>
  block.output ? <BlockPicture path={block.output.pdf} readFile={readFile} width={240} /> : null;

export default SlidesEditor;
