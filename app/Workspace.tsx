import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Eye, FileCode2, LayoutList, MonitorPlay, Network, Pencil, Presentation as PresentIcon, Share2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { ContentContext } from '../components/ContentContext';
import { EditModeContext, EditModeValue } from '../components/EditMode';
import { PickedFile } from '../components/results/droppedFiles';
import { ResultsAccessContext, canEditShared } from '../components/results/access';
import ResultPage from '../components/results/ResultPage';
import { PresenceContext } from '../components/presence';
import { ItemModal } from '../editor/components/ItemModal';
import { usePresence } from '../editor/presence';
import { loadAttachments } from '../editor/results/actions';
import { UploadPlan, planUpload } from '../editor/results/uploads';
import { describeSaveError } from '../editor/backend';
import { findPaper } from '../lib/results';
import { useT } from '../lib/phrases/app';
import { EditRequest, ResultPaper, SlideDeck } from '../types';
import { collaboratorSession, ownerSession } from './accounts';
import { PaperList, useAccount } from './AccountContext';
import { Reach } from './Dashboard';
import ImportDialog from './ImportDialog';
import Presentation from './Presentation';
import ShareDialog from './ShareDialog';
import { withLatestLogic } from './logic/latest';
import { deckOf } from './slides/latest';

const BlockEditor = lazy(() => import('../editor/results/BlockEditor'));
const PaperSettings = lazy(() => import('../editor/results/PaperSettings'));
const ReferencesEditor = lazy(() => import('../editor/results/ReferencesEditor'));
const UploadDialog = lazy(() => import('../editor/results/UploadDialog'));
const WritingMode = lazy(() => import('./writing/WritingMode'));
const SlidesMode = lazy(() => import('./slides/SlidesMode'));
const LogicMode = lazy(() => import('./logic/LogicMode'));
const Present = lazy(() => import('./slides/Present'));

const noop = () => {};

const TOOL =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40';

/**
 * What is being presented: the paper block by block (along its sections, or along the logic its author built, from
 * a block), or its slides (a Beamer deck once compiled).
 */
type Presenting = null | { blocks: string | null; along: 'paper' | 'logic' } | { deck: SlideDeck; start: number; beamerPdf?: Uint8Array };

/**
 * A paper opened by its owner or by someone it is shared with: the results page with its editors, sharing and
 * the presentation mode. `list` is where the paper came from: the account's own papers, or the shared ones.
 */
