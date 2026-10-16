import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Crosshair, FileCode2, FileText, Folder, FolderOpen, Image as ImageIcon, Loader2, Minus, Plus, RefreshCw, Scissors } from 'lucide-react';
import { describeSaveError } from '../../editor/backend';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import { FileWrite } from '../../editor/results/backend';
import { IMAGE_TYPES, ReadFile, attachmentPath, extensionOf, loadAttachments, newBlockId, preambleOf, putFiles, rebuildWith, withOutputs } from '../../editor/results/actions';
import { FileFolder, fileTree } from '../../editor/results/attachmentTree';
import { bibliographyStyle } from '../../editor/results/bibtex';
import { REFERENCES_FILE } from '../../editor/results/compile';
import { citedKeys, describeFailure } from '../../editor/results/numbering';
import { ResultsOp, applyResultsOp, resultsCommitMessage } from '../../editor/results/ops';
import { getTexEngine } from '../../editor/tex/engine';
import { parseAuxCitations, parseAuxLabels, parseErrors } from '../../editor/tex/log';
import { useMessage } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResultPaper } from '../../types';
import { Mark, blockChanges, blocksOf, bodyOf, findWord, fullDocument, headingsOf, locate, parseMarks, placeOf } from './document';
import { SHADOWED, attachedKey, attachedName, editableText, isLatex } from './files';
import PdfPages, { PdfClick, PdfPagesHandle } from './PdfPages';
import SourceEditor, { SourceEditorHandle, SourceFile } from './SourceEditor';

const MAIN = 'main.tex';
const PREAMBLE = 'preamble.tex';

type Texts = Record<string, string>;

interface Issue {
  message: string;
  /** A file of the writing view and its line, when the problem is in one. */
  file?: string;
  line?: number;
}

interface Compiled {
  pdf?: Uint8Array;
  marks: Mark[];
  issues: Issue[];
  seconds: number;
}

const decode = (data: Uint8Array): string => new TextDecoder().decode(data);
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The writing view's files, as the paper has them: its text, preamble and bibliography, and the attachments written as text. */
function textsOf(paper: ResultPaper, files: Record<string, Uint8Array>): Texts {
  const texts: Texts = { [MAIN]: bodyOf(paper.blocks), [PREAMBLE]: preambleOf(paper), ...(files[REFERENCES_FILE] ? { [REFERENCES_FILE]: decode(files[REFERENCES_FILE]) } : {}) };
  for (const [name, data] of Object.entries(files)) {
    if (name === REFERENCES_FILE) continue;
    const text = editableText(name, data);
    if (text !== null) texts[attachedKey(name)] = text;
  }
  return texts;
}

/** Whether a file of the writing view differs between two sets of texts; main.tex by its blocks' code. */
const changedIn = (a: Texts, b: Texts, name: string): boolean =>
  name === MAIN ? JSON.stringify(blocksOf(a[MAIN] ?? '')) !== JSON.stringify(blocksOf(b[MAIN] ?? '')) : a[name] !== b[name];

/** Whether two sets of texts hold the same paper: the same blocks with the same code, preamble, bibliography and attachments. */
const sameTexts = (a: Texts, b: Texts): boolean => [...new Set([...Object.keys(a), ...Object.keys(b), MAIN])].every((name) => !changedIn(a, b, name));

/** The attachments whose text changed since `saved`, as the bytes to store; references.bib among them. */
function changedFiles(current: Texts, saved: Texts): Record<string, Uint8Array> {
  const changed: Record<string, Uint8Array> = {};
  for (const [key, text] of Object.entries(current)) {
    const name = key === REFERENCES_FILE ? key : attachedName(key);
    if (name !== null && text !== saved[key]) changed[name] = encode(text);
  }
  return changed;
}

const references = (aux?: string): string => JSON.stringify([parseAuxLabels(aux ?? ''), parseAuxCitations(aux ?? '')]);

