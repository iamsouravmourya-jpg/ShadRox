import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { DebugProtocol } from './debugProtocol.ts';
import { Emitter, StreamDebugAdapter } from './abstractDebugAdapter.ts';

/**
 * Thin session rails on top of {@link StreamDebugAdapter}: spawn an adapter
 * process (debugpy, js-debug's `dap.js`, `net`, or anything that speaks DAP
 * over stdio), run the spec-mandated initialize handshake, and expose the
 * handful of requests a UI needs. No VS Code service infrastructure — this is
 * deliberately minimal: the rails, not the UI.
 */

/** How to launch the debug adapter itself. */
export interface DebugAdapterDescriptor {
	/** DAP `adapterID`, e.g. 'debugpy', 'pwa-node', 'node'. */
	adapterID: string;
	/** Executable: 'python', 'node', a venv `debugpy` path, etc. */
	command: string;
	/** Adapter arguments, e.g. ['-m', 'debugpy.adapter']. */
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

/** The launch/attach configuration handed to the adapter (adapter-specific bag). */
export interface DebugConfiguration {
	request: 'launch' | 'attach';
	/** e.g. { program: 'C:\\proj\\main.py', cwd: 'C:\\proj' } for debugpy. */
	configuration: Record<string, unknown>;
}

export type DebugSessionState = 'inactive' | 'initializing' | 'running' | 'stopped' | 'terminated';

/**
 * A single DAP client session. Owns one adapter process (or socket, once
 * connected elsewhere) and its {@link StreamDebugAdapter}.
 */
export class DebugSession {

	private adapter: StreamDebugAdapter | null = null;
	private child: ChildProcess | null = null;
	private capabilities: DebugProtocol.Capabilities = {};
	private state: DebugSessionState = 'inactive';
	private initializedResolve: (() => void) | null = null;
	private readonly eventEmitter = new Emitter<DebugProtocol.Event>();
	private readonly stateEmitter = new Emitter<DebugSessionState>();
	private readonly errorEmitter = new Emitter<Error>();

	get currentState(): DebugSessionState {
		return this.state;
	}

	get adapterCapabilities(): DebugProtocol.Capabilities {
		return this.capabilities;
	}

	/** Raw DAP events (output, stopped, breakpoint, …) for the future UI layer. */
	onEvent(listener: (e: DebugProtocol.Event) => void): () => void {
		return this.eventEmitter.event(listener);
	}

	onStateChange(listener: (s: DebugSessionState) => void): () => void {
		return this.stateEmitter.event(listener);
	}

	onError(listener: (e: Error) => void): () => void {
		return this.errorEmitter.event(listener);
	}

	/**
	 * Spawn the adapter, perform the `initialize` → `initialized` handshake,
	 * send `launch`/`attach`, and finish configuration. Resolves once the
	 * debuggee has been started; stop/output events arrive via `onEvent`.
	 */
	async startDebugging(descriptor: DebugAdapterDescriptor, config: DebugConfiguration): Promise<void> {
		if (this.adapter) {
			throw new Error('Debug session is already started; disconnect before starting another.');
		}

		this.setState('initializing');

		const adapter = new StreamDebugAdapter();
		this.adapter = adapter;

		const initializedPromise = new Promise<void>((resolve) => { this.initializedResolve = resolve; });

		// callbacks must exist before any message is dispatched
		adapter.onEvent((event) => this.handleEvent(event));
		adapter.onRequest((request) => this.handleServerRequest(request));
		adapter.onError((err) => this.errorEmitter.fire(err));
		adapter.onExit((code) => {
			if (this.state !== 'terminated') {
				this.errorEmitter.fire(new Error(`debug adapter exited (code ${code})`));
			}
			this.setState('terminated');
		});

		const options: SpawnOptions = {
			cwd: descriptor.cwd,
			env: descriptor.env ? { ...process.env, ...descriptor.env } : process.env,
			stdio: ['pipe', 'pipe', 'pipe']
		};
		const child = spawn(descriptor.command, descriptor.args ?? [], options);
		this.child = child;
		child.on('error', (err) => this.errorEmitter.fire(err));
		// stderr is adapter noise; keep it draining so the pipe never blocks.
		child.stderr?.resume();
		if (!child.stdout || !child.stdin) {
			throw new Error('debug adapter process has no stdio pipes');
		}
		adapter.connect(child.stdout, child.stdin);

		const initResponse = await this.request<DebugProtocol.InitializeResponse>('initialize', {
			adapterID: descriptor.adapterID,
			clientID: 'shadrox',
			clientName: 'ShadRox',
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: 'path'
		});
		this.capabilities = initResponse.body ?? {};

		// the adapter must answer the initialize request before it may emit
		// anything; wait for the `initialized` event before configuring.
		await initializedPromise;
		this.initializedResolve = null;

		await this.request(config.request, config.configuration ?? {});

		if (this.capabilities.supportsConfigurationDoneRequest) {
			await this.request('configurationDone', {});
		}

		this.setState('running');
	}

