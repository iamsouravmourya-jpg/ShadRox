/**
 * Copyright 2025 Cline contributors (https://github.com/cline/cline)
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * ---------------------------------------------------------------------------
 * Ported / adapted from Cline, Apache-2.0:
 *   reference/cline-main/sdk/packages/core/src/extensions/tools/executors/
 *     apply-patch.ts        — splitPatchInputLines, isWrapperLine,
 *                             trimWrapperLines, normalizePatchInput,
 *                             extractFilesForOperations, applyChunks,
 *                             patchToChanges, formatSkippedHunkFailure,
 *                             computePatchChanges.
 *     line-endings.ts       — detectLineEnding, normalizeLineEndings,
 *                             normalizeNewFileLineEndings.
 *
 * ShadRox adaptations (this module never touches the filesystem):
 *  - computePatchChanges() becomes computeClinePatchChanges(): current file
 *    contents arrive as a caller-supplied map instead of fs.readFile, and the
 *    cwd / restrictToCwd path resolution is rejected outright (paths are
 *    workspace-relative; the disk-landing layer that owns path safety is
 *    atomicApply + electron/workspace.cjs).
 *  - normalizeNewFileLineEndings(): node:os is unavailable in the renderer, so
 *    the Windows check reads process.platform / the user agent instead of
 *    os.EOL.
 *  - NEW, ShadRox-authored (not Cline): parseClinePatchSections() +
 *    clineSectionsToPatches() convert a patch into SEARCH/REPLACE blocks so
 *    the existing anchor-verification pipeline (patchEngine.locateBlock ->
 *    atomicApply zero-byte refusal) does the positioning. Cline positions
 *    hunks itself with fuzz and then writes; ShadRox may only narrow
 *    candidates, never place an unverified edit, so the fuzz findContext()
 *    machinery stays behind computeClinePatchChanges (an explicit seam for a
 *    future human-reviewed apply path) and is NOT used by auto-apply.
 * ---------------------------------------------------------------------------
 */

import {
	BASH_WRAPPERS,
	DiffError,
	PATCH_MARKERS,
	PatchActionType,
	PatchParser,
	peek,
	type PatchChunk,
	type PatchWarning,
} from "./clinePatchParser";

/* -------------------------------------------------------------------------- *
 * line-endings.ts (ported; node:os replaced by a renderer-safe platform check)
 * -------------------------------------------------------------------------- */

export type LineEnding = "\r\n" | "\n";

/** Returns "\r\n" if "\r\n" appears anywhere in the content, otherwise "\n". */
export function detectLineEnding(content: string): LineEnding {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeLineEndings(text: string, eol: LineEnding): string {
	return text.split(/\r\n|\n/).join(eol);
}

function isWindowsRuntime(): boolean {
	const proc = (globalThis as { process?: { platform?: string } }).process;
	if (proc && typeof proc.platform === "string") {
		return proc.platform === "win32";
	}
	const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
	return /win/i.test(nav?.platform ?? nav?.userAgent ?? "");
}

/**
 * New files have no EOL to preserve: use CRLF on Windows unless the content
 * already contains a "\r" and thereby chose its own endings
 * (github.com/cline/cline/issues/13504). No-op on LF platforms.
 */
export function normalizeNewFileLineEndings(content: string): string {
	if (isWindowsRuntime() && !content.includes("\r")) {
		return content.replaceAll("\n", "\r\n");
	}
	return content;
}

/* -------------------------------------------------------------------------- *
 * apply-patch.ts input normalisation (ported line-for-line)
 * -------------------------------------------------------------------------- */

function splitPatchInputLines(input: string): string[] {
	return input.split("\n").map((line) => line.replace(/\r$/, ""));
}

function isWrapperLine(line: string): boolean {
	if (line.trim() === "") {
		return false;
	}
	return BASH_WRAPPERS.some((wrapper) => line.startsWith(wrapper));
}

function trimWrapperLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && isWrapperLine(lines[start] ?? "")) {
		start++;
	}

	while (end > start && isWrapperLine(lines[end - 1] ?? "")) {
		end--;
	}

	return lines.slice(start, end);
}

