/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ported from Void (Microsoft/vscode fork),
 * `src/vs/workbench/contrib/debug/common/debugProtocol.d.ts`.
 *
 * Trimmed from the full generated schema to what a Debug Adapter Protocol
 * *client* needs: the initialize handshake, launch/attach, breakpoint
 * management, execution control (continue/next/step/pause), the call-stack /
 * scope / variable reads, disconnect, and the events a session must react to.
 *
 * JSDoc preserved where it documents wire semantics a client must honor.
 * Types intentionally dropped (memory, disassembly, completions, data
 * breakpoints, modules view, restart-frame, reverse continue, goto, step-in
 * targets, exception options, locations, cancel, breakpoint locations):
 * re-add them from the upstream schema when a feature needs them.
 *
 * The original file is `declare module DebugProtocol` (ambient global); here
 * it is an exported, type-only namespace so Node code can import it.
 */
export namespace DebugProtocol {

	/** Base class of requests, responses, and events. */
	export interface ProtocolMessage {
		/** Sequence number of the message (also known as message ID). The `seq` for the first message sent by a client or debug adapter is 1, and for each subsequent message is 1 greater than the previous message sent by that actor. `seq` can be used to order requests, responses, and events, and to associate requests with their corresponding responses. For protocol messages of type `request` the sequence number can be used to cancel the request. */
		seq: number;
		/** Message type.
			Values: 'request', 'response', 'event', etc.
		*/
		type: 'request' | 'response' | 'event' | string;
	}

	/** A client or debug adapter initiated request. */
	export interface Request extends ProtocolMessage {
		// type: 'request';
		/** The command to execute. */
		command: string;
		/** Object containing arguments for the command. */
		arguments?: any;
	}

	/** A debug adapter initiated event. */
	export interface Event extends ProtocolMessage {
		// type: 'event';
		/** Type of event. */
		event: string;
		/** Event-specific information. */
		body?: any;
	}

	/** Response for a request. */
	export interface Response extends ProtocolMessage {
		// type: 'response';
		/** Sequence number of the corresponding request. */
		request_seq: number;
		/** Outcome of the request.
			If true, the request was successful and the `body` attribute may contain the result of the request.
			If the value is false, the attribute `message` contains the error in short form and the `body` may contain additional information (see `ErrorResponse.body.error`).
		*/
		success: boolean;
		/** The command requested. */
		command: string;
		/** Contains the raw error in short form if `success` is false.
			This raw error might be interpreted by the client and is not shown in the UI.
			Some predefined values exist.
			Values:
			'cancelled': the request was cancelled.
			'notStopped': the request may be retried once the adapter is in a 'stopped' state.
			etc.
		*/
		message?: 'cancelled' | 'notStopped' | string;
		/** Contains request result if success is true and error details if success is false. */
		body?: any;
	}

	/** On error (whenever `success` is false), the body can provide more details. */
	export interface ErrorResponse extends Response {
		body: {
			/** A structured error message. */
			error?: Message;
		};
	}

	/** A structured message object. Used to return errors from requests. */
	export interface Message {
		/** Unique (within a debug adapter implementation) identifier for the message. */
		id: number;
		/** A format string for the message. Embedded variables have the form `{name}`.
			If variable name starts with an underscore character, the variable does not contain user data (PII) and can be safely used for telemetry purposes.
		*/
		format: string;
		/** An object used as a dictionary for looking up the variables in the format string. */
		variables?: { [key: string]: string; };
		/** If true send to telemetry. */
		sendTelemetry?: boolean;
		/** If true show user. */
		showUser?: boolean;
		/** A url where additional information about this message can be found. */
		url?: string;
		/** A label that is presented to the user as the UI for opening the url. */
		urlLabel?: string;
	}

	/** Event message for 'initialized' event type.
		This event indicates that the debug adapter is ready to accept configuration requests (e.g. `setBreakpoints`, `setExceptionBreakpoints`).
		A debug adapter is expected to send this event when it is ready to accept configuration requests (but not before the `initialize` request has finished).
		The sequence of events/requests is as follows:
		- adapters sends `initialized` event (after the `initialize` request has returned)
		- client sends zero or more `setBreakpoints` requests
		- client sends other future configuration requests
		- client sends one `configurationDone` request to indicate the end of the configuration.
	*/
	export interface InitializedEvent extends Event {
		// event: 'initialized';
	}

