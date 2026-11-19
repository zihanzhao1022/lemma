/**
 * The blocks of a paper as the content of a slide: <lemma-block ref="label"> in a slide's markup is replaced by what
 * the block shows. A table becomes a table of the page's own, set the way the paper sets it (the rules, bold and
 * underlined numbers) and with every cell named (data-row, data-col), so a slide can point at one cell or one row;
 * a figure, a text block, or a table the page reader cannot read becomes a picture of the block's compiled PDF.
 */
import katex from 'katex';
import { DEFAULT_PREAMBLE } from '../../editor/tex/document';
import { t } from '../../lib/phrases/app';
import { ResultBlock, ResultPaper } from '../../types';
import { Context, Element, Inline, Look, Style, hasUnsupported, parseBlocks, readDefinitions } from '../writing/latexHtml';
import { captionOf } from './deck';
import { BLOCK_TAG, CHART_TAG, attributes, findBlock } from './blockTags';
import { escapeHtml } from './htmlDeck';

/** A picture of a block's compiled PDF as a data URL, or null when it has none. */
export type Picture = (block: ResultBlock) => Promise<string | null>;

/* ------------------------------------------------------------------ text */

const TAGS: Record<Style, (inner: string) => string> = {
  em: (inner) => `<i>${inner}</i>`,
  bf: (inner) => `<b>${inner}</b>`,
  tt: (inner) => `<code>${inner}</code>`,
  sc: (inner) => `<span class="sc">${inner}</span>`,
  sf: (inner) => `<span class="sf">${inner}</span>`,
  ul: (inner) => `<u>${inner}</u>`,
  sup: (inner) => `<sup>${inner}</sup>`,
  sub: (inner) => `<sub>${inner}</sub>`,
};

/** The colour and size the source set, as a style attribute's content. */
function lookCss(look?: Look): string {
  if (!look) return '';
  const parts: string[] = [];
  if (look.color) parts.push(`color:${look.color}`);
  if (look.size !== undefined && look.size !== 1) parts.push(`font-size:${look.size}em`);
  return parts.join(';');
}

const styled = (css: string, inner: string): string => (css ? `<span style="${escapeHtml(css)}">${inner}</span>` : inner);

/** Math as MathML: no fonts or style sheet to carry along. */
function math(tex: string, display: boolean, macros: Record<string, string>): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'mathml', macros: { ...macros }, strict: 'ignore' });
  } catch {
    return escapeHtml(tex);
  }
}

function inlineHtml(items: Inline[], macros: Record<string, string>): string {
  return items
    .map((item): string => {
      switch (item.kind) {
        case 'text': {
          let inner = escapeHtml(item.text);
          for (const style of item.styles) inner = TAGS[style](inner);
          return styled(lookCss(item.look), inner);
        }
        case 'math':
          return styled(lookCss(item.look), math(item.tex, item.display, macros));
        case 'cite':
          return escapeHtml(`[${item.keys.join(', ')}]`);
        case 'ref':
          return escapeHtml(item.labels.join(', '));
        case 'link':
          return escapeHtml(item.text);
        case 'footnote':
          return '';
        case 'break':
          return '<br>';
        case 'rule': {
          const css = [`width:${item.width}`, `height:${item.height}`, ...(item.raise ? [`vertical-align:${item.raise}`] : []), ...(item.color ? [`background:${item.color}`] : [])].join(';');
          return `<span class="rule" style="${escapeHtml(css)}"></span>`;
        }
        case 'raw':
          return item.content ? inlineHtml(item.content, macros) : escapeHtml(item.text);
      }
    })
    .join('');
}

/** What a cell says, as words: its text, or its math where it has no text (a header of only $\Delta$). */
function plainOf(items: Inline[]): string {
  const words = (kind: 'text' | 'math') => {
    const of = (list: Inline[]): string =>
      list
        .map((item) => {
          if (item.kind === 'text') return kind === 'text' ? item.text : '';
          if (item.kind === 'math') return kind === 'math' ? item.tex : '';
          if (item.kind === 'raw') return item.content ? of(item.content) : kind === 'text' ? item.text : '';
          if (item.kind === 'link') return kind === 'text' ? item.text : '';
          return '';
        })
        .join('');
    return of(items).replace(/\s+/g, ' ').trim();
  };
  return words('text') || words('math');
}

/* ------------------------------------------------------------------ tables */