export function normalizePatchInput(input: string): { lines: string[] } {
	const rawLines = splitPatchInputLines(input);
	const beginIndex = rawLines.findIndex((line) =>
		line.startsWith(PATCH_MARKERS.BEGIN),
	);
	let endIndex = -1;
	for (let i = rawLines.length - 1; i >= 0; i--) {
		if (rawLines[i]?.startsWith(PATCH_MARKERS.END)) {
			endIndex = i;
			break;
		}
	}

	if (beginIndex !== -1 || endIndex !== -1) {
		if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
			throw new DiffError(
				"Invalid patch text - incomplete sentinels. Try breaking it into smaller patches.",
			);
		}
		const lines = rawLines.slice(beginIndex, endIndex + 1);
		return {
			lines,
		};
	}

	const stripped = trimWrapperLines(rawLines);
	while (stripped.length > 0 && stripped[0] === "") {
		stripped.shift();
	}
	while (stripped.length > 0 && stripped[stripped.length - 1] === "") {
		stripped.pop();
	}

	const lines = [PATCH_MARKERS.BEGIN, ...stripped, PATCH_MARKERS.END];
	return { lines };
}

function extractFilesForOperations(
	lines: readonly string[],
	markers: readonly string[],
): string[] {
	const files = new Set<string>();

	for (const line of lines) {
		for (const marker of markers) {
			if (line.startsWith(marker)) {
				files.add(line.substring(marker.length).trim());
				break;
			}
		}
	}

	return [...files];
}

/* -------------------------------------------------------------------------- *
 * applyChunks / patchToChanges / failure format (ported line-for-line)
 * -------------------------------------------------------------------------- */

export function applyChunks(
	content: string,
	chunks: PatchChunk[],
	filePath: string,
): string {
	if (chunks.length === 0) {
		return content;
	}

	const lines = content.split("\n");
	const result: string[] = [];
	let currentIndex = 0;

	for (const chunk of chunks) {
		if (chunk.origIndex > lines.length) {
			throw new DiffError(
				`${filePath}: chunk.origIndex ${chunk.origIndex} > lines.length ${lines.length}`,
			);
		}
		if (currentIndex > chunk.origIndex) {
			throw new DiffError(
				`${filePath}: currentIndex ${currentIndex} > chunk.origIndex ${chunk.origIndex}`,
			);
		}
		result.push(...lines.slice(currentIndex, chunk.origIndex));
		result.push(...chunk.insLines);
		currentIndex = chunk.origIndex + chunk.delLines.length;
	}

	result.push(...lines.slice(currentIndex));
	return result.join("\n");
}

function formatSkippedHunkFailure(warnings: readonly PatchWarning[]): string {
	const lines = [
		`Patch could not be applied because ${warnings.length} hunk${warnings.length === 1 ? "" : "s"} did not match the current file content.`,
	];

	for (const warning of warnings) {
		const hunkNumber =
			warning.chunkIndex === undefined
				? "unknown"
				: String(warning.chunkIndex + 1);
		lines.push(`${warning.path}: hunk ${hunkNumber}: ${warning.message}`);
		if (warning.context) {
			lines.push(`Context:\n${warning.context}`);
		}
	}

	return lines.join("\n");
}

/* -------------------------------------------------------------------------- *
 * computeClinePatchChanges — the diskless seam (adapted computePatchChanges)
 * -------------------------------------------------------------------------- */

export interface ClineFileChange {
	type: PatchActionType;
	oldContent?: string;
	newContent?: string;
	movePath?: string;
}

export interface ClineChangeSet {
	/** Workspace-relative path -> the change the patch computes. */
	changes: Record<string, ClineFileChange>;
	/** Cline's fuzz counter: how many hunks needed a whitespace-tolerant level. */
	fuzz: number;
}

interface LoadedFiles {
	files: Record<string, string>;
	eols: Record<string, LineEnding>;
}

