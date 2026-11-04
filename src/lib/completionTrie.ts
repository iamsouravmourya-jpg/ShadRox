/**
 * Project-identifier trie booster for inline ghost-text completion.
 *
 * PROVENANCE NOTE — read before reviewing. The porting brief asked for a
 * line-for-line port of `class Trie` from reference/aider-main/aider/repomap.py
 * (aider is Apache-2.0, so copying with an attribution header is allowed).
 * That class does not exist:
 *   - not in the vendored reference/aider-main snapshot (grep across every
 *     .py, case-sensitive hits on "class Trie": zero);
 *   - not in any historical repomap.py at tags v0.31.0 … v0.46.1 (fetched raw,
 *     verified 200 responses);
 *   - not anywhere in aider's git history: a blobless clone of the full commit
 *     graph (13,139 commits) pickaxe-searched with `git log --all -S "class
 *     Trie" -- aider/`, and -S on "most_common_prefix", "word_boundary=True",
 *     "leaf_count", "def complete_words" — all zero hits.
 * So there was nothing to copy, and an Apache-2.0 attribution header would be
 * a false claim about provenance. Everything here is written from scratch,
 * implementing exactly the semantics the brief describes: multi-word insertion
 * with word boundaries, a cached leaf count per node, remove(), and a
 * most-common-prefix lookup with a min_weight floor.
 *
 * COST DISCIPLINE: this trie is fed only from local buffer text and workspace
 * file paths. It makes zero AI API calls — its whole job is to answer instantly
 * when the completion model is offline, cooling down, or returning a weak
 * guess ("type 2 chars, suggest a project identifier used elsewhere").
 */

/** One trie node. `leafCount` is the cached occurrence count of every terminal
 *  reachable below it (aider's `_get_leaf_count`, maintained incrementally on
 *  insert/remove instead of recomputed by DFS). */
interface TrieNode {
  children: Map<string, TrieNode>;
  /** Occurrences of all keys passing through this node. */
  leafCount: number;
  /** Occurrences of the key that ends exactly here (aider's "$" terminal). */
  weight: number;
}

export interface RankedCandidate {
  /** The full project identifier that matched. */
  candidate: string;
  /** What to insert after the already-typed partial. */
  completion: string;
  /** How often this identifier was observed. */
  weight: number;
}

export interface RankOptions {
  /** aider's min_weight: ignore identifiers seen fewer times than this. */
  minWeight?: number;
  limit?: number;
}

/** Node-visit budget for the subtree scan, so a keystroke path never stalls. */
const COLLECT_BUDGET = 4_000;
/** Upper bound on distinct keys; past it new words are dropped, ranking is
 *  still exact for everything ingested before the cap. */
const DEFAULT_MAX_KEYS = 30_000;
/** Keys longer than this are almost certainly prose, not identifiers. */
const MAX_KEY_LENGTH = 128;

/** Word-boundary token scan: a token may only start where the previous char is
 *  not an identifier char, and must itself start like an identifier does. This
 *  is what makes "abc" match the key "abc" but never the middle of "xabc". */
const TOKEN_PATTERN = /(?<![\w$-])[A-Za-z_$][\w$-]{1,63}/g;

export class CompletionTrie {
  private readonly root: TrieNode;
  private readonly keys = new Set<string>();
  private readonly canonicalByNormalized = new Map<string, string>();
  private readonly wordBoundary: boolean;
  private readonly maxKeys: number;

  constructor(options: { wordBoundary?: boolean; maxKeys?: number } = {}) {
    this.wordBoundary = options.wordBoundary !== false;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.root = makeNode();
  }

  /** Distinct keys held (aider exposes the set implicitly via leaf counts). */
  get size(): number {
    return this.keys.size;
  }

  /**
   * Insert a word — or, with word boundaries on, a multi-word string, which is
   * indexed word by word so each part can be completed independently.
   */
  insert(key: string, weight = 1): void {
    const words = this.wordBoundary ? key.split(/\s+/).filter(Boolean) : [key];
    for (const originalWord of words) {
      const word = this.normalizedWord(originalWord);
      if (word.length > MAX_KEY_LENGTH) continue;
      if (weight <= 0) continue;
      if (!this.keys.has(word) && this.keys.size >= this.maxKeys) continue;
      let node = this.root;
      for (const char of word) {
        node.leafCount += weight; // cache update on the way down
        let next = node.children.get(char);
        if (!next) {
          next = makeNode();
          node.children.set(char, next);
        }
        node = next;
      }
      node.leafCount += weight;
      node.weight += weight;
      this.keys.add(word);
      this.canonicalByNormalized.set(word, originalWord);
    }
  }