/** A picture among the attachments, as large as the pane allows. */
const ImagePreview: React.FC<{ name: string; data: Uint8Array }> = ({ name, data }) => {
  // Made and let go in the same effect, so an address is never shown after it is revoked.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = URL.createObjectURL(new Blob([data.slice()], { type: extensionOf(name) === '.png' ? 'image/png' : 'image/jpeg' }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [name, data]);
  return <div className="flex h-full items-center justify-center overflow-auto p-6">{url && <img src={url} alt={name} className="max-h-full max-w-full bg-white object-contain shadow-sm" />}</div>;
};

/** 45 KB, 1.2 MB. */
const sizeOf = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** How many files a folder holds, its folders' included. */
const filesIn = (folder: FileFolder): number => folder.files.length + folder.folders.reduce((sum, sub) => sum + filesIn(sub), 0);

/** The folders above a file, outermost first: figs and figs/v2 for figs/v2/a.pdf. */
const foldersOf = (path: string): string[] => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));

const noop = () => undefined;

interface Props {
  paper: ResultPaper;
  readFile: ReadFile;
  onSave: ResultsSave;
  /** Where the view starts, under the paper's bar, in pixels from the top of the window. */
  top: number;
  visible: boolean;
}

/**
 * The paper written as one LaTeX document, like a desktop editor: files and outline on the left, the code in the
 * middle, the whole paper's PDF on the right. A double click in the PDF goes to the code it came from; saving
 * puts each block's code back and rebuilds the blocks the page shows.
 */
