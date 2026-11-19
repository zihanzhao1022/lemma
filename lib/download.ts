/** Files the browser saves: a deck exported, a paper's PDF. */

/** A file name from a title, without the characters file systems refuse, at most 80 characters before the extension. */
export const fileName = (title: string, extension: string, fallback = 'paper'): string =>
  `${title.replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 80) || fallback}.${extension}`;

/** Has the browser save bytes as a file. */
export function downloadFile(data: Uint8Array, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data.slice()], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