	/** Event message for 'stopped' event type.
		The event indicates that the execution of the debuggee has stopped due to some condition.
		This can be caused by a breakpoint previously set, a stepping request has completed, by executing a debugger statement etc.
	*/
	export interface StoppedEvent extends Event {
		// event: 'stopped';
		body: {
			/** The reason for the event.
				For backward compatibility this string is shown in the UI if the `description` attribute is missing (but it must not be translated).
				Values: 'step', 'breakpoint', 'exception', 'pause', 'entry', 'goto', 'function breakpoint', 'data breakpoint', 'instruction breakpoint', etc.
			*/
			reason: 'step' | 'breakpoint' | 'exception' | 'pause' | 'entry' | 'goto' | 'function breakpoint' | 'data breakpoint' | 'instruction breakpoint' | string;
			/** The full reason for the event, e.g. 'Paused on exception'. This string is shown in the UI as is and can be translated. */
			description?: string;
			/** The thread which was stopped. */
			threadId?: number;
			/** A value of true hints to the client that this event should not change the focus. */
			preserveFocusHint?: boolean;
			/** Additional information. E.g. if reason is `exception`, text contains the exception name. This string is shown in the UI. */
			text?: string;
			/** If `allThreadsStopped` is true, a debug adapter can announce that all threads have stopped.
				- The client should use this information to enable that all threads can be expanded to access their stacktraces.
				- If the attribute is missing or false, only the thread with the given `threadId` can be expanded.
			*/
			allThreadsStopped?: boolean;
			/** Ids of the breakpoints that triggered the event. */
			hitBreakpointIds?: number[];
		};
	}

	/** Event message for 'continued' event type.
		The event indicates that the execution of the debuggee has continued.
		Please note: a debug adapter is not expected to send this event in response to a request that implies that execution continues, e.g. `launch` or `continue`.
		It is only necessary to send a `continued` event if there was no previous request that implied this.
	*/
	export interface ContinuedEvent extends Event {
		// event: 'continued';
		body: {
			/** The thread which was continued. */
			threadId: number;
			/** If `allThreadsContinued` is true, a debug adapter can announce that all threads have continued. */
			allThreadsContinued?: boolean;
		};
	}

	/** Event message for 'exited' event type.
		The event indicates that the debuggee has exited and returns its exit code.
	*/
	export interface ExitedEvent extends Event {
		// event: 'exited';
		body: {
			/** The exit code returned from the debuggee. */
			exitCode: number;
		};
	}

	/** Event message for 'terminated' event type.
		The event indicates that debugging of the debuggee has terminated. This does **not** mean that the debuggee itself has exited.
	*/
	export interface TerminatedEvent extends Event {
		// event: 'terminated';
		body?: {
			/** A debug adapter may set `restart` to true (or to an arbitrary object) to request that the client restarts the session.
				The value is not interpreted by the client and passed unmodified as an attribute `__restart` to the `launch` and `attach` requests.
			*/
			restart?: any;
		};
	}

	/** Event message for 'thread' event type.
		The event indicates that a thread has started or exited.
	*/
	export interface ThreadEvent extends Event {
		// event: 'thread';
		body: {
			/** The reason for the event.
				Values: 'started', 'exited', etc.
			*/
			reason: 'started' | 'exited' | string;
			/** The identifier of the thread. */
			threadId: number;
		};
	}

	/** Event message for 'output' event type.
		The event indicates that the target has produced some output.
	*/
	export interface OutputEvent extends Event {
		// event: 'output';
		body: {
			/** The output category. If not specified or if the category is not understood by the client, `console` is assumed.
				Values:
				'console': Show the output in the client's default message UI, e.g. a 'debug console'.
				'important': A hint for the client to show the output in the client's UI for important and highly visible information.
				'stdout': Show the output as normal program output from the debuggee.
				'stderr': Show the output as error program output from the debuggee.
				'telemetry': Send the output to telemetry instead of showing it to the user.
				etc.
			*/
			category?: 'console' | 'important' | 'stdout' | 'stderr' | 'telemetry' | string;
			/** The output to report. */
			output: string;
			/** Support for keeping an output log organized by grouping related messages.
				'start': Start a new group in expanded mode.
				'startCollapsed': Start a new group in collapsed mode.
				'end': End the current group and decrease the indentation of subsequent output events.
			*/
			group?: 'start' | 'startCollapsed' | 'end';
			/** If an attribute `variablesReference` exists and its value is > 0, the output contains objects which can be retrieved by passing `variablesReference` to the `variables` request as long as execution remains suspended. */
			variablesReference?: number;
			/** The source location where the output was produced. */
			source?: Source;
			/** The source location's line where the output was produced. */
			line?: number;
			/** The position in `line` where the output was produced. */
			column?: number;
			/** Additional data to report. */
			data?: any;
		};
	}

