import React, { useEffect, useImperativeHandle, useRef } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap, CompletionContext, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as emptyHint,
} from '@codemirror/view';
import { SourceSnapshot, SourceSnapshots } from '../../app/writing/sourceMapping';
import { t } from '../../lib/phrases/results';

const COMMANDS = [
  'textbf', 'textit', 'emph', 'underline', 'texttt', 'textsc', 'textsf', 'textrm', 'textsuperscript', 'textsubscript',
  'textcolor', 'color', 'colorbox', 'cellcolor', 'rowcolor', 'multicolumn', 'multirow', 'makecell', 'toprule', 'midrule',
  'bottomrule', 'cmidrule', 'hline', 'cline', 'addlinespace', 'caption', 'label', 'ref', 'eqref', 'autoref', 'cref',
  'cite', 'citep', 'citet', 'includegraphics', 'centering', 'raggedright', 'small', 'footnotesize', 'scriptsize', 'tiny',
  'normalsize', 'large', 'Large', 'resizebox', 'rotatebox', 'setlength', 'tabcolsep', 'arraystretch', 'renewcommand',
  'section', 'subsection', 'subsubsection', 'paragraph', 'item', 'footnote', 'url', 'href', 'hspace', 'vspace', 'quad',
  'qquad', 'frac', 'sqrt', 'mathbf', 'mathrm', 'mathcal', 'boldsymbol', 'text', 'pm', 'times', 'cdot', 'leq', 'geq',
  'approx', 'sim', 'uparrow', 'downarrow', 'rightarrow', 'alpha', 'beta', 'gamma', 'delta', 'Delta', 'lambda', 'mu',
  'sigma', 'tau', 'checkmark', 'textwidth', 'columnwidth', 'linewidth', 'begin', 'end',
];

const ENVIRONMENTS = [
  'table', 'table*', 'figure', 'figure*', 'tabular', 'tabular*', 'tabularx', 'center', 'minipage', 'itemize', 'enumerate',
  'description', 'equation', 'equation*', 'align', 'align*', 'gather', 'cases', 'array', 'quote',
];

export interface CodeEditorHandle {
  /** Capture at compilation start; dispose when its PDF is replaced or the compilation fails. */
  captureSnapshot: (texts: Record<string, string>) => SourceSnapshot;
  /** Selects columns `start` to `end` on a 1-based line, centers it and briefly marks it. */
  reveal: (line: number, start?: number, end?: number) => void;
  /** Moves the cursor to a 1-based line and scrolls it into view. */
  goToLine: (line: number) => void;
  /** Inserts text at the cursor. */
  insert: (text: string) => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Problems to mark, by 1-based line of this editor's text. */
  problems?: { line: number; message: string }[];
  /** Commands defined in the paper's preamble, without the backslash. */
  macros?: string[];
  colors?: string[];
  /** Labels on the page, offered after \ref{. */
  labels?: string[];
  /** Grey text shown while the editor is empty. */
  placeholder?: string;
  onRun?: () => void;
  onSave?: () => void;
  className?: string;
}

function completions(names: React.MutableRefObject<{ macros: string[]; colors: string[]; labels: string[] }>) {
  return (context: CompletionContext) => {
    const reference = context.matchBefore(/\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref)\{[^}]*/);
    if (reference) {
      return { from: reference.from + reference.text.indexOf('{') + 1, options: names.current.labels.map((label) => ({ label, type: 'variable' })) };
    }
    const color = context.matchBefore(/\\(?:textcolor|color|cellcolor|rowcolor|colorbox)\{[^}]*/);
    if (color) {
      return { from: color.from + color.text.indexOf('{') + 1, options: names.current.colors.map((label) => ({ label, type: 'constant' })) };
    }
    const environment = context.matchBefore(/\\(?:begin|end)\{[A-Za-z*]*/);
    if (environment) {
      return { from: environment.from + environment.text.indexOf('{') + 1, options: ENVIRONMENTS.map((label) => ({ label, type: 'type' })) };
    }
    const command = context.matchBefore(/\\[A-Za-z]*/);
    if (!command || (command.from === command.to && !context.explicit)) return null;
    const own = names.current.macros.map((name) => ({ label: `\\${name}`, type: 'function', detail: t('导言区') }));
    return { from: command.from, options: [...own, ...COMMANDS.map((name) => ({ label: `\\${name}`, type: 'keyword' }))] };
  };
}

const flashLine = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(flashLine)) {
        if (effect.value === null) return Decoration.none;
        return Decoration.set([Decoration.line({ class: 'cm-code-flash' }).range(effect.value)]);
      }
    }
    return transaction.docChanged ? value.map(transaction.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.5' },
  '.cm-content': { paddingBottom: '40vh' },
  '&.cm-focused': { outline: 'none' },
  '.cm-code-flash': { animation: 'writing-flash 1.6s ease-out' },
});

