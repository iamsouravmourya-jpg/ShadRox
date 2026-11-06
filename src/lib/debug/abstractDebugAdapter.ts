/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ported from Void (Microsoft/vscode fork):
 *  - `src/vs/workbench/contrib/debug/common/abstractDebugAdapter.ts`
 *    (sequence-numbered request/response matching, event queue with task
 *    boundaries, cancellation of pending requests)
 *  - the `StreamDebugAdapter` framing half of
 *    `src/vs/workbench/contrib/debug/node/debugAdapter.ts`
 *    (Content-Length header parsing over Node streams, buffering of partial
 *    messages).
 *
 * Adaptations for ShadRox (runs in the Electron main / local Node):
 *  - vscode `Emitter`/`Event` replaced by the minimal local `Emitter` below.
 *  - vscode `timeout()` and `nls.localize()` replaced by a local helper and a
 *    plain English message.
 *  - the ambient global `DebugProtocol` namespace is imported from
 *    './debugProtocol'.
 *  - `connect()` is public so a session can attach any pair of Node streams:
 *    a spawned adapter's stdin/stdout or a `net.Socket` (pass the socket as
 *    both arguments).
 */
import * as stream from 'node:stream';
import type { DebugProtocol } from './debugProtocol.ts';
import { createFrameParser, encodeFrame } from '../../../electron/dap-framing.cjs';