	/** Event message for 'breakpoint' event type.
		The event indicates that some information about a breakpoint has changed.
	*/
	export interface BreakpointEvent extends Event {
		// event: 'breakpoint';
		body: {
			/** The reason for the event.
				Values: 'changed', 'new', 'removed', etc.
			*/
			reason: 'changed' | 'new' | 'removed' | string;
			/** The `id` attribute is used to find the target breakpoint, the other attributes are used as the new values. */
			breakpoint: Breakpoint;
		};
	}

	/** Event message for 'loadedSource' event type.
		The event indicates that some source has been added, changed, or removed from the set of all loaded sources.
	*/
	export interface LoadedSourceEvent extends Event {
		// event: 'loadedSource';
		body: {
			/** The reason for the event. */
			reason: 'new' | 'changed' | 'removed';
			/** The new, changed, or removed source. */
			source: Source;
		};
	}

	/** Event message for 'process' event type.
		The event indicates that the debugger has begun debugging a new process. Either one that it has launched, or one that it has attached to.
	*/
	export interface ProcessEvent extends Event {
		// event: 'process';
		body: {
			/** The logical name of the process. This is usually the full path to process's executable file. */
			name: string;
			/** The process ID of the debugged process, as assigned by the operating system. */
			systemProcessId?: number;
			/** If true, the process is running on the same computer as the debug adapter. */
			isLocalProcess?: boolean;
			/** Describes how the debug engine started debugging this process.
				'launch': Process was launched under the debugger.
				'attach': Debugger attached to an existing process.
				'attachForSuspendedLaunch': A project launcher component has launched a new process in a suspended state and then asked the debugger to attach.
			*/
			startMethod?: 'launch' | 'attach' | 'attachForSuspendedLaunch';
			/** The size of a pointer or address for this process, in bits. */
			pointerSize?: number;
		};
	}

	/** Initialize request; value of command field is 'initialize'.
		The `initialize` request is sent as the first request from the client to the debug adapter in order to configure it with client capabilities and to retrieve capabilities from the debug adapter.
		Until the debug adapter has responded with an `initialize` response, the client must not send any additional requests or events to the debug adapter.
		In addition the debug adapter is not allowed to send any requests or events to the client until it has responded with an `initialize` response.
		The `initialize` request may only be sent once.
	*/
	export interface InitializeRequest extends Request {
		// command: 'initialize';
		arguments: InitializeRequestArguments;
	}

	/** Arguments for `initialize` request. */
	export interface InitializeRequestArguments {
		/** The ID of the client using this adapter. */
		clientID?: string;
		/** The human-readable name of the client using this adapter. */
		clientName?: string;
		/** The ID of the debug adapter. */
		adapterID: string;
		/** The ISO-639 locale of the client using this adapter, e.g. en-US or de-CH. */
		locale?: string;
		/** If true all line numbers are 1-based (default). */
		linesStartAt1?: boolean;
		/** If true all column numbers are 1-based (default). */
		columnsStartAt1?: boolean;
		/** Determines in what format paths are specified. The default is `path`, which is the native format.
			Values: 'path', 'uri', etc.
		*/
		pathFormat?: 'path' | 'uri' | string;
		/** Client supports the `type` attribute for variables. */
		supportsVariableType?: boolean;
		/** Client supports the paging of variables. */
		supportsVariablePaging?: boolean;
	}

	/** Response to `initialize` request. */
	export interface InitializeResponse extends Response {
		/** The capabilities of this debug adapter. */
		body?: Capabilities;
	}

	/** ConfigurationDone request; value of command field is 'configurationDone'.
		This request indicates that the client has finished initialization of the debug adapter.
		So it is the last request in the sequence of configuration requests (which was started by the `initialized` event).
		Clients should only call this request if the corresponding capability `supportsConfigurationDoneRequest` is true.
	*/
	export interface ConfigurationDoneRequest extends Request {
		// command: 'configurationDone';
		arguments?: {};
	}

	/** Response to `configurationDone` request. This is just an acknowledgement, so no body field is required. */
	export interface ConfigurationDoneResponse extends Response {
	}

	/** Launch request; value of command field is 'launch'.
		This launch request is sent from the client to the debug adapter to start the debuggee with or without debugging (if `noDebug` is true).
		Since launching is debugger/runtime specific, the arguments for this request are not part of this specification.
	*/
	export interface LaunchRequest extends Request {
		// command: 'launch';
		arguments: LaunchRequestArguments;
	}

	/** Arguments for `launch` request. Additional attributes are implementation specific. */
	export interface LaunchRequestArguments {
		/** If true, the launch request should launch the program without enabling debugging. */
		noDebug?: boolean;
		/** Arbitrary data from the previous, restarted session.
			The data is sent as the `restart` attribute of the `terminated` event.
			The client should leave the data intact.
		*/
		__restart?: any;
		[key: string]: any;
	}

