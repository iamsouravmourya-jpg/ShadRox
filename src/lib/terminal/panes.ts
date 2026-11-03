/**
 * Terminal pane layout.
 *
 * The session model in sessions.ts is a flat list — every session is a live
 * shell. The pane layout sits on top of that: it decides which sessions are
 * visible at the same time and how their surfaces are arranged (side by side or
 * stacked). A session that is not in any pane still lives in the session list
 * and can be shown by splitting again; closing a pane does not kill its shell
 * until the user closes the tab explicitly.
 */

export type SplitOrientation = 'horizontal' | 'vertical';

/** One visible surface. References a session by its renderer-owned key. */
export interface PaneLeaf {
  type: 'leaf';
  /** The session key this pane shows. */
  sessionKey: string;
}

/** A split holding two child nodes. */
export interface PaneSplit {
  type: 'split';
  orientation: SplitOrientation;
  /** The split ratio of the first child, 0–1. */
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneLayout {
  root: PaneNode;
  /** Which leaf is focused (receives keyboard input). */
  activeKey: string | null;
}

export function createInitialLayout(sessionKey: string): PaneLayout {
  return { root: { type: 'leaf', sessionKey }, activeKey: sessionKey };
}

/** Every session key referenced anywhere in the tree. */
export function paneSessionKeys(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.sessionKey];
  return [...paneSessionKeys(node.first), ...paneSessionKeys(node.second)];
}

/** Total number of visible leaves. */
export function paneCount(node: PaneNode): number {
  if (node.type === 'leaf') return 1;
  return paneCount(node.first) + paneCount(node.second);
}

/**
 * Splits the pane showing `sessionKey` by inserting a new sibling with
 * `newSessionKey`. Returns a new tree; the original is untouched.
 */
export function splitPane(
  node: PaneNode,
  sessionKey: string,
  newSessionKey: string,
  orientation: SplitOrientation
): PaneNode {
  if (node.type === 'leaf') {
    if (node.sessionKey !== sessionKey) return node;
    return {
      type: 'split',
      orientation,
      ratio: 0.5,
      first: { type: 'leaf', sessionKey },
      second: { type: 'leaf', sessionKey: newSessionKey }
    };
  }
  return {
    ...node,
    first: splitPane(node.first, sessionKey, newSessionKey, orientation),
    second: splitPane(node.second, sessionKey, newSessionKey, orientation)
  };
}

/**
 * Removes the pane showing `sessionKey` from the tree, collapsing its parent
 * split into the surviving sibling. Returns null when the last pane is removed.
 */
export function removePane(node: PaneNode, sessionKey: string): PaneNode | null {
  if (node.type === 'leaf') {
    return node.sessionKey === sessionKey ? null : node;
  }
  const first = removePane(node.first, sessionKey);
  const second = removePane(node.second, sessionKey);
  if (first && second) return { ...node, first, second };
  return first ?? second;
}

/** Finds the pane that should be focused after `removedKey` is gone: the nearest
 *  sibling leaf in the same split, or null. */
export function nearestKey(node: PaneNode, removedKey: string): string | null {
  const keys = paneSessionKeys(node).filter((key) => key !== removedKey);
  if (keys.length === 0) return null;
  // Pick the one that was closest in the flat list — good enough for focus.
  const idx = paneSessionKeys(node).indexOf(removedKey);
  return keys[Math.min(idx, keys.length - 1)];
}

/** Replaces a session key throughout the tree (used when a session is renamed). */
export function replaceKey(node: PaneNode, oldKey: string, newKey: string): PaneNode {
  if (node.type === 'leaf') {
    return node.sessionKey === oldKey ? { type: 'leaf', sessionKey: newKey } : node;
  }
  return { ...node, first: replaceKey(node.first, oldKey, newKey), second: replaceKey(node.second, oldKey, newKey) };
}

/** Sets the ratio of the split that directly contains the leaf for `sessionKey`. */
export function setRatio(node: PaneNode, sessionKey: string, ratio: number): PaneNode {
  if (node.type === 'leaf') return node;
  const firstHas = paneSessionKeys(node.first).includes(sessionKey);
  const secondHas = paneSessionKeys(node.second).includes(sessionKey);
  let nextRatio = node.ratio;
  if (firstHas) nextRatio = Math.max(0.1, Math.min(0.9, ratio));
  else if (secondHas) nextRatio = 1 - Math.max(0.1, Math.min(0.9, ratio));
  return {
    ...node,
    ratio: nextRatio,
    first: setRatio(node.first, sessionKey, ratio),
    second: setRatio(node.second, sessionKey, ratio)
  };
}

/** Flip the orientation of the split that contains `sessionKey`. */
export function flipOrientation(node: PaneNode, sessionKey: string): PaneNode {
  if (node.type === 'leaf') return node;
  const has = paneSessionKeys(node).includes(sessionKey);
  return {
    ...node,
    orientation: has ? (node.orientation === 'horizontal' ? 'vertical' : 'horizontal') : node.orientation,
    first: flipOrientation(node.first, sessionKey),
    second: flipOrientation(node.second, sessionKey)
  };
}

/** Deep-replace the ratio of a split node by structural identity (same first/second refs). */
export function setRatioDeep(root: PaneNode, target: PaneSplit, ratio: number): PaneNode {
  if (root.type === 'leaf') return root;
  if (root === target) return { ...root, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
  return {
    ...root,
    first: setRatioDeep(root.first, target, ratio),
    second: setRatioDeep(root.second, target, ratio)
  };
}
