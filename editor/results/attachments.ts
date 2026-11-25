/**
 * What naming and storing a paper's files needs, without the TeX engine or PDF.js: shared by the pages
 * (actions.ts re-exports it) and by the MCP server, which runs where neither loads.
 */
import { ResultPaper } from '../../types';
import { DEFAULT_PREAMBLE } from '../tex/document';
import { ResultsOp } from './ops';

/** A private file's bytes; `version`, an attachment's content hash, lets the browser keep it (lib/fileCache). */
export type ReadFile = (path: string, version?: string) => Promise<Uint8Array>;

/** The bibliography file a paper's blocks cite from, an attachment like the others. */
export const REFERENCES_FILE = 'references.bib';

export const attachmentPath = (paperId: string, name: string): string => `results/${paperId}/files/${name}`;

export const preambleOf = (paper: ResultPaper): string => paper.preamble ?? DEFAULT_PREAMBLE;

export const newBlockId = (): string => `blk-${Date.now().toString(36)}`;

export async function hashBytes(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice()));
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** putFile operations for newly added attachments, with their content hashes. */
export async function putFiles(paperId: string, added: Record<string, Uint8Array>): Promise<{ ops: ResultsOp[]; hashes: Record<string, string> }> {
  const hashes: Record<string, string> = {};
  for (const [name, data] of Object.entries(added)) hashes[name] = await hashBytes(data);
  return { ops: Object.entries(hashes).map(([name, hash]): ResultsOp => ({ kind: 'putFile', paperId, name, hash })), hashes };
}
