/**
 * Spend caps: the user's own money limits, enforced in the agent loop.
 *
 * A BYOK key has no monthly meter — nothing here counts for a plan, because the
 * user pays their provider directly. That is the right
 * product answer and the wrong safety answer: nothing then stands between a
 * runaway tool loop and a four-figure provider bill. This module is the client
 * side of that wall. It is explicitly NOT a replacement for the server meter —
 * it can only see the usage frames this app streamed, so a cap here is a
 * client-side seatbelt, not accounting.
 *
 * Three numbers, all in credits (the same per-credit ceiling every other meter
 * in the app uses, so a run budget and a day cap are comparable):
 * - `perTurnCredits` — one chat turn, including all of its tool rounds.
 * - `perDayCredits`  — everything spent today across sessions and runs.
 * - `perRunCredits`  — the ceiling handed to one autonomous run.
 *
 * All three default OFF. With no cap saved, every gate below returns
 * "not blocked" and the loop behaves exactly as it did before this file existed.
 *
 * Cost math is never re-derived here: `creditsForTurn()` from `usageCredits.ts`
 * is the estimator the usage footer already shows, and `costRupees()` is what it
 * calls. Recording the same frames the footer displays means the cap and the
 * number the user is reading can never disagree.
 */

import { costRupees, roundRupees } from './modelRates';
import { creditsForTurn, type TurnUsage } from './usageCredits';
import { RUPEES_PER_CREDIT } from './plans';
import type { HistoryStore } from './chatHistory';
import type { RunBudget } from './autonomy/types';

const LEDGER_KEY = 'shadrox.spend.ledger';
const CAPS_KEY = 'shadrox.spend.caps';
/** Only the recent conversations' costs are kept; the day total is the live number. */
const MAX_SESSIONS = 24;
export const SPEND_EVENT = 'shadrox:spend-updated';
export const CAPS_EVENT = 'shadrox:spend-caps-updated';

function getSpendStore(): HistoryStore {
  try {
    const storage = window.localStorage;
    return {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key)
    };
  } catch (error) {
    throw new Error('Persistent browser storage is unavailable; spend limits cannot be enforced.', { cause: error });
  }
}

export interface SpendCaps {
  /** Credits. `Infinity` (and anything unparseable) means the cap is off. */
  perTurnCredits: number;
  perDayCredits: number;
  perRunCredits: number;
}

/** Default state of a BYOK-unlimited product: no cap, no accumulation gate. */
export const CAPS_OFF: SpendCaps = { perTurnCredits: Infinity, perDayCredits: Infinity, perRunCredits: Infinity };

export interface SessionSpend {
  credits: number;
  rupees: number;
  updatedAt: number;
}

interface Ledger {
  /** Local calendar day the totals belong to; anything else is stale. */
  day: string;
  dayCredits: number;
  dayRupees: number;
  sessions: Record<string, SessionSpend>;
}

export interface SpendSnapshot {
  day: string;
  sessionCredits: number;
  sessionRupees: number;
  dayCredits: number;
  dayRupees: number;
}

export interface SpendGate {
  blocked: boolean;
  /** Shown verbatim as the chat status line and as the tool loop's stop reason. */
  message?: string;
}

/** A credit figure that the meter and the cap can both compare without float drift. */
function roundCredits(value: number): number {
  return Math.round(value * 10) / 10;
}