type TableElement = Extract<Element, { kind: 'table' }>;

/** The first table of a block's LaTeX, read as the page reads it; null when the block has none or has what the page cannot show. */
function readTable(block: ResultBlock, preamble: string): { table: TableElement; macros: Record<string, string> } | null {
  const source = block.source ?? '';
  const definitions = readDefinitions(preamble);
  const context: Context = { definitions, labels: [] };
  const elements = parseBlocks(source, 0, source.length, context);
  if (hasUnsupported(elements)) return null;
  const table = elements.find((element): element is TableElement => element.kind === 'table');
  return table && table.rows.length > 0 ? { table, macros: definitions.math } : null;
}

const attr = (name: string, value: string | number | undefined): string => (value === undefined || value === '' ? '' : ` ${name}="${escapeHtml(String(value))}"`);

/**
 * Where a table's header ends (the rows down to the first one a rule falls under: the reader puts a rule above the
 * row it comes before, \midrule, and below the last one, \bottomrule) and the header's text over each column (a
 * cell that spans columns names the first of them).
 */
function headerOf(table: TableElement): { headerAt: number; columns: string[] } {
  const found = table.rows.findIndex((row, index) => index + 1 < table.rows.length && (row.below || table.rows[index + 1].above));
  const headerAt = found < 0 ? 0 : found;
  const columns: string[] = [];
  let column = 0;
  for (const cell of table.rows[headerAt].cells) {
    columns[column] = plainOf(cell.content);
    column += cell.span;
  }
  return { headerAt, columns };
}

/**
 * A table block as <table> markup. Its header is the rows down to the first one a rule falls under. Every cell
 * knows its row (the text of the row's first cell) and its column (the text of the header over it) as data-row and
 * data-col, and its place as data-r and data-c; each row says which rules touch it as data-above and data-below.
 */
export function tableHtml(block: ResultBlock, preamble: string): string | null {
  const read = readTable(block, preamble);
  if (!read) return null;
  const { table, macros } = read;
  const { headerAt, columns } = headerOf(table);
  const rowHtml = (row: TableElement['rows'][number], index: number): string => {
    const label = index > headerAt ? plainOf(row.cells[0]?.content ?? []) : '';
    let at = 0;
    const cells = row.cells
      .map((cell, order) => {
        const start = at;
        at += cell.span;
        const head = index <= headerAt || order === 0;
        const tag = head ? 'th' : 'td';
        const style = [cell.align === 'c' ? 'text-align:center' : cell.align === 'r' ? 'text-align:right' : 'text-align:left', ...(cell.background ? [`background:${cell.background}`] : [])].join(';');
        return `<${tag}${cell.span > 1 ? attr('colspan', cell.span) : ''}${cell.wrap ? ' class="wrap"' : ''}${attr('style', style)}${attr('data-row', label)}${attr('data-col', columns[start])}${attr('data-r', index)}${attr('data-c', start)}><span class="n">${inlineHtml(cell.content, macros)}</span></${tag}>`;
      })
      .join('');
    return `<tr${attr('data-r', index)}${attr('data-row', label)}${attr('data-above', row.above)}${attr('data-below', row.below)}${attr('style', row.background ? `background-color:${row.background}` : '')}>${cells}</tr>`;
  };
  const head = table.rows.slice(0, headerAt + 1).map((row, index) => rowHtml(row, index));
  const body = table.rows.slice(headerAt + 1).map((row, index) => rowHtml(row, headerAt + 1 + index));
  return `<table><thead>${head.join('')}</thead><tbody>${body.join('')}</tbody></table>`;
}

/* ------------------------------------------------------------------ charts */

/** A bar's number: the first number in the cell's text ("42.2", "42.2 ± 0.3", "−1.5"), as written and as a value. */
function numberIn(text: string): { text: string; value: number } | null {
  const found = /[-−]?\d+(?:\.\d+)?/.exec(text);
  return found ? { text: found[0].replace('−', '-'), value: Number(found[0].replace('−', '-')) } : null;
}