const WritingMode: React.FC<Props> = ({ paper, readFile, onSave, top, visible }) => {
  const t = useT();
  const editor = useRef<SourceEditorHandle>(null);
  const pdf = useRef<PdfPagesHandle>(null);
  const [attachments, setAttachments] = useState<Record<string, Uint8Array> | null>(null);
  const [texts, setTexts] = useState<Texts | null>(null);
  const [version, setVersion] = useState(0);
  const [active, setActive] = useState(MAIN);
  // A picture or PDF among the attachments, shown in place of the code until a file is opened again.
  const [preview, setPreview] = useState<string | null>(null);
  // The attachments' folders that are open in the file list, like Overleaf's: all closed at first.
  const [folders, setFolders] = useState<ReadonlySet<string>>(() => new Set());
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [listing, setListing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useMessage();
  const saved = useRef<Texts | null>(null);
  const textsRef = useRef(texts);
  textsRef.current = texts;
  const filesRef = useRef(attachments);
  filesRef.current = attachments;
  // What the last run left for the next: the labels and citations it wrote, and BibTeX's output for the citations.
  const carried = useRef<{ aux?: string; bbl?: string; bibKey: string }>({ bibKey: '' });
  const running = useRef(false);
  const again = useRef(false);

  // The paper's files, again whenever the paper changes; the texts follow unless the owner has unsaved work.
  useEffect(() => {
    let cancelled = false;
    loadAttachments(paper, readFile).then(
      (files) => {
        if (cancelled) return;
        setAttachments(files);
        const fresh = textsOf(paper, files);
        const current = textsRef.current;
        if (current && saved.current && !sameTexts(current, saved.current)) return;
        if (current && sameTexts(fresh, current)) {
          saved.current = current;
          return;
        }
        saved.current = fresh;
        setTexts(fresh);
        setVersion((value) => value + 1);
      },
      (error: unknown) => setProblem(() => describeSaveError(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [paper, readFile, setProblem]);

  const compile = useCallback(async () => {
    if (!textsRef.current || !filesRef.current) return;
    // One run at a time; typing during a run asks for another when it ends.
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    setCompiling(true);
    try {
      do {
        again.current = false;
        const snapshot = textsRef.current;
        const files = filesRef.current;
        if (!snapshot || !files) break;
        const started = performance.now();
        const engine = await getTexEngine();
        const body = snapshot[MAIN] ?? '';
        const preamble = snapshot[PREAMBLE] ?? '';
        const bib = snapshot[REFERENCES_FILE];
        const keys = citedKeys(body);
        const style = bibliographyStyle({ ...paper, preamble });
        const cites = bib !== undefined && keys.length > 0;
        const doc = fullDocument(preamble, body, cites ? { style, file: REFERENCES_FILE } : null);
        // The attachments as they are being edited.
        const inputs: Record<string, string | Uint8Array> = { ...files, ...(bib !== undefined ? { [REFERENCES_FILE]: encode(bib) } : {}), ...changedFiles(snapshot, saved.current ?? {}) };
        const state = carried.current;
        const bibKey = JSON.stringify([keys, bib, style]);
        const bibtex = cites && (bibKey !== state.bibKey || state.bbl === undefined);
        const pass = (aux: string | undefined, bbl: string | undefined, withBibtex: boolean) =>
          engine.compile({
            main: doc.main,
            files: { ...inputs, ...(aux ? { 'main.aux': aux } : {}), ...(bbl && !withBibtex ? { 'main.bbl': bbl } : {}) },
            bibtex: withBibtex,
            read: ['main.gpos', 'main.bbl'],
          });
        let out = await pass(state.aux, cites ? state.bbl : undefined, bibtex);
        const bbl = cites ? (bibtex ? out.written?.['main.bbl'] : state.bbl) : undefined;
        // Like latexmk: once more when the run changed the labels or citations it read.
        if (out.pdf && out.aux !== undefined && references(out.aux) !== references(state.aux)) out = await pass(out.aux, bbl, false);
        carried.current = { aux: out.aux, bbl, bibKey: cites ? bibKey : '' };
        const issues = parseErrors(out.log).map((issue): Issue => {
          // An error in an attachment the editor has open goes to its line there.
          const attached = issue.file ? attachedKey(issue.file.replace(/^\.\//, '')) : '';
          if (issue.file && issue.line !== undefined && snapshot[attached] !== undefined) return { message: issue.message, file: attached, line: issue.line };
          if (issue.file || issue.line === undefined) return { message: issue.file ? `${issue.file}: ${issue.message}` : issue.message };
          if (issue.line >= doc.bodyStart && issue.line < doc.bodyStart + doc.bodyLines) return { message: issue.message, file: MAIN, line: issue.line - doc.bodyStart + 1 };
          if (issue.line >= doc.preambleStart && issue.line < doc.preambleStart + doc.preambleLines) {
            return { message: issue.message, file: PREAMBLE, line: issue.line - doc.preambleStart + 1 };
          }
          return { message: issue.message };
        });
        if (!out.pdf && issues.length === 0) issues.push({ message: out.reason ?? t('没有生成 PDF') });
        const seconds = (performance.now() - started) / 1000;
        // A run without a PDF keeps the last one on screen.
        setCompiled((previous) => ({
          pdf: out.pdf ?? previous?.pdf,
          marks: out.pdf ? parseMarks(out.written?.['main.gpos'] ?? '') : previous?.marks ?? [],
          issues,
          seconds,
        }));
      } while (again.current);
    } catch (error) {
      setProblem(() => describeSaveError(error));
    } finally {
      running.current = false;
      setCompiling(false);
    }
  }, [paper, setProblem, t]);

  // Compiles when the view opens and a moment after typing stops.
  const first = useRef(true);
  useEffect(() => {
    if (!visible || !texts || !attachments) return undefined;
    const timer = window.setTimeout(() => void compile(), first.current ? 0 : 1200);
    first.current = false;
    return () => window.clearTimeout(timer);
  }, [visible, texts, attachments, compile]);

  // An attachment open in the editor or on view that the paper no longer has gives way to main.tex.
  useEffect(() => {
    if (texts && texts[active] === undefined) setActive(MAIN);
  }, [texts, active]);
  useEffect(() => {
    if (preview && attachments && !attachments[preview]) setPreview(null);
  }, [preview, attachments]);

  /** Opens a file of the writing view in the editor, with the folders it is in. */
  const openFile = useCallback((name: string) => {
    setActive(name);
    setPreview(null);
    const path = attachedName(name);
    if (path?.includes('/')) setFolders((current) => (foldersOf(path).every((folder) => current.has(folder)) ? current : new Set([...current, ...foldersOf(path)])));
  }, []);
  const toggleFolder = (path: string) =>
    setFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const tree = useMemo(() => fileTree(Object.keys(attachments ?? {}).filter((name) => name !== REFERENCES_FILE)), [attachments]);

  const dirty = texts !== null && saved.current !== null && !sameTexts(texts, saved.current);

  const save = useCallback(async () => {
    const current = textsRef.current;
    const files = filesRef.current;
    if (!current || !files || !saved.current || saving) return;
    if (sameTexts(current, saved.current)) return;
    setSaving(true);
    setProblem(null);
    try {
      const changes = blockChanges(paper.blocks, blocksOf(current[MAIN] ?? ''), newBlockId);
      const ops: ResultsOp[] = [];
      if (current[PREAMBLE] !== saved.current[PREAMBLE]) ops.push({ kind: 'patchPaper', id: paper.id, fields: { preamble: current[PREAMBLE] } });
      for (const change of changes.put) ops.push({ kind: 'putBlock', paperId: paper.id, block: change.block, ...(change.at === undefined ? {} : { at: change.at }) });
      for (const block of changes.deleted) ops.push({ kind: 'deleteBlock', paperId: paper.id, blockId: block.id });
      if (changes.order) ops.push({ kind: 'reorderBlocks', paperId: paper.id, ids: changes.order });
      const writes: FileWrite[] = [];
      // The bibliography and the attachments edited here, stored again; the blocks that use them compile anew.
      const edited = changedFiles(current, saved.current);
      if (Object.keys(edited).length > 0) {
        const uploads = await putFiles(paper.id, edited);
        ops.push(...uploads.ops);
        writes.push(...Object.entries(edited).map(([name, data]) => ({ path: attachmentPath(paper.id, name), data })));
      }
      const used = { ...files, ...edited };
      const draft = ops.reduce<ResultPaper[]>((papers, op) => applyResultsOp(papers, op), [paper])[0];
      // The page's blocks are compiled one by one, as the page shows them.
      const rebuilt = await rebuildWith(draft, used);
      if (rebuilt.failed) {
        setProblem(() => describeFailure(draft.blocks, rebuilt.failed!));
        return;
      }
      const deletes = [...changes.deleted.flatMap((block) => [block.output, block.alternate?.output].flatMap((output) => (output ? [output.pdf] : []))), ...rebuilt.deletes];
      await onSave(withOutputs(paper.id, ops, rebuilt), [...writes, ...rebuilt.writes], deletes, resultsCommitMessage('write', paper.title), `content: update result "${paper.title}"`);
      saved.current = current;
      setTexts({ ...current });
    } catch (error) {
      setProblem(() => describeSaveError(error));
    } finally {
      setSaving(false);
    }
  }, [paper, onSave, saving, setProblem]);

  const files = useMemo<SourceFile[]>(
    () =>
      texts
        ? [
            { name: MAIN, text: texts[MAIN] ?? '', blocks: true },
            { name: PREAMBLE, text: texts[PREAMBLE] ?? '' },
            ...(texts[REFERENCES_FILE] !== undefined ? [{ name: REFERENCES_FILE, text: texts[REFERENCES_FILE], latex: false }] : []),
            ...Object.entries(texts).flatMap(([key, text]) => {
              const name = attachedName(key);
              return name === null ? [] : [{ name: key, text, latex: isLatex(name) }];
            }),
          ]
        : [],
    // The editor reads them only when `version` changes.
    [version],
  );

  const problems = useMemo(() => {
    const byFile: Record<string, { line: number; message: string }[]> = {};
    for (const issue of compiled?.issues ?? []) if (issue.file && issue.line) (byFile[issue.file] ??= []).push({ line: issue.line, message: issue.message });
    return byFile;
  }, [compiled]);

  const headings = useMemo(() => headingsOf(texts?.[MAIN] ?? ''), [texts]);
  const marks = compiled?.marks ?? [];

  const showInPdf = (line: number) => {
    const place = placeOf(marks, line);
    if (place) pdf.current?.show(place.page, place.y);
  };

  const fromPdf = (click: PdfClick) => {
    const found = locate(marks, click);
    if (!found) return;
    const lines = (textsRef.current?.[MAIN] ?? '').split('\n');
    const word = findWord(lines, found.line, found.until, click.word, click.context);
    openFile(MAIN);
    editor.current?.reveal(MAIN, word?.line ?? found.line, word?.start, word?.end);
  };

  // Each level of folders one chevron and gap further in, so a folder's files line up under its icon.
  const indent = (depth: number) => ({ paddingLeft: `${0.5 + depth * 1.2}rem` });
  const rowLook = (selected: boolean) =>
    `flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left transition-colors duration-150 ${selected ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-gray-700 hover:bg-black/[0.04]'}`;

  const fileRow = (name: string, icon: React.ReactNode, label = name, depth = 0) => (
    <button key={name} type="button" onClick={() => openFile(name)} title={attachedName(name) ?? undefined} className={rowLook(!preview && active === name)} style={indent(depth)}>
      {icon}
      <span className="truncate">{label}</span>
      {texts && saved.current && changedIn(texts, saved.current, name) && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" title={t('有未保存的修改')} />}
    </button>
  );

  /** An attachment in the list: text opens in the editor, a picture or PDF on view, the rest only listed. */
  const attachmentRow = (name: string, depth: number): React.ReactNode => {
    const label = name.split('/').pop() ?? name;
    // A main.tex among the attachments never reaches the compiles: the paper's own text is main.tex there.
    if (SHADOWED.includes(name)) {
      return (
        <p key={name} className="flex items-center gap-2 py-1.5 pr-2 text-gray-400" style={indent(depth)} title={t('编译时用的是论文自己的 {name}，这个附件用不到，可以在「导言区与附件」里删掉', { name })}>
          <FileText size={15} className="shrink-0" />
          <span className="truncate line-through">{label}</span>
        </p>
      );
    }
    if (texts?.[attachedKey(name)] !== undefined) return fileRow(attachedKey(name), <FileCode2 size={15} className="shrink-0 text-gray-400" />, label, depth);
    if (IMAGE_TYPES.includes(extensionOf(name))) {
      return (
        <button key={name} type="button" onClick={() => setPreview(name)} title={name} className={rowLook(preview === name)} style={indent(depth)}>
          <ImageIcon size={15} className="shrink-0 text-gray-400" />
          <span className="truncate">{label}</span>
        </button>
      );
    }
    return (
      <p key={name} className="flex items-center gap-2 py-1.5 pr-2 text-gray-400" style={indent(depth)} title={t('{name} 不是 UTF-8 编码，不能在这里编辑', { name })}>
        <FileText size={15} className="shrink-0" />
        <span className="truncate">{label}</span>
      </p>
    );
  };

  /** A folder's folders (each open or closed) and then its files. */
  const folderRows = (folder: FileFolder, depth: number): React.ReactNode[] => [
    ...folder.folders.flatMap((sub) => {
      const open = folders.has(sub.path);
      return [
        <button key={`folder:${sub.path}`} type="button" onClick={() => toggleFolder(sub.path)} aria-expanded={open} title={sub.path} className={`${rowLook(false)} gap-1.5`} style={indent(depth)}>
          <ChevronRight size={13} className={`shrink-0 text-gray-400 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
          {open ? <FolderOpen size={15} className="shrink-0 text-gray-400" /> : <Folder size={15} className="shrink-0 text-gray-400" />}
          <span className="truncate">{sub.name}</span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-gray-400">{filesIn(sub)}</span>
        </button>,
        ...(open ? folderRows(sub, depth + 1) : []),
      ];
    }),
    ...folder.files.map((name) => attachmentRow(name, depth)),
  ];

  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900 disabled:opacity-40';
  const issues = compiled?.issues ?? [];

  return (
    <div className={`fixed inset-x-0 bottom-0 z-20 flex bg-white ${visible ? '' : 'hidden'}`} style={{ top }}>
      {/* A plain column, not a flex one: rows of a flex column shrink once the list is longer than the window. */}
      <nav aria-label={t('文件和大纲')} className="hidden w-56 shrink-0 overflow-y-auto border-r border-black/[0.06] bg-[#f5f5f7] p-3 text-[13px] lg:block">
        <p className="px-2 pb-1 text-xs font-medium text-gray-500">{t('文件')}</p>
        {fileRow(MAIN, <FileCode2 size={15} className="shrink-0 text-violet-600" />)}
        {fileRow(PREAMBLE, <FileCode2 size={15} className="shrink-0 text-gray-400" />, t('导言区 preamble.tex'))}
        {texts?.[REFERENCES_FILE] !== undefined && fileRow(REFERENCES_FILE, <FileText size={15} className="shrink-0 text-gray-400" />)}
        {folderRows(tree, 0)}
        <p className="mt-5 px-2 pb-1 text-xs font-medium text-gray-500">{t('大纲')}</p>
        {headings.length === 0 && <p className="px-2 text-xs text-gray-400">{t('写下 \\section，这里就会列出章节')}</p>}
        {headings.map((heading) => (
          <button
            key={`${heading.line}`}
            type="button"
            onClick={() => {
              openFile(MAIN);
              editor.current?.reveal(MAIN, heading.line);
              showInPdf(heading.line);
            }}
            className="w-full truncate rounded-md py-1 pr-2 text-left text-gray-700 hover:bg-black/[0.04]"
            style={{ paddingLeft: `${0.5 + heading.level * 0.9}rem` }}
            title={heading.title}
          >
            {heading.title}
          </button>
        ))}
      </nav>

      <section className="flex min-w-0 flex-1 flex-col border-r border-black/[0.06]">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-black/[0.06] px-3">
          <span className="mr-2 min-w-0 truncate text-sm font-medium text-gray-800">{preview ?? attachedName(active) ?? active}</span>
          {preview && attachments?.[preview] && <span className="shrink-0 text-xs text-gray-400">{sizeOf(attachments[preview].length)}</span>}
          {!preview && active === MAIN && (
            <>
              <button type="button" onClick={() => editor.current?.splitBlock() || setProblem(() => t('把光标放在一个块中间的某一行，再从那里分块'))} className={bar} title={t('从光标所在的行开始一个新块')}>
                <Scissors size={14} />
                <span className="hidden xl:inline">{t('从这里分块')}</span>
              </button>
              <button type="button" onClick={() => showInPdf(editor.current?.cursorLine() ?? 1)} disabled={marks.length === 0} className={bar} title={t('在 PDF 里找到光标所在的行')}>
                <Crosshair size={14} />
                <span className="hidden xl:inline">{t('定位到 PDF')}</span>
              </button>
            </>
          )}
          <span className="ml-auto hidden whitespace-nowrap text-xs text-gray-400 lg:inline">{saving ? t('保存中…') : dirty ? t('有未保存的修改') : t('已保存')}</span>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="galley-press ml-auto shrink-0 whitespace-nowrap rounded-lg bg-violet-700 px-3 py-1 text-[13px] font-medium text-white hover:bg-violet-800 disabled:bg-gray-200 disabled:text-gray-500 lg:ml-2"
            title={t('保存（⌘S）')}
          >
            {t('保存')}
          </button>
        </div>
        {problem && (
          <p role="alert" className="border-b border-red-100 bg-red-50 px-3 py-1.5 text-xs text-red-700">
            {problem}
          </p>
        )}
        <div className="relative min-h-0 flex-1">
          {preview && attachments?.[preview] && (
            // Over the editor, which stays as it was underneath.
            <div className="absolute inset-0 z-10 bg-[#e9e9ec]">
              {extensionOf(preview) === '.pdf' ? <PdfPages key={preview} data={attachments[preview]} zoom={1} onDoubleClick={noop} /> : <ImagePreview name={preview} data={attachments[preview]} />}
            </div>
          )}
          {texts ? (
            <SourceEditor
              ref={editor}
              files={files}
              version={version}
              active={active}
              onChange={(name, text) => setTexts((current) => (current ? { ...current, [name]: text } : current))}
              onSave={() => void save()}
              onCompile={() => void compile()}
              problems={problems}
              hidden={paper.blocks.filter((block) => block.hidden).map((block) => block.id)}
            />
          ) : (
            <p className="p-6 text-sm text-gray-400">{t('正在打开论文…')}</p>
          )}
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-black/[0.06] px-3">
          <button type="button" onClick={() => void compile()} disabled={compiling || !texts} className="galley-press inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-gray-900 px-3 py-1 text-[13px] font-medium text-white hover:bg-gray-700 disabled:opacity-60">
            {compiling ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t('重新编译')}
          </button>
          {issues.length > 0 && (
            <button type="button" onClick={() => setListing((on) => !on)} aria-expanded={listing} className={`${bar} text-red-700 hover:text-red-800`}>
              <AlertTriangle size={14} />
              {t('{n} 个问题', { n: issues.length })}
            </button>
          )}
          <span className="ml-1 whitespace-nowrap text-xs text-gray-400">{compiling ? t('编译中…') : compiled ? t('{s} 秒', { s: compiled.seconds.toFixed(1) }) : ''}</span>
          <span className="ml-auto hidden truncate text-xs text-gray-400 xl:inline">{t('双击 PDF 里的文字，跳到它的代码')}</span>
          <span className="ml-auto flex shrink-0 items-center xl:ml-2">
            <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))} aria-label={t('缩小')} title={t('缩小')} className={bar}>
              <Minus size={14} />
            </button>
            <button type="button" onClick={() => setZoom(1)} className={`${bar} tabular-nums`} title={t('适合宽度')}>
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" onClick={() => setZoom((value) => Math.min(2.5, value + 0.1))} aria-label={t('放大')} title={t('放大')} className={bar}>
              <Plus size={14} />
            </button>
          </span>
        </div>
        {listing && issues.length > 0 && (
          <ul className="max-h-48 shrink-0 overflow-y-auto border-b border-red-100 bg-red-50/60 py-1 text-xs">
            {issues.map((issue, index) => (
              <li key={index}>
                <button
                  type="button"
                  disabled={!issue.file}
                  onClick={() => {
                    if (!issue.file || !issue.line) return;
                    openFile(issue.file);
                    editor.current?.reveal(issue.file, issue.line);
                  }}
                  className="w-full px-3 py-1 text-left text-red-800 enabled:hover:bg-red-100/70"
                >
                  {issue.file && issue.line ? t('{file} 第 {line} 行：{message}', { file: issue.file, line: issue.line, message: issue.message }) : issue.message}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="min-h-0 flex-1">
          {compiled?.pdf ? (
            <PdfPages ref={pdf} data={compiled.pdf} zoom={zoom} onDoubleClick={fromPdf} />
          ) : (
            <p className="flex h-full items-center justify-center bg-[#e9e9ec] text-sm text-gray-500">{compiling || !compiled ? t('正在编译整篇论文…') : t('没有生成 PDF')}</p>
          )}
        </div>
      </section>
    </div>
  );
};

export default WritingMode;