/**
 * Parse a patch and compute per-file changes against the SUPPLIED current
 * contents, without writing anything anywhere. This is Cline's
 * computePatchChanges with loadFiles() reading from the caller's content map
 * instead of disk. Any hunk that fails every match level throws a DiffError
 * BEFORE a change set is returned — mirroring ShadRox's zero-byte contract:
 * a caller can only land what this function returned success for.
 */
export function computeClinePatchChanges(
	patchText: string,
	currentContents: Record<string, string>,
): ClineChangeSet {
	const normalizedInput = normalizePatchInput(patchText);
	const lines = normalizedInput.lines;

	const files: Record<string, string> = {};
	const eols: Record<string, LineEnding> = {};

	for (const filePath of extractFilesForOperations(lines, [
		PATCH_MARKERS.UPDATE,
		PATCH_MARKERS.DELETE,
	])) {
		const content = findContent(currentContents, filePath);
		if (content === undefined) {
			throw new DiffError(`File not found: ${filePath}`);
		}
		files[filePath] = content.replace(/\r\n/g, "\n");
		eols[filePath] = detectLineEnding(content);
	}

	// ADD targets load only when they already exist, so the parser's
	// "File already exists" guard reflects the real state.
	for (const filePath of extractFilesForOperations(lines, [PATCH_MARKERS.ADD])) {
		const content = findContent(currentContents, filePath);
		if (content !== undefined) {
			files[filePath] = content;
			eols[filePath] = detectLineEnding(content);
		}
	}

	const parser = new PatchParser(lines, files);
	const { patch, fuzz } = parser.parse();
	if (patch.warnings && patch.warnings.length > 0) {
		throw new DiffError(formatSkippedHunkFailure(patch.warnings));
	}

	const changes: Record<string, ClineFileChange> = {};
	const withFileEol = (
		filePath: string,
		content: string | undefined,
	): string | undefined =>
		content === undefined
			? undefined
			: normalizeLineEndings(content, eols[filePath] ?? "\n");

	for (const [filePath, action] of Object.entries(patch.actions)) {
		switch (action.type) {
			case PatchActionType.DELETE:
				changes[filePath] = {
					type: PatchActionType.DELETE,
					oldContent: withFileEol(filePath, files[filePath]),
				};
				break;
			case PatchActionType.ADD:
				if (action.newFile === undefined) {
					throw new DiffError("ADD action without file content");
				}
				changes[filePath] = {
					type: PatchActionType.ADD,
					newContent: normalizeNewFileLineEndings(action.newFile),
				};
				break;
			case PatchActionType.UPDATE:
				changes[filePath] = {
					type: PatchActionType.UPDATE,
					oldContent: withFileEol(filePath, files[filePath]),
					newContent: withFileEol(
						filePath,
						applyChunks(files[filePath] ?? "", action.chunks, filePath),
					),
					movePath: action.movePath,
				};
				break;
		}
	}

	return { changes, fuzz };
}

/** Workspace paths are matched case-insensitively, like atomicApply does. */
export function findContent(
	currentContents: Record<string, string>,
	path: string,
): string | undefined {
	const normalize = (value: string) =>
		value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
	const wanted = normalize(path);
	for (const [name, content] of Object.entries(currentContents)) {
		if (normalize(name) === wanted) return content;
	}
	return undefined;
}

/* -------------------------------------------------------------------------- *
 * ShadRox-authored: structural section parse + SEARCH/REPLACE conversion.
 * NOT from Cline. The grammar knowledge (markers, stop markers, '@@' sections,
 * '+'-prefixed add lines, peek) is Cline's; the OUTPUT shape is ShadRox's so
 * the existing verification pipeline positions and re-verifies every hunk.
 * -------------------------------------------------------------------------- */

export interface ClineHunkSection {
	/** Keep + delete lines of the hunk, prefixes stripped (peek's `old`). */
	contextOld: string[];
	chunks: PatchChunk[];
	eof: boolean;
}