function todayKey(now = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function finite(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function blankLedger(day: string): Ledger {
  return { day, dayCredits: 0, dayRupees: 0, sessions: {} };
}

function readLedger(store: HistoryStore, day: string): Ledger {
  let raw: string | null = null;
  try {
    raw = store.getItem(LEDGER_KEY);
  } catch (error) {
    throw new Error('Unable to read the spend ledger; spending is paused until storage is available.', { cause: error });
  }
  if (!raw) return blankLedger(day);
  try {
    const parsed = JSON.parse(raw) as Partial<Ledger> | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.sessions || typeof parsed.sessions !== 'object') {
      throw new Error('The spend ledger is invalid; spending is paused to avoid exceeding your cap.');
    }
    const ledger = blankLedger(day);
    // Yesterday's totals are history, not a starting balance: a new day starts
    // the day counter at zero while the per-session figures survive.
    if (parsed.day === day) {
      ledger.dayCredits = roundCredits(Math.max(0, finite(parsed.dayCredits, 0)));
      ledger.dayRupees = roundRupees(Math.max(0, finite(parsed.dayRupees, 0)));
    }
    const sessions = parsed.sessions;
    if (sessions && typeof sessions === 'object') {
      for (const [id, entry] of Object.entries(sessions as Record<string, unknown>)) {
        const record = entry as Partial<SessionSpend> | null;
        if (!record) continue;
        ledger.sessions[id] = {
          credits: roundCredits(Math.max(0, finite(record.credits, 0))),
          rupees: roundRupees(Math.max(0, finite(record.rupees, 0))),
          updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0
        };
      }
    }
    return ledger;
  } catch (error) {
    throw new Error('The spend ledger is unreadable; spending is paused to avoid exceeding your cap.', { cause: error });
  }
}

function writeLedger(store: HistoryStore, ledger: Ledger): void {
  const entries = Object.entries(ledger.sessions).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const kept: Ledger = { ...ledger, sessions: {} };
  for (const [id, entry] of entries.slice(0, MAX_SESSIONS)) kept.sessions[id] = entry;
  try {
    store.setItem(LEDGER_KEY, JSON.stringify(kept));
  } catch (error) {
    throw new Error('Unable to save spend data; the current turn may not be reflected in the cap meter.', { cause: error });
  }
}

function announce(event: string = SPEND_EVENT): void {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent(event));
  } catch {
    /* tests and SSR have no window; the stored number is the source of truth */
  }
}

/* ------------------------------------------------------------------ *
 * Caps
 * ------------------------------------------------------------------ */

/** Reads the caps. Absent, blank, zero or negative all mean OFF. */
export function loadSpendCaps(store = getSpendStore()): SpendCaps {
  let raw: string | null = null;
  try {
    raw = store.getItem(CAPS_KEY);
  } catch (error) {
    throw new Error('Unable to read spend caps; spending is paused until storage is available.', { cause: error });
  }
  if (!raw) return { ...CAPS_OFF };
  try {
    const parsed = JSON.parse(raw) as Partial<SpendCaps> | null;
    if (!parsed || typeof parsed !== 'object') throw new Error('Spend-cap data is invalid.');
    return {
      perTurnCredits: finite(parsed.perTurnCredits, Infinity),
      perDayCredits: finite(parsed.perDayCredits, Infinity),
      perRunCredits: finite(parsed.perRunCredits, Infinity)
    };
  } catch (error) {
    throw new Error('Spend caps are unreadable; spending is paused to avoid exceeding your cap.', { cause: error });
  }
}

/**
 * Saves the caps. `null`, `''`, `0` and a negative all switch that cap off, so
 * the settings field can be cleared rather than having to hold a magic number.
 */
export function saveSpendCaps(caps: Partial<SpendCaps>, store = getSpendStore()): SpendCaps {
  const next: SpendCaps = {
    perTurnCredits: finite(caps.perTurnCredits, Infinity),
    perDayCredits: finite(caps.perDayCredits, Infinity),
    perRunCredits: finite(caps.perRunCredits, Infinity)
  };
  const isOff = !Number.isFinite(next.perTurnCredits) && !Number.isFinite(next.perDayCredits) && !Number.isFinite(next.perRunCredits);
  try {
    if (isOff) store.removeItem(CAPS_KEY);
    else store.setItem(CAPS_KEY, JSON.stringify(next));
  } catch (error) {
    throw new Error('Unable to save spend caps. Check browser storage and try again.', { cause: error });
  }
  announce();
  return next;
}

/** Settings field helper: the stored number, or '' when that cap is off. */
export function capInputValue(cap: number): string {
  return Number.isFinite(cap) ? String(cap) : '';
}

/** Settings parse helper: a blank or non-positive field switches the cap off. */
export function parseCapInput(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
}

/* ------------------------------------------------------------------ *
 * Accumulation
 * ------------------------------------------------------------------ */

/**
 * Adds one SSE usage frame to the session and day totals.
 *
 * Returns the credits added — 0 when the provider reported no token split, which
 * is the same rule `creditsForTurn()` uses to withhold a guess. Nothing here may
 * throw into the stream handler: a lost estimate is worse for the user than a
 * lost cap hit, but never a reason to fail a reply they are watching.
 */