const decimalsOf = (text: string): number => text.split('.')[1]?.length ?? 0;
const isBold = (items: Inline[]): boolean => items.some((item) => (item.kind === 'text' && item.styles.includes('bf')) || (item.kind === 'raw' && !!item.content && isBold(item.content)));
/** Header and row names compared by their letters and digits only: "EM ↑" is EM. */
const key = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** An end for the axis a little past the largest value, at 1, 2, 2.5 or 5 times a power of ten, and its step. */
export function axisFor(largest: number): { max: number; step: number } {
  if (!(largest > 0)) return { max: 1, step: 0.2 };
  const rough = largest / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power;
  return { max: Math.ceil(largest / step - 1e-9) * step, step };
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

export type ChartResult = { html: string } | { problem: 'not-table' | 'no-column' | 'no-numbers'; column?: string };

/**
 * A bar chart of one column of a table block, row by row: <lemma-chart ref="tab:main" col="EM">. Optional:
 * rows="A; B; Ours" (which rows, in this order; all with a number when left out), ours="Ours" (the row drawn in the
 * accent colour; the row whose number is bold when left out), base="Method E" (a dashed line at that row's number,
 * and the gain over it, shown at a step: step="1" when left out), max="50" (the end of the axis).
 * Each number keeps its row and column (data-row, data-col) as the table's cells do, so the numbers of `ours` and
 * `base` can travel from the table on the slide before or after (runtime.js).
 */
export function chartHtml(block: ResultBlock, preamble: string, given: Record<string, string>): ChartResult {
  const read = block.kind === 'table' ? readTable(block, preamble) : null;
  if (!read) return { problem: 'not-table' };
  const { table } = read;
  const { headerAt, columns } = headerOf(table);
  const wanted = (given.col ?? '').trim();
  const byIndex = /^\d+$/.test(wanted) ? Number(wanted) : -1;
  let at = byIndex >= 0 && byIndex < columns.length ? byIndex : columns.findIndex((name) => name !== undefined && key(name) === key(wanted));
  if (at < 0 && wanted) at = columns.findIndex((name) => name !== undefined && key(name).startsWith(key(wanted)));
  if (at <= 0) return { problem: 'no-column', column: wanted };
  const column = columns[at];

  // Each body row with a name and a number in that column.
  const found: { label: string; number: { text: string; value: number }; bold: boolean }[] = [];
  for (const row of table.rows.slice(headerAt + 1)) {
    let start = 0;
    const cell = row.cells.find((item) => {
      const here = start;
      start += item.span;
      return here === at;
    });
    const label = plainOf(row.cells[0]?.content ?? []);
    const number = cell ? numberIn(plainOf(cell.content)) : null;
    if (label && number) found.push({ label, number, bold: isBold(cell?.content ?? []) });
  }
  const chosen = given.rows
    ? given.rows
        .split(';')
        .map((name) => found.find((item) => key(item.label) === key(name)))
        .filter((item): item is (typeof found)[number] => !!item)
    : found;
  if (chosen.length === 0) return { problem: 'no-numbers', column };

  const pick = (name: string | undefined) => (name ? chosen.find((item) => key(item.label) === key(name)) : undefined);
  const ours = pick(given.ours) ?? chosen.find((item) => item.bold);
  const base = pick(given.base);
  const step = Math.max(1, Math.round(Number(given.step) || 1));
  const largest = Math.max(...chosen.map((item) => item.number.value), base?.number.value ?? 0);
  const asked = Number(given.max);
  const axis = asked > 0 ? { max: asked, step: axisFor(asked).step } : axisFor(largest);
  const ticks: number[] = [];
  for (let value = 0; value <= axis.max + 1e-9; value += axis.step) ticks.push(round(value));

  const grid = ticks.map((value) => `<i style="--x:${value}" data-t="${value}"></i>`).join('');
  const marker = base ? `<div class="marker"${attr('data-step', step)} style="--b:${base.number.value}"><em>${escapeHtml(base.label)} ${escapeHtml(base.number.text)}</em></div>` : '';
  const rows = chosen
    .map((item) => {
      const mine = item === ours;
      const moves = mine || item === base;
      const gain = mine && base && item.number.value > base.number.value ? item.number.value - base.number.value : 0;
      const decimals = Math.max(decimalsOf(item.number.text), decimalsOf(base?.number.text ?? ''));
      const extra = gain
        ? `<i class="gain"${attr('data-step', step)}></i><span class="gainlab"${attr('data-step', step)}>+${escapeHtml(gain.toFixed(decimals))}</span>`
        : '';
      const value = `<span class="val"${attr('data-row', item.label)}${attr('data-col', column)}${moves ? ' data-move=""' : ''}>${escapeHtml(item.number.text)}</span>`;
      const style = `--v:${Math.max(0, item.number.value)}${gain && base ? `;--b:${base.number.value}` : ''}`;
      return `<div class="row${mine ? ' ours' : ''}" style="${style}"><span class="lab">${escapeHtml(item.label)}</span><div class="track"><i class="bar"></i>${extra}${value}</div></div>`;
    })
    .join('');
  // The names' column as wide as the longest name needs (about 1.1cqw a letter at the chart's size, in bold), within reason.
  const longest = Math.max(...chosen.map((item) => item.label.length));
  const names = Math.min(32, Math.max(8, Math.round(longest * 1.1 + 2)));
  // Room after the axis for the number at a bar's end, and the gain after it.
  const tail = base ? 13 : 6;
  return { html: `<div class="plot" style="--max:${axis.max};--lab:${names}cqw;--tail:${tail}cqw"><div class="grid">${grid}${marker}</div>${rows}</div>` };
}

/** The columns of a table block a chart can be drawn from: the header's text over each column with numbers. */
export function chartColumns(block: ResultBlock, preamble: string): string[] {
  const read = block.kind === 'table' ? readTable(block, preamble) : null;
  if (!read) return [];
  const { columns } = headerOf(read.table);
  return columns.flatMap((name, at) => (at > 0 && name && 'html' in chartHtml(block, preamble, { col: String(at) }) ? [name] : []));
}

/* ------------------------------------------------------------------ the tag */

export { findBlock, refsIn } from './blockTags';

async function resolveOne(given: Record<string, string>, paper: ResultPaper, picture: Picture): Promise<string> {
  const ref = (given.ref ?? '').trim();
  const shared = attr('data-ref', ref);
  const block = findBlock(paper, ref);
  if (!block) return `<div class="block missing"${shared}>${escapeHtml(t('这个块已经删除'))}</div>`;
  if (block.kind === 'table') {
    const table = tableHtml(block, paper.preamble ?? DEFAULT_PREAMBLE);
    if (table) return `<div class="block tbl"${shared}${attr('data-focus', given.focus)}>${table}</div>`;
  }
  const source = await picture(block);
  if (source) return `<div class="block pic"${shared}><img src="${source}" alt="${escapeHtml(captionOf(block.source) || ref)}"></div>`;
  return `<div class="block missing"${shared}>${escapeHtml(t('这个块还没有编译'))}</div>`;
}

function resolveChart(given: Record<string, string>, paper: ResultPaper): string {
  const ref = (given.ref ?? '').trim();
  const shared = attr('data-ref', ref);
  const block = findBlock(paper, ref);
  if (!block) return `<div class="block missing"${shared}>${escapeHtml(t('这个块已经删除'))}</div>`;
  const chart = chartHtml(block, paper.preamble ?? DEFAULT_PREAMBLE, given);
  if ('html' in chart) return `<div class="block chart"${shared}${attr('data-col', given.col)}>${chart.html}</div>`;
  const problem =
    chart.problem === 'not-table'
      ? t('图只能从读得出的表格块画出来')
      : chart.problem === 'no-column'
        ? t('表格里没有这一列：{col}', { col: chart.column || '?' })
        : t('这一列没有数字：{col}', { col: chart.column || '?' });
  return `<div class="block missing"${shared}>${escapeHtml(problem)}</div>`;
}

/**
 * The markup with each <lemma-block ref="…"> replaced by its block, and each <lemma-chart ref="…" col="…"> by a
 * chart of that table's column. `focus="…"` on a block's tag (steps that point at the cells of a table, see
 * runtime.js) goes on as data-focus.
 */
export async function resolveBlocks(html: string, paper: ResultPaper, picture: Picture): Promise<string> {
  const matches = [...html.matchAll(BLOCK_TAG), ...html.matchAll(CHART_TAG)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (matches.length === 0) return html;
  const parts = await Promise.all(
    matches.map((match) => (/^<lemma-chart/i.test(match[0]) ? resolveChart(attributes(match[1]), paper) : resolveOne(attributes(match[1]), paper, picture))),
  );
  let out = '';
  let at = 0;
  matches.forEach((match, index) => {
    const from = match.index ?? 0;
    out += html.slice(at, from) + parts[index];
    at = from + match[0].length;
  });
  return out + html.slice(at);
}