  /**
   * Remove one (or `weight`) occurrences of a word and prune the nodes it
   * leaves behind, so a deleted identifier stops being suggested.
   */
  remove(key: string, weight = 1): boolean {
    const word = this.normalizedWord(this.wordBoundary ? key.split(/\s+/).filter(Boolean)[0] ?? '' : key);
    if (!word || weight <= 0) return false;
    // Path of [parent, char] pairs plus the terminal node, so we can prune
    // bottom-up after decrementing.
    const path: Array<{ parent: TrieNode; char: string }> = [];
    let node = this.root;
    for (const char of word) {
      const next = node.children.get(char);
      if (!next) return false;
      path.push({ parent: node, char });
      node = next;
    }
    const cut = Math.min(weight, node.weight);
    if (cut <= 0) return false;
    node.weight -= cut;
    if (node.weight === 0) {
      this.keys.delete(word);
      this.canonicalByNormalized.delete(word);
    }
    let current = node;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      current.leafCount -= cut;
      const { parent, char } = path[index];
      if (current.leafCount === 0 && current.weight === 0) parent.children.delete(char);
      current = parent;
    }
    this.root.leafCount -= cut;
    return true;
  }

  /** Cached leaf count for the subtree under `prefix` (aider `_get_leaf_count`). */
  leafCountFor(prefix: string): number {
    const node = this.descend(prefix);
    return node ? node.leafCount : 0;
  }

  /** True while the exact word is present. */
  has(word: string): boolean {
    return this.keys.has(this.normalizedWord(word));
  }

  /**
   * aider's `most_common_prefix(prompt, weights=None, min_weight=1.0)`:
   * complete the trailing word of `prompt` with the subtree's highest-weighted
   * terminal at or above `minWeight`. Ranked by weight, then shortest (the
   * tightest completion wins ties), then lexicographic for determinism.
   * Returns the whole completed phrase — preceding prompt words included — or
   * '' when nothing matches, mirroring aider's return shape.
   */
  mostCommonPrefix(prompt: string, minWeight = 1): string {
    const words = prompt.split(/\s+/).filter(Boolean);
    const trailing = words[words.length - 1] ?? '';
    if (!trailing) return '';
    const best = this.rankCandidates(trailing, { minWeight, limit: 1 })[0];
    if (!best) return '';
    const head = words.slice(0, words.length - 1);
    return head.length ? `${head.join(' ')} ${best.candidate}` : best.candidate;
  }

  /**
   * The keystroke-path lookup: every candidate identifier that starts with the
   * typed `partial` at a word boundary, ranked, each carrying the text to
   * insert after the caret. Exact matches (nothing left to type) are dropped.
   */
  rankCandidates(partial: string, options: RankOptions = {}): RankedCandidate[] {
    const { minWeight = 1, limit = 5 } = options;
    const normalizedPartial = this.normalizedWord(partial);
    if (!normalizedPartial) return [];
    const node = this.descend(normalizedPartial);
    if (!node) return [];
    const found: Array<{ word: string; weight: number }> = [];
    let budget = COLLECT_BUDGET;
    // Iterative DFS over the subtree; recursion is unnecessary and stack-safe
    // iteration matches the keystroke latency budget.
    const stack: Array<{ node: TrieNode; word: string }> = [{ node, word: normalizedPartial }];
    while (stack.length && budget > 0) {
      const entry = stack.pop() as { node: TrieNode; word: string };
      budget -= 1;
      if (entry.node.weight >= minWeight && entry.node.weight > 0) {
        found.push({ word: entry.word, weight: entry.node.weight });
      }
      for (const [char, child] of entry.node.children) {
        if (child.leafCount < minWeight) continue; // whole branch is too weak
        stack.push({ node: child, word: entry.word + char });
      }
    }
    return found
      .filter((entry) => entry.word.length > normalizedPartial.length)
      .sort((a, b) => b.weight - a.weight || a.word.length - b.word.length || (a.word < b.word ? -1 : 1))
      .slice(0, limit)
      .map((entry) => {
        const canonical = this.canonicalByNormalized.get(entry.word) ?? entry.word;
        return {
          candidate: canonical,
          completion: canonical.slice(partial.length),
          weight: entry.weight
        };
      });
  }

  clear(): void {
    this.root.children.clear();
    this.root.leafCount = 0;
    this.root.weight = 0;
    this.keys.clear();
    this.canonicalByNormalized.clear();
  }

  private normalizedWord(word: string): string {
    return word.toLowerCase();
  }

  private descend(prefix: string): TrieNode | null {
    let node = this.root;
    for (const char of this.normalizedWord(prefix)) {
      const next = node.children.get(char);
      if (!next) return null;
      node = next;
    }
    return node;
  }
}