	/** Response to `launch` request. This is just an acknowledgement, so no body field is required. */
	export interface LaunchResponse extends Response {
	}

	/** Attach request; value of command field is 'attach'.
		The `attach` request is sent from the client to the debug adapter to attach to a debuggee that is already running.
		Since attaching is debugger/runtime specific, the arguments for this request are not part of this specification.
	*/
	export interface AttachRequest extends Request {
		// command: 'attach';
		arguments: AttachRequestArguments;
	}

	/** Arguments for `attach` request. Additional attributes are implementation specific. */
	export interface AttachRequestArguments {
		/** Arbitrary data from the previous, restarted session.
			The data is sent as the `restart` attribute of the `terminated` event.
			The client should leave the data intact.
		*/
		__restart?: any;
		[key: string]: any;
	}

	/** Response to `attach` request. This is just an acknowledgement, so no body field is required. */
	export interface AttachResponse extends Response {
	}

	/** Disconnect request; value of command field is 'disconnect'.
		The `disconnect` request asks the debug adapter to disconnect from the debuggee (thus ending the debug session) and then to shut down itself (the debug adapter).
		In addition, the debug adapter must terminate the debuggee if it was started with the `launch` request. If an `attach` request was used to connect to the debuggee, then the debug adapter must not terminate the debuggee.
		This implicit behavior of when to terminate the debuggee can be overridden with the `terminateDebuggee` argument (which is only supported by a debug adapter if the corresponding capability `supportTerminateDebuggee` is true).
	*/
	export interface DisconnectRequest extends Request {
		// command: 'disconnect';
		arguments?: DisconnectArguments;
	}

	/** Arguments for `disconnect` request. */
	export interface DisconnectArguments {
		/** A value of true indicates that this `disconnect` request is part of a restart sequence. */
		restart?: boolean;
		/** Indicates whether the debuggee should be terminated when the debugger is disconnected.
			If unspecified, the debug adapter is free to do whatever it thinks is best.
			The attribute is only honored by a debug adapter if the corresponding capability `supportTerminateDebuggee` is true.
		*/
		terminateDebuggee?: boolean;
		/** Indicates whether the debuggee should stay stopped when the debugger is disconnected.
			If unspecified, the debuggee should resume execution.
			The attribute is only honored by a debug adapter if the corresponding capability `supportSuspendDebuggee` is true.
		*/
		suspendDebuggee?: boolean;
	}

	/** Response to `disconnect` request. This is just an acknowledgement, so no body field is required. */
	export interface DisconnectResponse extends Response {
	}

	/** SetBreakpoints request; value of command field is 'setBreakpoints'.
		Sets multiple breakpoints for a single source and clears all previous breakpoints in that source.
		To clear all breakpoint for a source, specify an empty array.
		When a breakpoint is hit, a `stopped` event (with reason `breakpoint`) is generated.
	*/
	export interface SetBreakpointsRequest extends Request {
		// command: 'setBreakpoints';
		arguments: SetBreakpointsArguments;
	}

	/** Arguments for `setBreakpoints` request. */
	export interface SetBreakpointsArguments {
		/** The source location of the breakpoints; either `source.path` or `source.sourceReference` must be specified. */
		source: Source;
		/** The code locations of the breakpoints. */
		breakpoints?: SourceBreakpoint[];
		/** Deprecated: The code locations of the breakpoints. */
		lines?: number[];
		/** A value of true indicates that the underlying source has been modified which results in new breakpoint locations. */
		sourceModified?: boolean;
	}

	/** Response to `setBreakpoints` request.
		Returned is information about each breakpoint created by this request.
		This includes the actual code location and whether the breakpoint could be verified.
		The breakpoints returned are in the same order as the elements of the `breakpoints`
		(or the deprecated `lines`) array in the arguments.
	*/
	export interface SetBreakpointsResponse extends Response {
		body: {
			/** Information about the breakpoints.
				The array elements are in the same order as the elements of the `breakpoints` (or the deprecated `lines`) array in the arguments.
			*/
			breakpoints: Breakpoint[];
		};
	}

	/** Continue request; value of command field is 'continue'.
		The request resumes execution of all threads. If the debug adapter supports single thread execution (see capability `supportsSingleThreadExecutionRequests`), setting the `singleThread` argument to true resumes only the specified thread. If not all threads were resumed, the `allThreadsContinued` attribute of the response should be set to false.
	*/
	export interface ContinueRequest extends Request {
		// command: 'continue';
		arguments: ContinueArguments;
	}

	/** Arguments for `continue` request. */
	export interface ContinueArguments {
		/** Specifies the active thread. If the debug adapter supports single thread execution (see `supportsSingleThreadExecutionRequests`) and the argument `singleThread` is true, only the thread with this ID is resumed. */
		threadId: number;
		/** If this flag is true, execution is resumed only for the thread with given `threadId`. */
		singleThread?: boolean;
	}

