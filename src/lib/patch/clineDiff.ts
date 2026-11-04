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
 * Ported verbatim (line-for-line sections) from Cline, Apache-2.0:
 *   reference/cline-main/sdk/packages/core/src/extensions/tools/executors/
 *     apply-patch-parser.ts  — canonicalize(), calculateSimilarity(),
 *                              levenshteinDistance(), SIMILARITY_THRESHOLD.
 *
 * ShadRox adaptations: none to the algorithms; the module exists so both the
 * ported PatchParser (patch/clinePatchParser.ts) and patchEngine's fuzzy
 * locate level share one implementation of Cline's similarity math.
 * ---------------------------------------------------------------------------
 */

export const SIMILARITY_THRESHOLD = 0.66;

/**
 * Normalise smart punctuation to ASCII before any comparison. Models emit
 * em-dashes, curly quotes and escapes that a file does not contain verbatim;
 * Cline canonicalizes both sides of every context comparison.
 */
export function canonicalize(input: string): string {
	const punctuationMap: Record<string, string> = {
		"\u2010": "-",
		"\u2011": "-",
		"\u2012": "-",
		"\u2013": "-",
		"\u2014": "-",
		"\u2212": "-",
		"\u201C": '"',
		"\u201D": '"',
		"\u201E": '"',
		"\u00AB": '"',
		"\u00BB": '"',
		"\u2018": "'",
		"\u2019": "'",
		"\u201B": "'",
		"\u00A0": " ",
		"\u202F": " ",
	};
	return input
		.normalize("NFC")
		.replace(/./gu, (char) => punctuationMap[char] ?? char)
		.replace(/\\`/g, "`")
		.replace(/\\'/g, "'")
		.replace(/\\"/g, '"');
}

export function calculateSimilarity(str1: string, str2: string): number {
	const longer = str1.length > str2.length ? str1 : str2;
	const shorter = str1.length > str2.length ? str2 : str1;
	if (longer.length === 0) {
		return 1;
	}
	const editDistance = levenshteinDistance(shorter, longer);
	return (longer.length - editDistance) / longer.length;
}

export function levenshteinDistance(str1: string, str2: string): number {
	const rows = str2.length + 1;
	const cols = str1.length + 1;
	const matrix = new Array<number>(rows * cols).fill(0);
	const at = (r: number, c: number): number => matrix[r * cols + c] ?? 0;
	const set = (r: number, c: number, value: number): void => {
		matrix[r * cols + c] = value;
	};

	for (let i = 0; i <= str2.length; i++) set(i, 0, i);
	for (let j = 0; j <= str1.length; j++) set(0, j, j);

	for (let i = 1; i <= str2.length; i++) {
		for (let j = 1; j <= str1.length; j++) {
			if (str2[i - 1] === str1[j - 1]) {
				set(i, j, at(i - 1, j - 1));
			} else {
				set(i, j, 1 + Math.min(at(i - 1, j - 1), at(i, j - 1), at(i - 1, j)));
			}
		}
	}

	return at(str2.length, str1.length);
}
