import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blockChanges, blocksOf, bodyOf } from '../../app/writing/document';
import { IMAGE_TYPES, extensionOf } from '../../app/writing/PicturePicker';
import { TextModel } from '../../app/writing/textModel';
import { Message } from '../../lib/i18n';
import { ResultPaper } from '../../types';
import { EditModeValue, useEditMode } from '../EditMode';
import { useResultsAccess } from './access';

type Live = typeof import('./articleLive');

/** The two texts typed on: main.tex (the blocks) and the preamble (the title and the authors). */
export type Part = 'main' | 'preamble';

export const showMessage = (message: Message | null): string | null => (message === null ? null : typeof message === 'function' ? message() : message);

/** The blocks an article holds: those with code, hidden ones too (whoever edits sees them, greyed). */
const inBody = (blocks: ResultPaper['blocks']) => blocks.filter((block) => block.source?.trim());

/** Whether a text holds the same code for every block as the paper. */
function sameAsPaper(text: string, paper: ResultPaper): boolean {
  const changes = blockChanges(inBody(paper.blocks), blocksOf(text), () => '');
  return changes.put.length === 0 && changes.deleted.length === 0 && !changes.order;
}

/**
 * The text of a paper's article as it is typed on its page, PDF or web page alike: main.tex with every block under
 * its marker line, its undo history, the paper's attachments, and saving a moment after typing stops. The text
 * follows the paper while nothing typed waits to be saved. `onReset` hears when it started over from the paper.
 */