export function recordUsageFrame(
  sessionId: string,
  usage: TurnUsage & { modelId?: string },
  store = getSpendStore(),
  now = Date.now()
): number {
  const modelId = usage.modelId ?? '';
  const credits = creditsForTurn(modelId, usage);
  if (!credits) return 0;
  const day = todayKey(now);
  const ledger = readLedger(store, day);
  const rupees = roundRupees(costRupees(modelId, {
    inputTokens: usage.inputTokens as number,
    outputTokens: usage.outputTokens as number
  }));
  const session = ledger.sessions[sessionId] ?? { credits: 0, rupees: 0, updatedAt: 0 };
  session.credits = roundCredits(session.credits + credits);
  session.rupees = roundRupees(session.rupees + rupees);
  session.updatedAt = Math.max(now, newestStamp(ledger) + 1);
  ledger.sessions[sessionId] = session;
  ledger.dayCredits = roundCredits(ledger.dayCredits + credits);
  ledger.dayRupees = roundRupees(ledger.dayRupees + rupees);
  writeLedger(store, ledger);
  announce();
  return credits;
}

/** Strictly-increasing stamps keep `MAX_SESSIONS` pruning deterministic. */
function newestStamp(ledger: Ledger): number {
  return Object.values(ledger.sessions).reduce((newest, entry) => Math.max(newest, entry.updatedAt), 0);
}

/** The stored cost of one session and of today, with the day rolled over. */
export function readSpendSnapshot(sessionId: string | null, store = getSpendStore(), now = Date.now()): SpendSnapshot {
  const day = todayKey(now);
  const ledger = readLedger(store, day);
  const session = (sessionId && ledger.sessions[sessionId]) || null;
  return {
    day,
    sessionCredits: session ? session.credits : 0,
    sessionRupees: session ? session.rupees : 0,
    dayCredits: ledger.dayCredits,
    dayRupees: ledger.dayRupees
  };
}

/** Drops every accumulated figure. Kept for tests and for a "reset meter" action. */
export function resetSpend(store = getSpendStore()): void {
  try {
    store.removeItem(LEDGER_KEY);
  } catch (error) {
    throw new Error('Unable to reset spend data.', { cause: error });
  }
  announce();
}

/* ------------------------------------------------------------------ *
 * Gates
 * ------------------------------------------------------------------ */

export function rupeesOf(credits: number): string {
  return `₹${roundRupees(credits * RUPEES_PER_CREDIT).toFixed(2)}`;
}

/**
 * The per-day wall, checked before a request is started, never during one.
 * Reaching the cap exactly counts as hitting it: `spent >= cap` blocks, so the
 * boundary is the number the user typed and not one turn past it.
 */
export function dailySpendGate(
  sessionId: string | null,
  caps?: SpendCaps,
  store?: HistoryStore,
  now = Date.now()
): SpendGate {
  try {
    const activeStore = store ?? getSpendStore();
    const activeCaps = caps ?? loadSpendCaps(activeStore);
    if (!Number.isFinite(activeCaps.perDayCredits)) return { blocked: false };
    const snapshot = readSpendSnapshot(sessionId, activeStore, now);
    if (snapshot.dayCredits < activeCaps.perDayCredits) return { blocked: false };
    return {
      blocked: true,
      message:
        `Daily budget exhausted: ${roundCredits(snapshot.dayCredits)} of ${activeCaps.perDayCredits} credits ` +
        `(${rupeesOf(snapshot.dayCredits)} of ${rupeesOf(activeCaps.perDayCredits)}) spent today. ` +
        `Raise or clear the cap in Settings → spend caps.`
    };
  } catch (error) {
    return { blocked: true, message: error instanceof Error ? error.message : 'Unable to verify spend caps; spending is paused.' };
  }
}

/**
 * The per-turn wall, checked before every round of the tool loop — the loop is
 * where one turn can quietly become twenty billed requests.
 */
export function perTurnSpendGate(turnCredits: number, caps?: SpendCaps): SpendGate {
  try {
    const activeCaps = caps ?? loadSpendCaps();
    if (!Number.isFinite(activeCaps.perTurnCredits)) return { blocked: false };
    if (roundCredits(turnCredits) < activeCaps.perTurnCredits) return { blocked: false };
    return {
      blocked: true,
      message:
        `Per-turn budget exhausted: ${roundCredits(turnCredits)} of ${activeCaps.perTurnCredits} credits ` +
        `(${rupeesOf(turnCredits)} of ${rupeesOf(activeCaps.perTurnCredits)}) — stopping this turn before another request.`
    };
  } catch (error) {
    return { blocked: true, message: error instanceof Error ? error.message : 'Unable to verify spend caps; spending is paused.' };
  }
}

