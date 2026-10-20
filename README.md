# Lemma

实验结果管理 + 科研写作一体化平台，而且很方便展示。

A platform for managing experiment results and writing the paper in one place, made to present well.

## 它能做什么

- **论文页**：用 LaTeX 写的文字、图和表格分块编译成清楚的网页，按章节排好；图可以放大，图和表格能互相切换，两份都保留。
- **写作模式**：整篇论文作为一个 main.tex 编辑，右边是整篇 PDF；双击 PDF 里的文字会跳到对应的 LaTeX 代码。
- **论文列表**：文件夹（可嵌套、可拖拽）、彩色标签、归档、搜索。
- **幻灯片**：每篇论文一套，第一次选做法：
  - 可视化幻灯片：用论文里编译好的图和表格先生成一套，再拖拽排版、加文字和演讲备注；论文里的块改了，幻灯片上的也跟着变。可以导出 PDF（块保持矢量）和 PowerPoint（文字可编辑，块是 300 dpi 图片）。
  - Beamer：用 LaTeX 写，`\lemmablock{tab:main}` 把论文里编译好的块放到一页上（按块的 `\label` 或块 id），右边实时编译。导出 PDF 就是编译结果，导出 PowerPoint 是每页一张图。
- **协作和展示**：分享给合作者、页边批注、演示模式（一块一屏，或者放幻灯片）。
- **在 Claude Code 里用**：Lemma 是一个 MCP 服务器，Claude Code 可以读论文、改块的 LaTeX 和导言区、搭逻辑结构（见下面「连接 Claude Code」）。

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

**不连 GitHub 的开发模式**：`npm run dev:mock` 用三个虚构账号（`zihanzhao1022`、`alice`、`bob`），数据都存在浏览器里（localStorage），清掉网站数据就回到初始状态，第一次打开会放进几篇虚构的示例论文（见 `.env.mock` 和 `lib/session.ts`）。

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
| `server/` | Cloudflare Pages Functions 的代码：GitHub 登录（`auth.ts`），给 Claude Code 的 MCP 服务器（`mcp/`） |
| `lib/` | 多语言（`lib/phrases/`，中文为键，带日文和英文）、会话和通用工具 |
| `public/texlive/` | TeX 引擎和常用 TeX Live 文件，由 `scripts/fetch-texlive.mjs` 生成 |

界面文字都写在 `t('中文')` 里，翻译在 `lib/phrases/*.ts`；`lib/i18n.coverage.test.ts` 会检查每句都有日文和英文。

## 部署

展示页是 Cloudflare Pages 项目 `lemmatex`（https://lemmatex.pages.dev ），连着这个仓库，每次推送到 main 自动构建和发布：

- 构建命令：`npm run build`，输出目录 `dist`，Node 版本读取 `.node-version`（22）
- `functions/api/` 是登录用的三个接口（Pages Functions，和网站同一个域名）：`/api/token` 用 GitHub 返回的 code 换令牌，`/api/refresh` 用只有这几个接口能读的 Cookie 续期，`/api/logout` 退出。代码在 `server/auth.ts`。
- `functions/mcp.ts`、`functions/api/mcp/`、`functions/.well-known/` 和 `functions/index.ts` 是给 Claude Code 的 MCP 服务器（见「连接 Claude Code」），用的是同一个 `GITHUB_CLIENT_SECRET`，不需要别的设置。本地试：`npm run build` 之后 `npx wrangler pages dev dist --port 8788`。
- 在 Pages 项目的 Settings → Variables and Secrets 里设置 `GITHUB_CLIENT_SECRET`（类型 Secret）：GitHub App 的 client secret，不进仓库。

## 连接 Claude Code

在终端里运行一次（`--scope user`：在哪个目录里打开 Claude Code 都能用）：

```bash
claude mcp add --transport http --scope user lemma https://lemmatex.pages.dev/mcp
```

然后在 Claude Code 里输入 `/mcp`，选 lemma → Authenticate：浏览器会打开 Lemma 的确认页，允许之后用 GitHub 登录，就连上了。之后可以直接说「列出我的 Lemma 论文」「把实验 3.2 挂到方法 2.1 下面」「改一下引言的第二段」。

- 能做的事：列出论文，看一篇论文的块、逻辑结构、关联线和附件，读块的 LaTeX 和文本附件（比如 `references.bib`）；改、加、删块，改导言区，把块挂到逻辑结构里或拿出来，连或删关联线。分享和公开不在其中。
- 每次修改都马上作为一次提交存进你的论文仓库，提交说明末尾带「(Claude Code)」。
- Claude Code 那边不编译 LaTeX：在 Lemma 里打开这篇论文时，改过的块会在后台自动编译；切回 Lemma 的标签页时会重新读取论文。
- 授权只会交给本机（localhost）上的 Claude Code。要撤销，在 GitHub 的 Settings → Applications → Authorized GitHub Apps 里撤销 Lemma。

实现在 `server/mcp/`：`oauth.ts` 让网站当 OAuth 授权服务器（用 GitHub 登录，发给客户端的是封好的令牌，`seal.ts`，服务器不存任何东西），`protocol.ts` 是 MCP 接口，`tools.ts` 是各个工具，`library.ts` 用和网页相同的方式读写论文仓库。GitHub App 只允许回到网站首页，所以 GitHub 的回答先到首页，再由 `functions/index.ts` 转给 MCP 的登录流程。

## 账号和数据

每个人用自己的 GitHub 账号登录，论文存在自己账号下的一个仓库里（默认叫 `lemma-papers`，私有）：`results.json` 是论文列表和各块的 LaTeX，`results/<论文>/` 放编译好的 PDF 和附件，`lemma.json` 标记这是 Lemma 的仓库。第一次登录时，Lemma 的页面带着填好的名字打开 GitHub 的新建仓库页，再请用户把 Lemma 的 GitHub App 装到这个仓库上；App 只能读写装了它的仓库。

GitHub App 是 `lemmatex`（https://github.com/apps/lemmatex ），公开的 client ID 和名字写在 `app/github/config.ts`。它的权限只有仓库内容读写（和必带的元数据只读），回调地址是 https://lemmatex.pages.dev/ ，安装时同时请求用户授权。

目前每个账号只能管理自己的论文：分享给合作者、"与我共享"、批注和公开链接还没接上，界面上先不显示（见 `app/AccountContext.tsx` 的 `Features`）。

本地开发：`npm run dev` 是真实登录（需要 Pages Functions，只在 Cloudflare 上有）；`npm run dev:mock` 用三个虚构账号，数据存在浏览器里，不连 GitHub。

## 来历

从 [zihanzhao1022.github.io](https://github.com/zihanzhao1022/zihanzhao1022.github.io) 的“论文结果”页面拆出来。`editor/` 里还留着一些主页编辑器的代码（个人资料、新闻等表单，`editor/config.ts` 里主页的 GitHub App 和 Worker 地址），Lemma 用不到（它的登录在 `app/github/`），以后再整理。

## 许可

AGPL-3.0，见 `LICENSE`。内置的 SwiftLaTeX 也是 AGPL-3.0（`public/texlive/LICENSE-SwiftLaTeX.txt`）。
