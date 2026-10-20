/**
 * What an MCP client like Claude Code can do with a person's papers: read them, change their blocks and
 * preambles, and build their logic. Each change is one commit of Lemma's own operations (editor/results/ops.ts),
 * stored as the pages store it. LaTeX does not run here: Lemma compiles changed blocks the next time the paper
 * is open there (staleBlocks, Workspace).
 */
import { Relation, cleanRelations, related, startOf, withRelation, withoutRelation } from '../../app/logic/graph';
import { LabelWords, nodeLabels } from '../../app/logic/labels';
import { Logic, LogicTree, TOP, branchEnd, cleanLogic, logicTree, placedIn, subtreeOf, withPlacement, withoutBlock } from '../../app/logic/tree';
import { ResultsOp, resultsCommitMessage } from '../../editor/results/ops';
import { DEFAULT_PREAMBLE } from '../../editor/tex/document';
import { ResultBlock, ResultBlockKind, ResultPaper } from '../../types';
import { Library, ToolError } from './library';

interface Schema {
  type: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: string[];
  additionalProperties?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run: (args: Record<string, unknown>, library: Library) => Promise<string>;
}

const WORDS: LabelWords = { figure: (n) => (n ? `Figure ${n}` : 'Figure'), table: (n) => (n ? `Table ${n}` : 'Table'), abstract: 'Abstract', empty: '(empty)' };
const KINDS: ResultBlockKind[] = ['text', 'figure', 'table'];
/** Longest text a tool gives back in one go. */
const MAX_TEXT = 200_000;

const REPO: Schema = { type: 'string', description: 'owner/name of the Lemma repository; needed only when the person has several.' };
const PAPER: Schema = { type: 'string', description: 'The paper: its ID, slug or title, as list_papers shows them.' };
const BLOCK: Schema = { type: 'string', description: 'A block ID, as get_paper lists them (blk-…).' };

const object = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: 'object', properties: { ...properties, repo: REPO }, required, additionalProperties: false });

const given = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`Give ${what}.`);
  return value.trim();
};
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
/** LaTeX as given, which must not be empty. */
const latexOf = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`Give ${what}.`);
  return value;
};

