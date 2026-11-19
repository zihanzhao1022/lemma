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
import { escapeHtml, unescapeHtml } from './htmlDeck';

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
 * A table block as <table> markup. Its header is the rows down to the first one a rule falls under. Every cell
 * knows its row (the text of the row's first cell) and its column (the text of the header over it) as data-row and
 * data-col, and its place as data-r and data-c; each row says which rules touch it as data-above and data-below.
 */
export function tableHtml(block: ResultBlock, preamble: string): string | null {
  const read = readTable(block, preamble);
  if (!read) return null;
  const { table, macros } = read;
  // The reader puts a rule above the row it comes before (\midrule) and below the last one (\bottomrule).
  const found = table.rows.findIndex((row, index) => index + 1 < table.rows.length && (row.below || table.rows[index + 1].above));
  const headerAt = found < 0 ? 0 : found;
  // The header's text over each column (a cell that spans columns names the first of them).
  const columns: string[] = [];
  let column = 0;
  for (const cell of table.rows[headerAt].cells) {
    columns[column] = plainOf(cell.content);
    column += cell.span;
  }
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

/* ------------------------------------------------------------------ the tag */

const TAG = /<lemma-block\b([^>]*?)\/?>(?:\s*<\/lemma-block>)?/gi;
const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) found[match[1].toLowerCase()] = unescapeHtml(match[2] ?? match[3] ?? '');
  return found;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The block a ref names: its id, a label of its compiled output, or a \label in its LaTeX (a block not compiled yet has no output). */
export function findBlock(paper: ResultPaper, ref: string): ResultBlock | undefined {
  if (!ref) return undefined;
  const label = new RegExp(`\\\\label\\s*\\{${escapeRegExp(ref)}\\}`);
  return (
    paper.blocks.find((block) => block.id === ref) ??
    paper.blocks.find((block) => Object.keys(block.output?.labels ?? {}).includes(ref)) ??
    paper.blocks.find((block) => label.test(block.source ?? ''))
  );
}

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

/**
 * The markup with each <lemma-block ref="…"> replaced by its block. `focus="…"` on the tag (steps that point at the
 * cells of a table, see runtime.js) goes on as data-focus.
 */
export async function resolveBlocks(html: string, paper: ResultPaper, picture: Picture): Promise<string> {
  const matches = [...html.matchAll(TAG)];
  if (matches.length === 0) return html;
  const parts = await Promise.all(matches.map((match) => resolveOne(attributes(match[1]), paper, picture)));
  let out = '';
  let at = 0;
  matches.forEach((match, index) => {
    const from = match.index ?? 0;
    out += html.slice(at, from) + parts[index];
    at = from + match[0].length;
  });
  return out + html.slice(at);
}

/** The refs a deck's slides name. */
export const refsIn = (html: string): string[] => [...new Set([...html.matchAll(TAG)].map((match) => (attributes(match[1]).ref ?? '').trim()).filter(Boolean))];
