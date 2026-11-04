/**
 * Public surface of the ShadRox DAP client foundation, ported from Void
 * (MIT). Not yet wired into the agent tool registry: `src/lib/agent/tools.ts`
 * declares tools through a closed `TOOL_DEFINITIONS` list plus a hard-coded
 * `runTool` switch whose listing is fed straight into the model prompt, so
 * there is no non-invasive plug-in point for a debug tool today. The session
 * is consumable directly (electron main) via these exports.
 */
export type { DebugProtocol } from './debugProtocol.ts';
export { AbstractDebugAdapter, Emitter, StreamDebugAdapter } from './abstractDebugAdapter.ts';
export {
	DebugSession,
	type DebugAdapterDescriptor,
	type DebugConfiguration,
	type DebugSessionState
} from './debugSession.ts';