/** A new block's ID, like the pages make (blk- and lowercase letters and digits), with a little chance in it. */
const newBlockId = (): string => `blk-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const message = (action: string, paper: ResultPaper): string => `${resultsCommitMessage(action, paper.title)} (Claude Code)`;
const batch = (ops: ResultsOp[]): ResultsOp => (ops.length === 1 ? ops[0] : { kind: 'batch', ops });

function paperOf(papers: ResultPaper[], ref: unknown): ResultPaper {
  const wanted = given(ref, 'the paper (its ID, slug or title)');
  const lower = wanted.toLowerCase();
  const found =
    papers.find((paper) => paper.id === wanted) ??
    papers.find((paper) => paper.slug === wanted) ??
    papers.find((paper) => paper.title.trim().toLowerCase() === lower);
  if (found) return found;
  const near = papers.filter((paper) => paper.title.toLowerCase().includes(lower));
  if (near.length === 1) return near[0];
  const list = papers.map((paper) => `${paper.id} "${paper.title}"`).join('; ');
  throw new ToolError(`No paper "${wanted}"${near.length > 1 ? ' (several titles contain it)' : ''}. The papers: ${list || 'none'}.`);
}

function blockOf(paper: ResultPaper, ref: unknown): ResultBlock {
  const id = given(ref, 'a block ID (get_paper lists them)');
  const block = paper.blocks.find((item) => item.id === id);
  if (!block) throw new ToolError(`"${paper.title}" has no block ${id}; get_paper lists its blocks.`);
  return block;
}

/** Stops a save when the paper or one of these blocks is gone from the latest list: changed elsewhere meanwhile. */
const stillThere = (paperId: string, blockIds: string[]) => (latest: ResultPaper[]) => {
  const paper = latest.find((item) => item.id === paperId);
  if (!paper) throw new ToolError('The paper was deleted meanwhile.');
  const gone = blockIds.filter((id) => !paper.blocks.some((block) => block.id === id));
  if (gone.length > 0) throw new ToolError(`${gone.join(', ')} was deleted meanwhile; look at the paper again (get_paper).`);
};

async function paperIn(library: Library, args: Record<string, unknown>): Promise<ResultPaper> {
  return paperOf(await library.papers(), args.paper);
}

const namesOf = (paper: ResultPaper): ((id: string) => string) => {
  const labels = nodeLabels(paper, WORDS);
  return (id) => labels[id]?.title ?? id;
};

/** The paper's logic as the graph view sees it: the start (its introduction) always on top. */
function logicOf(paper: ResultPaper): { start: string | null; logic: Logic; tree: LogicTree; inGraph: Set<string>; lines: Relation[] } {
  const start = startOf(paper);
  const stored = paper.logic ?? {};
  const logic = start && stored[start] !== undefined && stored[start] !== TOP ? { ...stored, [start]: TOP } : stored;
  const tree = logicTree({ blocks: paper.blocks, logic });
  const inGraph = new Set([...tree.order, ...(start ? [start] : [])]);
  return { start, logic, tree, inGraph, lines: cleanRelations(paper.relations ?? [], inGraph) };
}

/** The logic and links stored as the graph view stores them (its flush): the start on top, lines inside the logic. */
function logicPatch(paper: ResultPaper, blocks: ResultBlock[], logic: Logic, relations: Relation[]): ResultsOp {
  const kept = cleanLogic(blocks, logic);
  const start = startOf({ ...paper, blocks });
  if (start && kept[start] !== undefined) kept[start] = TOP;
  const lines = cleanRelations(relations, new Set([...placedIn(blocks, kept), ...(start ? [start] : [])]));
  return { kind: 'patchPaper', id: paper.id, fields: { logic: Object.keys(kept).length > 0 ? kept : null, relations: lines.length > 0 ? lines : null } };
}

function describeLogic(paper: ResultPaper): string[] {
  const name = namesOf(paper);
  const { start, tree, lines } = logicOf(paper);
  if (!start) return ['Logic: the paper has no blocks yet.'];
  const out = [`Logic (each block under the one it belongs to), starting at ${start} ${name(start)}:`];
  const draw = (id: string, depth: number) => {
    out.push(`${'  '.repeat(depth)}- ${id} ${name(id)}`);
    (tree.nodes[id]?.children ?? []).forEach((child) => draw(child, depth + 1));
  };
  draw(start, 0);
  const alone = tree.roots.filter((id) => id !== start);
  if (alone.length > 0) {
    out.push('In the logic but not linked to the start:');
    alone.forEach((id) => draw(id, 1));
  }
  const outside = paper.blocks.filter((block) => !tree.nodes[block.id] && block.id !== start);
  if (outside.length > 0) out.push(`Not in the logic yet: ${outside.map((block) => `${block.id} ${name(block.id)}`).join('; ')}`);
  out.push(lines.length > 0 ? `Links drawn between blocks: ${lines.map(([a, b]) => `${a} ${name(a)} — ${b} ${name(b)}`).join('; ')}` : 'No links drawn between blocks.');
  return out;
}

function describePaper(paper: ResultPaper): string {
  const labels = nodeLabels(paper, WORDS);
  const lines = [`"${paper.title}" (ID ${paper.id}, slug ${paper.slug})`];
  const about = [(paper.authors ?? []).length > 0 ? `by ${paper.authors.join(', ')}` : '', paper.venue ?? '', paper.year ? String(paper.year) : ''].filter(Boolean);
  if (about.length > 0) lines.push(about.join('; '));
  lines.push('', `Blocks, in the paper's order (${paper.blocks.length}):`);
  paper.blocks.forEach((block, index) => {
    const label = labels[block.id];
    const notes = [block.hidden ? 'hidden from readers' : '', block.output ? '' : 'no PDF yet'].filter(Boolean);
    const caption = block.kind !== 'text' && label?.detail ? ` — ${label.detail}` : '';
    lines.push(`${index + 1}. ${block.id} [${block.kind}] ${label?.title ?? ''}${caption}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`);
  });
  lines.push('', ...describeLogic(paper));
  lines.push('', paper.files?.length ? `Attachments: ${paper.files.join(', ')}` : 'No attachments.');
  return lines.join('\n');
}

