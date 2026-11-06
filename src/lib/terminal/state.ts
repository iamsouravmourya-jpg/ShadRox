import { classifyCommandFailure } from '../autoFix';
import type { CommandFailureClassification } from '../autoFix';
import { ShellIntegrationParser } from './shellIntegration';
import type { StructuredTerminalState } from './shellIntegration';

/**
 * How long a running command may stay silent before ShadRox calls it hung.
 * Twenty seconds is the point where "slow" and "stuck" stop being guesswork:
 * builds and test suites stream output far more often than that, while a command
 * waiting on a prompt or a deadlocked subprocess says nothing at all.
 */
export const DEFAULT_HUNG_THRESHOLD_SECONDS = 20;
export const MIN_HUNG_THRESHOLD_SECONDS = 5;
export const MAX_HUNG_THRESHOLD_SECONDS = 900;
export const HUNG_THRESHOLD_CHOICES = [10, 20, 30, 60, 120] as const;
export const HUNG_THRESHOLD_STORAGE_KEY = 'shadrox.terminal.hungSeconds';
/**
 * Silence while a command runs is what an interactive prompt looks like, but a
 * compiling build is silent for seconds at a time too. Ten seconds keeps
 * "awaiting input" from inviting an answer into a busy stdin.
 */
export const DEFAULT_AWAITING_INPUT_SECONDS = 10;

export interface TerminalSettingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TerminalStateSummary {
  activeSessionId: string | null;
  activeCwd: string;
  isExecuting: boolean;
  activeCommand: string | null;
  lastExitCode: number | null;
  /** Seconds since the running command last printed anything (0 when idle). */
  hungSeconds: number;
  /** Configurable threshold `hungSeconds` is measured against. */
  hungThresholdSeconds: number;
  isHung: boolean;
  /** Seconds left before the running command trips the threshold (0 when hung/idle). */
  secondsToHung: number;
  /** A command is running and quiet enough that it may be waiting on stdin. */
  awaitingInput: boolean;
  /** aider-style classification of the last non-zero command, or null. */
  lastFailure: CommandFailureClassification | null;
}

interface RunTracking {
  /** Bumped by every command execution so a notice can fire at most once per run. */
  epoch: number;
  notified: boolean;
}

function clampHungThreshold(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_HUNG_THRESHOLD_SECONDS;
  const rounded = Math.round(seconds);
  if (rounded < MIN_HUNG_THRESHOLD_SECONDS) return MIN_HUNG_THRESHOLD_SECONDS;
  if (rounded > MAX_HUNG_THRESHOLD_SECONDS) return MAX_HUNG_THRESHOLD_SECONDS;
  return rounded;
}

export function readHungThresholdSetting(
  storage: TerminalSettingStorage | null | undefined,
  fallback: number = DEFAULT_HUNG_THRESHOLD_SECONDS
): number {
  if (!storage) return clampHungThreshold(fallback);
  try {
    const raw = storage.getItem(HUNG_THRESHOLD_STORAGE_KEY);
    if (raw === null) return clampHungThreshold(fallback);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return clampHungThreshold(fallback);
    return clampHungThreshold(parsed);
  } catch {
    return clampHungThreshold(fallback);
  }
}

export function writeHungThresholdSetting(storage: TerminalSettingStorage | null | undefined, seconds: number): void {
  if (!storage) return;
  try {
    storage.setItem(HUNG_THRESHOLD_STORAGE_KEY, String(clampHungThreshold(seconds)));
  } catch {
    // Private-mode or full-quota storage is not worth surfacing.
  }
}

class TerminalStateManager {
  private parsers = new Map<string, ShellIntegrationParser>();
  private runs = new Map<string, RunTracking>();
  private activeSessionId: string | null = null;
  private hungThresholdSeconds = DEFAULT_HUNG_THRESHOLD_SECONDS;

  public getOrCreateParser(sessionId: string, initialCwd: string = ''): ShellIntegrationParser {
    let parser = this.parsers.get(sessionId);
    if (!parser) {
      parser = new ShellIntegrationParser(sessionId, initialCwd);
      this.parsers.set(sessionId, parser);
    }
    return parser;
  }

  public setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  public feed(sessionId: string, chunk: string): string {
    const parser = this.getOrCreateParser(sessionId);
    const { cleanText, events } = parser.feed(chunk);
    for (const event of events) this.trackEvent(sessionId, event.type);
    return cleanText;
  }

  /**
   * A hung notice belongs to one command execution, not to the clock: every tick
   * would otherwise re-print it. `command-executed` opens a new run, `D`/prompt
   * close it and let the next run notify again.
   */
  private trackEvent(sessionId: string, type: string): void {
    if (type !== 'command-executed' && type !== 'command-finished' && type !== 'prompt-start') return;
    const current = this.runs.get(sessionId) ?? { epoch: 0, notified: false };
    if (type === 'command-executed') {
      this.runs.set(sessionId, { epoch: current.epoch + 1, notified: false });
      return;
    }
    this.runs.set(sessionId, { epoch: current.epoch, notified: false });
  }

