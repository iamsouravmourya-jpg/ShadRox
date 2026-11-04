import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { StreamDebugAdapter } from './abstractDebugAdapter.ts';
import type { DebugProtocol } from './debugProtocol.ts';

/** Encode one DAP frame the way a debug adapter would put it on the wire. */
function frame(message: Record<string, unknown>): Buffer {
	const json = JSON.stringify(message);
	return Buffer.from(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`, 'utf8');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function connected(): { adapter: StreamDebugAdapter; in: PassThrough; out: PassThrough } {
	const adapter = new StreamDebugAdapter();
	const intoAdapter = new PassThrough();   // client -> adapter
	const fromAdapter = new PassThrough();   // adapter -> client
	adapter.connect(fromAdapter, intoAdapter);
	return { adapter, in: fromAdapter, out: intoAdapter };
}

test('a header split mid-string yields exactly one parsed message', async () => {
	const { adapter, in: feed } = connected();
	const messages: DebugProtocol.ProtocolMessage[] = [];
	adapter.onMessage((m) => messages.push(m));

	const bytes = frame({ seq: 7, type: 'event', event: 'output', body: { category: 'console', output: 'hello' } });
	// cut inside the "Content-Length" header itself
	const cut = 12;
	assert.ok(bytes.subarray(0, cut).toString().includes('Content-L'));
	feed.write(bytes.subarray(0, cut));
	feed.write(bytes.subarray(cut));
	await sleep(5);

	assert.equal(messages.length, 1, 'partial header must not produce two messages');
	assert.equal(messages[0].type, 'event');
	assert.deepEqual((messages[0] as DebugProtocol.Event).body.output, 'hello');
});

test('a body split mid-JSON yields exactly one parsed message', async () => {
	const { adapter, in: feed } = connected();
	const messages: DebugProtocol.ProtocolMessage[] = [];
	adapter.onMessage((m) => messages.push(m));

	const bytes = frame({
		seq: 3, type: 'response', request_seq: 2, success: true, command: 'threads',
		body: { threads: [{ id: 1, name: 'Main Thread' }] }
	});
	const bodyStart = bytes.indexOf(Buffer.from('{'));
	// cut the JSON body in the middle of a token, after the header is complete
	const cut = bodyStart + 20;
	feed.write(bytes.subarray(0, cut));
	await sleep(5);
	assert.equal(messages.length, 0, 'incomplete body must be buffered, not parsed');
	feed.write(bytes.subarray(cut));
	await sleep(5);

	assert.equal(messages.length, 1);
	assert.equal((messages[0] as DebugProtocol.Response).request_seq, 2);
});

test('outgoing messages are Content-Length framed and responses match by sequence number', async () => {
	const { adapter, in: feed, out: written } = connected();
	const wire: Buffer[] = [];
	written.on('data', (chunk: Buffer) => wire.push(chunk));

	let response: DebugProtocol.Response | undefined;
	const seq = adapter.sendRequest('threads', {}, (res) => { response = res; });
	await sleep(5);

	// the request reached the wire with a correct Content-Length header
	const bytes = Buffer.concat(wire).toString('utf8');
	const match = /^Content-Length: (\d+)\r\n\r\n/.exec(bytes);
	assert.ok(match, `expected a Content-Length header, got: ${bytes.slice(0, 60)}`);
	const body = bytes.slice(match[0].length);
	assert.equal(Number(match[1]), Buffer.byteLength(body, 'utf8'), 'header length must equal body byte length');
	const parsed = JSON.parse(body) as DebugProtocol.Request;
	assert.equal(parsed.command, 'threads');
	assert.equal(parsed.seq, seq, 'returned seq must equal the frame seq');

	// deliver the matching response
	feed.write(frame({
		seq: 9, type: 'response', request_seq: seq, success: true, command: 'threads',
		body: { threads: [{ id: 1, name: 'main' }] }
	}));
	await sleep(20);

	assert.ok(response, 'the request callback must fire for its response');
	assert.equal(response!.request_seq, seq, 'response must be matched to its request by sequence number');
	assert.equal(response!.success, true);
	assert.deepEqual(response!.body.threads, [{ id: 1, name: 'main' }]);
	assert.deepEqual(adapter.getPendingRequestIds(), [], 'a matched response clears the pending request');
});

test('an error response surfaces success=false with its message', async () => {
	const { adapter, in: feed } = connected();

	let response: DebugProtocol.Response | undefined;
	const seq = adapter.sendRequest('next', { threadId: 1 }, (res) => { response = res; });

	feed.write(frame({
		seq: 11, type: 'response', request_seq: seq, success: false, command: 'next', message: 'cancelled'
	}));
	await sleep(20);

	assert.ok(response);
	assert.equal(response!.success, false);
	assert.equal(response!.command, 'next');
	assert.equal(response!.message, 'cancelled');
	assert.deepEqual(adapter.getPendingRequestIds(), []);
});

test('stopSession cancels a response that never arrives', async () => {
	const { adapter } = connected();

	let response: DebugProtocol.Response | undefined;
	adapter.sendRequest('stackTrace', { threadId: 1 }, (res) => { response = res; });
	assert.deepEqual(adapter.getPendingRequestIds().length, 1);

	await adapter.stopSession();

	assert.ok(response, 'a missing response must be cancelled, not left hanging');
	assert.equal(response!.success, false);
	assert.equal(response!.command, 'canceled');
	assert.deepEqual(adapter.getPendingRequestIds(), []);
});
