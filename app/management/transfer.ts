/**
 * Moving a figure or table between papers, as results operations: inserting a copy (from the library), taking its
 * home's changes (pull), giving it this copy's (push). What else the source needs comes along (carry.ts).
 */
// Light modules only: the MCP server uses this too, where the TeX engine and PDF.js do not load.
import { REFERENCES_FILE, ReadFile, attachmentPath, newBlockId, preambleOf, putFiles } from '../../editor/results/attachments';
import type { FileWrite } from '../../editor/results/backend';
import type { ResultsOp } from '../../editor/results/ops';
import { BlockOrigin, ResultBlock, ResultPaper } from '../../types';
import {
  Definition,
  FileCopy,
  PackageNeed,
  bibNeeds,
  homeOf,
  homeSource,
  inverse,
  labelClashes,
  mapArguments,
  planFiles,
  preambleNeeds,
  sourceForHome,
  withPreambleLines,
} from './carry';

/** What a source needs in the paper it goes to, and how it is written there. */
export interface CarryPlan {
  from: ResultPaper;
  to: ResultPaper;
  /** The source as the paper it goes to writes it. */
  source: string;
  /** File arguments renamed on the way: as written in `from` → as written in `to`. */
  mapping: Record<string, string>;
  copies: FileCopy[];
  definitions: Definition[];
  packages: PackageNeed[];
  bib: { keys: string[]; text: string };
  /** Labels it defines that other blocks of `to` define too. */
  clashes: string[];
}

/** Which of the plan's additions to make: the packages to add by name (the definitions always come along). */
export interface CarryChoices {
  packages: string[];
}

export const suggestedChoices = (plan: CarryPlan): CarryChoices => ({ packages: plan.packages.filter((item) => item.suggested).map((item) => item.name) });

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function bibOf(paper: ResultPaper, readFile: ReadFile): Promise<string> {
  if (!(paper.files ?? []).includes(REFERENCES_FILE)) return '';
  try {
    return decode(await readFile(attachmentPath(paper.id, REFERENCES_FILE), paper.fileHashes?.[REFERENCES_FILE]));
  } catch {
    return '';
  }
}

/**
 * What it takes to put `source` (as `from` writes it) into `to`. `mapping` holds the renames already agreed on
 * (from's arguments → to's); `block` is the block of `to` it replaces, whose labels are no clash.
 */
export async function planCarry(source: string, from: ResultPaper, to: ResultPaper, readFile: ReadFile, mapping: Record<string, string> = {}, block?: string): Promise<CarryPlan> {
  const files = planFiles(source, from, to, mapping);
  const written = mapArguments(source, files.mapping);
  const needs = preambleNeeds(source, preambleOf(from), preambleOf(to));
  const [fromBib, toBib] = await Promise.all([bibOf(from, readFile), bibOf(to, readFile)]);
  return {
    from,
    to,
    source: written,
    mapping: files.mapping,
    copies: files.copies,
    definitions: needs.definitions,
    packages: needs.packages,
    bib: bibNeeds(source, fromBib, toBib),
    clashes: labelClashes(written, to, block),
  };
}

/** Whether carrying adds anything besides the block itself. */
export const addsAnything = (plan: CarryPlan, choices: CarryChoices): boolean =>
  plan.copies.length > 0 || plan.definitions.length > 0 || choices.packages.length > 0 || plan.bib.keys.length > 0;

/** The preamble lines a plan adds with these choices. */
export const preambleLines = (plan: CarryPlan, choices: CarryChoices): string[] => [
  ...plan.packages.filter((item) => choices.packages.includes(item.name)).map((item) => item.line),
  ...plan.definitions.map((item) => item.text),
];

/** The additions as operations and file writes on the paper it goes to: attachments, preamble, bibliography. */
export async function carryOps(plan: CarryPlan, choices: CarryChoices, readFile: ReadFile, note: string): Promise<{ ops: ResultsOp[]; writes: FileWrite[] }> {
  const added: Record<string, Uint8Array> = {};
  for (const copy of plan.copies) added[copy.to] = await readFile(attachmentPath(plan.from.id, copy.from), plan.from.fileHashes?.[copy.from]);
  if (plan.bib.keys.length > 0) {
    const current = await bibOf(plan.to, readFile);
    const base = current.replace(/\s+$/, '');
    added[REFERENCES_FILE] = new TextEncoder().encode(`${base}${base ? '\n\n' : ''}${plan.bib.text}\n`);
  }
  const ops: ResultsOp[] = [];
  const lines = preambleLines(plan, choices);
  if (lines.length > 0) ops.push({ kind: 'patchPaper', id: plan.to.id, fields: { preamble: withPreambleLines(preambleOf(plan.to), lines, note) } });
  const uploads = await putFiles(plan.to.id, added);
  ops.push(...uploads.ops);
  return { ops, writes: Object.entries(added).map(([name, data]) => ({ path: attachmentPath(plan.to.id, name), data })) };
}