	/** Response to `continue` request. */
	export interface ContinueResponse extends Response {
		body: {
			/** The value true (or a missing property) signals to the client that all threads have been resumed. The value false indicates that not all threads were resumed. */
			allThreadsContinued?: boolean;
		};
	}

	/** Next request; value of command field is 'next'.
		The request executes one step (in the given granularity) for the specified thread and allows all other threads to run freely by resuming them.
		The debug adapter first sends the response and then a `stopped` event (with reason `step`) after the step has completed.
	*/
	export interface NextRequest extends Request {
		// command: 'next';
		arguments: NextArguments;
	}

	/** Arguments for `next` request. */
	export interface NextArguments {
		/** Specifies the thread for which to resume execution for one step (of the given granularity). */
		threadId: number;
		/** If this flag is true, all other suspended threads are not resumed. */
		singleThread?: boolean;
		/** Stepping granularity. If no granularity is specified, a granularity of `statement` is assumed. */
		granularity?: SteppingGranularity;
	}

	/** Response to `next` request. This is just an acknowledgement, so no body field is required. */
	export interface NextResponse extends Response {
	}

	/** StepIn request; value of command field is 'stepIn'.
		The request resumes the given thread to step into a function/method and allows all other threads to run freely by resuming them.
		If the request cannot step into a target, `stepIn` behaves like the `next` request.
		The debug adapter first sends the response and then a `stopped` event (with reason `step`) after the step has completed.
	*/
	export interface StepInRequest extends Request {
		// command: 'stepIn';
		arguments: StepInArguments;
	}

	/** Arguments for `stepIn` request. */
	export interface StepInArguments {
		/** Specifies the thread for which to resume execution for one step-into (of the given granularity). */
		threadId: number;
		/** If this flag is true, all other suspended threads are not resumed. */
		singleThread?: boolean;
		/** Stepping granularity. If no granularity is specified, a granularity of `statement` is assumed. */
		granularity?: SteppingGranularity;
	}

	/** Response to `stepIn` request. This is just an acknowledgement, so no body field is required. */
	export interface StepInResponse extends Response {
	}

	/** StepOut request; value of command field is 'stepOut'.
		The request resumes the given thread to step out (return) from a function/method and allows all other threads to run freely by resuming them.
		The debug adapter first sends the response and then a `stopped` event (with reason `step`) after the step has completed.
	*/
	export interface StepOutRequest extends Request {
		// command: 'stepOut';
		arguments: StepOutArguments;
	}

	/** Arguments for `stepOut` request. */
	export interface StepOutArguments {
		/** Specifies the thread for which to resume execution for one step-out (of the given granularity). */
		threadId: number;
		/** If this flag is true, all other suspended threads are not resumed. */
		singleThread?: boolean;
		/** Stepping granularity. If no granularity is specified, a granularity of `statement` is assumed. */
		granularity?: SteppingGranularity;
	}

	/** Response to `stepOut` request. This is just an acknowledgement, so no body field is required. */
	export interface StepOutResponse extends Response {
	}

	/** Pause request; value of command field is 'pause'.
		The request suspends the debuggee.
		The debug adapter first sends the response and then a `stopped` event (with reason `pause`) after the thread has been paused successfully.
	*/
	export interface PauseRequest extends Request {
		// command: 'pause';
		arguments: PauseArguments;
	}

	/** Arguments for `pause` request. */
	export interface PauseArguments {
		/** Pause execution for this thread. */
		threadId: number;
	}

	/** Response to `pause` request. This is just an acknowledgement, so no body field is required. */
	export interface PauseResponse extends Response {
	}

	/** Threads request; value of command field is 'threads'.
		The request retrieves a list of all threads.
	*/
	export interface ThreadsRequest extends Request {
		// command: 'threads';
	}

	/** Response to `threads` request. */
	export interface ThreadsResponse extends Response {
		body: {
			/** All threads. */
			threads: Thread[];
		};
	}

	/** StackTrace request; value of command field is 'stackTrace'.
		The request returns a stacktrace from the current execution state of a given thread.
		A client can request all stack frames by omitting the startFrame and levels arguments.
	*/
	export interface StackTraceRequest extends Request {
		// command: 'stackTrace';
		arguments: StackTraceArguments;
	}

	/** Arguments for `stackTrace` request. */
	export interface StackTraceArguments {
		/** Retrieve the stacktrace for this thread. */
		threadId: number;
		/** The index of the first frame to return; if omitted frames start at 0. */
		startFrame?: number;
		/** The maximum number of frames to return. If levels is not specified or 0, all frames are returned. */
		levels?: number;
		/** Specifies details on how to format the stack frames. */
		format?: StackFrameFormat;
	}

