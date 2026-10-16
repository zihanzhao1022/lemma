import { MAX_ENTRIES, PickedFile, TooManyFiles, isJunk } from '../../components/results/droppedFiles';
import { ATTACHMENT_LIMIT, ATTACHMENT_TYPES, extensionOf } from './actions';

export const isZip = (name: string): boolean => name.toLowerCase().endsWith('.zip');

/** What came out of a .zip: the files a paper can use, by their path in it, and those left out. */
export interface Unzipped {
  files: Record<string, Uint8Array>;
  /** Paths of files a paper cannot use (their type), or too large to keep. */
  skipped: { type: string[]; size: string[] };
}

/**
 * The one folder that holds everything in a zipped folder (paper/ for paper/main.tex and paper/figs/a.pdf),
 * with its slash; '' when there is none. Taken off, paths read like the project's own.
 */
export function wrapperOf(paths: string[]): string {
  const first = paths[0]?.split('/')[0];
  return first && paths.every((path) => path.includes('/') && path.split('/')[0] === first) ? `${first}/` : '';
}

/** The uncompressed size a .zip says an entry has, read before unpacking it (JSZip keeps it unexposed). */
const declaredSize = (entry: unknown): number | undefined => (entry as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;

/**
 * The files of a .zip that a paper can use (its attachment types), unpacked; hidden files and caches
 * (.DS_Store, __MACOSX) are left out, and nothing too large is unpacked at all.
 */
export async function unzip(data: Uint8Array | Blob): Promise<Unzipped> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && !isJunk(entry.name));
  if (entries.length > MAX_ENTRIES) throw new TooManyFiles();
  const wrapper = wrapperOf(entries.map((entry) => entry.name));
  const files: Record<string, Uint8Array> = {};
  const skipped: Unzipped['skipped'] = { type: [], size: [] };
  for (const entry of entries) {
    const path = entry.name.slice(wrapper.length);
    if (!ATTACHMENT_TYPES.includes(extensionOf(path))) skipped.type.push(path);
    else if ((declaredSize(entry) ?? 0) > ATTACHMENT_LIMIT) skipped.size.push(path);
    else {
      const bytes = await entry.async('uint8array');
      if (bytes.length > ATTACHMENT_LIMIT) skipped.size.push(path);
      else files[path] = bytes;
    }
  }
  return { files, skipped };
}

/**
 * Picked or dropped files with each .zip among them replaced by what is in it, in the folder the .zip was in.
 * `archives` names the .zip files opened.
 */
export async function expandZips(picked: PickedFile[]): Promise<{ picked: PickedFile[]; archives: string[]; skipped: Unzipped['skipped'] }> {
  const out: PickedFile[] = [];
  const archives: string[] = [];
  const skipped: Unzipped['skipped'] = { type: [], size: [] };
  for (const item of picked) {
    if (!isZip(item.path)) {
      out.push(item);
      continue;
    }
    archives.push(item.path);
    const folder = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/') + 1) : '';
    const unzipped = await unzip(item.file);
    for (const [path, data] of Object.entries(unzipped.files)) {
      out.push({ path: `${folder}${path}`, file: new File([data.slice()], path.split('/').pop() ?? path) });
    }
    skipped.type.push(...unzipped.skipped.type.map((path) => `${item.path}: ${path}`));
    skipped.size.push(...unzipped.skipped.size.map((path) => `${item.path}: ${path}`));
  }
  return { picked: out, archives, skipped };
}