const Workspace: React.FC<{ list: PaperList; owner: boolean; paperId?: string }> = ({ list, owner, paperId }) => {
  const t = useT();
  const account = useAccount()!;
  const { slug } = useParams();
  const { access, saveResults, saveContentOp, reorderBlocks, switchBlock: switchToKept, uploadFiles: uploadToPaper, isRenumbering, content } = list;
  // Shared papers come from several owners, whose slugs may repeat: the route says which one.
  const paper = (paperId ? content.results.find((item) => item.id === paperId) : undefined) ?? findPaper(content.results, slug);
  const shown = useMemo(() => ({ ...content, results: paper ? [paper] : [] }), [content, paper]);
  const session = useMemo(() => (owner ? ownerSession(account.account) : collaboratorSession(account.account)), [owner, account.account]);
  const presence = usePresence(session, account.features.comments);
  const [request, setRequest] = useState<EditRequest | null>(null);
  const [upload, setUpload] = useState<{ paperId: string; plan: UploadPlan } | null>(null);
  // A .zip of a LaTeX project dropped on the paper: it can become the paper itself, or only its attachments.
  const [importing, setImporting] = useState<{ paperId: string; plan: UploadPlan } | null>(null);
  // The owner looks at the page as readers see it, or edits it.
  const [editing, setEditing] = useState(true);
  // The paper block by block, or its slides from one of them.
  const [presenting, setPresenting] = useState<Presenting>(null);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [saving, setSaving] = useState(0);
  // The page's blocks, the whole paper as one LaTeX document with its PDF, its slides, or its logic as a tree.
  const [mode, setMode] = useState<'blocks' | 'write' | 'slides' | 'logic'>('blocks');
  // The writing, slide and logic views stay mounted once opened, so switching back and forth keeps their state.
  const [opened, setOpened] = useState<{ write?: boolean; slides?: boolean; logic?: boolean }>({});
  const bar = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const contentRef = useRef(content);
  contentRef.current = content;
  const { setToast } = account;

  // How many saves are on their way, for the toolbar; each one that lands counts as a change to the paper.
  const { touchPaper } = account;
  const author = paper ? (owner ? account.account.login : account.ownerOf(paper.id)?.login) : undefined;
  const counted = useCallback<typeof saveResults>(
    (...args) => {
      setSaving((n) => n + 1);
      return saveResults(...args)
        .then(() => {
          if (paper && author) touchPaper(author, paper.id);
        })
        .finally(() => setSaving((n) => n - 1));
    },
    [saveResults, paper, author, touchPaper],
  );

  const busy = useCallback(
    (paperId: string): boolean => {
      if (access.state !== 'private') {
        setToast({ message: () => t('论文还在加载，请稍后再试') });
        return true;
      }
      if (isRenumbering(paperId)) {
        setToast({ message: () => t('正在更新编号并保存，请几秒后再编辑') });
        return true;
      }
      return false;
    },
    [access.state, isRenumbering, setToast, t],
  );

  const open = useCallback(
    (next: EditRequest) => {
      const paperId = next.kind === 'edit' ? next.id : 'paperId' in next ? next.paperId : null;
      if (!owner && ((next.kind !== 'block' && next.kind !== 'paperSettings') || !canEditShared(access, paperId ?? ''))) {
        setToast({ message: () => t('你只能编辑作者允许你编辑的论文') });
        return;
      }
      if (paperId && busy(paperId)) return;
      setRequest(next);
    },
    [owner, access, busy, setToast, t],
  );

  const prepared = useRef(new Set<string>());
  const prepare = useCallback(
    (paperId: string) => {
      void import('../editor/tex/engine').then(({ warmTexEngine }) => warmTexEngine());
      void import('../editor/results/BlockEditor').catch(() => undefined);
      const item = contentRef.current.results.find((candidate) => candidate.id === paperId);
      if (!item || access.state !== 'private' || prepared.current.has(paperId)) return;
      prepared.current.add(paperId);
      loadAttachments(item, access.readFile).catch(() => prepared.current.delete(paperId));
    },
    [access],
  );

  const switchBlock = useCallback(
    (paperId: string, blockId: string) => {
      if (busy(paperId)) return;
      switchToKept(paperId, blockId, (convertTo) => setRequest({ kind: 'block', paperId, blockId, convertTo }));
    },
    [busy, switchToKept],
  );

  const uploadFiles = useCallback(
    (paperId: string, picked: PickedFile[]) => {
      const item = contentRef.current.results.find((candidate) => candidate.id === paperId);
      if (!item || busy(paperId)) return;
      planUpload(picked, item.files ?? []).then(
        (plan) => (plan.project ? setImporting({ paperId, plan }) : setUpload({ paperId, plan })),
        (error: unknown) => setToast({ message: () => describeSaveError(error) }),
      );
    },
    [busy, setToast],
  );

  const value = useMemo<EditModeValue>(
    () => ({
      editing: owner && editing,
      loggedIn: true,
      canLogin: true,
      ready: access.state !== 'loading',
      open,
      login: noop,
      reorder: noop,
      reorderBlocks,
      ...(owner ? { switchBlock, uploadFiles } : {}),
      prepare,
    }),
    [owner, editing, access.state, open, reorderBlocks, switchBlock, uploadFiles, prepare],
  );

  // The writing view fills the window under the paper's bar; the page itself stops scrolling meanwhile.
  useLayoutEffect(() => {
    if (mode === 'blocks') return undefined;
    window.scrollTo(0, 0);
    const measure = () => setTop(Math.round(bar.current?.getBoundingClientRect().bottom ?? 0));
    measure();
    window.addEventListener('resize', measure);
    // Focusing a field can still scroll the page under the view; it follows the bar.
    window.addEventListener('scroll', measure, { passive: true });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
      document.body.style.overflow = overflow;
    };
  }, [mode]);
  useEffect(() => {
    if (mode !== 'blocks') setOpened((current) => (current[mode] ? current : { ...current, [mode]: true }));
  }, [mode]);

  const present = () => {
    const deck = paper ? deckOf(paper) : null;
    if (!deck || !paper) {
      setPresenting({ blocks: null, along: 'paper' });
      return;
    }
    if (deck.kind === 'visual') {
      setPresenting({ deck, start: 0 });
      return;
    }
    // A Beamer deck shows once compiled (at once when the slide view already compiled it); one that does not
    // compile closes again and says so.
    const showing = (current: Presenting): current is { deck: SlideDeck; start: number; beamerPdf?: Uint8Array } => current !== null && 'deck' in current && current.deck === deck;
    setPresenting({ deck, start: 0 });
    import('./slides/beamer')
      .then(({ compileBeamer }) => compileBeamer(paper, deck.beamer ?? '', access.readFile))
      .then(({ pdf }) => {
        if (!pdf) throw new Error('no PDF');
        setPresenting((current) => (showing(current) ? { ...current, beamerPdf: pdf } : current));
      })
      .catch(() => {
        setPresenting((current) => (showing(current) ? null : current));
        setToast({ message: () => t('幻灯片还没编译成功，先修好代码里的问题') });
      });
  };

  const closeDialog = useCallback(() => setRequest(null), []);

  const presentFrom = useCallback((start: string | null) => setPresenting({ blocks: start, along: 'logic' }), []);
  const target: ResultPaper | undefined =
    request && request.kind !== 'edit' && 'paperId' in request ? content.results.find((item) => item.id === request.paperId) : undefined;
  const canEdit = owner || (paper ? canEditShared(access, paper.id) : false);

  if (access.state === 'loading') return <p className="py-24 text-center text-sm text-gray-400">{t('正在打开论文…')}</p>;
  if (!paper) {
    return (
      <div className="py-24 text-center">
        <p className="text-gray-700">{t('找不到这篇论文，可能已经删除，或者作者取消了共享。')}</p>
        <Link to="/" className="mt-4 inline-block text-sm text-violet-700 hover:underline">
          {t('回到我的论文')}
        </Link>
      </div>
    );
  }

  return (
    <ContentContext.Provider value={shown}>
      <EditModeContext.Provider value={value}>
        <ResultsAccessContext.Provider value={access}>
          <PresenceContext.Provider value={account.features.comments ? presence : null}>
            {/* The paper's own bar: what one does with the whole paper. */}
            <div ref={bar} className="sticky top-12 z-30 -mx-4 mb-6 flex flex-wrap items-center gap-1 border-b border-gray-200 bg-white/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 md:-mx-12 md:px-12">
              {owner && (
                <div role="group" aria-label={t('显示方式')} className="mr-3 flex rounded-lg bg-black/[0.05] p-0.5 text-[13px]">
                  {(
                    [
                      ['blocks', <LayoutList key="icon" size={14} />, t('分块')],
                      ['write', <FileCode2 key="icon" size={14} />, t('写作')],
                      ['slides', <MonitorPlay key="icon" size={14} />, t('幻灯片')],
                      ['logic', <Network key="icon" size={14} />, t('逻辑')],
                    ] as const
                  ).map(([value, icon, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={mode === value}
                      onClick={() => setMode(value)}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 transition-[background-color,box-shadow,color] duration-150 ${
                        mode === value ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.12)]' : 'text-gray-500 hover:text-gray-800'
                      }`}
                    >
                      {icon}
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <span className="mr-auto flex min-w-0 items-center gap-4 text-sm text-gray-500">
                {owner ? <Reach paper={paper} /> : <span className="truncate">{t('{name} 共享给你', { name: account.ownerOf(paper.id)?.name ?? '' })}</span>}
                {saving > 0 && <span className="text-gray-400">{t('保存中…')}</span>}
              </span>
              {owner && mode === 'blocks' && (
                <button type="button" onClick={() => setEditing((on) => !on)} aria-pressed={!editing} className={TOOL}>
                  {editing ? <Eye size={16} /> : <Pencil size={16} />}
                  {editing ? t('看读者视角') : t('回到编辑')}
                </button>
              )}
              {/* The slide and logic views have their own: the deck as it is on screen, the block chosen. */}
              {mode !== 'slides' && mode !== 'logic' && (
                <button type="button" onClick={present} className={TOOL}>
                  <PresentIcon size={16} />
                  {t('演示')}
                </button>
              )}
              {owner && account.features.sharing && (
                <button type="button" onClick={() => setSharingOpen(true)} className="inline-flex items-center gap-1.5 rounded-md bg-violet-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-800">
                  <Share2 size={16} />
                  {t('分享')}
                </button>
              )}
              {!owner && !canEdit && <span className="text-sm text-gray-400">{t('只读')}</span>}
            </div>
            <ResultPage inApp backTo="/" backLabel={t('我的论文')} />
            {owner && opened.write && (
              <Suspense fallback={null}>
                {/* One per paper: switching papers must never carry one paper's text or slides into another. */}
                <WritingMode key={paper.id} paper={paper} readFile={access.readFile} onSave={counted} top={top} visible={mode === 'write'} />
              </Suspense>
            )}
            {owner && opened.slides && (
              <Suspense fallback={null}>
                <SlidesMode
                  key={paper.id}
                  paper={paper}
                  readFile={access.readFile}
                  onSave={counted}
                  top={top}
                  visible={mode === 'slides'}
                  active={presenting === null}
                  onPresent={(deck, start, beamerPdf) => setPresenting({ deck, start, beamerPdf })}
                />
              </Suspense>
            )}
            {owner && opened.logic && (
              <Suspense fallback={null}>
                <LogicMode key={paper.id} paper={paper} onSave={counted} top={top} visible={mode === 'logic'} onPresent={presentFrom} />
              </Suspense>
            )}
            {request?.kind === 'block' && target && (
              <Suspense fallback={null}>
                <BlockEditor
                  paper={target}
                  blockId={request.blockId}
                  blockKind={request.blockKind}
                  afterBlockId={request.afterBlockId}
                  convertTo={request.convertTo}
                  readFile={access.readFile}
                  onSave={counted}
                  onClose={closeDialog}
                />
              </Suspense>
            )}
            {request?.kind === 'paperSettings' && target && (
              <Suspense fallback={null}>
                <PaperSettings paper={target} readFile={access.readFile} onSave={counted} onClose={closeDialog} />
              </Suspense>
            )}
            {request?.kind === 'references' && target && owner && (
              <Suspense fallback={null}>
                <ReferencesEditor paper={target} readFile={access.readFile} onSave={counted} onClose={closeDialog} />
              </Suspense>
            )}
            {request?.kind === 'edit' && owner && (
              <ItemModal request={request} content={content} onSave={(op) => saveContentOp(op)} onClose={closeDialog} />
            )}
            {upload && (
              <Suspense fallback={null}>
                <UploadDialog
                  title={paper.title}
                  plan={upload.plan}
                  onConfirm={() => {
                    uploadToPaper(upload.paperId, upload.plan.files);
                    setUpload(null);
                  }}
                  onClose={() => setUpload(null)}
                />
              </Suspense>
            )}
            {importing?.plan.project && owner && (
              <ImportDialog
                source={{ project: importing.plan.project }}
                into={content.results.find((item) => item.id === importing.paperId) ?? paper}
                onAttach={() => {
                  setUpload(importing);
                  setImporting(null);
                }}
                onClose={() => setImporting(null)}
              />
            )}
            {sharingOpen && owner && (
              <ShareDialog paper={paper} owner={account.account} saveContentOp={saveContentOp} saveResults={counted} onClose={() => setSharingOpen(false)} />
            )}
            {presenting && 'blocks' in presenting && (
              <Presentation paper={withLatestLogic(paper)} readFile={access.readFile} start={presenting.blocks} along={presenting.along} onClose={() => setPresenting(null)} />
            )}
            {presenting && 'deck' in presenting && (
              <Suspense fallback={null}>
                <Present paper={paper} deck={presenting.deck} readFile={access.readFile} start={presenting.start} beamerPdf={presenting.beamerPdf} onClose={() => setPresenting(null)} />
              </Suspense>
            )}
          </PresenceContext.Provider>
        </ResultsAccessContext.Provider>
      </EditModeContext.Provider>
    </ContentContext.Provider>
  );
};

export default Workspace;
