/**
 * New-project intent detection — the code half of the scaffold rule.
 *
 * The defect this exists for: a friend opened an EMPTY folder, asked for a
 * landing page, and the agent dumped one giant HTML file and stopped. A
 * new-project ask must become a real multi-file structure (index, styles,
 * script, assets — the logo drawn as SVG code, not fetched), built section by
 * section and checked in the preview. The loop refuses a one-file finish once
 * and nudges; the prompt states the rule the rest of the time.
 *
 * Detection is deliberately conservative: fix/change verbs cancel the scaffold
 * reading, so "fix the landing page header" stays an ordinary edit turn.
 */

const BUILD_VERB = /\b(build|create|make|scaffold|generate|develop|design|code|bana|banao|banado|bna|bnao)\b/i;
const PROJECT_NOUN = /\b(landing\s?page|website|web\s?site|web\s?page|homepage|home\s?page|portfolio|dashboard|web\s?app|site|app|application|blog|store|shop|page)\b/i;
const FIX_VERB = /\b(fix|debug|repair|refactor|update|change|modify|edit|remove|delete|rename|tweak|adjust|improve|optimi[sz]e)\b/i;
const ADD_PAGE = /\b(add|create|make|new)\b[^.?!]{0,40}\b(another|new|second|more|extra)?\s*(page|section)\b/i;

/** "build me a landing page" in an empty folder — not "fix my landing page". */
export function detectScaffoldIntent(ask: string): boolean {
  if (!ask.trim()) return false;
  if (FIX_VERB.test(ask)) return false;
  return BUILD_VERB.test(ask) && PROJECT_NOUN.test(ask);
}

/** "add an about page" — a NEW file linked from the existing pages, never an append. */
export function detectAddPageIntent(ask: string): boolean {
  if (!ask.trim()) return false;
  if (detectScaffoldIntent(ask)) return false;
  return ADD_PAGE.test(ask) || /\bnew\s+(page|section)\b/i.test(ask);
}

export const SCAFFOLD_RULE =
  'NEW PROJECTS: when the user asks to build a site/app/page in a new or empty folder, never answer with one dumped HTML file. '
  + 'Plan the structure with update_tasks, then create real separate files: index.html, styles.css, script.js and an assets/ folder. '
  + 'Draw the logo yourself as inline SVG or an .svg file you write — never fetch one, never leave a placeholder. '
  + 'Build section by section (header/hero, features, footer), link the CSS and JS from the HTML, then start the preview and check it renders before finish. '
  + 'A landing page is at least 3 files; one giant HTML file is a failed answer.';

export const ADD_PAGE_RULE =
  'ADDING A PAGE: "add a page/section" to an existing site means a NEW html file (about.html, contact.html, ...) plus links to it from the existing pages\' navigation. '
  + 'Never append the new page into the existing giant HTML file, and never leave the new page unlinked.';

/** The one-time finish refusal a one-file scaffold attempt earns. */
export function scaffoldNudge(createdCount: number): string {
  return `finish refused: this is a new-project request, but only ${createdCount} file${createdCount === 1 ? ' was' : 's were'} created. `
    + SCAFFOLD_RULE
    + ' Create the remaining files now (styles.css, script.js, the SVG logo), link them from index.html, verify, then call finish again.';
}

export function addPageNudge(): string {
  return 'finish refused: the user asked to add a page, but no new file was created. '
    + ADD_PAGE_RULE
    + ' Create the new page file, add navigation links to it from the existing pages, verify, then call finish again.';
}

export function previewNudge(detail: string): string {
  return `finish refused: the new site has not been checked in the preview (${detail}). `
    + 'Use preview_control {"action":"start"} (or restart) so the pane points at the live site, fix anything it reports, then call finish again.';
}