/** Resolve after `ms` milliseconds. Replaces vscode's base/common/async timeout. */
function timeout(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Minimal listener collection replacing vscode's `base/common/event` Emitter.
 * Supports exactly what the ported adapter uses: single-argument `fire`,
 * subscribe-via-`event` getter returning a disposable, and `dispose`.
 */
export class Emitter<T> {
	private listeners: Array<(e: T) => void> = [];

	get event(): (listener: (e: T) => void) => () => void {
		return (listener: (e: T) => void) => {
			this.listeners.push(listener);
			return () => {
				const idx = this.listeners.indexOf(listener);
				if (idx >= 0) {
					this.listeners.splice(idx, 1);
				}
			};
		};
	}

	fire(event: T): void {
		for (const listener of this.listeners.slice()) {
			listener(event);
		}
	}

	dispose(): void {
		this.listeners = [];
	}
}

/**
 * Abstract implementation of the low level API for a debug adapter.
 * Missing is how this API communicates with the debug adapter.
 */
export abstract class AbstractDebugAdapter {
	private sequence: number;
	private pendingRequests = new Map<number, (e: DebugProtocol.Response) => void>();
	private requestCallback: ((request: DebugProtocol.Request) => void) | undefined;
	private eventCallback: ((request: DebugProtocol.Event) => void) | undefined;
	private messageCallback: ((message: DebugProtocol.ProtocolMessage) => void) | undefined;
	private queue: DebugProtocol.ProtocolMessage[] = [];
	protected readonly _onError = new Emitter<Error>();
	protected readonly _onExit = new Emitter<number | null>();

	constructor() {
		this.sequence = 1;
	}

	abstract startSession(): Promise<void>;

	abstract stopSession(): Promise<void>;

	abstract sendMessage(message: DebugProtocol.ProtocolMessage): void;

	get onError(): (listener: (e: Error) => void) => () => void {
		return this._onError.event;
	}

	get onExit(): (listener: (e: number | null) => void) => () => void {
		return this._onExit.event;
	}

	onMessage(callback: (message: DebugProtocol.ProtocolMessage) => void): void {
		if (this.messageCallback) {
			this._onError.fire(new Error(`attempt to set more than one 'Message' callback`));
		}
		this.messageCallback = callback;
	}

	onEvent(callback: (event: DebugProtocol.Event) => void): void {
		if (this.eventCallback) {
			this._onError.fire(new Error(`attempt to set more than one 'Event' callback`));
		}
		this.eventCallback = callback;
	}

	onRequest(callback: (request: DebugProtocol.Request) => void): void {
		if (this.requestCallback) {
			this._onError.fire(new Error(`attempt to set more than one 'Request' callback`));
		}
		this.requestCallback = callback;
	}

	sendResponse(response: DebugProtocol.Response): void {
		if (response.seq > 0) {
			this._onError.fire(new Error(`attempt to send more than one response for command ${response.command}`));
		} else {
			this.internalSend('response', response);
		}
	}

	sendRequest(command: string, args: any, clb: (result: DebugProtocol.Response) => void, cbTimeout?: number): number {
		const request: any = {
			command: command
		};
		if (args && Object.keys(args).length > 0) {
			request.arguments = args;
		}
		this.internalSend('request', request);
		if (typeof cbTimeout === 'number') {
			const timer = setTimeout(() => {
				clearTimeout(timer);
				const pending = this.pendingRequests.get(request.seq);
				if (pending) {
					this.pendingRequests.delete(request.seq);
					const err: DebugProtocol.Response = {
						type: 'response',
						seq: 0,
						request_seq: request.seq,
						success: false,
						command,
						message: `Timeout after ${cbTimeout} ms for '${command}'`
					};
					pending(err);
				}
			}, cbTimeout);
		}
		if (clb) {
			// store callback for this request
			this.pendingRequests.set(request.seq, clb);
		}

		return request.seq;
	}

	acceptMessage(message: DebugProtocol.ProtocolMessage): void {
		if (this.messageCallback) {
			this.messageCallback(message);
		} else {
			this.queue.push(message);
			if (this.queue.length === 1) {
				// first item = need to start processing loop
				this.processQueue();
			}
		}
	}

	/**
	 * Returns whether we should insert a timeout between processing messageA
	 * and messageB. Artificially queueing protocol messages guarantees that any
	 * microtasks for previous message finish before next message is processed.
	 * This is essential ordering when using promises anywhere along the call path.
	 */
	protected needsTaskBoundaryBetween(messageA: DebugProtocol.ProtocolMessage, messageB: DebugProtocol.ProtocolMessage) {
		return messageA.type !== 'event' || messageB.type !== 'event';
	}

	/**
	 * Reads and dispatches items from the queue until it is empty.
	 */
	private async processQueue() {
		let message: DebugProtocol.ProtocolMessage | undefined;
		while (this.queue.length) {
			if (!message || this.needsTaskBoundaryBetween(this.queue[0], message)) {
				await timeout(0);
			}

			message = this.queue.shift();
			if (!message) {
				return; // may have been disposed of
			}

			switch (message.type) {
				case 'event':
					this.eventCallback?.(message as DebugProtocol.Event);
					break;
				case 'request':
					this.requestCallback?.(message as DebugProtocol.Request);
					break;
				case 'response': {
					const response = message as DebugProtocol.Response;
					const clb = this.pendingRequests.get(response.request_seq);
					if (clb) {
						this.pendingRequests.delete(response.request_seq);
						clb(response);
					}
					break;
				}
			}
		}
	}

	private internalSend(typ: 'request' | 'response' | 'event', message: DebugProtocol.ProtocolMessage): void {
		message.type = typ;
		message.seq = this.sequence++;
		this.sendMessage(message);
	}

	protected async cancelPendingRequests(): Promise<void> {
		if (this.pendingRequests.size === 0) {
			return Promise.resolve();
		}

		const pending = new Map<number, (e: DebugProtocol.Response) => void>();
		this.pendingRequests.forEach((value, key) => pending.set(key, value));
		await timeout(500);
		pending.forEach((callback, request_seq) => {
			const err: DebugProtocol.Response = {
				type: 'response',
				seq: 0,
				request_seq,
				success: false,
				command: 'canceled',
				message: 'canceled'
			};
			callback(err);
			this.pendingRequests.delete(request_seq);
		});
	}

	getPendingRequestIds(): number[] {
		return Array.from(this.pendingRequests.keys());
	}

	dispose(): void {
		this.queue = [];
	}
}

/**
 * An implementation that communicates via two Node streams with the debug
 * adapter. Frames every message with the DAP wire format:
 *
 *   Content-Length: <byte length of UTF-8 JSON body>\r\n
 *   \r\n
 *   <JSON body>
 *
 * Partial messages are buffered until a full header/body pair has arrived, so
 * a header split across two `data` events or a body cut mid-JSON still yields
 * exactly one parsed message.
 */
export class StreamDebugAdapter extends AbstractDebugAdapter {

	private outputStream: stream.Writable | undefined;

	/**
	 * Framing lives in `electron/dap-framing.cjs` so the main-process host and
	 * this renderer-side client cannot drift apart. The parser is incremental:
	 * partial headers and mid-JSON bodies are buffered until the rest arrives.
	 */
	private readonly parser = createFrameParser({
		onMessage: (message: unknown) => this.acceptMessage(message as DebugProtocol.ProtocolMessage),
		onError: (error: Error) => this._onError.fire(error)
	});

	/** Wire the adapter to a pair of streams: the readable carries adapter →
	 *  client messages, the writable carries client → adapter messages. For a
	 *  `net.Socket`, pass the socket for both. */
	connect(readable: stream.Readable, writable: stream.Writable): void {

		this.outputStream = writable;
		this.parser.reset();

		readable.on('data', (data: Buffer) => this.parser.push(data));
	}

	startSession(): Promise<void> {
		// the streams are supplied by the owner (see DebugSession); nothing to open here
		return Promise.resolve();
	}

	async stopSession(): Promise<void> {
		await this.cancelPendingRequests();
	}

	sendMessage(message: DebugProtocol.ProtocolMessage): void {

		if (this.outputStream) {
			this.outputStream.write(encodeFrame(message), 'utf8');
		}
	}
}
