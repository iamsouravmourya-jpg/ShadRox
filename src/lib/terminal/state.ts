import { ShellIntegrationParser, StructuredTerminalState } from './shellIntegration';

export interface TerminalStateSummary {
  activeSessionId: string | null;
  activeCwd: string;
  isExecuting: boolean;
  activeCommand: string | null;
  lastExitCode: number | null;
  hungSeconds: number;
}

class TerminalStateManager {
  private parsers = new Map<string, ShellIntegrationParser>();
  private activeSessionId: string | null = null;

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
    const { cleanText } = parser.feed(chunk);
    return cleanText;
  }

  public getSessionState(sessionId: string): StructuredTerminalState | null {
    const parser = this.parsers.get(sessionId);
    return parser ? parser.getState() : null;
  }

  public getSummary(): TerminalStateSummary {
    if (!this.activeSessionId) {
      return {
        activeSessionId: null,
        activeCwd: '',
        isExecuting: false,
        activeCommand: null,
        lastExitCode: null,
        hungSeconds: 0
      };
    }

    const parser = this.parsers.get(this.activeSessionId);
    if (!parser) {
      return {
        activeSessionId: this.activeSessionId,
        activeCwd: '',
        isExecuting: false,
        activeCommand: null,
        lastExitCode: null,
        hungSeconds: 0
      };
    }

    const state = parser.getState();
    return {
      activeSessionId: this.activeSessionId,
      activeCwd: state.cwd,
      isExecuting: state.isExecuting,
      activeCommand: state.currentCommand,
      lastExitCode: state.lastCommand?.exitCode ?? null,
      hungSeconds: parser.getHungSeconds()
    };
  }

  public dropSession(sessionId: string): void {
    this.parsers.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      const next = this.parsers.keys().next();
      this.activeSessionId = next.done ? null : next.value;
    }
  }

  public clearAll(): void {
    this.parsers.clear();
    this.activeSessionId = null;
  }
}

export const terminalStateManager = new TerminalStateManager();