	/** Response to `stackTrace` request. */
	export interface StackTraceResponse extends Response {
		body: {
			/** The frames of the stack frame. If the array has length zero, there are no stack frames available.
				This means that there is no location information available.
			*/
			stackFrames: StackFrame[];
			/** The total number of frames available in the stack. */
			totalFrames?: number;
		};
	}

	/** Scopes request; value of command field is 'scopes'.
		The request returns the variable scopes for a given stack frame ID.
	*/
	export interface ScopesRequest extends Request {
		// command: 'scopes';
		arguments: ScopesArguments;
	}

	/** Arguments for `scopes` request. */
	export interface ScopesArguments {
		/** Retrieve the scopes for the stack frame identified by `frameId`. The `frameId` must have been obtained in the current suspended state. */
		frameId: number;
	}

	/** Response to `scopes` request. */
	export interface ScopesResponse extends Response {
		body: {
			/** The scopes of the stack frame. If the array has length zero, there are no scopes available. */
			scopes: Scope[];
		};
	}

	/** Variables request; value of command field is 'variables'.
		Retrieves all child variables for the given variable reference.
		A filter can be used to limit the fetched children to either named or indexed children.
	*/
	export interface VariablesRequest extends Request {
		// command: 'variables';
		arguments: VariablesArguments;
	}

	/** Arguments for `variables` request. */
	export interface VariablesArguments {
		/** The variable for which to retrieve its children. The `variablesReference` must have been obtained in the current suspended state. */
		variablesReference: number;
		/** Filter to limit the child variables to either named or indexed. If omitted, both types are fetched. */
		filter?: 'indexed' | 'named';
		/** The index of the first variable to return; if omitted children start at 0. */
		start?: number;
		/** The number of variables to return. If count is missing or 0, all variables are returned. */
		count?: number;
		/** Specifies details on how to format the Variable values. */
		format?: ValueFormat;
	}

	/** Response to `variables` request. */
	export interface VariablesResponse extends Response {
		body: {
			/** All (or a range) of variables for the given variable reference. */
			variables: Variable[];
		};
	}

	/** LoadedSources request; value of command field is 'loadedSources'.
		Retrieves the set of all sources currently loaded by the debugged process.
		Clients should only call this request if the corresponding capability `supportsLoadedSourcesRequest` is true.
	*/
	export interface LoadedSourcesRequest extends Request {
		// command: 'loadedSources';
		arguments?: {};
	}

	/** Response to `loadedSources` request. */
	export interface LoadedSourcesResponse extends Response {
		body: {
			/** Set of loaded sources. */
			sources: Source[];
		};
	}

	/** Information about the capabilities of a debug adapter. Trimmed to the
		flags this client actually consults; the upstream schema lists the rest. */
	export interface Capabilities {
		/** The debug adapter supports the `configurationDone` request. */
		supportsConfigurationDoneRequest?: boolean;
		/** The debug adapter supports conditional breakpoints. */
		supportsConditionalBreakpoints?: boolean;
		/** The debug adapter supports breakpoints that break execution after a specified number of hits. */
		supportsHitConditionalBreakpoints?: boolean;
		/** The debug adapter supports setting a variable to a value. */
		supportsSetVariable?: boolean;
		/** The debug adapter supports the `restart` request. */
		supportsRestartRequest?: boolean;
		/** The debug adapter supports a `format` attribute on the `stackTrace`, `variables`, and `evaluate` requests. */
		supportsValueFormattingOptions?: boolean;
		/** The debug adapter supports the `terminateDebuggee` attribute on the `disconnect` request. */
		supportTerminateDebuggee?: boolean;
		/** The debug adapter supports the `suspendDebuggee` attribute on the `disconnect` request. */
		supportSuspendDebuggee?: boolean;
		/** The debug adapter supports the delayed loading of parts of the stack. */
		supportsDelayedStackTraceLoading?: boolean;
		/** The debug adapter supports the `loadedSources` request. */
		supportsLoadedSourcesRequest?: boolean;
		/** The debug adapter supports log points by interpreting the `logMessage` attribute of the `SourceBreakpoint`. */
		supportsLogPoints?: boolean;
		/** The debug adapter supports the `singleThread` property on the execution requests. */
		supportsSingleThreadExecutionRequests?: boolean;
	}

	/** A Thread */
	export interface Thread {
		/** Unique identifier for the thread. */
		id: number;
		/** The name of the thread. */
		name: string;
	}