/** The renames a copy keeps (its home's arguments → its own), without those that rename nothing. */
const filesOf = (mapping: Record<string, string>): Record<string, string> | undefined => {
  const kept = Object.fromEntries(Object.entries(mapping).filter(([from, to]) => from !== to));
  return Object.keys(kept).length > 0 ? kept : undefined;
};

const originOf = (paper: string, block: string, base: string, mapping: Record<string, string>): BlockOrigin => {
  const files = filesOf(mapping);
  return { paper, block, base, ...(files ? { files } : {}) };
};

/** Inserting a copy of `home` into the plan's paper at `at` (default: the end). The copy's ID is returned too. */
export async function insertCopy(
  plan: CarryPlan,
  home: ResultBlock,
  choices: CarryChoices,
  readFile: ReadFile,
  note: string,
  at?: number,
): Promise<{ op: ResultsOp; writes: FileWrite[]; blockId: string }> {
  const carried = await carryOps(plan, choices, readFile, note);
  const block: ResultBlock = { id: newBlockId(), kind: home.kind, source: plan.source, origin: originOf(plan.from.id, home.id, plan.source, plan.mapping) };
  const put: ResultsOp = { kind: 'putBlock', paperId: plan.to.id, block, ...(at === undefined ? {} : { at }) };
  return { op: { kind: 'batch', ops: [...carried.ops, put] }, writes: carried.writes, blockId: block.id };
}

/** A copy's block in its paper. */
export interface CopyRef {
  paper: ResultPaper;
  block: ResultBlock;
}

/** Planning to take a copy's home's version (pull). */
export function planPull(copy: CopyRef, papers: ResultPaper[], readFile: ReadFile): Promise<CarryPlan> | null {
  const origin = copy.block.origin;
  const home = origin && homeOf(origin, papers);
  if (!origin || !home) return null;
  return planCarry(home.block.source ?? '', home.paper, copy.paper, readFile, origin.files ?? {}, copy.block.id);
}

/** Planning to give a copy's version to its home (push); `source` is what to give, the copy's own by default. */
export function planPush(copy: CopyRef, papers: ResultPaper[], readFile: ReadFile, source = copy.block.source ?? ''): Promise<CarryPlan> | null {
  const origin = copy.block.origin;
  const home = origin && homeOf(origin, papers);
  if (!origin || !home) return null;
  return planCarry(source, copy.paper, home.paper, readFile, inverse(origin.files ?? {}), home.block.id);
}

/** Pull: the copy takes `plan.source` (its home's version, or a merge of both) and agrees with its home on it. */
export async function pullOps(copy: CopyRef, plan: CarryPlan, choices: CarryChoices, readFile: ReadFile, note: string, source = plan.source): Promise<{ op: ResultsOp; writes: FileWrite[] }> {
  const origin = copy.block.origin!;
  const carried = await carryOps(plan, choices, readFile, note);
  return {
    op: {
      kind: 'batch',
      ops: [
        ...carried.ops,
        { kind: 'putBlock', paperId: copy.paper.id, block: { ...copy.block, source } },
        { kind: 'setOrigin', paperId: copy.paper.id, blockId: copy.block.id, origin: originOf(origin.paper, origin.block, plan.source, plan.mapping) },
      ],
    },
    writes: carried.writes,
  };
}

/**
 * Push: the home takes the copy's version (`plan.source`, in the home's names), and the copy, which may take a
 * merged version itself (`copySource`), agrees with it.
 */
export async function pushOps(
  copy: CopyRef,
  plan: CarryPlan,
  choices: CarryChoices,
  readFile: ReadFile,
  note: string,
  copySource = copy.block.source ?? '',
): Promise<{ op: ResultsOp; writes: FileWrite[] }> {
  const origin = copy.block.origin!;
  const home = plan.to.blocks.find((block) => block.id === origin.block)!;
  const carried = await carryOps(plan, choices, readFile, note);
  // The copy's names for the home's arguments: the renames agreed on, the other way.
  const mapping = inverse(plan.mapping);
  const base = mapArguments(plan.source, mapping);
  return {
    op: {
      kind: 'batch',
      ops: [
        ...carried.ops,
        { kind: 'putBlock', paperId: plan.to.id, block: { ...home, source: plan.source } },
        ...(copySource === (copy.block.source ?? '') ? [] : [{ kind: 'putBlock', paperId: copy.paper.id, block: { ...copy.block, source: copySource } } as ResultsOp]),
        { kind: 'setOrigin', paperId: copy.paper.id, blockId: copy.block.id, origin: originOf(origin.paper, origin.block, base, mapping) },
      ],
    },
    writes: carried.writes,
  };
}

export { homeSource, sourceForHome };