/**
 * The ceiling one autonomous run gets. A declared per-run cap replaces the
 * default; with the cap off this returns the same object it was handed, so the
 * loop's existing per-run behaviour is untouched.
 */
export function runBudgetWithCap(defaultBudget: RunBudget, caps: SpendCaps = loadSpendCaps()): RunBudget {
  if (!Number.isFinite(caps.perRunCredits)) return defaultBudget;
  return { ...defaultBudget, maxCredits: Math.min(defaultBudget.maxCredits, caps.perRunCredits) };
}

/** Subscribes a component to ledger writes; mirrors `onQuotaChange` in shape. */
export function onSpendChange(callback: () => void): () => void {
  const handler = () => callback();
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  window.addEventListener(SPEND_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(SPEND_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}
export interface TokenSpendRecord {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  estimatedSavedUsd: number;
}

export interface SpendLedgerSummary {
  totalPromptTokens: number;
  totalCachedTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  cacheSavingsUsd: number;
  cacheHitRatio: number;
}

export class SpendLedger {
  private records: TokenSpendRecord[] = [];

  public recordTurnSpend(params: {
    provider: string;
    model: string;
    promptTokens: number;
    cachedTokens?: number;
    completionTokens: number;
    inputPricePerMillion?: number;
    outputPricePerMillion?: number;
    cacheReadPricePerMillion?: number;
  }): TokenSpendRecord {
    const cachedTokens = params.cachedTokens || 0;
    const basePromptTokens = Math.max(0, params.promptTokens - cachedTokens);

    const inputRate = params.inputPricePerMillion ?? 0.15; // default reasonable rate per million
    const outputRate = params.outputPricePerMillion ?? 0.60;
    const cacheRate = params.cacheReadPricePerMillion ?? 0.0375; // ~75% discount

    const inputCost = (basePromptTokens / 1_000_000) * inputRate;
    const cacheCost = (cachedTokens / 1_000_000) * cacheRate;
    const outputCost = (params.completionTokens / 1_000_000) * outputRate;
    const estimatedCostUsd = inputCost + cacheCost + outputCost;

    // Calculate how much was saved vs non-cached input
    const unCachedInputCost = (cachedTokens / 1_000_000) * inputRate;
    const estimatedSavedUsd = Math.max(0, unCachedInputCost - cacheCost);

    const record: TokenSpendRecord = {
      id: `spend-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      provider: params.provider,
      model: params.model,
      promptTokens: params.promptTokens,
      cachedTokens,
      completionTokens: params.completionTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
      estimatedSavedUsd: Math.round(estimatedSavedUsd * 100000) / 100000
    };

    this.records.push(record);
    return record;
  }

  public getSummary(): SpendLedgerSummary {
    let totalPrompt = 0;
    let totalCached = 0;
    let totalCompletion = 0;
    let totalCost = 0;
    let totalSaved = 0;

    for (const r of this.records) {
      totalPrompt += r.promptTokens;
      totalCached += r.cachedTokens;
      totalCompletion += r.completionTokens;
      totalCost += r.estimatedCostUsd;
      totalSaved += r.estimatedSavedUsd;
    }

    // promptTokens already contains cachedTokens (see usageCredits.ts and
    // api/_types.ts), so adding them would count every cached token twice.
    const cacheHitRatio = totalPrompt > 0 ? totalCached / totalPrompt : 0;

    return {
      totalPromptTokens: totalPrompt,
      totalCachedTokens: totalCached,
      totalCompletionTokens: totalCompletion,
      totalCostUsd: Math.round(totalCost * 10000) / 10000,
      cacheSavingsUsd: Math.round(totalSaved * 10000) / 10000,
      cacheHitRatio: Math.round(cacheHitRatio * 100) / 100
    };
  }

  public getRecords(): readonly TokenSpendRecord[] {
    return this.records;
  }

  public clear(): void {
    this.records.length = 0;
  }
}

export const globalSpendLedger = new SpendLedger();