	/** A `Source` is a descriptor for source code.
		It is returned from the debug adapter as part of a `StackFrame` and it is used by clients when specifying breakpoints.
	*/
	export interface Source {
		/** The short name of the source. Every source returned from the debug adapter has a name.
			When sending a source to the debug adapter this name is optional.
		*/
		name?: string;
		/** The path of the source to be shown in the UI.
			It is only used to locate and load the content of the source if no `sourceReference` is specified (or its value is 0).
		*/
		path?: string;
		/** If the value > 0 the contents of the source must be retrieved through the `source` request (even if a path is specified).
			Since a `sourceReference` is only valid for a session, it can not be used to persist a source.
		*/
		sourceReference?: number;
		/** A hint for how to present the source in the UI.
			A value of `deemphasize` can be used to indicate that the source is not available or that it is skipped on stepping.
		*/
		presentationHint?: 'normal' | 'emphasize' | 'deemphasize';
		/** The origin of this source. For example, 'internal module', 'inlined content from source map', etc. */
		origin?: string;
		/** A list of sources that are related to this source. These may be the source that generated this source. */
		sources?: Source[];
		/** Additional data that a debug adapter might want to loop through the client.
			The client should leave the data intact and persist it across sessions. The client should not interpret the data.
		*/
		adapterData?: any;
	}

	/** A Stackframe contains the source location. */
	export interface StackFrame {
		/** An identifier for the stack frame. It must be unique across all threads.
			This id can be used to retrieve the scopes of the frame with the `scopes` request.
		*/
		id: number;
		/** The name of the stack frame, typically a method name. */
		name: string;
		/** The source of the frame. */
		source?: Source;
		/** The line within the source of the frame. If the source attribute is missing or doesn't exist, `line` is 0 and should be ignored by the client. */
		line: number;
		/** Start position of the range covered by the stack frame. */
		column: number;
		/** The end line of the range covered by the stack frame. */
		endLine?: number;
		/** End position of the range covered by the stack frame. */
		endColumn?: number;
		/** Indicates whether this frame can be restarted with the `restartFrame` request. */
		canRestart?: boolean;
		/** The module associated with this frame, if any. */
		moduleId?: number | string;
		/** A hint for how to present this frame in the UI.
			A value of `label` can be used to indicate that the frame is an artificial frame that is used as a visual label or separator. A value of `subtle` can be used to change the appearance of a frame in a 'subtle' way.
		*/
		presentationHint?: 'normal' | 'label' | 'subtle';
	}

	/** A `Scope` is a named container for variables. Optionally a scope can map to a source or a range within a source. */
	export interface Scope {
		/** Name of the scope such as 'Arguments', 'Locals', or 'Registers'. This string is shown in the UI as is and can be translated. */
		name: string;
		/** A hint for how to present this scope in the UI. If this attribute is missing, the scope is shown with a generic UI.
			Values:
			'arguments': Scope contains method arguments.
			'locals': Scope contains local variables.
			'registers': Scope contains registers. Only a single `registers` scope should be returned from a `scopes` request.
			etc.
		*/
		presentationHint?: 'arguments' | 'locals' | 'registers' | 'returnValue' | string;
		/** The variables of this scope can be retrieved by passing the value of `variablesReference` to the `variables` request as long as execution remains suspended. */
		variablesReference: number;
		/** The number of named variables in this scope. */
		namedVariables?: number;
		/** The number of indexed variables in this scope. */
		indexedVariables?: number;
		/** If true, the number of variables in this scope is large or expensive to retrieve. */
		expensive: boolean;
		/** The source for this scope. */
		source?: Source;
		/** The start line of the range covered by this scope. */
		line?: number;
		/** Start position of the range covered by the scope. */
		column?: number;
		/** The end line of the range covered by this scope. */
		endLine?: number;
		/** End position of the range covered by the scope. */
		endColumn?: number;
	}

	/** A Variable is a name/value pair.
		If the value is structured (has children), a handle is provided to retrieve the children with the `variables` request.
	*/
	export interface Variable {
		/** The variable's name. */
		name: string;
		/** The variable's value.
			This can be a multi-line text, e.g. for a function the body of a function.
			An empty string can be used if no value should be shown in the UI.
		*/
		value: string;
		/** The type of the variable's value. Typically shown in the UI when hovering over the value. */
		type?: string;
		/** Properties of a variable that can be used to determine how to render the variable in the UI. */
		presentationHint?: VariablePresentationHint;
		/** The evaluatable name of this variable which can be passed to the `evaluate` request to fetch the variable's value. */
		evaluateName?: string;
		/** If `variablesReference` is > 0, the variable is structured and its children can be retrieved by passing `variablesReference` to the `variables` request as long as execution remains suspended. */
		variablesReference: number;
		/** The number of named child variables. */
		namedVariables?: number;
		/** The number of indexed child variables. */
		indexedVariables?: number;
	}