export interface ClineUpdateSection {
	path: string;
	movePath?: string;
	hunks: ClineHunkSection[];
}

export interface ClineParsedSections {
	adds: Array<{ path: string; content: string }>;
	updates: ClineUpdateSection[];
	deletes: string[];
}

/** Cline's PatchParser needs file contents to position hunks; this variant
 *  keeps the same grammar walk but stops at the structured hunks, so patch
 *  extraction works for files whose buffers are not loaded yet. */
export function parseClinePatchSections(patchText: string): ClineParsedSections {
	const { lines } = normalizePatchInput(patchText);
	const sections: ClineParsedSections = { adds: [], updates: [], deletes: [] };
	const seen = new Set<string>();
	let index = 0;

	const hasMore = () => index < lines.length;
	const isEnd = () => lines[index]?.startsWith(PATCH_MARKERS.END) ?? false;

	// PatchParser.skipBeginSentinel() equivalent.
	if (lines[index]?.startsWith(PATCH_MARKERS.BEGIN)) {
		index++;
	}

	while (hasMore() && !isEnd()) {
		const line = lines[index];
		if (line?.startsWith(PATCH_MARKERS.DELETE)) {
			const path = line.substring(PATCH_MARKERS.DELETE.length).trim();
			if (seen.has(path)) throw new DiffError(`Duplicate delete for file: ${path}`);
			seen.add(path);
			sections.deletes.push(path);
			index++;
			continue;
		}
		if (line?.startsWith(PATCH_MARKERS.ADD)) {
			const path = line.substring(PATCH_MARKERS.ADD.length).trim();
			if (seen.has(path)) throw new DiffError(`Duplicate add for file: ${path}`);
			seen.add(path);
			index++;
			const contentLines: string[] = [];
			const stopMarkers = [
				PATCH_MARKERS.END,
				PATCH_MARKERS.UPDATE,
				PATCH_MARKERS.DELETE,
				PATCH_MARKERS.ADD,
			];
			while (
				hasMore() &&
				!stopMarkers.some((marker) => lines[index]?.startsWith(marker.trim()))
			) {
				const addLine = lines[index++];
				if (addLine === undefined) break;
				if (!addLine.startsWith("+")) {
					throw new DiffError(`Invalid Add File line (missing '+'): ${addLine}`);
				}
				contentLines.push(addLine.substring(1));
			}
			sections.adds.push({ path, content: contentLines.join("\n") });
			continue;
		}
		if (line?.startsWith(PATCH_MARKERS.UPDATE)) {
			const path = line.substring(PATCH_MARKERS.UPDATE.length).trim();
			if (seen.has(path)) throw new DiffError(`Duplicate update for file: ${path}`);
			seen.add(path);
			index++;
			let movePath: string | undefined;
			if (lines[index]?.startsWith(PATCH_MARKERS.MOVE)) {
				movePath = (lines[index++] ?? "").substring(PATCH_MARKERS.MOVE.length).trim();
			}
			const hunks: ClineHunkSection[] = [];
			const stopMarkers = [
				PATCH_MARKERS.END,
				PATCH_MARKERS.UPDATE,
				PATCH_MARKERS.DELETE,
				PATCH_MARKERS.ADD,
				PATCH_MARKERS.END_FILE,
			];
			while (!stopMarkers.some((marker) => lines[index]?.startsWith(marker.trim()))) {
				if (index >= lines.length) break;
				const outerBefore = index;
				const currentLine = lines[index];
				const defStr = currentLine?.startsWith("@@ ")
					? currentLine.substring(3)
					: undefined;
				const sectionStr = currentLine === "@@" ? currentLine : undefined;
				if (defStr !== undefined || sectionStr !== undefined) {
					index++;
				}
				// defStr is a function-signature anchor. Without file contents we
				// cannot resolve it, and ShadRox positions hunks by their context
				// lines anyway, so it is consumed and dropped here.
				const [contextOld, chunks, endIndex, eof] = peek(lines, index);
				if (contextOld.length || chunks.length) {
					hunks.push({ contextOld, chunks, eof });
				}
				index = endIndex;
				if (index === outerBefore) {
					// Neither a section marker nor any hunk content advanced the
					// cursor — stop instead of looping on an empty section.
					break;
				}
			}
			sections.updates.push({ path, movePath, hunks });
			continue;
		}
		throw new DiffError(`Unknown line while parsing: ${line}`);
	}

	return sections;
}

