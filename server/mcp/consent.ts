/**
 * The pages a person sees while connecting Claude Code (or another MCP client) to Lemma: the question whether to
 * let it in, and what went wrong. In the person's language (Chinese, Japanese or English), on the site itself.
 */

export type Lang = 'zh' | 'ja' | 'en';

const WORDS = {
  zh: {
    title: '允许 {client} 使用你的 Lemma 论文？',
    body: '它可以读取你的论文，修改块的 LaTeX、导言区和逻辑结构；每次修改都作为一次提交存进你的 GitHub 仓库。',
    where: '用 GitHub 登录之后，授权交给这台电脑上的 {where}。',
    allow: '允许，用 GitHub 登录',
    deny: '取消',
    revoke: '以后可以在 GitHub 的 {link} 里撤销 Lemma 的授权。',
    revokeLink: '已授权的应用',
    badClient: '这个连接链接无效。请回到 Claude Code，重新连接 Lemma。',
    expired: '这次连接已经过期。请回到 Claude Code，重新连接 Lemma。',
    unavailable: 'Lemma 的登录服务还没有设置好。',
    problem: '没能连接',
  },
  ja: {
    title: '{client} に Lemma の論文の利用を許可しますか？',
    body: '論文を読み、ブロックの LaTeX、プリアンブル、論理構成を変更できます。変更はそのたびに GitHub リポジトリへのコミットとして保存されます。',
    where: 'GitHub でログインすると、このコンピューターの {where} に認可が渡されます。',
    allow: '許可して GitHub でログイン',
    deny: 'キャンセル',
    revoke: 'Lemma の認可は、後から GitHub の {link} で取り消せます。',
    revokeLink: '認可済みのアプリ',
    badClient: 'この接続リンクは無効です。Claude Code に戻って、もう一度 Lemma に接続してください。',
    expired: 'この接続は期限が切れました。Claude Code に戻って、もう一度 Lemma に接続してください。',
    unavailable: 'Lemma のログインはまだ設定されていません。',
    problem: '接続できませんでした',
  },
  en: {
    title: 'Let {client} use your Lemma papers?',
    body: 'It can read your papers and change their blocks’ LaTeX, their preambles and their logic; each change is saved as a commit to your GitHub repository.',
    where: 'Once you sign in with GitHub, the authorization goes to {where} on this computer.',
    allow: 'Allow and sign in with GitHub',
    deny: 'Cancel',
    revoke: 'You can revoke Lemma’s authorization later under GitHub’s {link}.',
    revokeLink: 'authorized apps',
    badClient: 'This connection link is not valid. Go back to Claude Code and connect Lemma again.',
    expired: 'This connection has expired. Go back to Claude Code and connect Lemma again.',
    unavailable: 'Signing in to Lemma is not set up yet.',
    problem: 'Could not connect',
  },
} satisfies Record<Lang, Record<string, string>>;

export type Problem = 'badClient' | 'expired' | 'unavailable';

/** The person's language, from what the browser asks for; English when it is none of the three. */
export function languageOf(request: Request): Lang {
  for (const part of (request.headers.get('Accept-Language') ?? '').split(',')) {
    const tag = part.trim().toLowerCase();
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('ja')) return 'ja';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');

const STYLE = `
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--muted:#6e6e73;--line:rgba(0,0,0,.12);--accent:#6d28d9;--accent-strong:#5b21b6}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--card:#2c2c2e;--text:#f5f5f7;--muted:#a1a1a6;--line:rgba(255,255,255,.16);--accent:#8b5cf6;--accent-strong:#7c3aed}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans","Noto Sans CJK SC",sans-serif}
main{width:100%;max-width:440px;padding:28px;border-radius:16px;background:var(--card);box-shadow:0 16px 48px -20px rgba(0,0,0,.35)}
.mark{font:600 15px/1 "Source Serif 4",Georgia,serif;color:var(--accent)}
h1{margin:12px 0;font-size:19px;line-height:1.45}
p{margin:0 0 12px;color:var(--muted)}
strong{color:var(--text);font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}
button{font:inherit;padding:8px 16px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}
button.allow{border-color:var(--accent);background:var(--accent);color:#fff;font-weight:600}
button.allow:hover{background:var(--accent-strong)}
button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.note{margin:20px 0 0;font-size:13px}
a{color:var(--accent)}
`;

/** The page's own rules: nothing loads from elsewhere, and no other site can frame it to steal a click. */
const HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const page = (lang: Lang, body: string): string =>
  `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lemma</title><style>${STYLE}</style></head><body><main><div class="mark">Lemma</div>${body}</main></body></html>`;

/**
 * Whether to let `client` in. The client names itself, so the page also shows where on this computer the
 * answer goes; `sealed` carries the request to the form's handler.
 */
export function consentPage(lang: Lang, { client, where, sealed }: { client: string; where: string; sealed: string }, headers: Record<string, string> = {}): Response {
  const words = WORDS[lang];
  const link = `<a href="https://github.com/settings/apps/authorizations" target="_blank" rel="noopener noreferrer">${escape(words.revokeLink)}</a>`;
  const body = `<h1>${escape(fill(words.title, { client }))}</h1>
<p>${escape(words.body)}</p>
<p>${fill(escape(words.where), { where: `<strong>${escape(where)}</strong>` })}</p>
<form method="post" action="/api/mcp/authorize">
<input type="hidden" name="request" value="${escape(sealed)}">
<div class="actions"><button class="allow" type="submit" name="decision" value="allow">${escape(words.allow)}</button><button type="submit" name="decision" value="deny">${escape(words.deny)}</button></div>
</form>
<p class="note">${fill(escape(words.revoke), { link })}</p>`;
  return new Response(page(lang, body), { status: 200, headers: { ...HEADERS, ...headers } });
}

/** What went wrong, when there is no client to send the answer to. */
export function problemPage(lang: Lang, problem: Problem, status: number): Response {
  const words = WORDS[lang];
  return new Response(page(lang, `<h1>${escape(words.problem)}</h1><p>${escape(words[problem])}</p>`), { status, headers: HEADERS });
}
