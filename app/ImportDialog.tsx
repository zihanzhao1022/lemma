import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Modal } from '../editor/components/Modal';
import { describeSaveError } from '../editor/backend';
import { REFERENCES_FILE } from '../editor/results/compile';
import { ProjectPaper, mainCandidates, projectPaper } from '../editor/results/project';
import type { DroppedProject } from '../editor/results/uploads';
import { unzip } from '../editor/results/zip';
import { useMessage } from '../lib/i18n';
import { useT } from '../lib/phrases/app';
import { ResultPaper } from '../types';
import { useAccount } from './AccountContext';
import { newPaper } from './library';
import { moveTo, paperKey, touch } from './organizer';

/** A list of file names, scrolling when long. */
const Names: React.FC<{ names: string[] }> = ({ names }) => (
  <ul className="max-h-32 overflow-y-auto rounded border border-gray-100 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700">
    {names.map((name) => (
      <li key={name} className="truncate" title={name}>
        {name}
      </li>
    ))}
  </ul>
);

interface Read {
  files: Record<string, Uint8Array>;
  candidates: string[];
  skipped: string[];
}

interface Props {
  /** A .zip picked for a new paper, or one dropped on a paper that holds a LaTeX project (planUpload). */
  source: { file: File } | { project: DroppedProject };
  /** The paper the project goes into, in place of its content; a new paper otherwise. */
  into?: ResultPaper;
  /** Where a new paper goes. */
  folder?: string | null;
  /** Puts the .zip's files in the paper's attachments instead, as any upload (into a paper only). */
  onAttach?: () => void;
  onClose: () => void;
}

/**
 * A paper from a .zip of a LaTeX project (an Overleaf download): what it will hold is shown first, its title can
 * be changed, and its main file chosen when there are several. Importing saves it as it is; the blocks compile
 * one after another in the background. A new paper opens once saved; a paper the .zip was dropped on gets the
 * project in place of its content.
 */
