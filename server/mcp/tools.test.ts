import { describe, expect, it } from 'vitest';
import { GitHubError } from '../../editor/github';
import { ResultsOp, applyResultsOp } from '../../editor/results/ops';
import { ResultBlock, ResultPaper } from '../../types';
import { Library } from './library';
import { handleMcp } from './protocol';
import { seal } from './seal';

const SITE = 'https://lemma.example';
const env = { GITHUB_CLIENT_SECRET: 'made-up-secret' };

/** LaTeX's counters at the end of each block, as compiling the made-up paper leaves them. */
const COUNTERS: Record<string, Record<string, number>> = {
  intro: { section: 1, subsection: 0, figure: 0 },
  meth: { section: 2, subsection: 0, figure: 0 },
  m1: { section: 2, subsection: 1, figure: 0 },
  m2: { section: 2, subsection: 2, figure: 0 },
  exps: { section: 3, subsection: 0, figure: 0 },
  e1: { section: 3, subsection: 1, figure: 0 },
  f1: { section: 3, subsection: 1, figure: 1 },
  e2: { section: 3, subsection: 2, figure: 1 },
  concl: { section: 4, subsection: 0, figure: 1 },
};
const output = (id: string) => ({ pdf: `results/res-a/${id}-0000.pdf`, width: 400, height: 100, counters: COUNTERS[id] });
const text = (id: string, source: string): ResultBlock => ({ id, kind: 'text', source, output: output(id) });

/** A made-up paper: two methods, their experiments in the next section, and a logic begun by hand. */
const paper = (): ResultPaper => ({
  id: 'res-a',
  slug: 'made-up-study',
  title: 'A Made-up Study of Gates',
  authors: ['Ada Example'],
  venue: 'Made-up Conf',
  year: 2027,
  blocks: [
    text('intro', '\\section{Introduction}\nA made-up introduction.'),
    text('meth', '\\section{Method}\nOverview.'),
    text('m1', '\\subsection{Gate}\nThe made-up gate.'),
    text('m2', '\\subsection{Cache}\nThe made-up cache.'),
    text('exps', '\\section{Experiments}\nSetup.'),
    text('e1', '\\subsection{Gate accuracy}\nResult one.'),
    { id: 'f1', kind: 'figure', source: '\\begin{figure}\n\\caption{Made-up accuracy.}\n\\end{figure}', output: output('f1') },
    text('e2', '\\subsection{Cache hits}\nResult two.'),
    text('concl', '\\section{Conclusion}\nDone.'),
  ],
  logic: { meth: 'intro', m1: 'meth', e1: 'm1' },
  files: ['references.bib', 'fig/plot.png'],
});

interface Commit {
  op: ResultsOp;
  message: string;
  deletes: string[];
}

/** The papers in memory, saved as the repository would: the op applied to the latest list. */
function fakeLibrary(papers: ResultPaper[] = [paper()], files: Record<string, string> = {}) {
  const state = { papers, commits: [] as Commit[] };
  const library: Library = {
    repo: 'ada-example/lemma-papers',
    papers: async () => state.papers,
    save: async (op, message, deletes = [], check) => {
      check?.(state.papers);
      state.papers = applyResultsOp(state.papers, op);
      state.commits.push({ op, message, deletes });
      return state.papers;
    },
    readText: async (path) => files[path] ?? null,
  };
  return { library, state };
}