export function useArticleText(paper: ResultPaper, live: boolean, { delay = 4000, onReset }: { delay?: number; onReset?: () => void } = {}) {
  const editMode = useEditMode();
  const access = useResultsAccess();
  const saveResults = editMode.saveResults;
  const paperRef = useRef(paper);
  paperRef.current = paper;
  const resetRef = useRef(onReset);
  resetRef.current = onReset;
  const live$ = useRef<Live | null>(null);
  const model = useRef<TextModel | null>(null);
  const preamble = useRef<TextModel | null>(null);
  const savedPreamble = useRef(0);
  /** The text a part is typed into. */
  const modelOf = useCallback((part: Part) => (part === 'preamble' ? preamble.current : model.current), []);
  // Undo goes to the text changed last.
  const lastPart = useRef<Part>('main');
  const files = useRef<Record<string, Uint8Array> | null>(null);
  const added = useRef<Record<string, Uint8Array>>({});
  const savedVersion = useRef(0);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((value) => value + 1), []);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<Message | null>(null);
  const [attachmentNames, setAttachmentNames] = useState<string[]>([]);

  useEffect(() => {
    if (!live) return;
    const fresh = bodyOf(inBody(paper.blocks));
    const ownPreamble = paper.preamble ?? '';
    if (!model.current) {
      model.current = new TextModel(fresh);
      savedVersion.current = model.current.version;
      preamble.current = new TextModel(ownPreamble);
      savedPreamble.current = preamble.current.version;
    } else {
      if (model.current.version === savedVersion.current && !sameAsPaper(model.current.text, paper)) {
        model.current.reset(fresh);
        savedVersion.current = model.current.version;
        resetRef.current?.();
      }
      if (preamble.current && preamble.current.version === savedPreamble.current && preamble.current.text !== ownPreamble) {
        preamble.current.reset(ownPreamble);
        savedPreamble.current = preamble.current.version;
        resetRef.current?.();
      }
    }
    bump();
  }, [live, paper, bump]);

  // The editor's code and the paper's attachments, again whenever the paper changes.
  useEffect(() => {
    if (!live || !access) return undefined;
    let cancelled = false;
    import('./articleLive')
      .then(async (mod) => {
        live$.current = mod;
        const loaded = await mod.loadAttachments(paper, access.readFile);
        if (cancelled) return;
        files.current = { ...loaded, ...added.current };
        setAttachmentNames(Object.keys(files.current).filter((name) => IMAGE_TYPES.includes(extensionOf(name))).sort());
        setReady(true);
        bump();
      })
      .catch((error: unknown) => !cancelled && setProblem(() => live$.current?.describeSaveError(error) ?? String(error)));
    return () => {
      cancelled = true;
    };
  }, [live, paper, access, bump]);

  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const saving = useRef<Promise<void> | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const save = useCallback(async (): Promise<void> => {
    window.clearTimeout(saveTimer.current);
    while (saving.current) await saving.current;
    const lib = live$.current;
    const text = model.current;
    if (!lib || !text || !files.current || !saveResults) return;
    const add = added.current;
    const head = preamble.current;
    const preambleChanged = head !== null && head.version !== savedPreamble.current;
    if (text.version === savedVersion.current && !preambleChanged && Object.keys(add).length === 0) return;
    const version = text.version;
    const body = text.text;
    const headVersion = head?.version ?? 0;
    const headText = preambleChanged ? head!.text : undefined;
    setSaveState('saving');
    const run = (async () => {
      try {
        const failed = await lib.saveArticleText(paperRef.current, body, files.current ?? {}, add, saveResults, headText);
        if (failed) {
          setProblem(() => showMessage(failed) ?? '');
          return;
        }
        savedVersion.current = version;
        if (head) savedPreamble.current = headVersion;
        added.current = Object.fromEntries(Object.entries(added.current).filter(([name]) => !(name in add)));
        setProblem(null);
      } catch (error) {
        setProblem(() => lib.describeSaveError(error));
      }
    })();
    saving.current = run;
    await run;
    saving.current = null;
    setSaveState(model.current?.version === savedVersion.current && preamble.current?.version === savedPreamble.current ? 'saved' : 'dirty');
  }, [saveResults]);

  // Saving compiles every changed block and the article again: it waits for a pause.
  const saveSoon = useCallback(
    (wait = delay) => {
      setSaveState('dirty');
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void save(), wait);
    },
    [save, delay],
  );
  /** Holds off a save that is waiting, while the caret is on the page. */
  const holdSave = useCallback(() => window.clearTimeout(saveTimer.current), []);

  // Leaving the page, or the editing, saves what is typed.
  useEffect(() => {
    if (!live) return undefined;
    const hide = () => document.visibilityState === 'hidden' && void save();
    const unload = (event: BeforeUnloadEvent) => {
      if ((model.current && model.current.version !== savedVersion.current) || (preamble.current && preamble.current.version !== savedPreamble.current)) event.preventDefault();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('beforeunload', unload);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('beforeunload', unload);
      void save();
    };
  }, [live, save]);

  /** Changes a text (main.tex unless said), and saves a moment later. */
  const change = useCallback(
    (from: number, to: number, insert: string, kind?: string, part: Part = 'main') => {
      modelOf(part)?.change(from, to, insert, kind);
      lastPart.current = part;
      bump();
      saveSoon();
    },
    [bump, saveSoon, modelOf],
  );

  /** Undoes (or redoes) the last change to the text changed last; where its caret goes, and in which text. */
  const history = useCallback(
    (redo: boolean): { part: Part; offset: number } | null => {
      const part = lastPart.current;
      const target = modelOf(part);
      const offset = redo ? target?.redo() : target?.undo();
      if (offset === null || offset === undefined) return null;
      bump();
      saveSoon();
      return { part, offset };
    },
    [bump, saveSoon, modelOf],
  );

  /** The block tools save what is typed first, so the paper they change is the paper on screen. */
  const flushed = useMemo<EditModeValue>(() => {
    const after = <A extends unknown[]>(action: ((...args: A) => void) | undefined) => (action ? (...args: A) => void save().then(() => action(...args)) : undefined);
    return {
      ...editMode,
      open: after(editMode.open)!,
      reorderBlocks: after(editMode.reorderBlocks)!,
      hideBlock: after(editMode.hideBlock),
      deleteBlock: after(editMode.deleteBlock),
      switchBlock: after(editMode.switchBlock),
    };
  }, [editMode, save]);

  /** A picture from the computer: added to the attachments beside `beside`, with a name LaTeX can use. */
  const addPicture = useCallback(async (chosen: File, beside?: string): Promise<string> => {
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    const folder = beside?.includes('/') ? beside.slice(0, beside.lastIndexOf('/') + 1) : '';
    const base = chosen.name.replace(/\s+/g, '-');
    const dot = base.lastIndexOf('.');
    let name = `${folder}${base}`;
    for (let n = 2; files.current?.[name] !== undefined; n += 1) name = `${folder}${base.slice(0, dot)}-${n}${base.slice(dot)}`;
    added.current = { ...added.current, [name]: bytes };
    files.current = { ...(files.current ?? {}), [name]: bytes };
    setAttachmentNames((names) => [...names, name].sort());
    return name;
  }, []);

  return { live$, model, preamble, modelOf, history, files, tick, bump, ready, problem, setProblem, attachmentNames, saveState, save, saveSoon, holdSave, change, flushed, addPicture };
}
