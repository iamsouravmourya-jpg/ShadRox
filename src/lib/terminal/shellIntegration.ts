// Adapted from VS Code/void shell integration (MIT).
// Protocol: OSC 133 / OSC 633 terminal shell integration sequences.

export interface ShellCommandEvent {
  type: 'prompt-start' | 'prompt-end' | 'command-start' | 'command-executed' | 'command-finished' | 'cwd-change';
  timestamp: number;
  exitCode?: number | null;
  cwd?: string;
  commandLine?: string;
}

export interface StructuredCommandRecord {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  outputTail: string;
}

export interface StructuredTerminalState {
  sessionId: string;
  cwd: string;
  currentCommand: string | null;
  isPromptActive: boolean;
  isExecuting: boolean;
  lastOutputAt: number;
  lastCommand: StructuredCommandRecord | null;
  recentCommands: StructuredCommandRecord[];
}

const OSC_SEQUENCE_REGEX = /\x1b\](133|633);([A-Za-z0-9_=;\-\/\.\:\s]+)(\x07|\x1b\\)/g;
const OSC_7_CWD_REGEX = /\x1b\]7;file:\/\/[^\/]*([^\x07\x1b]+)(\x07|\x1b\\)/g;

export class ShellIntegrationParser {
  private buffer = '';
  private state: StructuredTerminalState;
  private currentTail = '';
  private maxHistory = 10;
  private maxTailLength = 4096;

  constructor(sessionId: string, initialCwd: string = '') {
    this.state = {
      sessionId,
      cwd: initialCwd,
      currentCommand: null,
      isPromptActive: true,
      isExecuting: false,
      lastOutputAt: Date.now(),
      lastCommand: null,
      recentCommands: []
    };
  }

  public getState(): Readonly<StructuredTerminalState> {
    return { ...this.state };
  }

  public getHungSeconds(now: number = Date.now()): number {
    if (!this.state.isExecuting) return 0;
    return Math.max(0, Math.floor((now - this.state.lastOutputAt) / 1000));
  }

  /**
   * Feed incoming raw PTY text chunk and return cleaned display text (with OSC markers stripped)
   */
  public feed(chunk: string): { cleanText: string; events: ShellCommandEvent[] } {
    if (!chunk) return { cleanText: '', events: [] };
    const now = Date.now();
    this.state.lastOutputAt = now;

    const events: ShellCommandEvent[] = [];
    const textToScan = this.buffer + chunk;
    this.buffer = '';

    // Handle split escape sequences at end of chunk
    const lastEsc = textToScan.lastIndexOf('\x1b');
    let processable = textToScan;
    if (lastEsc >= 0 && lastEsc > textToScan.length - 128) {
      const fragment = textToScan.slice(lastEsc);
      if (!fragment.includes('\x07') && !fragment.includes('\x1b\\')) {
        processable = textToScan.slice(0, lastEsc);
        this.buffer = fragment;
      }
    }

    // Combined regex for OSC 7 and OSC 133/633
    const COMBINED_OSC_REGEX = /\x1b\](?:7;file:\/\/[^\/]*([^\x07\x1b]+)|(133|633);([A-Za-z0-9_=;\-\/\.\:\s]+))(\x07|\x1b\\)/g;

    let cleanText = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = COMBINED_OSC_REGEX.exec(processable)) !== null) {
      const textSlice = processable.slice(lastIndex, match.index);
      if (textSlice) {
        cleanText += textSlice;
        if (this.state.isExecuting) {
          this.currentTail += textSlice;
          if (this.currentTail.length > this.maxTailLength) {
            this.currentTail = this.currentTail.slice(-this.maxTailLength);
          }
        }
      }
      lastIndex = match.index + match[0].length;

      if (match[1] !== undefined) {
        // OSC 7 CWD match
        const cleanPath = decodeURIComponent(match[1]);
        this.state.cwd = cleanPath;
        events.push({ type: 'cwd-change', cwd: cleanPath, timestamp: now });
      } else if (match[3] !== undefined) {
        // OSC 133 or 633 match
        const payload = match[3];
        const code = payload.charAt(0);
        const params = payload.slice(1).replace(/^[;=]/, '');

        switch (code) {
          case 'A': // Prompt Start
            this.state.isPromptActive = true;
            this.state.isExecuting = false;
            events.push({ type: 'prompt-start', timestamp: now });
            break;

          case 'B': // Prompt End / Command Line Start
            this.state.isPromptActive = false;
            events.push({ type: 'prompt-end', timestamp: now });
            break;

          case 'C': // Command Executed / Output Start
            this.state.isExecuting = true;
            this.currentTail = '';
            events.push({ type: 'command-executed', timestamp: now });
            break;

          case 'D': { // Command Finished
            let exitCode: number | null = null;
            if (params) {
              const parsed = parseInt(params.split(';')[0], 10);
              if (!Number.isNaN(parsed)) exitCode = parsed;
            }
            this.state.isExecuting = false;
            events.push({ type: 'command-finished', exitCode, timestamp: now });

            if (this.state.currentCommand) {
              const finishedRecord: StructuredCommandRecord = {
                id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
                command: this.state.currentCommand,
                cwd: this.state.cwd,
                startedAt: this.state.lastCommand?.startedAt || now,
                finishedAt: now,
                exitCode,
                outputTail: this.currentTail
              };
              this.state.lastCommand = finishedRecord;
              this.state.recentCommands.push(finishedRecord);
              if (this.state.recentCommands.length > this.maxHistory) {
                this.state.recentCommands.shift();
              }
              this.state.currentCommand = null;
            }
            break;
          }

          case 'E': // Command Line text (OSC 633;E;<cmd>)
            this.state.currentCommand = params.trim();
            events.push({ type: 'command-start', commandLine: this.state.currentCommand, timestamp: now });
            break;

          case 'P': // Property (e.g. Cwd=<path>)
            if (params.startsWith('Cwd=')) {
              const cwd = params.slice(4).trim();
              this.state.cwd = cwd;
              events.push({ type: 'cwd-change', cwd, timestamp: now });
            }
            break;
        }
      }
    }

    const trailing = processable.slice(lastIndex);
    if (trailing) {
      cleanText += trailing;
      if (this.state.isExecuting) {
        this.currentTail += trailing;
        if (this.currentTail.length > this.maxTailLength) {
          this.currentTail = this.currentTail.slice(-this.maxTailLength);
        }
      }
    }

    return { cleanText, events };
  }

  public reset(cwd: string = ''): void {
    this.buffer = '';
    this.currentTail = '';
    this.state = {
      sessionId: this.state.sessionId,
      cwd: cwd || this.state.cwd,
      currentCommand: null,
      isPromptActive: true,
      isExecuting: false,
      lastOutputAt: Date.now(),
      lastCommand: null,
      recentCommands: []
    };
  }
}