  public getSessionState(sessionId: string): StructuredTerminalState | null {
    const parser = this.parsers.get(sessionId);
    return parser ? parser.getState() : null;
  }

  public hasSession(sessionId: string): boolean {
    return this.parsers.has(sessionId);
  }

  public getHungThresholdSeconds(): number {
    return this.hungThresholdSeconds;
  }

  public setHungThresholdSeconds(seconds: number): number {
    this.hungThresholdSeconds = clampHungThreshold(seconds);
    return this.hungThresholdSeconds;
  }

  public isSessionHung(sessionId: string, now: number = Date.now()): boolean {
    const parser = this.parsers.get(sessionId);
    if (!parser) return false;
    const state = parser.getState();
    return state.isExecuting && parser.getHungSeconds(now) >= this.hungThresholdSeconds;
  }

  /**
   * True once per hung command execution; the second call for the same run
   * returns false even if the silence keeps growing.
   */
  public consumeHungNotice(sessionId: string, now: number = Date.now()): boolean {
    if (!this.isSessionHung(sessionId, now)) return false;
    const run = this.runs.get(sessionId);
    if (!run || run.notified) return false;
    run.notified = true;
    return true;
  }

  public getSummary(now: number = Date.now()): TerminalStateSummary {
    const parser = this.activeSessionId ? this.parsers.get(this.activeSessionId) : undefined;
    if (!this.activeSessionId || !parser) {
      return this.emptySummary(this.activeSessionId, parser);
    }
    return this.summaryFor(this.activeSessionId, parser, now);
  }

  /**
   * Summary for one named tab. The panel renders from a tab it picked itself, and
   * `activeSessionId` only catches up in an effect, so it must not read the active
   * session for the numbers it shows.
   */
  public getSummaryFor(sessionId: string | null, now: number = Date.now()): TerminalStateSummary {
    const parser = sessionId ? this.parsers.get(sessionId) : undefined;
    if (!sessionId || !parser) return this.emptySummary(sessionId, parser);
    return this.summaryFor(sessionId, parser, now);
  }

  /** Every live session, oldest first; used by the stdin injection gate. */
  public getSessionIds(): string[] {
    return Array.from(this.parsers.keys());
  }

  public getSummaries(now: number = Date.now()): TerminalStateSummary[] {
    return this.getSessionIds().map((sessionId) => this.summaryFor(sessionId, this.getOrCreateParser(sessionId), now));
  }

  private emptySummary(activeSessionId: string | null, parser?: ShellIntegrationParser): TerminalStateSummary {
    return {
      activeSessionId,
      activeCwd: parser?.getState().cwd ?? '',
      isExecuting: false,
      activeCommand: null,
      lastExitCode: null,
      hungSeconds: 0,
      hungThresholdSeconds: this.hungThresholdSeconds,
      isHung: false,
      secondsToHung: 0,
      awaitingInput: false,
      lastFailure: null
    };
  }

  private summaryFor(sessionId: string, parser: ShellIntegrationParser, now: number): TerminalStateSummary {
    const state = parser.getState();
    const hungSeconds = state.isExecuting ? parser.getHungSeconds(now) : 0;
    const isHung = state.isExecuting && hungSeconds >= this.hungThresholdSeconds;
    const last = state.lastCommand;
    const exitCode = last?.exitCode ?? null;
    const failed = Boolean(last) && exitCode !== null && exitCode !== 0;

    return {
      activeSessionId: sessionId,
      activeCwd: state.cwd,
      isExecuting: state.isExecuting,
      activeCommand: state.currentCommand,
      lastExitCode: exitCode,
      hungSeconds,
      hungThresholdSeconds: this.hungThresholdSeconds,
      isHung,
      secondsToHung: isHung ? 0 : Math.max(0, this.hungThresholdSeconds - hungSeconds),
      awaitingInput: state.isExecuting && !isHung && hungSeconds >= DEFAULT_AWAITING_INPUT_SECONDS,
      lastFailure: failed
        ? classifyCommandFailure({
            command: last?.command ?? '',
            exitCode,
            stdout: last?.outputTail ?? '',
            stderr: ''
          })
        : null
    };
  }

  public dropSession(sessionId: string): void {
    this.parsers.delete(sessionId);
    this.runs.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      const next = this.parsers.keys().next();
      this.activeSessionId = next.done ? null : next.value;
    }
  }

  public clearAll(): void {
    this.parsers.clear();
    this.runs.clear();
    this.activeSessionId = null;
  }
}

export const terminalStateManager = new TerminalStateManager();