	/** Replace all breakpoints for one source file; returns verified locations. */
	async setBreakpoints(path: string, lines: number[]): Promise<DebugProtocol.Breakpoint[]> {
		const res = await this.request<DebugProtocol.SetBreakpointsResponse>('setBreakpoints', {
			source: { path },
			breakpoints: lines.map((line) => ({ line }))
		});
		return res.body?.breakpoints ?? [];
	}

	async threads(): Promise<DebugProtocol.Thread[]> {
		const res = await this.request<DebugProtocol.ThreadsResponse>('threads', {});
		return res.body?.threads ?? [];
	}

	async stackTrace(threadId: number, startFrame?: number, levels?: number): Promise<DebugProtocol.StackFrame[]> {
		const res = await this.request<DebugProtocol.StackTraceResponse>('stackTrace', { threadId, startFrame, levels });
		return res.body?.stackFrames ?? [];
	}

	async scopes(frameId: number): Promise<DebugProtocol.Scope[]> {
		const res = await this.request<DebugProtocol.ScopesResponse>('scopes', { frameId });
		return res.body?.scopes ?? [];
	}

	async variables(variablesReference: number): Promise<DebugProtocol.Variable[]> {
		const res = await this.request<DebugProtocol.VariablesResponse>('variables', { variablesReference });
		return res.body?.variables ?? [];
	}

	async loadedSources(): Promise<DebugProtocol.Source[]> {
		const res = await this.request<DebugProtocol.LoadedSourcesResponse>('loadedSources', {});
		return res.body?.sources ?? [];
	}

	async continueExecution(threadId: number): Promise<void> {
		this.setState('running');
		await this.request('continue', { threadId });
	}

	async next(threadId: number): Promise<void> {
		await this.request('next', { threadId });
	}

	async stepIn(threadId: number): Promise<void> {
		await this.request('stepIn', { threadId });
	}

	async stepOut(threadId: number): Promise<void> {
		await this.request('stepOut', { threadId });
	}

	async pause(threadId: number): Promise<void> {
		await this.request('pause', { threadId });
	}

	/** Ask the adapter to disconnect, then tear the transport/process down. */
	async disconnect(options?: DebugProtocol.DisconnectArguments): Promise<void> {
		const adapter = this.adapter;
		if (adapter) {
			try {
				await this.request('disconnect', options ?? { terminateDebuggee: true });
			} catch {
				// the adapter may already be gone; teardown below still runs
			}
		}
		await this.teardown();
	}

	/** Forcefully stop the session (adapter process killed). */
	async stop(): Promise<void> {
		await this.teardown(true);
	}

	private async teardown(kill = false): Promise<void> {
		const adapter = this.adapter;
		this.adapter = null;
		if (adapter) {
			await adapter.stopSession(); // fails any still-pending requests with 'canceled'
			adapter.dispose();
		}
		const child = this.child;
		this.child = null;
		if (child) {
			if (kill) {
				child.kill();
			} else {
				child.stdin?.end();
				// give the adapter a moment to exit on its own after `disconnect`
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
					child.once('exit', () => { clearTimeout(timer); resolve(); });
				});
			}
		}
		if (this.state !== 'terminated') {
			this.setState('terminated');
		}
	}

	/** Promise wrapper over the callback-style request API; rejects on error responses. */
	private request<T extends DebugProtocol.Response>(command: string, args: object): Promise<T> {
		const adapter = this.adapter;
		if (!adapter) {
			return Promise.reject(new Error(`cannot send '${command}': no active debug adapter`));
		}
		return new Promise<T>((resolve, reject) => {
			adapter.sendRequest(command, args, (response) => {
				if (response.success) {
					resolve(response as T);
				} else {
					reject(new Error(response.message || `request '${command}' failed`));
				}
			});
		});
	}

	private handleEvent(event: DebugProtocol.Event): void {
		switch (event.event) {
			case 'initialized':
				this.initializedResolve?.();
				break;
			case 'stopped':
				this.setState('stopped');
				break;
			case 'continued':
				this.setState('running');
				break;
			case 'terminated':
				this.setState('terminated');
				break;
			default:
				break;
		}
		this.eventEmitter.fire(event);
	}

	/**
	 * Adapter → client requests (runInTerminal, startDebugging, …). This
	 * foundation does not host a terminal proxy yet, so answer them as
	 * unsupported rather than leave the adapter waiting forever.
	 */
	private handleServerRequest(request: DebugProtocol.Request): void {
		this.adapter?.sendResponse({
			seq: 0,
			type: 'response',
			request_seq: request.seq,
			success: false,
			command: request.command,
			message: `client does not support '${request.command}'`
		} as DebugProtocol.Response);
	}

	private setState(next: DebugSessionState): void {
		if (this.state !== next) {
			this.state = next;
			this.stateEmitter.fire(next);
		}
	}
}
