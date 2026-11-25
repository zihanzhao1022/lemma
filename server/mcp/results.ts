/**
 * The results library for MCP clients: the figures and tables of all the person's papers (the Management page),
 * inserting one into another paper as a linked copy, and keeping copies in step with the block they came from
 * (app/management). Copies carry what they need: attachments, preamble definitions, packages, bibliography entries.
 */
import { diffLines, homeOf, homeSource, mergeThree, syncState } from '../../app/management/carry';
import { LibraryItem, filterItems, libraryItems } from '../../app/management/results';
import {
  CarryChoices,
  CarryPlan,
  CopyRef,
  insertCopy,
  planCarry,
  planPull,
  planPush,
  preambleLines,
  pullOps,
  pushOps,
  suggestedChoices,
} from '../../app/management/transfer';
import { tagsOfMark } from '../../editor/results/ops';
import { FloatKind, ResultPaper, SyncState } from '../../types';
import { Library, ToolError } from './library';
import { MAX_TEXT, PAPER, Schema, Tool, given, message, object, optional, paperIn, paperOf } from './shared';

const STATES: Record<SyncState, string> = {
  synced: 'the same as the library',
  behind: 'the library changed since (pull to take it)',
  ahead: 'changed in this paper, not pushed (push to give it to the library)',
  diverged: 'changed on both sides (merge: give the merged LaTeX with pull or push)',
  orphan: 'the block it came from is gone (unlink to keep it as this paper’s own)',
};

const PACKAGES: Schema = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Packages to add to the receiving preamble, by name. Left out: only packages for figures and tables (booktabs, xcolor, multirow…), never fonts, page layout or a template’s own.',
};

const nameOf = (item: Pick<LibraryItem, 'kind' | 'number'>): string => `${item.kind === 'figure' ? 'Figure' : 'Table'}${item.number ? ` ${item.number}` : ''}`;

/** The packages to add: those asked for (that the plan offers), or the suggested ones. */
function choicesOf(plan: CarryPlan, asked: unknown): CarryChoices {
  if (!Array.isArray(asked)) return suggestedChoices(plan);
  const offered = new Set(plan.packages.map((item) => item.name));
  return { packages: asked.filter((name): name is string => typeof name === 'string' && offered.has(name)) };
}

/** What carrying brought along, in a few lines. */
function carried(plan: CarryPlan, choices: CarryChoices): string[] {
  const lines: string[] = [];
  if (plan.copies.length > 0) lines.push(`Copied attachments: ${plan.copies.map((copy) => (copy.to === copy.from ? copy.to : `${copy.from} → ${copy.to} (the name was taken)`)).join(', ')}.`);
  const added = preambleLines(plan, choices);
  if (added.length > 0) lines.push(`Added to the preamble of "${plan.to.title}":\n${added.join('\n')}`);
  const left = plan.packages.filter((item) => !choices.packages.includes(item.name)).map((item) => item.name);
  if (left.length > 0) lines.push(`Not added (loaded by "${plan.from.title}" only; pass them in "packages" if the block needs them): ${left.join(', ')}.`);
  if (plan.bib.keys.length > 0) lines.push(`Added to references.bib: ${plan.bib.keys.join(', ')}.`);
  if (plan.clashes.length > 0) lines.push(`Warning: "${plan.to.title}" already defines the label(s) ${plan.clashes.join(', ')}; rename one so \\ref finds the right block.`);
  return lines;
}

const readFileOf = (library: Library) => (path: string) => library.readBytes(path);

function copyIn(paper: ResultPaper, blockId: string): CopyRef {
  const block = paper.blocks.find((item) => item.id === blockId);
  if (!block) throw new ToolError(`"${paper.title}" has no block ${blockId}; get_paper lists its blocks.`);
  if (!block.origin) throw new ToolError(`${blockId} in "${paper.title}" is not a copy from the library; insert_result makes copies.`);
  return { paper, block };
}