function makeNode(): TrieNode {
  return { children: new Map(), leafCount: 0, weight: 0 };
}

// ---------------------------------------------------------------------------
// Project registry: the single module-level trie fed by local text only.
// ---------------------------------------------------------------------------

/** Below this many typed characters the partial is too ambiguous to boost. */
export const MIN_PARTIAL_CHARS = 2;
/** A confident completion is worth more than this few trimmed characters; a
 *  1–2 char reply off a temperature-0 engine is an echo or a stray token, i.e.
 *  exactly the "low-confidence guess" the trie exists to replace. */
export const LOW_CONFIDENCE_MODEL_CHARS = 2;

export const projectTrie = new CompletionTrie();

/** Tokens already ingested per document id, so re-ingesting a buffer never
 *  double-counts it (aider's word counts are occurrences; here they are
 *  documents-per-word, which ranks stable identifiers just as well). */
const documentTokens = new Map<string, Set<string>>();

/** Split text into boundary-clean identifier tokens. */
export function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const matches = text.matchAll(TOKEN_PATTERN);
  for (const match of matches) {
    const word = match[0];
    if (word.length >= MIN_PARTIAL_CHARS) tokens.add(word);
  }
  return tokens;
}

/**
 * Index one buffer. Idempotent per `id`: the same document ingested again adds
 * nothing. Returns how many new identifiers the trie gained.
 */
export function ingestDocument(id: string, text: string): number {
  const seen = documentTokens.get(id) ?? new Set<string>();
  let added = 0;
  for (const word of extractTokens(text)) {
    if (seen.has(word)) continue;
    seen.add(word);
    projectTrie.insert(word);
    added += 1;
  }
  documentTokens.set(id, seen);
  return added;
}

/** Drop a document's contribution entirely (closed tab / deleted file). */
export function ejectDocument(id: string): void {
  const seen = documentTokens.get(id);
  if (!seen) return;
  for (const word of seen) projectTrie.remove(word);
  documentTokens.delete(id);
}

/** Index workspace file paths, the zero-cost identifier source: file and
 *  folder names are project vocabulary before a single byte is opened. */
export function ingestWorkspacePaths(paths: readonly string[]): number {
  let added = 0;
  for (const path of paths) {
    // Path separators become token boundaries: "src/lib/fim.ts" yields
    // src, lib, fim and ts, exactly the vocabulary the model keeps guessing.
    added += ingestDocument(`path:${path}`, path);
  }
  return added;
}

/**
 * The identifier run touching the caret, boundary-checked: empty when the char
 * before the run cannot start an identifier or the caret sits inside a numeric
 * literal. "const workspaceFold|ing" → "workspaceFold".
 */
export function trailingIdentifier(prefix: string): string {
  const run = /[A-Za-z0-9_$]*$/.exec(prefix)?.[0] ?? '';
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(run)) return '';
  return run;
}

/** Trie boost for a typed partial, or null when there is nothing to suggest. */
export function boostFor(prefix: string): RankedCandidate | null {
  const partial = trailingIdentifier(prefix);
  if (partial.length < MIN_PARTIAL_CHARS) return null;
  return projectTrie.rankCandidates(partial, { minWeight: 1, limit: 1 })[0] ?? null;
}

/**
 * The merge rule (pure, so it can be tested without CodeMirror): a ghost
 * suggestion is chosen from the model text and the trie boost. The model wins
 * whenever it actually produced something; the project identifier takes over
 * when the model returned nothing (offline, aborted, cooling down — the
 * fimClient contract is an empty string there) or a low-confidence stub.
 */
export function mergeGhostSuggestion(
  modelText: string,
  partial: string,
  boost: RankedCandidate | null
): string {
  if (!partial || partial.length < MIN_PARTIAL_CHARS || !boost) return modelText;
  if (!modelText || modelText.trim().length <= LOW_CONFIDENCE_MODEL_CHARS) return boost.completion;
  return modelText;
}

/** Test seam: wipe the registry between cases. */
export function resetProjectRegistry(): void {
  projectTrie.clear();
  documentTokens.clear();
}