async function post(body: unknown, library: Library | (() => Promise<Library>), authorized = true): Promise<Response> {
  const token = await seal(env.GITHUB_CLIENT_SECRET, 'access', { github: 'ghu_made_up', login: 'ada-example', aud: `${SITE}/mcp` }, Date.now() + 60_000);
  const open = typeof library === 'function' ? library : async () => library;
  return handleMcp(
    new Request(`${SITE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }),
    env,
    open,
  );
}

async function tool(library: Library, name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  const res = await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, library);
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: body.result.content[0].text, error: body.result.isError === true };
}

const blockIds = (papers: ResultPaper[]) => papers[0].blocks.map((block) => block.id);

describe('the MCP endpoint', () => {
  it('asks for a token first, saying where to get one', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize' }, fakeLibrary().library, false);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('starts a session in the version the client speaks, and lists its tools', async () => {
    const { library } = fakeLibrary();
    const init = (await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }, library)).json()) as { result: Record<string, unknown> };
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'lemma' } });
    expect(String(init.result.instructions)).toContain('compiles changed blocks');
    const newer = (await (await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, library)).json()) as { result: { protocolVersion: string } };
    expect(newer.result.protocolVersion).toBe('2025-11-25');
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, library)).status).toBe(202);
    const listed = (await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, library)).json()) as { result: { tools: Record<string, unknown>[] } };
    expect(listed.result.tools.map((item) => item.name)).toEqual([
      'list_papers',
      'get_paper',
      'read_blocks',
      'read_attachment',
      'update_block',
      'add_block',
      'delete_block',
      'update_preamble',
      'place_blocks',
      'remove_from_logic',
      'link_blocks',
      'unlink_blocks',
    ]);
    for (const item of listed.result.tools) {
      expect(item).toMatchObject({ inputSchema: { type: 'object' } });
      expect(item).not.toHaveProperty('run');
    }
    const unknown = (await (await post({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, library)).json()) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
    const noTool = (await (await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'format_disk' } }, library)).json()) as { error: { code: number } };
    expect(noTool.error.code).toBe(-32602);
    const both = (await (await post([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }], library)).json()) as unknown[];
    expect(both).toEqual([{ jsonrpc: '2.0', id: 'a', result: {} }]);
  });

  it('takes messages only by POST', async () => {
    const res = await handleMcp(new Request(`${SITE}/mcp`), env);
    expect(res.status).toBe(405);
  });
});

describe('reading papers', () => {
  it('lists the papers and shows one: its blocks, its logic, its links and attachments', async () => {
    const { library } = fakeLibrary();
    expect((await tool(library, 'list_papers', {})).text).toContain('res-a "A Made-up Study of Gates" (slug made-up-study; 9 blocks; 4 in its logic)');
    const { text: shown } = await tool(library, 'get_paper', { paper: 'made-up-study' });
    expect(shown).toContain('1. intro [text] 1 Introduction');
    expect(shown).toContain('7. f1 [figure] Figure 1 — Made-up accuracy');
    expect(shown).toContain('- intro 1 Introduction\n  - meth 2 Method\n    - m1 2.1 Gate\n      - e1 3.1 Gate accuracy');
    expect(shown).toContain('Not in the logic yet: m2 2.2 Cache; exps 3 Experiments; f1 Figure 1; e2 3.2 Cache hits; concl 4 Conclusion');
    expect(shown).toContain('Attachments: references.bib, fig/plot.png');
    expect((await tool(library, 'get_paper', { paper: 'gates' })).text).toContain('A Made-up Study of Gates');
    const missing = await tool(library, 'get_paper', { paper: 'Something else' });
    expect(missing.error).toBe(true);
    expect(missing.text).toContain('res-a "A Made-up Study of Gates"');
  });

  it('gives the LaTeX of the blocks asked for, and the preamble', async () => {
    const { library } = fakeLibrary();
    const { text: some } = await tool(library, 'read_blocks', { paper: 'res-a', blocks: ['m1', 'f1'], preamble: true });
    expect(some).toContain("%%% Preamble of \"A Made-up Study of Gates\" (Lemma's default)\n\\documentclass");
    expect(some).toContain('%%% Block m1 [text] 2.1 Gate\n\\subsection{Gate}\nThe made-up gate.');
    expect(some).toContain('%%% Block f1 [figure] Figure 1\n\\begin{figure}');
    expect(some).not.toContain('Introduction');
    expect((await tool(library, 'read_blocks', { paper: 'res-a', blocks: ['nope'] })).error).toBe(true);
  });

  it('reads text attachments, and only those', async () => {
    const { library } = fakeLibrary([paper()], {
      'results/res-a/files/references.bib': '@article{made, title={Made up}}',
      'results/res-a/files/fig/plot.png': '\u0000PNG\uFFFD\uFFFD\uFFFD',
    });
    expect((await tool(library, 'read_attachment', { paper: 'res-a', name: 'references.bib' })).text).toBe('@article{made, title={Made up}}');
    expect((await tool(library, 'read_attachment', { paper: 'res-a', name: 'fig/plot.png' })).error).toBe(true);
    const unknown = await tool(library, 'read_attachment', { paper: 'res-a', name: 'secret.txt' });
    expect(unknown).toMatchObject({ error: true });
    expect(unknown.text).toContain('references.bib, fig/plot.png');
  });
});

describe('changing papers', () => {
  it("changes a block's LaTeX and leaves its PDF for Lemma to bring up to date", async () => {
    const { library, state } = fakeLibrary();
    const result = await tool(library, 'update_block', { paper: 'res-a', block: 'm1', source: '\\subsection{Gate}\nA better made-up gate.' });
    expect(result.text).toContain('Lemma compiles it the next time');
    const m1 = state.papers[0].blocks.find((block) => block.id === 'm1');
    expect(m1).toMatchObject({ kind: 'text', source: '\\subsection{Gate}\nA better made-up gate.', output: output('m1') });
    expect(state.commits[0].message).toBe('results: update block in "A Made-up Study of Gates" (Claude Code)');
    expect((await tool(library, 'update_block', { paper: 'res-a', block: 'm1', source: '\\subsection{Gate}\nA better made-up gate.' })).text).toContain('nothing changed');
    expect(state.commits).toHaveLength(1);
    expect((await tool(library, 'update_block', { paper: 'res-a', block: 'm1', source: '  ' })).error).toBe(true);
  });

  it('never brings back a block deleted elsewhere meanwhile', async () => {
    const { library, state } = fakeLibrary();
    const stale: Library = { ...library, papers: async () => [paper()] };
    state.papers = applyResultsOp(state.papers, { kind: 'deleteBlock', paperId: 'res-a', blockId: 'm2' });
    const result = await tool(stale, 'update_block', { paper: 'res-a', block: 'm2', source: 'Back again?' });
    expect(result).toMatchObject({ error: true });
    expect(result.text).toContain('deleted meanwhile');
    expect(blockIds(state.papers)).not.toContain('m2');
  });

  it('adds blocks where asked, a branch next to its siblings in the paper and under its block in the logic', async () => {
    const { library, state } = fakeLibrary();
    const branch = await tool(library, 'add_block', { paper: 'res-a', kind: 'table', source: '\\begin{table}\\caption{Made-up}\\end{table}', under: 'm1' });
    expect(branch.text).toMatch(/^Added blk-[a-z0-9]+ \(table\)/);
    const id = /blk-[a-z0-9]+/.exec(branch.text)?.[0] ?? '';
    // After Gate accuracy and the figure that goes with it, not inside Cache hits.
    expect(blockIds(state.papers)).toEqual(['intro', 'meth', 'm1', 'm2', 'exps', 'e1', 'f1', id, 'e2', 'concl']);
    expect(state.papers[0].logic).toEqual({ meth: 'intro', m1: 'meth', e1: 'm1', [id]: 'm1' });

    await tool(library, 'add_block', { paper: 'res-a', kind: 'text', source: 'A made-up motivation.', after: 'intro' });
    expect(state.papers[0].blocks[1].source).toBe('A made-up motivation.');
    await tool(library, 'add_block', { paper: 'res-a', kind: 'text', source: '\\section{Related work}', before: 'meth' });
    expect(state.papers[0].blocks[2].source).toBe('\\section{Related work}');
    await tool(library, 'add_block', { paper: 'res-a', kind: 'text', source: 'An appendix.' });
    expect(state.papers[0].blocks[state.papers[0].blocks.length - 1].source).toBe('An appendix.');
    expect((await tool(library, 'add_block', { paper: 'res-a', kind: 'poem', source: 'x' })).error).toBe(true);
    expect((await tool(library, 'add_block', { paper: 'res-a', kind: 'text', source: 'x', after: 'intro', before: 'meth' })).error).toBe(true);
  });

  it('deletes a block with its PDF, the blocks under it moving up in the logic', async () => {
    const { library, state } = fakeLibrary([{ ...paper(), relations: [['e1', 'meth']] }]);
    await tool(library, 'delete_block', { paper: 'res-a', block: 'm1' });
    expect(blockIds(state.papers)).not.toContain('m1');
    expect(state.papers[0].logic).toEqual({ meth: 'intro', e1: 'meth' });
    expect(state.commits[0].deletes).toEqual(['results/res-a/m1-0000.pdf']);
    await tool(library, 'delete_block', { paper: 'res-a', block: 'e1' });
    expect(state.papers[0].relations).toBeUndefined();
  });

  it('changes the preamble, which must be one', async () => {
    const { library, state } = fakeLibrary();
    expect((await tool(library, 'update_preamble', { paper: 'res-a', preamble: '\\usepackage{amsmath}' })).error).toBe(true);
    expect((await tool(library, 'update_preamble', { paper: 'res-a', preamble: '\\documentclass{article}\n\\begin{document}' })).error).toBe(true);
    await tool(library, 'update_preamble', { paper: 'res-a', preamble: '\\documentclass{article}\n\\usepackage{amsmath}' });
    expect(state.papers[0].preamble).toBe('\\documentclass{article}\n\\usepackage{amsmath}');
  });
});

describe('building the logic', () => {
  it('hangs blocks under others, never the introduction under anything, nor a block under its own branch', async () => {
    const { library, state } = fakeLibrary();
    const placed = await tool(library, 'place_blocks', {
      paper: 'res-a',
      placements: [
        { block: 'm2', under: 'meth' },
        { block: 'e2', under: 'm2' },
        { block: 'f1', under: 'e1' },
        { block: 'concl', under: null },
      ],
    });
    expect(state.papers[0].logic).toEqual({ meth: 'intro', m1: 'meth', e1: 'm1', m2: 'meth', e2: 'm2', f1: 'e1', concl: '' });
    expect(placed.text).toContain('      - e1 3.1 Gate accuracy\n        - f1 Figure 1');
    expect(placed.text).toContain('In the logic but not linked to the start:\n  - concl 4 Conclusion');
    expect((await tool(library, 'place_blocks', { paper: 'res-a', placements: [{ block: 'intro', under: 'meth' }] })).error).toBe(true);
    expect((await tool(library, 'place_blocks', { paper: 'res-a', placements: [{ block: 'meth', under: 'e1' }] })).error).toBe(true);
    expect(state.commits).toHaveLength(1);
    expect(state.commits[0].message).toBe('results: update logic of "A Made-up Study of Gates" (Claude Code)');
  });

  it('takes blocks out of the logic, never the introduction', async () => {
    const { library, state } = fakeLibrary();
    await tool(library, 'remove_from_logic', { paper: 'res-a', blocks: ['meth'] });
    expect(state.papers[0].logic).toEqual({ m1: 'intro', e1: 'm1' });
    expect((await tool(library, 'remove_from_logic', { paper: 'res-a', blocks: ['intro'] })).error).toBe(true);
  });

  it('links blocks of the logic that bear on each other, once, and unlinks them', async () => {
    const { library, state } = fakeLibrary();
    expect((await tool(library, 'link_blocks', { paper: 'res-a', a: 'm1', b: 'e1' })).error).toBe(true);
    expect((await tool(library, 'link_blocks', { paper: 'res-a', a: 'm1', b: 'e2' })).text).toContain('not in the logic yet');
    await tool(library, 'place_blocks', { paper: 'res-a', placements: [{ block: 'e2', under: 'm1' }] });
    const linked = await tool(library, 'link_blocks', { paper: 'res-a', a: 'meth', b: 'e2' });
    expect(linked.text).toContain('Links drawn between blocks: e2 3.2 Cache hits — meth 2 Method');
    expect(state.papers[0].relations).toEqual([['e2', 'meth']]);
    expect((await tool(library, 'link_blocks', { paper: 'res-a', a: 'e2', b: 'meth' })).text).toBe('They are linked already.');
    await tool(library, 'unlink_blocks', { paper: 'res-a', a: 'meth', b: 'e2' });
    expect(state.papers[0].relations).toBeUndefined();
    expect((await tool(library, 'unlink_blocks', { paper: 'res-a', a: 'meth', b: 'e2' })).text).toBe('They were not linked.');
  });
});

describe('what goes wrong', () => {
  it('says so in words, also when GitHub refuses', async () => {
    const refused = await tool(fakeLibrary().library, 'get_paper', { paper: '' });
    expect(refused).toMatchObject({ error: true, text: 'Give the paper (its ID, slug or title).' });
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_papers', arguments: {} } }, () => Promise.reject(new GitHubError('GitHub 返回 401', 401)));
    const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('connect Lemma again');
  });
});