/**
 * Why a Cline operation was refused. Typed so the failure survives every layer
 * (patch block -> plan failure -> UI toast) instead of degrading into the
 * generic "text not found" that a missing anchor also produces.
 */
export type ClineRefusalCode =
	/** `*** Delete File:` — the apply pipeline has no delete kind. */
	| "DELETE_NOT_A_PATCH"
	/** `*** Move to:` — a rename is a delete plus a create. */
	| "MOVE_NOT_SUPPORTED"
	/** `*** Add File:` over a path that already exists. */
	| "ADD_FILE_EXISTS"
	/** A hunk with no context lines to anchor on. */
	| "HUNK_UNANCHORED"
	/** The apply_patch body could not be parsed at all. */
	| "PARSE_ERROR"
	/** A fence that declared a file and then wrote no body (a deletion). */
	| "EMPTY_BODY"
	/** The reply ended mid-fence or mid-block, so the edit is incomplete. */
	| "TRUNCATED_BLOCK"
	/** SEARCH/REPLACE markers present but no complete block could be parsed. */
	| "MALFORMED_SEARCH_REPLACE";

export type ClinePatchEntry =
	| { path: string; kind: "searchReplace"; blocks: Array<{ original: string; updated: string }> }
	| { path: string; kind: "rewrite"; content: string }
	| { path: string; kind: "refuse"; reason: string; code: ClineRefusalCode };

const REFUSAL_PREFIX = "[apply-patch refused:";

/**
 * SEARCH text for a patchEngine refusal: a block no file contains, so
 * resolvePatchContent reports `not-found` and atomicApply writes zero bytes
 * with the reason surfaced in the plan failure.
 *
 * The code is embedded in the marker (`[apply-patch refused: CODE: reason]`)
 * so `refusalReason` can recover it later; it is still a string no file
 * contains, so the zero-byte guarantee is unchanged.
 */
export function refusalBlock(
	reason: string,
	code?: ClineRefusalCode,
): { original: string; updated: string } {
	const marker = `${REFUSAL_PREFIX} ${code ? `${code}: ` : ""}${reason}]`;
	return { original: marker, updated: "" };
}

/**
 * Reads back a refusal created by `refusalBlock`. Returns null for an ordinary
 * SEARCH block. `code` lets the UI say *why* a patch is blocked instead of
 * showing a failed anchor.
 */
export function refusalReason(
	block: { original: string; updated: string },
): { code: ClineRefusalCode | "REFUSED"; reason: string } | null {
	const text = (block.original ?? "").trim();
	if (!text.startsWith(REFUSAL_PREFIX) || !text.endsWith("]")) return null;
	const inner = text.slice(REFUSAL_PREFIX.length, -1).trim();
	const match = /^([A-Z][A-Z0-9_]*):\s*([\s\S]+)$/.exec(inner);
	if (!match) return { code: "REFUSED", reason: inner };
	return { code: match[1] as ClineRefusalCode, reason: match[2] };
}

/**
 * Convert one Cline hunk into SEARCH/REPLACE blocks.
 *
 * Each chunk becomes one block: [kept context since the previous chunk] +
 * [deleted lines] as SEARCH, the same kept lines + [inserted lines] as
 * REPLACE; the last chunk also carries the hunk's trailing kept lines so the
 * anchor is as unique as the model made it. Kept lines are never shared
 * between two blocks (shared lines would make the ranges overlap, and
 * patchEngine would then refuse both). A pure insertion with no context at
 * all cannot be anchored — it is refused, never guessed.
 */
