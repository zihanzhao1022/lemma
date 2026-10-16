import type { PickedFile } from '../../components/results/droppedFiles';
import { ATTACHMENT_LIMIT, ATTACHMENT_TYPES, MAX_UPLOAD, attachmentName, extensionOf } from './actions';
import { mainCandidates } from './project';
import { expandZips } from './zip';

export { MAX_UPLOAD };

/** A .zip among the files that holds a LaTeX project (a .tex with \documentclass and \begin{document}). */
export interface DroppedProject {
  archive: string;
  /** What the .zip holds that a paper can use, by its path in the .zip. */
  files: Record<string, Uint8Array>;
  /** Paths in the .zip left out: types a paper cannot use, or too large. */
  skipped: string[];
}

/** What uploading picked files would do to a paper's attachments. */
export interface UploadPlan {
  /** The files to upload, by the name each is stored under (with its folders). */
  files: Record<string, Uint8Array>;
  /** Those names that replace attachments the paper has. */
  replaced: string[];
  /** Files left out, by why: a type compiles cannot use, over ATTACHMENT_LIMIT, or past MAX_UPLOAD. */
  skipped: { type: string[]; size: string[]; count: string[] };
  /** The .zip files opened: what was in them is among `files`, in the folder each .zip was in. */
  archives: string[];
  /** The first .zip that is a LaTeX project, which can become the paper itself rather than its attachments. */
  project?: DroppedProject;
}

/** Reads the files an upload takes (a .zip opened) and names them like the attachments they become. */
export async function planUpload(picked: PickedFile[], existing: string[]): Promise<UploadPlan> {
  const files: Record<string, Uint8Array> = {};
  const opened = await expandZips(picked);
  const skipped: UploadPlan['skipped'] = { type: [...opened.skipped.type], size: [...opened.skipped.size], count: [] };
  for (const { path, file } of opened.picked) {
    const parts = path.split('/');
    const name = parts[parts.length - 1];
    if (!ATTACHMENT_TYPES.includes(extensionOf(name))) skipped.type.push(path);
    else if (file.size > ATTACHMENT_LIMIT) skipped.size.push(path);
    else if (Object.keys(files).length >= MAX_UPLOAD) skipped.count.push(path);
    else {
      const data = new Uint8Array(await file.arrayBuffer());
      files[await attachmentName(name, data, parts.slice(0, -1))] = data;
    }
  }
  const project = opened.zips.find((zip) => mainCandidates(zip.files).length > 0);
  return {
    files,
    replaced: Object.keys(files).filter((name) => existing.includes(name)),
    skipped,
    archives: opened.archives,
    ...(project ? { project: { archive: project.archive, files: project.files, skipped: [...project.skipped.type, ...project.skipped.size] } } : {}),
  };
}