	/** Properties of a variable that can be used to determine how to render the variable in the UI. */
	export interface VariablePresentationHint {
		/** The kind of variable. Before introducing additional values, try to use the listed values.
			Values:
			'property', 'method', 'class', 'data', 'event', 'baseClass', 'innerClass', 'interface', 'mostDerivedClass', 'virtual', 'dataBreakpoint', etc.
		*/
		kind?: 'property' | 'method' | 'class' | 'data' | 'event' | 'baseClass' | 'innerClass' | 'interface' | 'mostDerivedClass' | 'virtual' | 'dataBreakpoint' | string;
		/** Set of attributes represented as an array of strings. Before introducing additional values, try to use the listed values.
			Values:
			'static', 'constant', 'readOnly', 'rawString', 'hasObjectId', 'canHaveObjectId', 'hasSideEffects', 'hasDataBreakpoint', etc.
		*/
		attributes?: ('static' | 'constant' | 'readOnly' | 'rawString' | 'hasObjectId' | 'canHaveObjectId' | 'hasSideEffects' | 'hasDataBreakpoint' | string)[];
		/** Visibility of variable. Before introducing additional values, try to use the listed values.
			Values: 'public', 'private', 'protected', 'internal', 'final', etc.
		*/
		visibility?: 'public' | 'private' | 'protected' | 'internal' | 'final' | string;
		/** If true, clients can present the variable with a UI that supports a specific gesture to trigger its evaluation. */
		lazy?: boolean;
	}

	/** Properties of a breakpoint or logpoint passed to the `setBreakpoints` request. */
	export interface SourceBreakpoint {
		/** The source line of the breakpoint or logpoint. */
		line: number;
		/** Start position within source line of the breakpoint or logpoint. */
		column?: number;
		/** The expression for conditional breakpoints.
			It is only honored by a debug adapter if the corresponding capability `supportsConditionalBreakpoints` is true.
		*/
		condition?: string;
		/** The expression that controls how many hits of the breakpoint are ignored.
			The attribute is only honored by a debug adapter if the corresponding capability `supportsHitConditionalBreakpoints` is true.
		*/
		hitCondition?: string;
		/** If this attribute exists and is non-empty, the debug adapter must not 'break' (stop) but log the message instead.
			The attribute is only honored by a debug adapter if the corresponding capability `supportsLogPoints` is true.
		*/
		logMessage?: string;
	}

	/** Information about a breakpoint created in `setBreakpoints` requests. */
	export interface Breakpoint {
		/** The identifier for the breakpoint. It is needed if breakpoint events are used to update or remove breakpoints. */
		id?: number;
		/** If true, the breakpoint could be set (but not necessarily at the desired location). */
		verified: boolean;
		/** A message about the state of the breakpoint.
			This is shown to the user and can be used to explain why a breakpoint could not be verified.
		*/
		message?: string;
		/** The source where the breakpoint is located. */
		source?: Source;
		/** The start line of the actual range covered by the breakpoint. */
		line?: number;
		/** Start position of the source range covered by the breakpoint. */
		column?: number;
		/** The end line of the actual range covered by the breakpoint. */
		endLine?: number;
		/** End position of the source range covered by the breakpoint. */
		endColumn?: number;
		/** A machine-readable explanation of why a breakpoint may not be verified. */
		reason?: 'pending' | 'failed';
	}

	/** The granularity of one 'step' in the stepping requests `next`, `stepIn`, `stepOut`, and `stepBack`.
		'statement': The step should allow the program to run until the current statement has finished executing.
		'line': The step should allow the program to run until the current source line has executed.
		'instruction': The step should allow one instruction to execute (e.g. one x86 instruction).
	*/
	export type SteppingGranularity = 'statement' | 'line' | 'instruction';

	/** Provides formatting information for a value. */
	export interface ValueFormat {
		/** Display the value in hex. */
		hex?: boolean;
	}

	/** Provides formatting information for a stack frame. */
	export interface StackFrameFormat extends ValueFormat {
		/** Displays parameters for the stack frame. */
		parameters?: boolean;
		/** Displays the types of parameters for the stack frame. */
		parameterTypes?: boolean;
		/** Displays the names of parameters for the stack frame. */
		parameterNames?: boolean;
		/** Displays the values of parameters for the stack frame. */
		parameterValues?: boolean;
		/** Displays the line number of the stack frame. */
		line?: boolean;
		/** Displays the module of the stack frame. */
		module?: boolean;
		/** Includes all stack frames, including those the debug adapter might otherwise hide. */
		includeAll?: boolean;
	}
}