export type HunkConversion =
	| { kind: "blocks"; blocks: Array<{ original: string; updated: string }> }
	| { kind: "refuse"; reason: string };

export function hunkToBlocks(hunk: ClineHunkSection): HunkConversion {
	const blocks: Array<{ original: string; updated: string }> = [];
	let consumed = 0;

	for (let chunkIndex = 0; chunkIndex < hunk.chunks.length; chunkIndex += 1) {
		const chunk = hunk.chunks[chunkIndex];
		const keeps = hunk.contextOld.slice(consumed, chunk.origIndex);
		const delEnd = chunk.origIndex + chunk.delLines.length;
		const isLast = chunkIndex === hunk.chunks.length - 1;
		const trailing = isLast ? hunk.contextOld.slice(delEnd) : [];

		let searchLines = [...keeps, ...chunk.delLines];
		let replaceLines: string[];
		if (isLast) {
			searchLines = [...searchLines, ...trailing];
			replaceLines = [...keeps, ...chunk.insLines, ...trailing];
		} else {
			replaceLines = [...keeps, ...chunk.insLines];
		}

		if (!searchLines.length) {
			return {
				kind: "refuse",
				reason:
					"hunk has no context lines to anchor on — add @@ context lines around the insertion",
			};
		}

		blocks.push({
			original: searchLines.join("\n"),
			updated: replaceLines.join("\n"),
		});
		consumed = delEnd;
	}

	if (!blocks.length) {
		// A section with zero chunks carries only kept context: a no-op hunk.
		return { kind: "blocks", blocks: [] };
	}
	return { kind: "blocks", blocks };
}

/**
 * Turn parsed sections into ShadRox patch entries, one per touched file.
 *  - UPDATE  -> searchReplace blocks (verified by patchEngine at plan time).
 *  - ADD     -> whole-file rewrite (pipeline create path; refuse when the
 *               target already exists, mirroring Cline's own guard).
 *  - DELETE / MOVE -> refused: the ShadRox apply pipeline has no delete kind,
 *               and silently dropping either would apply half a patch.
 */
export function clineSectionsToPatches(
	sections: ClineParsedSections,
	currentContents: Record<string, string>,
): ClinePatchEntry[] {
	const entries: ClinePatchEntry[] = [];

	for (const add of sections.adds) {
		if (findContent(currentContents, add.path) !== undefined) {
			entries.push({
				path: add.path,
				kind: "refuse",
				code: "ADD_FILE_EXISTS",
				reason: `Add File Error: File already exists: ${add.path}`,
			});
			continue;
		}
		entries.push({
			path: add.path,
			kind: "rewrite",
			content: normalizeNewFileLineEndings(add.content),
		});
	}

	for (const update of sections.updates) {
		if (update.movePath) {
			entries.push({
				path: update.path,
				kind: "refuse",
				code: "MOVE_NOT_SUPPORTED",
				reason: `Move to ${update.movePath} is not supported by the ShadRox apply pipeline — rename the file manually and re-request the edit`,
			});
			continue;
		}
		const blocks: Array<{ original: string; updated: string }> = [];
		for (const hunk of update.hunks) {
			const converted = hunkToBlocks(hunk);
			if (converted.kind === "refuse") {
				entries.push({
					path: update.path,
					kind: "refuse",
					code: "HUNK_UNANCHORED",
					reason: converted.reason,
				});
				blocks.length = 0;
				break;
			}
			blocks.push(...converted.blocks);
		}
		if (!blocks.length) continue;
		entries.push({ path: update.path, kind: "searchReplace", blocks });
	}

	for (const path of sections.deletes) {
		entries.push({
			path,
			kind: "refuse",
			code: "DELETE_NOT_A_PATCH",
			// Deletion has no patch kind: the pipeline only ever writes contents.
			// Say so plainly — this reason reaches the review card and the toast.
			reason: `Deletion is not applied from a patch, so ${path} was left untouched. Delete it from the file tree, or ask the agent to delete it.`,
		});
	}

	return entries;
}
