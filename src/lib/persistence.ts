let previewWarningShown = false;

export function canUseIndexedDb(): boolean {
  if (typeof indexedDB === 'undefined') return false;
  if (typeof window !== 'undefined' && window.self !== window.top) {
    if (!previewWarningShown) {
      console.info('[ShadRox] Local persistence is disabled inside the isolated preview frame.');
      previewWarningShown = true;
    }
    return false;
  }
  return true;
}
