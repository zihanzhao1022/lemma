import { describe, expect, it } from 'vitest';
import RUNTIME from './runtime.js?raw';
import { buildDocument, cleanSlide } from './deckDocument';
import { HtmlDeck } from './htmlDeck';

const deck: HtmlDeck = {
  title: 'Made-up & "quoted"',
  footer: 'Ada Example et al. · Made-up Conf',
  brief: 'not in the document',
  css: ':root { --accent: #c00; }\n/* </style><b>out of the style</b> */',
  slides: [
    { id: 'cover', html: '<section class="slide cover"><h1 class="title">Cover</h1></section>' },
    { id: 'a', html: '<h1 class="title">No section around me</h1><p onclick="steal()">text</p>' },
    { id: 'b', html: '<section class="slide"><h1 class="title">B</h1><script>steal()</script><iframe src="https://x.test"></iframe></section>' },
  ],
};

describe('the runtime', () => {
  it('is script that parses, and cannot end its own tag', () => {
    expect(() => new Function(RUNTIME)).not.toThrow();
    expect(RUNTIME).not.toMatch(/<\/script/i);
  });
});

describe('a deck as a document', () => {
  const nonce = 'abc123';
  const html = buildDocument(deck, { mode: 'present', nonce, lang: 'zh-CN' });

  it('says first what may run: the runtime named by the nonce, and nothing from or to elsewhere', () => {
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    expect(head.indexOf('Content-Security-Policy')).toBeLessThan(head.indexOf('<title>'));
    expect(head).toContain("default-src 'none'");
    expect(head).toContain(`script-src 'nonce-${nonce}'`);
    expect(head).toContain("form-action 'none'");
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="${nonce}">`);
  });

  it('makes a nonce of its own for each document, unless given one', () => {
    const a = /nonce-([0-9a-f]+)/.exec(buildDocument(deck, { mode: 'present' }))?.[1];
    const b = /nonce-([0-9a-f]+)/.exec(buildDocument(deck, { mode: 'present' }))?.[1];
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('takes out what in a slide could run or load', () => {
    expect(html).not.toContain('steal()');
    expect(html).not.toContain('https://x.test');
    expect(html).not.toContain('onclick');
    expect(cleanSlide('<a href="javascript:evil()">x</a><img src="javascript:evil()" onerror=evil()>')).toBe('<a href="#">x</a><img src="#">');
    expect(cleanSlide('<a href=\'  JavaScript:evil()\'>x</a>')).toBe('<a href="#">x</a>');
    expect(cleanSlide('<a href="https://kept.test/a">x</a>')).toBe('<a href="https://kept.test/a">x</a>');
    expect(cleanSlide('<p>kept <b>markup</b></p>')).toBe('<p>kept <b>markup</b></p>');
  });

  it("keeps the deck's style from ending its tag", () => {
    expect(html).toContain('<style id="deck">\n:root { --accent: #c00; }');
    expect(html).not.toContain('</style><b>');
    expect(html).toContain('<\\/style><b>out of the style</b>');
  });

  it('puts every slide in a section with the deck’s line and its page number at the foot', () => {
    const stage = html.slice(html.indexOf('<div class="stage">'), html.indexOf('<script nonce'));
    expect(stage.match(/<section\b/g)).toHaveLength(3);
    expect(html).toContain('<section class="slide">\n<h1 class="title">No section around me</h1>');
    expect(html).toContain('<div class="foot"><span>Ada Example et al. · Made-up Conf</span><span>1 / 3</span></div>');
    expect(html).toContain('<span>3 / 3</span>');
  });

  it('says its mode, language, title and where to open', () => {
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<title>Made-up &amp; &quot;quoted&quot;</title>');
    expect(html).toContain('<body data-mode="present">');
    expect(buildDocument(deck, { mode: 'preview', start: { slide: 2, step: 1 } })).toContain('<body data-mode="preview" data-start="2.1">');
    expect(html).not.toContain('not in the document');
  });
});
