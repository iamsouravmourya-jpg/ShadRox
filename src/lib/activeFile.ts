/**
 * The editor shows a document whenever any file is mounted, even before the
 * user picks one: `CodeEditor` falls back to the first file when nothing is
 * selected. Every write from the editor has to target that same file, so both
 * sides resolve the index through this one function.
 *
 * When they disagreed the edit landed only in the CodeMirror document: no dirty
 * flag, no auto-save, nothing for Ctrl+S to write, and the text vanished the
 * next time the file was opened. That happened for every single-file workspace
 * and for every reopen from "Recently opened", because mounting leaves the
 * selection at -1.
 */
export function resolveActiveFileIndex(selectedIndex: number, fileCount: number): number {
  if (selectedIndex >= 0 && selectedIndex < fileCount) return selectedIndex;
  return fileCount > 0 ? 0 : -1;
}