/** A LaTeX code editor (CodeMirror 6) with highlighting, completion and problem markers. */
const CodeEditor = React.forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { value, onChange, problems = [], macros = [], colors = [], labels = [], placeholder, onRun, onSave, className = '' },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onRun, onSave });
  callbacks.current = { onChange, onRun, onSave };
  const names = useRef({ macros, colors, labels });
  names.current = { macros, colors, labels };
  const readOnly = useRef(new Compartment());
  const hint = useRef(new Compartment());
  const snapshots = useRef(new SourceSnapshots());
  const flashTimer = useRef<number | null>(null);
  // The imperative ref is available before the effect creates its EditorView. Keep navigation
  // across that gap and effect reinitialization, including StrictMode's first mount replay.
  const requestedNavigation = useRef<{ line: number; start?: number; end?: number; flash: boolean } | null>(null);

  const clearFlash = () => {
    if (flashTimer.current === null) return;
    window.clearTimeout(flashTimer.current);
    flashTimer.current = null;
    view.current?.dispatch({ effects: flashLine.of(null) });
  };

  const applyNavigation = () => {
    const editor = view.current;
    const request = requestedNavigation.current;
    if (!editor || !request) return;
    clearFlash();
    const target = editor.state.doc.line(Math.max(1, Math.min(request.line, editor.state.doc.lines)));
    const anchor = request.start === undefined ? target.from : Math.max(target.from, Math.min(target.to, target.from + request.start));
    const head = request.end === undefined ? anchor : Math.max(anchor, Math.min(target.to, target.from + request.end));
    editor.dispatch({
      selection: { anchor, head },
      effects: [EditorView.scrollIntoView(anchor, { y: 'center' }), ...(request.flash ? [flashLine.of(target.from)] : [])],
    });
    editor.focus();
    if (request.flash) flashTimer.current = window.setTimeout(clearFlash, 1600);
  };

  useEffect(() => {
    if (!host.current) return undefined;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          lintGutter(),
          StreamLanguage.define(stex),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          autocompletion({ override: [completions(names)] }),
          EditorView.lineWrapping,
          readOnly.current.of([]),
          hint.current.of(placeholder ? emptyHint(placeholder) : []),
          flashField,
          keymap.of([
            { key: 'Mod-Enter', run: () => (callbacks.current.onRun?.(), true) },
            { key: 'Mod-s', run: () => (callbacks.current.onSave?.(), true), preventDefault: true },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              snapshots.current.update('main.tex', update.changes, update.state.doc);
              callbacks.current.onChange(update.state.doc.toString());
            }
          }),
          theme,
        ],
      }),
    });
    view.current = editor;
    applyNavigation();
    return () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      flashTimer.current = null;
      snapshots.current.clear();
      editor.destroy();
      view.current = null;
    };
    // The editor is created once; later values arrive through the effect below.
  }, []);

  // The hint follows the interface language.
  useEffect(() => {
    view.current?.dispatch({ effects: hint.current.reconfigure(placeholder ? emptyHint(placeholder) : []) });
  }, [placeholder]);

  // Text set from outside (not typed here) replaces the document.
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    // A visual/table undo replaces the whole source; its old positions cannot be followed incrementally.
    snapshots.current.clear();
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const doc = editor.state.doc;
    const diagnostics: Diagnostic[] = problems
      .filter((problem) => problem.line >= 1 && problem.line <= doc.lines)
      .map((problem) => {
        const line = doc.line(problem.line);
        return { from: line.from, to: line.to, severity: 'error', message: problem.message };
      });
    editor.dispatch(setDiagnostics(editor.state, diagnostics));
  }, [problems]);

  useImperativeHandle(ref, () => ({
    captureSnapshot: (texts) => {
      const documents = new Map<string, EditorState['doc']>();
      if (view.current) documents.set('main.tex', view.current.state.doc);
      return snapshots.current.capture(texts, documents);
    },
    reveal: (line, start, end) => {
      requestedNavigation.current = { line, start, end, flash: true };
      applyNavigation();
    },
    goToLine: (line) => {
      requestedNavigation.current = { line, flash: false };
      applyNavigation();
    },
    insert: (text) => {
      const editor = view.current;
      if (!editor) return;
      const { from, to } = editor.state.selection.main;
      editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      editor.focus();
    },
  }));

  return <div ref={host} className={`h-full min-h-0 overflow-hidden ${className}`} />;
});

export default CodeEditor;