const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[Cut here.]` : text);

export const RESULT_TOOLS: Tool[] = [
  {
    name: 'list_results',
    title: 'List the results library',
    description:
      "Every figure and table of the person's papers (OnizukaTex's Management page), each by the paper it belongs to, with its caption, labels, where its paper cites it, and its copies in other papers with how each compares with it. Copies are listed under the block they came from, not on their own.",
    inputSchema: object(
      {
        paper: { ...PAPER, description: 'Only this paper’s figures and tables (its ID, slug or title).' },
        kind: { type: 'string', enum: ['figure', 'table'], description: 'Only figures, or only tables.' },
        search: { type: 'string', description: 'Words to find in the caption, a label or the paper’s title.' },
      },
      [],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, library) => {
      const papers = await library.papers();
      const kind = args.kind === 'figure' || args.kind === 'table' ? (args.kind as FloatKind) : undefined;
      const paper = optional(args.paper) ? paperOf(papers, args.paper).id : undefined;
      const items = filterItems(libraryItems(papers), { kind, paper, search: optional(args.search) });
      if (items.length === 0) return 'No figures or tables match.';
      const lines = items.map((item) => {
        const parts = [`- ${item.paper.id} ${item.block.id}: ${nameOf(item)} of "${item.paper.title}"${item.caption ? ` — ${item.caption}` : ''}`];
        const tags = tagsOfMark(item.block.mark);
        if (tags.length > 0) parts.push(`  tags (the person's own): ${tags.join(', ')}`);
        if (item.labels.length > 0) parts.push(`  labels: ${item.labels.join(', ')}`);
        if (item.citedBy.length > 0) parts.push(`  cited in its paper by ${item.citedBy.join(', ')}`);
        if (item.slides.length > 0) parts.push(`  on slides ${item.slides.join(', ')}`);
        for (const copy of item.copies) parts.push(`  copy: ${copy.block.id} in "${copy.paper.title}" (${copy.paper.id}), ${STATES[copy.state]}`);
        return parts.join('\n');
      });
      return clip([`${items.length} figure(s) and table(s) (paper ID, block ID):`, ...lines].join('\n'));
    },
  },
  {
    name: 'insert_result',
    title: 'Insert a result into another paper',
    description:
      "Insert a figure or table of one paper into another as a linked copy (list_results lists them): it brings the attachments it names (a name the paper already uses for another file goes in a folder), the preamble definitions it uses, packages for figures and tables, and the bibliography entries it cites. The copy remembers where it came from, so sync_result can later pull the library's changes or push the copy's. OnizukaTex compiles it the next time the paper is open there.",
    inputSchema: object(
      {
        from: { ...PAPER, description: 'The paper the figure or table belongs to.' },
        block: { type: 'string', description: 'Its block ID (list_results lists them).' },
        into: { ...PAPER, description: 'The paper to put the copy in.' },
        after: { type: 'string', description: 'Put it right after this block of the receiving paper; at the end when left out.' },
        packages: PACKAGES,
      },
      ['from', 'block', 'into'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (args, library) => {
      const papers = await library.papers();
      const from = paperOf(papers, args.from);
      const into = paperOf(papers, args.into);
      if (from.id === into.id) throw new ToolError('Give another paper to insert it into.');
      const id = given(args.block, 'the block ID');
      const home = from.blocks.find((block) => block.id === id);
      if (!home) throw new ToolError(`"${from.title}" has no block ${id}; list_results lists its figures and tables.`);
      if (home.kind === 'text') throw new ToolError(`${id} is a text block; the library holds figures and tables.`);
      const after = optional(args.after);
      const at = after ? into.blocks.findIndex((block) => block.id === after) + 1 : undefined;
      if (at === 0) throw new ToolError(`"${into.title}" has no block ${after}.`);
      const readFile = readFileOf(library);
      const plan = await planCarry(home.source ?? '', from, into, readFile);
      const choices = choicesOf(plan, args.packages);
      const made = await insertCopy(plan, home, choices, readFile, `Definitions brought from "${from.title}"`, at);
      await library.save(made.op, message('insert a result from the library into', into), [], (latest) => {
        if (!latest.some((paper) => paper.id === into.id)) throw new ToolError(`"${into.title}" was deleted meanwhile.`);
      }, made.writes);
      return [`Inserted a copy of ${id} (${home.kind}) from "${from.title}" into "${into.title}" as ${made.blockId}.`, ...carried(plan, choices), 'OnizukaTex compiles it the next time the paper is open there.'].join('\n');
    },
  },
  {
    name: 'sync_result',
    title: 'Keep a copy in step with the library',
    description:
      "For a figure or table copied from another paper (insert_result): 'status' compares it with the block it came from and shows the difference, or both versions and a merge when both changed; 'pull' takes the library's version; 'push' gives the library this copy's version; 'unlink' makes it this paper's own. When both changed, pull and push need `source`: the merged LaTeX (written in this paper's file names), without conflict markers.",
    inputSchema: object(
      {
        paper: { ...PAPER, description: 'The paper the copy is in.' },
        block: { type: 'string', description: "The copy's block ID." },
        action: { type: 'string', enum: ['status', 'pull', 'push', 'unlink'], description: 'What to do; status changes nothing.' },
        source: { type: 'string', description: 'The merged LaTeX, when both sides changed.' },
        packages: PACKAGES,
      },
      ['paper', 'block', 'action'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async (args, library) => {
      const papers = await library.papers();
      const copy = copyIn(await paperIn(library, args), given(args.block, "the copy's block ID"));
      const origin = copy.block.origin!;
      const home = homeOf(origin, papers);
      const state = syncState(copy.block, papers) ?? 'synced';
      const readFile = readFileOf(library);
      const source = typeof args.source === 'string' && args.source.trim() ? args.source : undefined;
      if (source && /^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(source)) throw new ToolError('The merged LaTeX still has conflict markers; resolve them first.');
      const where = home ? `"${home.paper.title}" (${home.paper.id}, block ${home.block.id})` : 'a deleted block';
      const still = (latest: ResultPaper[]) => {
        if (!latest.some((paper) => paper.id === copy.paper.id && paper.blocks.some((block) => block.id === copy.block.id))) throw new ToolError('The copy was deleted meanwhile.');
      };

      switch (args.action) {
        case 'status': {
          const out = [`${copy.block.id} in "${copy.paper.title}" is a copy of ${where}: ${STATES[state]}.`];
          if (!home) return out.join('\n');
          const theirs = homeSource(origin, home.block);
          const mine = copy.block.source ?? '';
          if (state === 'behind' || state === 'ahead') {
            out.push('', "Difference ('-' only in the library, '+' only in this paper):");
            out.push(...diffLines(theirs, mine).map((line) => `${line.kind === 'del' ? '-' : line.kind === 'add' ? '+' : ' '} ${line.text}`));
          }
          if (state === 'diverged') {
            const merged = mergeThree(origin.base, mine, theirs, { mine: 'this paper', theirs: 'library' });
            out.push('', `A merge by lines (${merged.conflicts} conflict(s), marked as git marks them):`, merged.text);
            out.push('', 'Resolve it, then call pull (only this paper takes it) or push (both take it) with the result as `source`.');
          }
          return clip(out.join('\n'));
        }
        case 'unlink':
          await library.save({ kind: 'setOrigin', paperId: copy.paper.id, blockId: copy.block.id, origin: null }, message('unlink a copy in', copy.paper), [], still);
          return `${copy.block.id} in "${copy.paper.title}" is no longer linked to the library; it is listed as a result of its own.`;
        case 'pull': {
          if (!home) throw new ToolError('The block it came from is gone; there is nothing to pull. Unlink it instead.');
          if (state === 'synced') return `${copy.block.id} is already the same as the library.`;
          if (state === 'diverged' && !source) throw new ToolError('Both sides changed: look at the merge (action "status") and pull with the merged LaTeX as `source`.');
          const plan = (await planPull(copy, papers, readFile))!;
          const choices = choicesOf(plan, args.packages);
          const made = await pullOps(copy, plan, choices, readFile, `Definitions brought from "${home.paper.title}"`, state === 'diverged' ? source : undefined);
          await library.save(made.op, message('pull from the library into', copy.paper), [], still, made.writes);
          return [`${copy.block.id} in "${copy.paper.title}" took ${state === 'diverged' ? 'the merged version' : "the library's version"}.`, ...carried(plan, choices), 'OnizukaTex compiles it the next time the paper is open there.'].join('\n');
        }
        case 'push': {
          if (!home) throw new ToolError('The block it came from is gone; there is nothing to push to. Unlink it instead.');
          if (state === 'synced') return `${copy.block.id} is already the same as the library.`;
          if (state === 'behind') throw new ToolError("The library changed and this copy did not: pull instead, or the library's change would be lost.");
          if (state === 'diverged' && !source) throw new ToolError('Both sides changed: look at the merge (action "status") and push with the merged LaTeX as `source`.');
          const plan = (await planPush(copy, papers, readFile, state === 'diverged' ? source : undefined))!;
          const choices = choicesOf(plan, args.packages);
          const made = await pushOps(copy, plan, choices, readFile, `Definitions brought from "${copy.paper.title}"`, state === 'diverged' ? source : undefined);
          await library.save(made.op, message(`push "${copy.paper.title}" to the library in`, home.paper), [], still, made.writes);
          return [`"${home.paper.title}" took the ${state === 'diverged' ? 'merged' : 'copy’s'} version of ${home.block.id}, and the copy agrees with it.`, ...carried(plan, choices), 'OnizukaTex compiles it the next time the paper is open there.'].join('\n');
        }
        default:
          throw new ToolError('Give the action: status, pull, push or unlink.');
      }
    },
  },
];