const compiledLater = 'Lemma compiles it the next time the paper is open there.';

/** The logic after a save, from the list the save returns. */
const logicAfter = (papers: ResultPaper[], paperId: string): string => {
  const paper = papers.find((item) => item.id === paperId);
  return paper ? describeLogic(paper).join('\n') : '';
};

export const TOOLS: Tool[] = [
  {
    name: 'list_papers',
    title: 'List papers',
    description: "List the papers in the person's Lemma repository, with their IDs.",
    inputSchema: object({}, []),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_args, library) => {
      const papers = await library.papers();
      if (papers.length === 0) return `No papers in ${library.repo} yet.`;
      return [
        `Papers in ${library.repo} (${papers.length}):`,
        ...papers.map((paper) => {
          const placed = logicOf(paper).tree.order.length;
          return `- ${paper.id} "${paper.title}" (slug ${paper.slug}; ${paper.blocks.length} blocks${placed > 0 ? `; ${placed} in its logic` : ''})`;
        }),
      ].join('\n');
    },
  },
  {
    name: 'get_paper',
    title: 'Look at a paper',
    description:
      "A paper's outline: its blocks in order (ID, kind, heading or caption), its logic (which block belongs under which, starting at the introduction), the links drawn between blocks, and its attachments. Look here before reading or changing a paper.",
    inputSchema: object({ paper: PAPER }, ['paper']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, library) => describePaper(await paperIn(library, args)),
  },
  {
    name: 'read_blocks',
    title: 'Read blocks',
    description: "The LaTeX of a paper's blocks (all of them, or those listed) and, if asked, its preamble. For a long paper, read the blocks you need rather than all of them.",
    inputSchema: object(
      {
        paper: PAPER,
        blocks: { type: 'array', items: BLOCK, description: 'The blocks to read; all of them when left out.' },
        preamble: { type: 'boolean', description: 'Also give the preamble (\\documentclass up to \\begin{document}).' },
      },
      ['paper'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const name = namesOf(paper);
      const chosen = Array.isArray(args.blocks) && args.blocks.length > 0 ? args.blocks.map((id) => blockOf(paper, id)) : paper.blocks;
      const parts = chosen.map((block) => `%%% Block ${block.id} [${block.kind}] ${name(block.id)}${block.hidden ? ' (hidden from readers)' : ''}\n${block.source ?? ''}`);
      if (args.preamble === true) parts.unshift(`%%% Preamble of "${paper.title}"${paper.preamble === undefined ? " (Lemma's default)" : ''}\n${paper.preamble ?? DEFAULT_PREAMBLE}`);
      const text = parts.join('\n\n');
      return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[Cut here: read fewer blocks at a time.]` : text || `"${paper.title}" has no blocks yet.`;
    },
  },
  {
    name: 'read_attachment',
    title: 'Read an attachment',
    description: 'A text attachment of a paper (references.bib, a .sty, .cls or .tex file), by its name as get_paper lists it.',
    inputSchema: object({ paper: PAPER, name: { type: 'string', description: 'The attachment\'s name, e.g. "references.bib" or "sty/macros.sty".' } }, ['paper', 'name']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const name = given(args.name, "the attachment's name");
      const files = paper.files ?? [];
      if (!files.includes(name)) throw new ToolError(`"${paper.title}" has no attachment ${name}. ${files.length > 0 ? `Its attachments: ${files.join(', ')}.` : 'It has no attachments.'}`);
      const text = await library.readText(`results/${paper.id}/files/${name}`);
      if (text === null) throw new ToolError(`${name} is listed but missing from the repository.`);
      if (text.includes('\u0000') || (text.match(/�/g)?.length ?? 0) > 2) throw new ToolError(`${name} is not a text file.`);
      return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[Cut here: the file is longer.]` : text;
    },
  },
  {
    name: 'update_block',
    title: 'Change a block',
    description:
      "Replace the LaTeX of one block. Keep its kind: a text block holds text with its headings (\\section…), a figure block one figure environment, a table block one table environment. Lemma compiles it the next time the paper is open there, so compile errors do not show here: keep the LaTeX valid and in the paper's own style.",
    inputSchema: object({ paper: PAPER, block: BLOCK, source: { type: 'string', description: "The block's new LaTeX, in full." } }, ['paper', 'block', 'source']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const block = blockOf(paper, args.block);
      const source = latexOf(args.source, "the block's LaTeX");
      if (source === (block.source ?? '')) return `${block.id} already has this LaTeX; nothing changed.`;
      await library.save({ kind: 'putBlock', paperId: paper.id, block: { id: block.id, kind: block.kind, source } }, message('update block in', paper), [], stillThere(paper.id, [block.id]));
      return `Saved the new LaTeX of ${block.id} in "${paper.title}". ${compiledLater}`;
    },
  },
  {
    name: 'add_block',
    title: 'Add a block',
    description:
      'Add a block (text, figure or table) to a paper: after or before a block, or at the end. With `under`, it also goes into the logic under that block and, unless after or before says otherwise, into the paper next to that block\'s other branches. Lemma compiles it the next time the paper is open there.',
    inputSchema: object(
      {
        paper: PAPER,
        kind: { type: 'string', enum: KINDS, description: 'text, figure (one figure environment) or table (one table environment).' },
        source: { type: 'string', description: "The block's LaTeX." },
        after: { ...BLOCK, description: 'Put it right after this block.' },
        before: { ...BLOCK, description: 'Put it right before this block.' },
        under: { ...BLOCK, description: 'Hang it in the logic under this block.' },
      },
      ['paper', 'kind', 'source'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const kind = args.kind;
      if (typeof kind !== 'string' || !(KINDS as string[]).includes(kind)) throw new ToolError('Give the kind: text, figure or table.');
      const source = latexOf(args.source, "the block's LaTeX");
      const after = optional(args.after);
      const before = optional(args.before);
      const under = optional(args.under);
      if (after && before) throw new ToolError('Give after or before, not both.');
      const { logic, tree } = logicOf(paper);
      const parent = under ? blockOf(paper, under).id : null;
      const indexOf = (id: string) => paper.blocks.findIndex((item) => item.id === id);
      const at = after
        ? indexOf(blockOf(paper, after).id) + 1
        : before
          ? indexOf(blockOf(paper, before).id)
          : parent
            ? indexOf(branchEnd(paper, tree, parent)) + 1
            : paper.blocks.length;
      const block: ResultBlock = { id: newBlockId(), kind: kind as ResultBlockKind, source };
      const blocks = [...paper.blocks.slice(0, at), block, ...paper.blocks.slice(at)];
      const ops: ResultsOp[] = [{ kind: 'putBlock', paperId: paper.id, block, at }];
      if (parent) ops.push(logicPatch(paper, blocks, withPlacement(blocks, logic, block.id, parent), paper.relations ?? []));
      const named = [after, before, parent].filter((id): id is string => !!id);
      await library.save(batch(ops), message('add block to', paper), [], stillThere(paper.id, named));
      const name = namesOf(paper);
      return `Added ${block.id} (${kind}) to "${paper.title}" as block ${at + 1} of ${blocks.length}${parent ? `, under ${parent} ${name(parent)} in the logic` : ''}. ${compiledLater}`;
    },
  },
  {
    name: 'delete_block',
    title: 'Delete a block',
    description: "Delete a block from a paper, and from its logic and links. The repository's history keeps it.",
    inputSchema: object({ paper: PAPER, block: BLOCK }, ['paper', 'block']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const block = blockOf(paper, args.block);
      const name = namesOf(paper)(block.id);
      const blocks = paper.blocks.filter((item) => item.id !== block.id);
      const ops: ResultsOp[] = [{ kind: 'deleteBlock', paperId: paper.id, blockId: block.id }];
      const relations = paper.relations ?? [];
      const inLogic = Object.entries(paper.logic ?? {}).some(([id, parent]) => id === block.id || parent === block.id);
      if (inLogic || relations.some((pair) => pair.includes(block.id))) {
        ops.push(logicPatch(paper, blocks, withoutBlock(paper.blocks, logicOf(paper).logic, block.id), relations.filter((pair) => !pair.includes(block.id))));
      }
      // Its PDFs go too, unless something still refers to them (commitResults checks).
      const pdfs = [block.output?.pdf, block.alternate?.output?.pdf].filter((path): path is string => !!path);
      await library.save(batch(ops), message('delete block from', paper), pdfs, stillThere(paper.id, [block.id]));
      return `Deleted ${block.id} (${name}) from "${paper.title}". The repository's history keeps it.`;
    },
  },
  {
    name: 'update_preamble',
    title: 'Change the preamble',
    description: "Replace a paper's preamble: \\documentclass up to, not including, \\begin{document}. Every block is compiled again with it the next time the paper is open in Lemma.",
    inputSchema: object({ paper: PAPER, preamble: { type: 'string', description: 'The new preamble, in full.' } }, ['paper', 'preamble']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const preamble = latexOf(args.preamble, 'the preamble');
      if (!/\\documentclass/.test(preamble)) throw new ToolError('A preamble starts with \\documentclass.');
      if (/\\begin\s*\{document\}/.test(preamble)) throw new ToolError('Leave out \\begin{document}: the preamble ends before it.');
      if (preamble === paper.preamble) return 'The paper already has this preamble; nothing changed.';
      await library.save({ kind: 'patchPaper', id: paper.id, fields: { preamble } }, message('update preamble of', paper), [], stillThere(paper.id, []));
      return `Saved the preamble of "${paper.title}". Lemma compiles every block with it the next time the paper is open there.`;
    },
  },
  {
    name: 'place_blocks',
    title: 'Build the logic',
    description:
      "Build a paper's logic: hang each block under the block it belongs to (an experiment under the method it tests, a figure under the text it shows), or put it in the logic on its own with under: null. Applied in order; the logic afterwards is shown. The introduction is where the logic starts and stays on top.",
    inputSchema: object(
      {
        paper: PAPER,
        placements: {
          type: 'array',
          description: 'Each block and the block to hang it under (null: in the logic, linked to nothing yet).',
          items: { type: 'object', properties: { block: BLOCK, under: { type: ['string', 'null'], description: 'A block ID, or null.' } }, required: ['block', 'under'], additionalProperties: false },
        },
      },
      ['paper', 'placements'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      if (!Array.isArray(args.placements) || args.placements.length === 0) throw new ToolError('Give the placements: [{ block, under }].');
      let { logic, tree } = logicOf(paper);
      const { start } = logicOf(paper);
      let relations = paper.relations ?? [];
      const named = new Set<string>();
      for (const item of args.placements as { block?: unknown; under?: unknown }[]) {
        const block = blockOf(paper, item?.block);
        const under = item?.under === null || item?.under === undefined || item?.under === '' ? null : blockOf(paper, item.under).id;
        if (block.id === start && under !== null) throw new ToolError(`${block.id} is where the logic starts (the introduction): it stays on top.`);
        if (under !== null && (under === block.id || (tree.nodes[block.id] && subtreeOf(tree, block.id).has(under)))) {
          throw new ToolError(`${block.id} cannot go under ${under}, which is under it.`);
        }
        logic = withPlacement(paper.blocks, logic, block.id, under);
        tree = logicTree({ blocks: paper.blocks, logic });
        // A line drawn between the two goes: a branch joins them now.
        if (under) relations = withoutRelation(relations, block.id, under);
        named.add(block.id);
        if (under) named.add(under);
      }
      const saved = await library.save(logicPatch(paper, paper.blocks, logic, relations), message('update logic of', paper), [], stillThere(paper.id, [...named]));
      return `Saved.\n${logicAfter(saved, paper.id)}`;
    },
  },
  {
    name: 'remove_from_logic',
    title: 'Take blocks out of the logic',
    description: "Take blocks out of a paper's logic (they stay in the paper); the blocks under each move up to where it was.",
    inputSchema: object({ paper: PAPER, blocks: { type: 'array', items: BLOCK, description: 'The blocks to take out.' } }, ['paper', 'blocks']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      if (!Array.isArray(args.blocks) || args.blocks.length === 0) throw new ToolError('Give the blocks to take out.');
      let { logic } = logicOf(paper);
      const { start, tree } = logicOf(paper);
      let relations = paper.relations ?? [];
      const ids = args.blocks.map((ref) => blockOf(paper, ref).id);
      for (const id of ids) {
        if (id === start) throw new ToolError(`${id} is where the logic starts (the introduction); it cannot be taken out.`);
        if (!tree.nodes[id]) continue;
        logic = withoutBlock(paper.blocks, logic, id);
        relations = relations.filter((pair) => !pair.includes(id));
      }
      const saved = await library.save(logicPatch(paper, paper.blocks, logic, relations), message('update logic of', paper), [], stillThere(paper.id, ids));
      return `Saved.\n${logicAfter(saved, paper.id)}`;
    },
  },
  {
    name: 'link_blocks',
    title: 'Link two blocks',
    description:
      "Draw a link (a dashed line in Lemma's logic view) between two blocks of the logic that bear on each other beyond the tree, e.g. an experiment that tests two methods. Both must be in the logic.",
    inputSchema: object({ paper: PAPER, a: BLOCK, b: BLOCK }, ['paper', 'a', 'b']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const a = blockOf(paper, args.a).id;
      const b = blockOf(paper, args.b).id;
      if (a === b) throw new ToolError('Give two different blocks.');
      const { logic, tree, inGraph, lines } = logicOf(paper);
      const outside = [a, b].filter((id) => !inGraph.has(id));
      if (outside.length > 0) throw new ToolError(`${outside.join(' and ')} not in the logic yet: place it first (place_blocks).`);
      if (tree.nodes[a]?.parent === b || tree.nodes[b]?.parent === a) throw new ToolError('One hangs under the other already: a branch joins them.');
      if (related(lines, a, b)) return 'They are linked already.';
      const saved = await library.save(logicPatch(paper, paper.blocks, logic, withRelation(paper.relations ?? [], a, b)), message('update logic of', paper), [], stillThere(paper.id, [a, b]));
      return `Linked.\n${logicAfter(saved, paper.id)}`;
    },
  },
  {
    name: 'unlink_blocks',
    title: 'Unlink two blocks',
    description: 'Remove the link drawn between two blocks.',
    inputSchema: object({ paper: PAPER, a: BLOCK, b: BLOCK }, ['paper', 'a', 'b']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const a = blockOf(paper, args.a).id;
      const b = blockOf(paper, args.b).id;
      const { logic } = logicOf(paper);
      if (!related(paper.relations ?? [], a, b)) return 'They were not linked.';
      const saved = await library.save(logicPatch(paper, paper.blocks, logic, withoutRelation(paper.relations ?? [], a, b)), message('update logic of', paper), [], stillThere(paper.id, []));
      return `Unlinked.\n${logicAfter(saved, paper.id)}`;
    },
  },
];
