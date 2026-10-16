import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Modal } from '../editor/components/Modal';
import { describeSaveError } from '../editor/backend';
import { REFERENCES_FILE } from '../editor/results/compile';
import { ProjectPaper, mainCandidates, projectPaper } from '../editor/results/project';
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

/**
 * A new paper from a .zip of a LaTeX project (an Overleaf download): what it will hold is shown first, its
 * title can be changed, and its main file chosen when there are several. Importing saves it as it is and goes
 * to its page; the blocks compile there one after another.
 */
const ImportDialog: React.FC<{ file: File; folder: string | null; onClose: () => void }> = ({ file, folder, onClose }) => {
  const t = useT();
  const navigate = useNavigate();
  const { account, mine, organize, setToast } = useAccount()!;
  const [read, setRead] = useState<Read | null>(null);
  const [main, setMain] = useState('');
  const [project, setProject] = useState<ProjectPaper | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useMessage();

  // The .zip, once.
  useEffect(() => {
    let current = true;
    unzip(file)
      .then((opened) => {
        if (!current) return;
        const candidates = mainCandidates(opened.files);
        if (candidates.length === 0) {
          setProblem(() => t('压缩包里没有找到 LaTeX 主文件（含有 \\documentclass 和 \\begin{document} 的 .tex）。'));
          return;
        }
        setRead({ files: opened.files, candidates, skipped: [...opened.skipped.type, ...opened.skipped.size] });
        setMain(candidates[0]);
      })
      .catch(() => {
        if (current) setProblem(() => t('读不了这个压缩包，请确认它是 .zip 文件。'));
      });
    return () => {
      current = false;
    };
  }, [file, setProblem, t]);

  // What the chosen main file makes of the project.
  useEffect(() => {
    if (!read || !main) return undefined;
    let current = true;
    void projectPaper(read.files, main).then((made) => {
      if (!current) return;
      setProject(made);
      setTitle((now) => now || made?.title || file.name.replace(/\.zip$/i, ''));
    });
    return () => {
      current = false;
    };
  }, [read, main, file.name]);

  const kinds = (project?.blocks ?? []).reduce((count, block) => ({ ...count, [block.kind]: (count[block.kind] ?? 0) + 1 }), {} as Record<string, number>);

  const start = async () => {
    if (!project || busy) return;
    if (!title.trim()) {
      setProblem(() => t('先给论文起个标题'));
      return;
    }
    setBusy(true);
    setProblem(null);
    const base = newPaper({ title, year: new Date().getFullYear() }, account.name, mine.content.results.map((item) => item.slug));
    const stamp = Date.now().toString(36);
    const mark = (name: string) => (name.toLowerCase() === account.name.toLowerCase() ? `**${name}**` : name);
    const paper: ResultPaper = {
      ...base,
      ...(project.authors.length > 0 ? { authors: project.authors.map(mark) } : {}),
      preamble: project.preamble,
      blocks: project.blocks.map((block, index) => ({ id: `blk-${stamp}${index.toString(36).padStart(3, '0')}`, kind: block.kind, source: block.source })),
    };
    try {
      await mine.importPaper(paper, project.attachments, (done, total) => setToast({ message: () => t('正在编译第 {done} / {total} 块…', { done, total }) }));
      const key = paperKey(account.login, paper.id);
      organize((current) => touch(folder ? moveTo(current, [key], folder) : current, key));
      onClose();
      navigate(`/p/${account.login}/${paper.slug}`);
    } catch (error) {
      setProblem(() => describeSaveError(error));
      setBusy(false);
    }
  };

  const attachments = project ? Object.keys(project.attachments) : [];
  return (
    <Modal
      title={t('从压缩包导入论文')}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>
            {t('取消')}
          </button>
          <button type="button" disabled={!project || busy} onClick={() => void start()} className={BUTTON_PRIMARY}>
            {busy ? t('导入中…') : t('导入')}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-gray-700">
        {!project && !problem && (
          <p className="flex items-center gap-2 text-gray-500">
            <Loader2 size={15} className="animate-spin" />
            {t('正在读取 {name}…', { name: file.name })}
          </p>
        )}
        {project && (
          <>
            <label className="block space-y-1">
              <span className="text-gray-700">{t('标题')}</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100" />
            </label>
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
            <div className="space-y-1">
              <p>{t('{n} 个文件放进附件，文件夹保留原样：', { n: attachments.length })}</p>
              <Names names={attachments} />
              {attachments.includes(REFERENCES_FILE) && <p className="text-xs text-gray-500">{t('参考文献用项目里的 .bib，合成 references.bib。')}</p>}
            </div>
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
            <p className="text-xs text-gray-500">{t('导入后会打开这篇论文，各块在后台依次编译，可能要一两分钟；编译不了的块会提示你修改。')}</p>
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
