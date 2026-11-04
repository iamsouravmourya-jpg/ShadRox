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
 * Ported line-for-line from Cline, Apache-2.0 (reference/cline-main/sdk/
 * packages/ui/components/agent-chat/tool-summary/diff.ts): computeLcs,
 * diffLines, FRAGMENT_HUNK_HEADER, makeUnifiedDiff, hunkHeader, countDiffLines.
 *
 * Purpose in ShadRox: the review UI renders SEARCH/REPLACE proposals; this is
 * the separable pure-text renderer that turns an old/new pair (a whole file,
 * or one str_replace fragment) into a unified diff plus +/- line counts. No
 * VS Code / gRPC / React dependency — the rest of Cline's DiffEditRow is
 * host-coupled and was NOT ported.
 * ---------------------------------------------------------------------------
 */

function computeLcs(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array(n + 1).fill(0),
	);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] =
				a[i - 1] === b[j - 1]
					? dp[i - 1][j - 1] + 1
					: Math.max(dp[i][j - 1], dp[i - 1][j]);
		}
	}
	return dp;
}

function diffLines(
	oldLines: string[],
	newLines: string[],
): { type: "+" | "-" | " "; line: string }[] {
	const dp = computeLcs(oldLines, newLines);
	const result: { type: "+" | "-" | " "; line: string }[] = [];
	let i = oldLines.length;
	let j = newLines.length;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			result.unshift({ type: " ", line: oldLines[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			result.unshift({ type: "+", line: newLines[j - 1] });
			j--;
		} else {
			result.unshift({ type: "-", line: oldLines[i - 1] });
			i--;
		}
	}
	return result;
}

/** Honest hunk separator for diffs built from file fragments. */
export const FRAGMENT_HUNK_HEADER = "@@ … @@";

export type MakeUnifiedDiffOptions = {
	/**
	 * Set when oldText/newText are fragments of a larger file (e.g. editor
	 * str_replace payloads) rather than complete file contents. Hunk headers
	 * then render as `@@ … @@` instead of fabricating line-1-relative
	 * positions that would mislocate the change.
	 */
	fragment?: boolean;
};

export function makeUnifiedDiff(
	oldText: string,
	newText: string,
	filePath: string,
	ctx = 3,
	options?: MakeUnifiedDiffOptions,
): string {
	// Empty text means zero lines, not one blank line — otherwise creating an
	// empty file or deleting all content reports a phantom blank addition.
	const oldArr = oldText ? oldText.split("\n") : [];
	const newArr = newText ? newText.split("\n") : [];
	const ops = diffLines(oldArr, newArr);

	const output: string[] = [];
	output.push(`--- a/${filePath}`);
	output.push(`+++ b/${filePath}`);

	let i = 0;
	while (i < ops.length) {
		if (ops[i].type === " ") {
			i++;
			continue;
		}

		const hunkStart = Math.max(0, i - ctx);
		let end = i;
		while (end < ops.length) {
			if (ops[end].type !== " ") {
				end++;
				continue;
			}
			let next = end;
			while (next < ops.length && ops[next].type === " ") next++;
			if (next < ops.length && next - end <= ctx * 2) {
				end = next + 1;
			} else {
				break;
			}
		}
		const hunkEnd = Math.min(ops.length, end + ctx);

		let oldCount = 0;
		let newCount = 0;
		for (let k = hunkStart; k < hunkEnd; k++) {
			if (ops[k].type !== "+") oldCount++;
			if (ops[k].type !== "-") newCount++;
		}

		let oldStart = 1;
		let newStart = 1;
		for (let k = 0; k < hunkStart; k++) {
			if (ops[k].type !== "+") oldStart++;
			if (ops[k].type !== "-") newStart++;
		}

		output.push(
			options?.fragment
				? FRAGMENT_HUNK_HEADER
				: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
		);
		for (let k = hunkStart; k < hunkEnd; k++) {
			const prefix = ops[k].type === " " ? " " : ops[k].type;
			output.push(`${prefix}${ops[k].line}`);
		}

		i = hunkEnd;
	}

	return output.join("\n");
}

export function hunkHeader(lines: string[]): string {
	let oldCount = 0;
	let newCount = 0;
	for (const l of lines) {
		if (!l.startsWith("+")) oldCount++;
		if (!l.startsWith("-")) newCount++;
	}
	return `@@ -1,${oldCount} +1,${newCount} @@`;
}

/**
 * Count added/removed lines in a unified diff, ignoring the `---`/`+++`
 * file headers and `@@` hunk headers.
 */
export function countDiffLines(diff: string): {
	additions: number;
	deletions: number;
} {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}
