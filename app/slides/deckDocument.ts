/**
 * A deck as one HTML document, the same one wherever it is shown: in the preview and the presentation (inside a
 * sandboxed frame), in the file a deck is exported to, and for printing. Its slides' blocks are already in place
 * (blockHtml.ts). The deck's markup may come from Claude Code, so the document keeps it from doing more than showing:
 * a content security policy lets no script run but the runtime's (named by a nonce made for this document), and
 * nothing leave or load from elsewhere.
 */
import { escapeHtml, HtmlDeck } from './htmlDeck';
import KIT from './kit.css?raw';
import RUNTIME from './runtime.js?raw';

export type DocumentMode = 'preview' | 'present' | 'export' | 'print';

export interface DocumentOptions {
  mode: DocumentMode;
  /** The slide and step to open at (0-based). */
  start?: { slide: number; step: number };
  /** The document's language, e.g. "zh-CN". */
  lang?: string;
  /** A nonce for the runtime's script; made here when left out. */
  nonce?: string;
}

function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A slide's markup without what could run or load: scripts, frames, objects, links to elsewhere, event handlers. */
export function cleanSlide(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/<(iframe|object|embed|frame|frameset|applet)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|object|embed|frame|link|meta|base|form)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(\s(?:href|src|xlink:href|action)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi, (whole, name: string, value: string) => (/^["']?\s*javascript:/i.test(value) ? `${name}"#"` : whole));
}

/** A slide as a <section class="slide"> with the foot (the deck's line and the page number) inside it. */
function sectionOf(html: string, foot: string): string {
  const cleaned = cleanSlide(html).trim();
  const section = /^<section\b/i.test(cleaned) ? cleaned : `<section class="slide">\n${cleaned}\n</section>`;
  return section.replace(/<\/section>\s*$/i, `${foot}</section>`);
}

export function buildDocument(deck: HtmlDeck, options: DocumentOptions): string {
  const nonce = options.nonce ?? makeNonce();
  const policy = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'`;
  const total = deck.slides.length;
  const sections = deck.slides
    .map((slide, index) => sectionOf(slide.html, `\n<div class="foot"><span>${escapeHtml(deck.footer)}</span><span>${index + 1} / ${total}</span></div>\n`))
    .join('\n');
  const start = options.start ? ` data-start="${Math.max(0, Math.floor(options.start.slide))}.${Math.max(0, Math.floor(options.start.step))}"` : '';
  // `</style` inside the deck's own style would end it early.
  const css = deck.css.replace(/<\/style/gi, '<\\/style');
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(options.lang ?? 'en')}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(deck.title)}</title>`,
    `<style>\n${KIT}\n</style>`,
    `<style id="deck">\n${css}\n</style>`,
    '</head>',
    `<body data-mode="${options.mode}"${start}>`,
    `<div class="stage">\n${sections}\n</div>`,
    `<script nonce="${nonce}">\n${RUNTIME}\n</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
