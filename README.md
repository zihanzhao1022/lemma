# Lemma

实验结果管理 + 科研写作一体化平台，而且很方便展示。现在是原型阶段。

A platform for managing experiment results and writing the paper in one place, made to present well. This is a prototype.

## 它能做什么

- **论文页**：用 LaTeX 写的文字、图和表格分块编译成清楚的网页，按章节排好；图可以放大，图和表格能互相切换，两份都保留。
- **写作模式**：整篇论文作为一个 main.tex 编辑，右边是整篇 PDF；双击 PDF 里的文字会跳到对应的 LaTeX 代码。
- **论文列表**：文件夹（可嵌套、可拖拽）、彩色标签、归档、搜索。
- **幻灯片**：每篇论文一套，第一次选做法：
  - 可视化幻灯片：用论文里编译好的图和表格先生成一套，再拖拽排版、加文字和演讲备注；论文里的块改了，幻灯片上的也跟着变。可以导出 PDF（块保持矢量）和 PowerPoint（文字可编辑，块是 300 dpi 图片）。
  - Beamer：用 LaTeX 写，`\lemmablock{tab:main}` 把论文里编译好的块放到一页上（按块的 `\label` 或块 id），右边实时编译。导出 PDF 就是编译结果，导出 PowerPoint 是每页一张图。
- **协作和展示**：分享给合作者、页边批注、演示模式（一块一屏，或者放幻灯片）。

LaTeX 在浏览器里编译（SwiftLaTeX 的 pdfTeX，见 `public/texlive/`），不需要编译服务器。

## 本地运行

需要 Node 22（见 `.node-version`）。

```bash
npm install
npm run dev
```

然后打开 http://localhost:3000 。其他命令：

```bash
npm test        # 单元测试（vitest）
npm run build   # 类型检查并构建到 dist/
npm run preview # 预览构建结果
```

**原型说明**：登录用的是三个虚构账号（`zihanzhao1022`、`alice`、`bob`），数据都存在浏览器里（localStorage），清掉网站数据就回到初始状态。第一次打开会放进几篇虚构的示例论文。`index.html` 里的 `window.__LEMMA_PROTOTYPE__` 开启这个模式（见 `lib/session.ts`）。

## 目录

| 目录 | 内容 |
| --- | --- |
| `app/` | Lemma 的界面：首页、论文列表（文件夹、标签）、论文页、分享、演示 |
| `app/writing/` | 写作模式：整篇文档、位置标记、PDF 双击定位到代码 |
| `app/slides/` | 幻灯片：可视化编辑器、Beamer 编辑和编译、演示、导出 PDF 和 PowerPoint |
| `app/example/` | 内置的虚构示例论文（预先编译好的 PDF） |
| `components/results/` | 论文页：分块显示、目录、批注、PDF 显示 |
| `editor/results/` | 块编辑器、表格可视化编辑器、编译和保存 |
| `editor/tex/` | 浏览器里的 pdfTeX（worker 外壳、日志解析） |
| `lib/` | 多语言（`lib/phrases/`，中文为键，带日文和英文）、会话和通用工具 |
| `public/texlive/` | TeX 引擎和常用 TeX Live 文件，由 `scripts/fetch-texlive.mjs` 生成 |

界面文字都写在 `t('中文')` 里，翻译在 `lib/phrases/*.ts`；`lib/i18n.coverage.test.ts` 会检查每句都有日文和英文。

## 部署

静态站点，任何静态托管都可以。展示页是 Cloudflare 上的 Worker `lemmatex`（只放静态文件），连着这个仓库，每次推送到 main 自动构建和发布：

- 构建命令：`npm run build`
- 部署命令：`npx wrangler deploy`，按 `wrangler.jsonc` 把 `dist/` 发布出去（Worker 名必须和这里的 `name` 一致）
- Node 版本：读取 `.node-version`（22）

地址是 `lemmatex.<账号的子域>.workers.dev`，在 Cloudflare 控制台 lemmatex 的 Domains 里能看到，也能在那里绑定自己的域名。本地检查配置：`npm run build && npx wrangler deploy --dry-run`（不会发布）。

## 来历

从 [zihanzhao1022.github.io](https://github.com/zihanzhao1022/zihanzhao1022.github.io) 的“论文结果”页面拆出来。`editor/` 里还留着一些主页编辑器的代码（个人资料、新闻等表单，`editor/config.ts` 里主页的 GitHub App 和 Worker 地址），原型用不到，以后接真实账号时再整理。

## 许可

AGPL-3.0，见 `LICENSE`。内置的 SwiftLaTeX 也是 AGPL-3.0（`public/texlive/LICENSE-SwiftLaTeX.txt`）。
