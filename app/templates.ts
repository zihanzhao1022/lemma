/**
 * The LaTeX templates a new paper can start from: each venue's official preamble and style files (kept in
 * public/templates/<id>/, see its README for where each came from), with the paper's title and its author put in.
 * Without a venue a paper starts from the arXiv preprint style. Every preamble also loads what Lemma's table and
 * figure tools write (colours in cells, merged cells, rules), where the venue allows it.
 */

export type TemplateId = 'arxiv' | 'acl' | 'neurips' | 'icml' | 'iclr' | 'cvpr' | 'eccv' | 'aaai' | 'ijcai' | 'acm' | 'ieee';

export interface PaperTemplate {
  id: TemplateId;
  /** What the menu shows (venue names stay as they are in every language). */
  name: string;
  /** The venues it is for, found in what the owner types as the venue ("EMNLP 2027 Findings"). */
  venues: RegExp | null;
  /** Its files in public/templates/<id>/, copied into the paper as attachments. */
  files: string[];
  /** The preamble of a paper with this title, by this author, for this venue as typed. */
  preamble: (paper: { title: string; author: string; venue: string }) => string;
  /** Text blocks a new paper starts with, where the template needs them in the text. */
  blocks?: string[];
}

/** Text as LaTeX prints it, for a title or a name typed in the dialog. */
const SPECIAL: Record<string, string> = { '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };

export function latexText(text: string): string {
  return text.trim().replace(/[\\~^%&$#_{}]/g, (char) => SPECIAL[char] ?? `\\${char}`);
}

/** What Lemma's table and figure tools write needs these; amssymb clashes with fonts some classes load. */
const tools = ({ amssymb = true } = {}): string[] => [
  amssymb ? '\\usepackage{amsmath,amssymb}' : '\\usepackage{amsmath}',
  '\\usepackage{graphicx}',
  '\\usepackage[table]{xcolor}',
  '\\usepackage{booktabs,multirow,makecell,array,tabularx,hhline}',
];

const lines = (...parts: (string | string[])[]): string => parts.flat().join('\n');

/** The venue's own name as typed ("ICCV 2027" → "ICCV"), or a fallback. */
const venueName = (venue: string, names: RegExp, fallback: string): string => names.exec(venue)?.[0].toUpperCase() ?? fallback;

export const TEMPLATES: PaperTemplate[] = [
  {
    id: 'arxiv',
    name: 'arXiv',
    venues: /\barxiv\b|preprint/i,
    files: ['arxiv.sty'],
    preamble: ({ title, author }) =>
      lines(
        '\\documentclass{article}',
        '\\usepackage{arxiv}',
        '\\usepackage[utf8]{inputenc}',
        '\\usepackage[T1]{fontenc}',
        '\\usepackage{hyperref}',
        '\\usepackage{url}',
        '\\usepackage{amsfonts}',
        '\\usepackage{nicefrac}',
        '\\usepackage{microtype}',
        '\\usepackage{natbib}',
        tools(),
        '',
        `\\title{${title}}`,
        `\\author{${author}}`,
      ),
  },
  {
    id: 'acl',
    name: 'ACL · EMNLP · NAACL · EACL',
    venues: /\b(?:ACL|EMNLP|NAACL|EACL|AACL|IJCNLP|COLING|CoNLL|ARR|TACL|SemEval)\b/i,
    files: ['acl.sty', 'acl_natbib.bst'],
    preamble: ({ title, author }) =>
      lines(
        '\\documentclass[11pt]{article}',
        '\\usepackage[review]{acl}',
        '\\usepackage{times}',
        '\\usepackage{latexsym}',
        '\\usepackage[T1]{fontenc}',
        '\\usepackage[utf8]{inputenc}',
        '\\usepackage{microtype}',
        '\\usepackage{inconsolata}',
        tools(),
        '',
        `\\title{${title}}`,
        `\\author{${author} \\\\ Affiliation \\\\ \\texttt{email@domain}}`,
      ),
  },
  {
    id: 'neurips',
    name: 'NeurIPS 2026',
    venues: /\b(?:NeurIPS|NIPS)\b/i,
    files: ['neurips_2026.sty'],
    preamble: ({ title, author }) =>
      lines(
        '\\documentclass{article}',
        '\\usepackage{neurips_2026}',
        '\\usepackage[utf8]{inputenc}',
        '\\usepackage[T1]{fontenc}',
        '\\usepackage{hyperref}',
        '\\usepackage{url}',
        '\\usepackage{amsfonts}',
        '\\usepackage{nicefrac}',
        '\\usepackage{microtype}',
        tools(),
        '',
        `\\title{${title}}`,
        `\\author{${author} \\\\ Affiliation \\\\ \\texttt{email@domain}}`,
      ),
  },
  {
    // ICML sets its title in the text, in a full-width box at the top of the first page: \maketitle does that here.
    id: 'icml',
    name: 'ICML 2026',
    venues: /\bICML\b/i,
    files: ['icml2026.sty', 'icml2026.bst', 'algorithm.sty', 'algorithmic.sty', 'fancyhdr.sty'],
    preamble: ({ title, author }) =>
      lines(
        '\\documentclass{article}',
        '\\usepackage{microtype}',
        '\\usepackage{subcaption}',
        '\\usepackage{hyperref}',
        '\\newcommand{\\theHalgorithm}{\\arabic{algorithm}}',
        '\\usepackage{icml2026}',
        '\\usepackage{mathtools}',
        '\\usepackage{amsthm}',
        tools(),
        '',
        `\\title{${title}}`,
        `\\icmltitlerunning{${title}}`,
        '\\makeatletter',
        '\\renewcommand{\\maketitle}{%',
        '  \\twocolumn[',
        '    \\icmltitle{\\@title}',
        '    \\begin{icmlauthorlist}',
        `      \\icmlauthor{${author}}{aff}`,
        '    \\end{icmlauthorlist}',
        '    \\icmlaffiliation{aff}{Affiliation}',
        `    \\icmlcorrespondingauthor{${author}}{email@domain}`,
        '    \\vskip 0.3in',
        '  ]',
        '  \\printAffiliationsAndNotice{}}',
        '\\makeatother',
      ),
  },
  {
    id: 'iclr',
    name: 'ICLR 2027',
    venues: /\bICLR\b/i,
    files: ['iclr2027_conference.sty', 'iclr2027_conference.bst', 'fancyhdr.sty', 'natbib.sty', 'math_commands.tex'],
    preamble: ({ title, author }) =>
      lines(
        '\\documentclass{article}',
        '\\usepackage{iclr2027_conference,times}',
        '\\input{math_commands.tex}',
        '\\usepackage{hyperref}',
        '\\usepackage{url}',
        tools(),
        '',
        `\\title{${title}}`,
        `\\author{${author} \\\\ Affiliation \\\\ \\texttt{email@domain}}`,
      ),
  },
  {
    id: 'cvpr',
    name: 'CVPR · ICCV 2027',
    venues: /\b(?:CVPR|ICCV|3DV)\b/i,
    files: ['cvpr.sty', 'ieeenat_fullname.bst'],
    preamble: ({ title, author, venue }) =>
      lines(
        '\\documentclass[10pt,twocolumn,letterpaper]{article}',
        '\\usepackage[review]{cvpr}',
        '\\usepackage{cuted}',
        '\\usepackage{currfile}',
        '\\usepackage{caption}',
        tools(),
        '\\definecolor{cvprblue}{rgb}{0.21,0.49,0.74}',
        '\\usepackage[pagebackref,breaklinks,colorlinks,allcolors=cvprblue]{hyperref}',
        `\\def\\confName{${venueName(venue, /\b(?:CVPR|ICCV|3DV)\b/i, 'CVPR')}}`,
        '\\def\\confYear{2027}',
        '',
        `\\title{${title}}`,
        `\\author{${author} \\\\ Institution \\\\ {\\tt\\small email@domain}}`,
      ),
  },
  {
    id: 'eccv',
    name: 'ECCV 2026',
    venues: /\bECCV\b/i,
    files: ['llncs.cls', 'eccv.sty', 'eccvabbrv.sty', 'splncs04.bst'],
    preamble: ({ title, author }) =>
      lines(
        '\\documentclass[runningheads]{llncs}',
        '\\usepackage[review,year=2026,ID=*****]{eccv}',
        '\\usepackage{eccvabbrv}',
        tools(),
        '\\usepackage{hyperref}',
        '',
        `\\title{${title}}`,
        `\\titlerunning{${title}}`,
        `\\author{${author}}`,
        `\\authorrunning{${author}}`,
        '\\institute{Institution \\\\ \\email{email@domain}}',
      ),
  },
  {
    // AAAI's kit forbids hyperref, geometry, float and a few more; none of them is loaded here.
    id: 'aaai',
    name: 'AAAI 2027',
    venues: /\bAAAI\b/i,
    files: ['aaai2027.sty', 'aaai2027.bst'],
    preamble: ({ title, author }) =>
      lines(
        '\\documentclass[letterpaper]{article}',
        '\\usepackage[submission]{aaai2027}',
        '\\usepackage[hyphens]{url}',
        '\\urlstyle{rm}',
        '\\def\\UrlFont{\\rm}',
        '\\usepackage{natbib}',
        '\\usepackage{caption}',
        '\\frenchspacing',
        tools(),
        '\\pdfinfo{',
        '/TemplateVersion (2027.1)',
        '}',
        '\\setcounter{secnumdepth}{0}',
        '',
        `\\title{${title}}`,
        `\\author{${author}}`,
        '\\affiliations{Affiliation \\\\ email@domain}',
      ),
  },
  {
    id: 'ijcai',
    name: 'IJCAI 2027',
    venues: /\bIJCAI\b/i,
    files: ['ijcai27.sty', 'named.bst'],
    preamble: ({ title, author }) =>
      lines(
        '\\documentclass{article}',
        '\\pdfpagewidth=8.5in',
        '\\pdfpageheight=11in',
        '\\usepackage{ijcai27}',
        '\\usepackage{times}',
        '\\usepackage{soul}',
        '\\usepackage{url}',
        '\\usepackage[hidelinks]{hyperref}',
        '\\usepackage[utf8]{inputenc}',
        '\\usepackage[small]{caption}',
        '\\usepackage{amsthm}',
        tools(),
        '\\usepackage[switch]{lineno}',
        '\\linenumbers',
        '\\urlstyle{same}',
        '\\pdfinfo{',
        '/TemplateVersion (IJCAI.2027.0)',
        '}',
        '',
        `\\title{${title}}`,
        `\\author{${author} \\affiliations Affiliation \\emails email@domain}`,
      ),
  },
  {
    // acmart is in TeX Live; its fonts already give amssymb's symbols, and loading both fails. Its title must
    // come after the abstract, so the paper starts with the abstract and \maketitle (Lemma then adds none).
    id: 'acm',
    name: 'ACM (KDD · WWW · SIGIR · CHI …)',
    venues: /\b(?:ACM|SIGKDD|KDD|WWW|TheWebConf|SIGIR|CIKM|WSDM|RecSys|CHI|UIST|CSCW|SIGMOD|FAccT|ACM ?MM)\b/i,
    files: [],
    preamble: ({ title, author, venue }) =>
      lines(
        '\\documentclass[sigconf,review,anonymous]{acmart}',
        '\\setcopyright{acmlicensed}',
        '\\copyrightyear{2027}',
        '\\acmYear{2027}',
        '\\acmDOI{XXXXXXX.XXXXXXX}',
        `\\acmConference[${latexText(venue) || 'Conference'}]{${latexText(venue) || 'Conference'}}{2027}{Location}`,
        '\\acmISBN{978-1-4503-XXXX-X/2027/06}',
        tools({ amssymb: false }),
        '',
        `\\title{${title}}`,
        `\\author{${author}}`,
        '\\affiliation{\\institution{Institution}\\city{City}\\country{Country}}',
        '\\email{email@domain}',
      ),
    blocks: ['\\begin{abstract}\n\n\\end{abstract}\n\\maketitle'],
  },
  {
    // IEEEtran is in TeX Live, with its bibliography style.
    id: 'ieee',
    name: 'IEEE (IEEEtran)',
    venues: /\b(?:IEEE|ICRA|IROS|ICDE|ICDM|INFOCOM)\b/i,
    files: [],
    preamble: ({ title, author }) =>
      lines(
        '\\documentclass[conference]{IEEEtran}',
        '\\usepackage{cite}',
        '\\usepackage{amsfonts}',
        '\\usepackage{textcomp}',
        tools(),
        '',
        `\\title{${title}}`,
        `\\author{\\IEEEauthorblockN{${author}}\\IEEEauthorblockA{Affiliation \\\\ email@domain}}`,
      ),
  },
];

export const DEFAULT_TEMPLATE: TemplateId = 'arxiv';

export const templateById = (id: TemplateId): PaperTemplate => TEMPLATES.find((template) => template.id === id) ?? TEMPLATES[0];

/** The template for a venue as typed: the first whose venues it names, else the arXiv style. */
export function templateFor(venue: string): TemplateId {
  return TEMPLATES.find((template) => template.venues?.test(venue))?.id ?? DEFAULT_TEMPLATE;
}

/** A new paper's preamble from a template, its title and author typed in the dialog. */
export function templatePreamble(id: TemplateId, paper: { title: string; author: string; venue?: string }): string {
  return templateById(id).preamble({ title: latexText(paper.title), author: latexText(paper.author), venue: paper.venue?.trim() ?? '' });
}

/** A template's files, read from the site (public/templates/<id>/). */
export async function templateFiles(id: TemplateId, base = import.meta.env?.BASE_URL ?? '/'): Promise<Record<string, Uint8Array>> {
  const template = templateById(id);
  const entries = await Promise.all(
    template.files.map(async (name) => {
      const response = await fetch(`${base}templates/${id}/${name}`);
      if (!response.ok) throw new Error(`Template file ${id}/${name}: ${response.status}`);
      return [name, new Uint8Array(await response.arrayBuffer())] as const;
    }),
  );
  return Object.fromEntries(entries);
}