const ImportDialog: React.FC<Props> = ({ source, into, folder = null, onAttach, onClose }) => {
  const t = useT();
  const navigate = useNavigate();
  const { account, mine, organize, setToast } = useAccount()!;
  const [read, setRead] = useState<Read | null>(null);
  const [main, setMain] = useState('');
  const [project, setProject] = useState<ProjectPaper | null>(null);
  const [title, setTitle] = useState('');
  // Into a paper: whether it takes the project's title and authors too (an empty paper does unless told not to).
  const [retitle, setRetitle] = useState(!into || into.blocks.length === 0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useMessage();
  // What the dialog reads, whatever object the caller wraps it in.
  const origin: File | DroppedProject = 'file' in source ? source.file : source.project;
  const name = 'archive' in origin ? (origin.archive.split('/').pop() ?? origin.archive) : origin.name;

  // The .zip, once.
  useEffect(() => {
    let current = true;
    const opened =
      'archive' in origin
        ? Promise.resolve({ files: origin.files, skipped: origin.skipped })
        : unzip(origin).then((unzipped) => ({ files: unzipped.files, skipped: [...unzipped.skipped.type, ...unzipped.skipped.size] }));
    opened
      .then(({ files, skipped }) => {
        if (!current) return;
        const candidates = mainCandidates(files);
        if (candidates.length === 0) {
          setProblem(() => t('压缩包里没有找到 LaTeX 主文件（含有 \\documentclass 和 \\begin{document} 的 .tex）。'));
          return;
        }
        setRead({ files, candidates, skipped });
        setMain(candidates[0]);
      })
      .catch(() => {
        if (current) setProblem(() => t('读不了这个压缩包，请确认它是 .zip 文件。'));
      });
    return () => {
      current = false;
    };
  }, [origin, setProblem, t]);

  // What the chosen main file makes of the project.
  useEffect(() => {
    if (!read || !main) return undefined;
    let current = true;
    void projectPaper(read.files, main).then((made) => {
      if (!current) return;
      setProject(made);
      setTitle((now) => now || made?.title || into?.title || name.replace(/\.zip$/i, ''));
    });
    return () => {
      current = false;
    };
  }, [read, main, name, into?.title]);

  const kinds = (project?.blocks ?? []).reduce((count, block) => ({ ...count, [block.kind]: (count[block.kind] ?? 0) + 1 }), {} as Record<string, number>);
  // Attachments named like the parts now in the text (a main.tex put there by an earlier upload) go.
  const removed = into && project ? project.taken.filter((path) => (into.files ?? []).includes(path) && !(path in project.attachments)) : [];

  const start = async () => {
    if (!project || busy) return;
    if (retitle && !title.trim()) {
      setProblem(() => t('先给论文起个标题'));
      return;
    }
    setBusy(true);
    setProblem(null);
    const stamp = Date.now().toString(36);
    const mark = (author: string) => (author.toLowerCase() === account.name.toLowerCase() ? `**${author}**` : author);
    const base = into ?? newPaper({ title, year: new Date().getFullYear() }, account.name, mine.content.results.map((item) => item.slug));
    const paper: ResultPaper = {
      ...base,
      ...(retitle ? { title: title.trim(), ...(project.authors.length > 0 ? { authors: project.authors.map(mark) } : {}) } : {}),
      preamble: project.preamble,
      blocks: project.blocks.map((block, index) => ({ id: `blk-${stamp}${index.toString(36).padStart(3, '0')}`, kind: block.kind, source: block.source })),
    };
    const progress = (done: number, total: number) => setToast({ message: () => t('正在编译第 {done} / {total} 块…', { done, total }) });
    try {
      await mine.importPaper(paper, project.attachments, progress, into ? { previous: into, remove: removed } : undefined);
      const key = paperKey(account.login, paper.id);
      organize((current) => touch(folder && !into ? moveTo(current, [key], folder) : current, key));
      onClose();
      if (!into) navigate(`/p/${account.login}/${paper.slug}`);
    } catch (error) {
      setProblem(() => describeSaveError(error));
      setBusy(false);
    }
  };

  const attachments = project ? Object.keys(project.attachments) : [];
  const replacing = into ? into.blocks.length : 0;
  return (
    <Modal
      title={into ? t('把 {name} 导入这篇论文', { name }) : t('从压缩包导入论文')}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>
            {t('取消')}
          </button>
          {onAttach && (
            <button type="button" disabled={busy} onClick={onAttach} className={BUTTON_SECONDARY}>
              {t('只放进附件')}
            </button>
          )}
          <button type="button" disabled={!project || busy} onClick={() => void start()} className={BUTTON_PRIMARY}>
            {busy ? t('导入中…') : replacing > 0 ? t('替换并导入') : t('导入')}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-gray-700">
        {!project && !problem && (
          <p className="flex items-center gap-2 text-gray-500">
            <Loader2 size={15} className="animate-spin" />
            {t('正在读取 {name}…', { name })}
          </p>
        )}
        {project && (
          <>
            {into && <p>{t('这是一个 LaTeX 项目：导入后，它的正文和导言区就是这篇论文的，各块会编译出来；其他文件放进附件。')}</p>}
            {replacing > 0 && <p className="text-amber-700">{t('这篇论文现有的 {n} 个块和导言区会换成压缩包里的；同名的附件会被覆盖，其他附件保留。', { n: replacing })}</p>}
            {into && (
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={retitle} onChange={(event) => setRetitle(event.target.checked)} className="mt-0.5 accent-violet-700" />
                <span>{t('标题和作者也用项目里的')}</span>
              </label>
            )}
            {retitle && (
              <label className="block space-y-1">
                <span className="text-gray-700">{t('标题')}</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100" />
              </label>
            )}
            {read && read.candidates.length > 1 && (
              <label className="block space-y-1">
                <span className="text-gray-700">{t('主文件')}</span>
                <select value={main} onChange={(event) => setMain(event.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-[13px]">
                  {read.candidates.map((path) => (
                    <option key={path} value={path}>
                      {path}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p>
              {t('从 {main} 拆出 {n} 个块：{text} 段文字、{figures} 张图、{tables} 个表格；导言区沿用它的。', {
                main: project.main,
                n: project.blocks.length,
                text: kinds.text ?? 0,
                figures: kinds.figure ?? 0,
                tables: kinds.table ?? 0,
              })}
            </p>
            {attachments.length > 0 && (
              <div className="space-y-1">
                <p>{t('{n} 个文件放进附件，文件夹保留原样：', { n: attachments.length })}</p>
                <Names names={attachments} />
                {attachments.includes(REFERENCES_FILE) && <p className="text-xs text-gray-500">{t('参考文献用项目里的 .bib，合成 references.bib。')}</p>}
              </div>
            )}
            {removed.length > 0 && (
              <div className="space-y-1">
                <p className="text-gray-500">{t('附件里的这些文件已经并入正文，会从附件里删掉：')}</p>
                <Names names={removed} />
              </div>
            )}
            {project.renamed.length > 0 && (
              <div className="space-y-1">
                <p className="text-amber-700">{t('这些文件名换了（空格或中文等），代码里写到它们的地方一起改了：')}</p>
                <Names names={project.renamed.map(({ from, to }) => `${from} → ${to}`)} />
              </div>
            )}
            {read && read.skipped.length > 0 && (
              <div className="space-y-1">
                <p className="text-gray-500">{t('跳过 {n} 个编译用不到或超过 20 MB 的文件：', { n: read.skipped.length })}</p>
                <Names names={read.skipped} />
              </div>
            )}
            {project.overflow.length > 0 && (
              <div className="space-y-1">
                <p className="text-gray-500">{t('一次最多导入 {max} 个文件，跳过了其余 {n} 个：', { max: attachments.length, n: project.overflow.length })}</p>
                <Names names={project.overflow} />
              </div>
            )}
            <p className="text-xs text-gray-500">
              {into ? t('各块会在后台依次编译，可能要一两分钟；编译不了的块会提示你修改。') : t('导入后会打开这篇论文，各块在后台依次编译，可能要一两分钟；编译不了的块会提示你修改。')}
            </p>
          </>
        )}
        {problem && (
          <p role="alert" className="text-red-700">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
};

export default ImportDialog;
