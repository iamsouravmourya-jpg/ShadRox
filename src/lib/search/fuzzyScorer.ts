/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Ported from VSCode (microsoft/vscode, MIT):
 *   - src/vs/base/common/filters.ts       (fuzzyScore DP core, camelCase/prefix filters)
 *   - src/vs/base/common/fuzzyScorer.ts   (matrix scorer, item scorer, comparers, prepareQuery)
 *   - src/vs/base/common/comparers.ts     (compareAnything fallback)
 *   - src/vs/base/common/strings.ts       (stripWildcards, equalsIgnoreCase, isEmojiImprecise)
 *
 *  ShadRox adaptations:
 *   - All VSCode DI/observable/platform machinery removed; paths are always '/'-normalized.
 *   - `+`/`~` query tokens (must-contain / must-not-contain) parsed by `parseQueryTokens`.
 *   - `rankByFuzzy` / `rankFilesByFuzzy` convenience entry points for quick-open + palette.
 *  The scoring algorithms themselves are byte-faithful ports.
 *--------------------------------------------------------------------------------------------*/

//#region --- CharCode + string helpers (from vs/base/common/charCode.ts / strings.ts) ---

const CharCode = {
  Tab: 9,
  LineFeed: 10,
  CarriageReturn: 13,
  Space: 32,
  Exclamation: 33,
  DoubleQuote: 34,
  DollarSign: 36,
  Ampersand: 38,
  SingleQuote: 39,
  OpenParen: 40,
  CloseParen: 41,
  Asterisk: 42,
  Plus: 43,
  Comma: 44,
  Dash: 45,
  Period: 46,
  Slash: 47,
  Digit0: 48,
  Digit9: 57,
  Colon: 58,
  Semicolon: 59,
  LessThan: 60,
  Equals: 61,
  GreaterThan: 62,
  QuestionMark: 63,
  A: 65,
  Z: 90,
  OpenSquareBracket: 91,
  Backslash: 92,
  CloseSquareBracket: 93,
  Underline: 95,
  a: 97,
  z: 122,
  OpenCurlyBrace: 123,
  CloseCurlyBrace: 125
} as const;

function stripWildcards(pattern: string): string {
  return pattern.replace(/\*/g, '');
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

function startsWithIgnoreCase(str: string, candidate: string): boolean {
  if (candidate.length > str.length) {
    return false;
  }
  return str.slice(0, candidate.length).toLowerCase() === candidate.toLowerCase();
}

function isEmojiImprecise(x: number): boolean {
  return (
    (x >= 0x1f1e6 && x <= 0x1f1ff) || (x === 8986) || (x === 8987) || (x === 9200)
    || (x === 9203) || (x >= 9728 && x <= 10175) || (x === 11088) || (x === 11093)
    || (x >= 127744 && x <= 128591) || (x >= 128640 && x <= 128764)
    || (x >= 128992 && x <= 129008) || (x >= 129280 && x <= 129535)
    || (x >= 129648 && x <= 129782)
  );
}

//#endregion

//#region --- filters.ts: match types, prefix / camelCase / contiguous filters ---

export interface IMatch {
  start: number;
  end: number;
}

export type IFilter = (word: string, wordToMatchAgainst: string) => IMatch[] | null;

export function or(...filter: IFilter[]): IFilter {
  return function (word: string, wordToMatchAgainst: string): IMatch[] | null {
    for (let i = 0, len = filter.length; i < len; i++) {
      const match = filter[i](word, wordToMatchAgainst);
      if (match) {
        return match;
      }
    }
    return null;
  };
}

export const matchesStrictPrefix: IFilter = _matchesPrefix.bind(undefined, false);
export const matchesPrefix: IFilter = _matchesPrefix.bind(undefined, true);

function _matchesPrefix(ignoreCase: boolean, word: string, wordToMatchAgainst: string): IMatch[] | null {
  if (!wordToMatchAgainst || wordToMatchAgainst.length < word.length) {
    return null;
  }

  let matches: boolean;
  if (ignoreCase) {
    matches = startsWithIgnoreCase(wordToMatchAgainst, word);
  } else {
    matches = wordToMatchAgainst.indexOf(word) === 0;
  }

  if (!matches) {
    return null;
  }

  return word.length > 0 ? [{ start: 0, end: word.length }] : [];
}

export function matchesContiguousSubString(word: string, wordToMatchAgainst: string): IMatch[] | null {
  const index = wordToMatchAgainst.toLowerCase().indexOf(word.toLowerCase());
  if (index === -1) {
    return null;
  }

  return [{ start: index, end: index + word.length }];
}

function isLower(code: number): boolean {
  return CharCode.a <= code && code <= CharCode.z;
}

export function isUpper(code: number): boolean {
  return CharCode.A <= code && code <= CharCode.Z;
}

function isNumber(code: number): boolean {
  return CharCode.Digit0 <= code && code <= CharCode.Digit9;
}

function isWhitespace(code: number): boolean {
  return (
    code === CharCode.Space
    || code === CharCode.Tab
    || code === CharCode.LineFeed
    || code === CharCode.CarriageReturn
  );
}

const wordSeparators = new Set<number>();
// These are chosen as natural word separators based on written text.
'()[]{}<>`\'"-/;:,.?!'
  .split('')
  .forEach(s => wordSeparators.add(s.charCodeAt(0)));

function isWordSeparator(code: number): boolean {
  return isWhitespace(code) || wordSeparators.has(code);
}

function isAlphanumeric(code: number): boolean {
  return isLower(code) || isUpper(code) || isNumber(code);
}

function join(head: IMatch, tail: IMatch[]): IMatch[] {
  if (tail.length === 0) {
    tail = [head];
  } else if (head.end === tail[0].start) {
    tail[0].start = head.start;
  } else {
    tail.unshift(head);
  }
  return tail;
}

function nextAnchor(camelCaseWord: string, start: number): number {
  for (let i = start; i < camelCaseWord.length; i++) {
    const c = camelCaseWord.charCodeAt(i);
    if (isUpper(c) || isNumber(c) || (i > 0 && !isAlphanumeric(camelCaseWord.charCodeAt(i - 1)))) {
      return i;
    }
  }
  return camelCaseWord.length;
}

function _matchesCamelCase(word: string, camelCaseWord: string, i: number, j: number): IMatch[] | null {
  if (i === word.length) {
    return [];
  } else if (j === camelCaseWord.length) {
    return null;
  } else if (word[i] !== camelCaseWord[j].toLowerCase()) {
    return null;
  } else {
    let result: IMatch[] | null = null;
    let nextUpperIndex = j + 1;
    result = _matchesCamelCase(word, camelCaseWord, i + 1, j + 1);
    while (!result && (nextUpperIndex = nextAnchor(camelCaseWord, nextUpperIndex)) < camelCaseWord.length) {
      result = _matchesCamelCase(word, camelCaseWord, i + 1, nextUpperIndex);
      nextUpperIndex++;
    }
    return result === null ? null : join({ start: j, end: j + 1 }, result);
  }
}

interface ICamelCaseAnalysis {
  upperPercent: number;
  lowerPercent: number;
  alphaPercent: number;
  numericPercent: number;
}

// Heuristic to avoid computing camel case matcher for words that don't
// look like camelCaseWords.
function analyzeCamelCaseWord(word: string): ICamelCaseAnalysis {
  let upper = 0, lower = 0, alpha = 0, numeric = 0, code = 0;

  for (let i = 0; i < word.length; i++) {
    code = word.charCodeAt(i);

    if (isUpper(code)) { upper++; }
    if (isLower(code)) { lower++; }
    if (isAlphanumeric(code)) { alpha++; }
    if (isNumber(code)) { numeric++; }
  }

  const upperPercent = upper / word.length;
  const lowerPercent = lower / word.length;
  const alphaPercent = alpha / word.length;
  const numericPercent = numeric / word.length;

  return { upperPercent, lowerPercent, alphaPercent, numericPercent };
}

function isUpperCaseWord(analysis: ICamelCaseAnalysis): boolean {
  const { upperPercent, lowerPercent } = analysis;
  return lowerPercent === 0 && upperPercent > 0.6;
}

function isCamelCaseWord(analysis: ICamelCaseAnalysis): boolean {
  const { upperPercent, lowerPercent, alphaPercent, numericPercent } = analysis;
  return lowerPercent > 0.2 && upperPercent < 0.8 && alphaPercent > 0.6 && numericPercent < 0.2;
}

// Heuristic to avoid computing camel case matcher for words that don't
// look like camel case patterns.
function isCamelCasePattern(word: string): boolean {
  let upper = 0, lower = 0, code = 0, whitespace = 0;

  for (let i = 0; i < word.length; i++) {
    code = word.charCodeAt(i);

    if (isUpper(code)) { upper++; }
    if (isLower(code)) { lower++; }
    if (isWhitespace(code)) { whitespace++; }
  }

  if ((upper === 0 || lower === 0) && whitespace === 0) {
    return word.length <= 30;
  } else {
    return upper <= 5;
  }
}

export function matchesCamelCase(word: string, camelCaseWord: string): IMatch[] | null {
  if (!camelCaseWord) {
    return null;
  }

  camelCaseWord = camelCaseWord.trim();

  if (camelCaseWord.length === 0) {
    return null;
  }

  if (!isCamelCasePattern(word)) {
    return null;
  }

  if (camelCaseWord.length > 60) {
    camelCaseWord = camelCaseWord.substring(0, 60);
  }

  const analysis = analyzeCamelCaseWord(camelCaseWord);

  if (!isCamelCaseWord(analysis)) {
    if (!isUpperCaseWord(analysis)) {
      return null;
    }

    camelCaseWord = camelCaseWord.toLowerCase();
  }

  let result: IMatch[] | null = null;
  let i = 0;

  word = word.toLowerCase();
  while (i < camelCaseWord.length && (result = _matchesCamelCase(word, camelCaseWord, 0, i)) === null) {
    i = nextAnchor(camelCaseWord, i + 1);
  }

  return result;
}

//#endregion

//#region --- filters.ts: fuzzyScore (DP table scorer) + options + matchesFuzzy2 ---

/**
 * An array representing a fuzzy match.
 *
 * 0. the score
 * 1. the offset at which matching started
 * 2. `<match_pos_N>`
 * 3. `<match_pos_1>`
 * 4. `<match_pos_0>` etc
 */
export type FuzzyScore = [score: number, wordStart: number, ...matches: number[]];

export function isDefaultFuzzyScore(score?: FuzzyScore): boolean {
  return !score || (score.length === 2 && score[0] === -100 && score[1] === 0);
}

/** No matches and value `-100` */
export const defaultFuzzyScore: FuzzyScore = ([-100, 0]);

export interface FuzzyScoreOptions {
  readonly firstMatchCanBeWeak: boolean;
  readonly boostFullMatch: boolean;
}

export const FuzzyScoreOptions_default: FuzzyScoreOptions = { boostFullMatch: true, firstMatchCanBeWeak: false };

export interface FuzzyScorer {
  (pattern: string, lowPattern: string, patternPos: number, word: string, lowWord: string, wordPos: number, options?: FuzzyScoreOptions): FuzzyScore | undefined;
}

export function createMatches(score: undefined | FuzzyScore): IMatch[] {
  if (typeof score === 'undefined') {
    return [];
  }
  const res: IMatch[] = [];
  const wordPos = score[1];
  for (let i = score.length - 1; i > 1; i--) {
    const pos = score[i] + wordPos;
    const last = res[res.length - 1];
    if (last && last.end === pos) {
      last.end = pos + 1;
    } else {
      res.push({ start: pos, end: pos + 1 });
    }
  }
  return res;
}

const _maxLen = 128;

function initTable() {
  const table: number[][] = [];
  const row: number[] = [];
  for (let i = 0; i <= _maxLen; i++) {
    row[i] = 0;
  }
  for (let i = 0; i <= _maxLen; i++) {
    table.push(row.slice(0));
  }
  return table;
}

function initArr(maxLen: number) {
  const row: number[] = [];
  for (let i = 0; i <= maxLen; i++) {
    row[i] = 0;
  }
  return row;
}

const _minWordMatchPos = initArr(2 * _maxLen); // min word position for a certain pattern position
const _maxWordMatchPos = initArr(2 * _maxLen); // max word position for a certain pattern position
const _diag = initTable(); // the length of a contiguous diagonal match
const _table = initTable();
const _arrows = initTable(); // arrow values below: 1 = Diag, 2 = Left, 3 = LeftLeft
const _debug = false;

const Arrow = { Diag: 1, Left: 2, LeftLeft: 3 } as const;

function printTable(table: number[][], pattern: string, patternLen: number, word: string, wordLen: number): string {
  function pad(s: string, n: number, ch = ' ') {
    while (s.length < n) {
      s = ch + s;
    }
    return s;
  }
  let ret = ` |   |${word.split('').map(c => pad(c, 3)).join('|')}\n`;

  for (let i = 0; i <= patternLen; i++) {
    if (i === 0) {
      ret += ' |';
    } else {
      ret += `${pattern[i - 1]}|`;
    }
    ret += table[i].slice(0, wordLen + 1).map(n => pad(n.toString(), 3)).join('|') + '\n';
  }
  return ret;
}

function printTables(pattern: string, patternStart: number, word: string, wordStart: number): void {
  pattern = pattern.substr(patternStart);
  word = word.substr(wordStart);
  console.log(printTable(_table, pattern, pattern.length, word, word.length));
  console.log(printTable(_arrows, pattern, pattern.length, word, word.length));
  console.log(printTable(_diag, pattern, pattern.length, word, word.length));
}

function isSeparatorAtPos(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) {
    return false;
  }
  const code = value.codePointAt(index);
  switch (code) {
    case CharCode.Underline:
    case CharCode.Dash:
    case CharCode.Period:
    case CharCode.Space:
    case CharCode.Slash:
    case CharCode.Backslash:
    case CharCode.SingleQuote:
    case CharCode.DoubleQuote:
    case CharCode.Colon:
    case CharCode.DollarSign:
    case CharCode.LessThan:
    case CharCode.GreaterThan:
    case CharCode.OpenParen:
    case CharCode.CloseParen:
    case CharCode.OpenSquareBracket:
    case CharCode.CloseSquareBracket:
    case CharCode.OpenCurlyBrace:
    case CharCode.CloseCurlyBrace:
      return true;
    case undefined:
      return false;
    default:
      if (isEmojiImprecise(code)) {
        return true;
      }
      return false;
  }
}

function isWhitespaceAtPos(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) {
    return false;
  }
  const code = value.charCodeAt(index);
  switch (code) {
    case CharCode.Space:
    case CharCode.Tab:
      return true;
    default:
      return false;
  }
}

function isUpperCaseAtPos(pos: number, word: string, wordLow: string): boolean {
  return word[pos] !== wordLow[pos];
}

export function isPatternInWord(patternLow: string, patternPos: number, patternLen: number, wordLow: string, wordPos: number, wordLen: number, fillMinWordPosArr = false): boolean {
  while (patternPos < patternLen && wordPos < wordLen) {
    if (patternLow[patternPos] === wordLow[wordPos]) {
      if (fillMinWordPosArr) {
        // Remember the min word position for each pattern position
        _minWordMatchPos[patternPos] = wordPos;
      }
      patternPos += 1;
    }
    wordPos += 1;
  }
  return patternPos === patternLen; // pattern must be exhausted
}

export function fuzzyScore(pattern: string, patternLow: string, patternStart: number, word: string, wordLow: string, wordStart: number, options: FuzzyScoreOptions = FuzzyScoreOptions_default): FuzzyScore | undefined {

  const patternLen = pattern.length > _maxLen ? _maxLen : pattern.length;
  const wordLen = word.length > _maxLen ? _maxLen : word.length;

  if (patternStart >= patternLen || wordStart >= wordLen || (patternLen - patternStart) > (wordLen - wordStart)) {
    return undefined;
  }

  // Run a simple check if the characters of pattern occur
  // (in order) at all in word. If that isn't the case we
  // stop because no match will be possible
  if (!isPatternInWord(patternLow, patternStart, patternLen, wordLow, wordStart, wordLen, true)) {
    return undefined;
  }

  // Find the max matching word position for each pattern position
  // NOTE: the min matching word position was filled in above, in the `isPatternInWord` call
  _fillInMaxWordMatchPos(patternLen, wordLen, patternStart, wordStart, patternLow, wordLow);

  let row: number = 1;
  let column: number = 1;
  let patternPos = patternStart;
  let wordPos = wordStart;

  const hasStrongFirstMatch = [false];

  // There will be a match, fill in tables
  for (row = 1, patternPos = patternStart; patternPos < patternLen; row++, patternPos++) {

    // Reduce search space to possible matching word positions and to possible access from next row
    const minWordMatchPos = _minWordMatchPos[patternPos];
    const maxWordMatchPos = _maxWordMatchPos[patternPos];
    const nextMaxWordMatchPos = (patternPos + 1 < patternLen ? _maxWordMatchPos[patternPos + 1] : wordLen);

    for (column = minWordMatchPos - wordStart + 1, wordPos = minWordMatchPos; wordPos < nextMaxWordMatchPos; column++, wordPos++) {

      let score = Number.MIN_SAFE_INTEGER;
      let canComeDiag = false;

      if (wordPos <= maxWordMatchPos) {
        score = _doScore(
          pattern, patternLow, patternPos, patternStart,
          word, wordLow, wordPos, wordLen, wordStart,
          _diag[row - 1][column - 1] === 0,
          hasStrongFirstMatch
        );
      }

      let diagScore = 0;
      if (score !== Number.MIN_SAFE_INTEGER) {
        canComeDiag = true;
        diagScore = score + _table[row - 1][column - 1];
      }

      const canComeLeft = wordPos > minWordMatchPos;
      const leftScore = canComeLeft ? _table[row][column - 1] + (_diag[row][column - 1] > 0 ? -5 : 0) : 0; // penalty for a gap start

      const canComeLeftLeft = wordPos > minWordMatchPos + 1 && _diag[row][column - 1] > 0;
      const leftLeftScore = canComeLeftLeft ? _table[row][column - 2] + (_diag[row][column - 2] > 0 ? -5 : 0) : 0; // penalty for a gap start

      if (canComeLeftLeft && (!canComeLeft || leftLeftScore >= leftScore) && (!canComeDiag || leftLeftScore >= diagScore)) {
        // always prefer choosing left left to jump over a diagonal because that means a match is earlier in the word
        _table[row][column] = leftLeftScore;
        _arrows[row][column] = Arrow.LeftLeft;
        _diag[row][column] = 0;
      } else if (canComeLeft && (!canComeDiag || leftScore >= diagScore)) {
        // always prefer choosing left since that means a match is earlier in the word
        _table[row][column] = leftScore;
        _arrows[row][column] = Arrow.Left;
        _diag[row][column] = 0;
      } else if (canComeDiag) {
        _table[row][column] = diagScore;
        _arrows[row][column] = Arrow.Diag;
        _diag[row][column] = _diag[row - 1][column - 1] + 1;
      } else {
        throw new Error(`not possible`);
      }
    }
  }

  if (_debug) {
    printTables(pattern, patternStart, word, wordStart);
  }

  if (!hasStrongFirstMatch[0] && !options.firstMatchCanBeWeak) {
    return undefined;
  }

  row--;
  column--;

  const result: FuzzyScore = [_table[row][column], wordStart];

  let backwardsDiagLength = 0;
  let maxMatchColumn = 0;

  while (row >= 1) {
    // Find the column where we go diagonally up
    let diagColumn = column;
    do {
      const arrow = _arrows[row][diagColumn];
      if (arrow === Arrow.LeftLeft) {
        diagColumn = diagColumn - 2;
      } else if (arrow === Arrow.Left) {
        diagColumn = diagColumn - 1;
      } else {
        // found the diagonal
        break;
      }
    } while (diagColumn >= 1);

    // Overturn the "forwards" decision if keeping the "backwards" diagonal would give a better match
    if (
      backwardsDiagLength > 1 // only if we would have a contiguous match of 3 characters
      && patternLow[patternStart + row - 1] === wordLow[wordStart + column - 1] // only if we can do a contiguous match diagonally
      && !isUpperCaseAtPos(diagColumn + wordStart - 1, word, wordLow) // only if the forwards chose diagonal is not an uppercase
      && backwardsDiagLength + 1 > _diag[row][diagColumn] // only if our contiguous match would be longer than the "forwards" contiguous match
    ) {
      diagColumn = column;
    }

    if (diagColumn === column) {
      // this is a contiguous match
      backwardsDiagLength++;
    } else {
      backwardsDiagLength = 1;
    }

    if (!maxMatchColumn) {
      // remember the last matched column
      maxMatchColumn = diagColumn;
    }

    row--;
    column = diagColumn - 1;
    result.push(column);
  }

  if (wordLen - wordStart === patternLen && options.boostFullMatch) {
    // the word matches the pattern with all characters!
    // giving the score a total match boost (to come up ahead other words)
    result[0] += 2;
  }

  // Add 1 penalty for each skipped character in the word
  const skippedCharsCount = maxMatchColumn - patternLen;
  result[0] -= skippedCharsCount;

  return result;
}

function _fillInMaxWordMatchPos(patternLen: number, wordLen: number, patternStart: number, wordStart: number, patternLow: string, wordLow: string) {
  let patternPos = patternLen - 1;
  let wordPos = wordLen - 1;
  while (patternPos >= patternStart && wordPos >= wordStart) {
    if (patternLow[patternPos] === wordLow[wordPos]) {
      _maxWordMatchPos[patternPos] = wordPos;
      patternPos--;
    }
    wordPos--;
  }
}

function _doScore(
  pattern: string, patternLow: string, patternPos: number, patternStart: number,
  word: string, wordLow: string, wordPos: number, wordLen: number, wordStart: number,
  newMatchStart: boolean,
  outFirstMatchStrong: boolean[],
): number {
  if (patternLow[patternPos] !== wordLow[wordPos]) {
    return Number.MIN_SAFE_INTEGER;
  }

  let score = 1;
  let isGapLocation = false;
  if (wordPos === (patternPos - patternStart)) {
    // common prefix: `foobar <-> foobaz`
    //                            ^^^^^
    score = pattern[patternPos] === word[wordPos] ? 7 : 5;

  } else if (isUpperCaseAtPos(wordPos, word, wordLow) && (wordPos === 0 || !isUpperCaseAtPos(wordPos - 1, word, wordLow))) {
    // hitting upper-case: `foo <-> forOthers`
    //                              ^^ ^
    score = pattern[patternPos] === word[wordPos] ? 7 : 5;
    isGapLocation = true;

  } else if (isSeparatorAtPos(wordLow, wordPos) && (wordPos === 0 || !isSeparatorAtPos(wordLow, wordPos - 1))) {
    // hitting a separator: `. <-> foo.bar`
    //                                ^
    score = 5;

  } else if (isSeparatorAtPos(wordLow, wordPos - 1) || isWhitespaceAtPos(wordLow, wordPos - 1)) {
    // post separator: `foo <-> bar_foo`
    //                              ^^^
    score = 5;
    isGapLocation = true;
  }

  if (score > 1 && patternPos === patternStart) {
    outFirstMatchStrong[0] = true;
  }

  if (!isGapLocation) {
    isGapLocation = isUpperCaseAtPos(wordPos, word, wordLow) || isSeparatorAtPos(wordLow, wordPos - 1) || isWhitespaceAtPos(wordLow, wordPos - 1);
  }

  //
  if (patternPos === patternStart) { // first character in pattern
    if (wordPos > wordStart) {
      // the first pattern character would match a word character that is not at the word start
      // so introduce a penalty to account for the gap preceding this match
      score -= isGapLocation ? 3 : 5;
    }
  } else {
    if (newMatchStart) {
      // this would be the beginning of a new match (i.e. there would be a gap before this location)
      score += isGapLocation ? 2 : 0;
    } else {
      // this is part of a contiguous match, so give it a slight bonus, but do so only if it would not be a preferred gap location
      score += isGapLocation ? 0 : 1;
    }
  }

  if (wordPos + 1 === wordLen) {
    // we always penalize gaps, but this gives unfair advantages to a match that would match the last character in the word
    // so pretend there is a gap after the last character in the word to normalize things
    score -= isGapLocation ? 3 : 5;
  }

  return score;
}

//#region --- graceful (typo-tolerant) variants ---

export function fuzzyScoreGracefulAggressive(pattern: string, lowPattern: string, patternPos: number, word: string, lowWord: string, wordPos: number, options?: FuzzyScoreOptions): FuzzyScore | undefined {
  return fuzzyScoreWithPermutations(pattern, lowPattern, patternPos, word, lowWord, wordPos, true, options);
}

export function fuzzyScoreGraceful(pattern: string, lowPattern: string, patternPos: number, word: string, lowWord: string, wordPos: number, options?: FuzzyScoreOptions): FuzzyScore | undefined {
  return fuzzyScoreWithPermutations(pattern, lowPattern, patternPos, word, lowWord, wordPos, false, options);
}

function fuzzyScoreWithPermutations(pattern: string, lowPattern: string, patternPos: number, word: string, lowWord: string, wordPos: number, aggressive: boolean, options?: FuzzyScoreOptions): FuzzyScore | undefined {
  let top = fuzzyScore(pattern, lowPattern, patternPos, word, lowWord, wordPos, options);

  if (top && !aggressive) {
    // when using the original pattern yield a result we
    // return it unless we are aggressive and try to find
    // a better alignment, e.g. `cno` -> `^co^ns^ole` or `^c^o^nsole`.
    return top;
  }

  if (pattern.length >= 3) {
    // When the pattern is long enough then try a few (max 7)
    // permutations of the pattern to find a better match. The
    // permutations only swap neighbouring characters, e.g
    // `cnoso` becomes `conso`, `cnsoo`, `cnoos`.
    const tries = Math.min(7, pattern.length - 1);
    for (let movingPatternPos = patternPos + 1; movingPatternPos < tries; movingPatternPos++) {
      const newPattern = nextTypoPermutation(pattern, movingPatternPos);
      if (newPattern) {
        const candidate = fuzzyScore(newPattern, newPattern.toLowerCase(), patternPos, word, lowWord, wordPos, options);
        if (candidate) {
          candidate[0] -= 3; // permutation penalty
          if (!top || candidate[0] > top[0]) {
            top = candidate;
          }
        }
      }
    }
  }

  return top;
}

function nextTypoPermutation(pattern: string, patternPos: number): string | undefined {

  if (patternPos + 1 >= pattern.length) {
    return undefined;
  }

  const swap1 = pattern[patternPos];
  const swap2 = pattern[patternPos + 1];

  if (swap1 === swap2) {
    return undefined;
  }

  return pattern.slice(0, patternPos)
    + swap2
    + swap1
    + pattern.slice(patternPos + 2);
}

//#endregion

/**
 * Match pattern against word in a fuzzy way. As in IntelliSense and faster and more
 * powerful than the regex-based `matchesFuzzy`.
 */
export function matchesFuzzy2(pattern: string, word: string): IMatch[] | null {
  const score = fuzzyScore(pattern, pattern.toLowerCase(), 0, word, word.toLowerCase(), 0, { firstMatchCanBeWeak: true, boostFullMatch: true });
  return score ? createMatches(score) : null;
}

//#endregion

//#region --- fuzzyScorer.ts: matrix scorer (scoreFuzzy) ---

export type FuzzyScoreItem = [number /* score */, number[] /* match positions */];

const NO_MATCH = 0;
const NO_SCORE: FuzzyScoreItem = [NO_MATCH, []];

export function scoreFuzzy(target: string, query: string, queryLower: string, allowNonContiguousMatches: boolean): FuzzyScoreItem {
  if (!target || !query) {
    return NO_SCORE; // return early if target or query are undefined
  }

  const targetLength = target.length;
  const queryLength = query.length;

  if (targetLength < queryLength) {
    return NO_SCORE; // impossible for query to be contained in target
  }

  const targetLower = target.toLowerCase();
  return doScoreFuzzy(query, queryLower, queryLength, target, targetLower, targetLength, allowNonContiguousMatches);
}

function doScoreFuzzy(query: string, queryLower: string, queryLength: number, target: string, targetLower: string, targetLength: number, allowNonContiguousMatches: boolean): FuzzyScoreItem {
  const scores: number[] = [];
  const matches: number[] = [];

  //
  // Build Scorer Matrix:
  //
  // The matrix is composed of query q and target t. For each index we score
  // q[i] with t[i] and compare that with the previous score. If the score is
  // equal or larger, we keep the match. In addition to the score, we also keep
  // the length of the consecutive matches to use as boost for the score.
  //
  for (let queryIndex = 0; queryIndex < queryLength; queryIndex++) {
    const queryIndexOffset = queryIndex * targetLength;
    const queryIndexPreviousOffset = queryIndexOffset - targetLength;

    const queryIndexGtNull = queryIndex > 0;

    const queryCharAtIndex = query[queryIndex];
    const queryLowerCharAtIndex = queryLower[queryIndex];

    for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
      const targetIndexGtNull = targetIndex > 0;

      const currentIndex = queryIndexOffset + targetIndex;
      const leftIndex = currentIndex - 1;
      const diagIndex = queryIndexPreviousOffset + targetIndex - 1;

      const leftScore = targetIndexGtNull ? scores[leftIndex] : 0;
      const diagScore = queryIndexGtNull && targetIndexGtNull ? scores[diagIndex] : 0;

      const matchesSequenceLength = queryIndexGtNull && targetIndexGtNull ? matches[diagIndex] : 0;

      // If we are not matching on the first query character any more, we only produce a
      // score if we had a score previously for the last query index (by looking at the diagScore).
      // This makes sure that the query always matches in sequence on the target.
      let score: number;
      if (!diagScore && queryIndexGtNull) {
        score = 0;
      } else {
        score = computeCharScore(queryCharAtIndex, queryLowerCharAtIndex, target, targetLower, targetIndex, matchesSequenceLength);
      }

      // We have a score and its equal or larger than the left score
      // Match: sequence continues growing from previous diag value
      // Score: increases by diag score value
      const isValidScore = !!score && diagScore + score >= leftScore;
      if (isValidScore && (
        // We don't need to check if it's contiguous if we allow non-contiguous matches
        allowNonContiguousMatches ||
        // We must be looking for a contiguous match.
        // Looking at an index higher than 0 in the query means we must have already
        // found out this is contiguous otherwise there wouldn't have been a score
        queryIndexGtNull ||
        // lastly check if the query is completely contiguous at this index in the target
        targetLower.startsWith(queryLower, targetIndex)
      )) {
        matches[currentIndex] = matchesSequenceLength + 1;
        scores[currentIndex] = diagScore + score;
      }

      // We either have no score or the score is lower than the left score
      // Match: reset to 0
      // Score: pick up from left hand side
      else {
        matches[currentIndex] = NO_MATCH;
        scores[currentIndex] = leftScore;
      }
    }
  }

  // Restore Positions (starting from bottom right of matrix)
  const positions: number[] = [];
  let queryIndex = queryLength - 1;
  let targetIndex = targetLength - 1;
  while (queryIndex >= 0 && targetIndex >= 0) {
    const currentIndex = queryIndex * targetLength + targetIndex;
    const match = matches[currentIndex];
    if (match === NO_MATCH) {
      targetIndex--; // go left
    } else {
      positions.push(targetIndex);

      // go up and left
      queryIndex--;
      targetIndex--;
    }
  }

  return [scores[queryLength * targetLength - 1], positions.reverse()];
}

function computeCharScore(queryCharAtIndex: string, queryLowerCharAtIndex: string, target: string, targetLower: string, targetIndex: number, matchesSequenceLength: number): number {
  let score = 0;

  if (!considerAsEqual(queryLowerCharAtIndex, targetLower[targetIndex])) {
    return score; // no match of characters
  }

  // Character match bonus
  score += 1;

  // Consecutive match bonus
  if (matchesSequenceLength > 0) {
    score += (matchesSequenceLength * 5);
  }

  // Same case bonus
  if (queryCharAtIndex === target[targetIndex]) {
    score += 1;
  }

  // Start of word bonus
  if (targetIndex === 0) {
    score += 8;
  }

  else {

    // After separator bonus
    const separatorBonus = scoreSeparatorAtPos(target.charCodeAt(targetIndex - 1));
    if (separatorBonus) {
      score += separatorBonus;
    }

    // Inside word upper case bonus (camel case). We only give this bonus if we're not in a contiguous sequence.
    // For example:
    // NPE => NullPointerException = boost
    // HTTP => HTTP = not boost
    else if (isUpper(target.charCodeAt(targetIndex)) && matchesSequenceLength === 0) {
      score += 2;
    }
  }

  return score;
}

function considerAsEqual(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }

  // Special case path separators: ignore platform differences
  if (a === '/' || a === '\\') {
    return b === '/' || b === '\\';
  }

  return false;
}

function scoreSeparatorAtPos(charCode: number): number {
  switch (charCode) {
    case CharCode.Slash:
    case CharCode.Backslash:
      return 5; // prefer path separators...
    case CharCode.Underline:
    case CharCode.Dash:
    case CharCode.Period:
    case CharCode.Space:
    case CharCode.SingleQuote:
    case CharCode.DoubleQuote:
    case CharCode.Colon:
      return 4; // ...over other separators
    default:
      return 0;
  }
}

//#endregion

//#region --- fuzzyScorer.ts: scoreFuzzy2 (label-only scoring with IMatch output) ---

export type FuzzyScore2 = [number | undefined /* score */, IMatch[]];

const NO_SCORE2: FuzzyScore2 = [undefined, []];

export function scoreFuzzy2(target: string, query: IPreparedQuery | IPreparedQueryPiece, patternStart = 0, wordStart = 0): FuzzyScore2 {

  // Score: multiple inputs
  const preparedQuery = query as IPreparedQuery;
  if (preparedQuery.values && preparedQuery.values.length > 1) {
    return doScoreFuzzy2Multiple(target, preparedQuery.values, patternStart, wordStart);
  }

  // Score: single input
  return doScoreFuzzy2Single(target, query, patternStart, wordStart);
}

function doScoreFuzzy2Multiple(target: string, query: IPreparedQueryPiece[], patternStart: number, wordStart: number): FuzzyScore2 {
  let totalScore = 0;
  const totalMatches: IMatch[] = [];

  for (const queryPiece of query) {
    const [score, matches] = doScoreFuzzy2Single(target, queryPiece, patternStart, wordStart);
    if (typeof score !== 'number') {
      // if a single query value does not match, return with
      // no score entirely, we require all queries to match
      return NO_SCORE2;
    }

    totalScore += score;
    totalMatches.push(...matches);
  }

  // if we have a score, ensure that the positions are
  // sorted in ascending order and distinct
  return [totalScore, normalizeMatches(totalMatches)];
}

function doScoreFuzzy2Single(target: string, query: IPreparedQueryPiece, patternStart: number, wordStart: number): FuzzyScore2 {
  const score = fuzzyScore(query.original, query.originalLowercase, patternStart, target, target.toLowerCase(), wordStart, { firstMatchCanBeWeak: true, boostFullMatch: true });
  if (!score) {
    return NO_SCORE2;
  }

  return [score[0], createMatches(score)];
}

//#endregion

//#region --- fuzzyScorer.ts: item (label, description, path) scorer ---

/**
 * Scoring on structural items that have a label and optional description.
 */
export interface IItemScore {

  /**
   * Overall score.
   */
  score: number;

  /**
   * Matches within the label.
   */
  labelMatch?: IMatch[];

  /**
   * Matches within the description.
   */
  descriptionMatch?: IMatch[];
}

const NO_ITEM_SCORE = Object.freeze<IItemScore>({ score: 0 });

export interface IItemAccessor<T> {

  /**
   * Just the label of the item to score on.
   */
  getItemLabel(item: T): string | undefined;

  /**
   * The optional description of the item to score on.
   */
  getItemDescription(item: T): string | undefined;

  /**
   * If the item is a file, the path of the file to score on.
   */
  getItemPath(file: T): string | undefined;
}

const PATH_IDENTITY_SCORE = 1 << 18;
const LABEL_PREFIX_SCORE_THRESHOLD = 1 << 17;
const LABEL_SCORE_THRESHOLD = 1 << 16;

export type FuzzyScorerCache = { [key: string]: IItemScore };

function getCacheHash(label: string, description: string | undefined, allowNonContiguousMatches: boolean, query: IPreparedQuery) {
  const values = query.values ? query.values : [query];
  const cacheHash = [
    query.normalized,
    label,
    description ?? '',
    allowNonContiguousMatches ? '1' : '0',
    values.map(v => `${v.normalized}:${v.expectContiguousMatch ? '1' : '0'}`).join(',')
  ].join('\u0000');
  return cacheHash;
}

export function scoreItemFuzzy<T>(item: T, query: IPreparedQuery, allowNonContiguousMatches: boolean, accessor: IItemAccessor<T>, cache: FuzzyScorerCache): IItemScore {
  if (!item || !query.normalized) {
    return NO_ITEM_SCORE; // we need an item and query to score on at least
  }

  const label = accessor.getItemLabel(item);
  if (!label) {
    return NO_ITEM_SCORE; // we need a label at least
  }

  const description = accessor.getItemDescription(item);

  // in order to speed up scoring, we cache the score with a unique hash based on:
  // - label
  // - description (if provided)
  // - whether non-contiguous matching is enabled or not
  // - the (normalized) query values
  const cacheHash = getCacheHash(label, description, allowNonContiguousMatches, query);
  const cached = cache[cacheHash];
  if (cached) {
    return cached;
  }

  const itemScore = doScoreItemFuzzy(label, description, accessor.getItemPath(item), query, allowNonContiguousMatches);
  cache[cacheHash] = itemScore;

  return itemScore;
}

function doScoreItemFuzzy(label: string, description: string | undefined, path: string | undefined, query: IPreparedQuery, allowNonContiguousMatches: boolean): IItemScore {
  const preferLabelMatches = !path || !query.containsPathSeparator;

  // Treat identity matches on full path highest
  if (path && equalsIgnoreCase(query.pathNormalized, path)) {
    return { score: PATH_IDENTITY_SCORE, labelMatch: [{ start: 0, end: label.length }], descriptionMatch: description ? [{ start: 0, end: description.length }] : undefined };
  }

  // Score: multiple inputs
  if (query.values && query.values.length > 1) {
    return doScoreItemFuzzyMultiple(label, description, path, query.values, preferLabelMatches, allowNonContiguousMatches);
  }

  // Score: single input
  return doScoreItemFuzzySingle(label, description, path, query, preferLabelMatches, allowNonContiguousMatches);
}

function doScoreItemFuzzyMultiple(label: string, description: string | undefined, path: string | undefined, query: IPreparedQueryPiece[], preferLabelMatches: boolean, allowNonContiguousMatches: boolean): IItemScore {
  let totalScore = 0;
  const totalLabelMatches: IMatch[] = [];
  const totalDescriptionMatches: IMatch[] = [];

  for (const queryPiece of query) {
    const { score, labelMatch, descriptionMatch } = doScoreItemFuzzySingle(label, description, path, queryPiece, preferLabelMatches, allowNonContiguousMatches);
    if (score === NO_MATCH) {
      // if a single query value does not match, return with
      // no score entirely, we require all queries to match
      return NO_ITEM_SCORE;
    }

    totalScore += score;
    if (labelMatch) {
      totalLabelMatches.push(...labelMatch);
    }

    if (descriptionMatch) {
      totalDescriptionMatches.push(...descriptionMatch);
    }
  }

  // if we have a score, ensure that the positions are
  // sorted in ascending order and distinct
  return {
    score: totalScore,
    labelMatch: normalizeMatches(totalLabelMatches),
    descriptionMatch: normalizeMatches(totalDescriptionMatches)
  };
}

function doScoreItemFuzzySingle(label: string, description: string | undefined, path: string | undefined, query: IPreparedQueryPiece, preferLabelMatches: boolean, allowNonContiguousMatches: boolean): IItemScore {

  // Prefer label matches if told so or we have no description
  if (preferLabelMatches || !description) {
    const [labelScore, labelPositions] = scoreFuzzy(
      label,
      query.normalized,
      query.normalizedLowercase,
      allowNonContiguousMatches && !query.expectContiguousMatch);
    if (labelScore) {

      // If we have a prefix match on the label, we give a much
      // higher baseScore to elevate these results over others
      // This ensures that typing a file name wins over results
      // that are present somewhere in the label, but not the
      // beginning.
      const labelPrefixMatch = matchesPrefix(query.normalized, label);
      let baseScore: number;
      if (labelPrefixMatch) {
        baseScore = LABEL_PREFIX_SCORE_THRESHOLD;

        // We give another boost to labels that are short, e.g. given
        // files "window.ts" and "windowActions.ts" and a query of
        // "window", we want "window.ts" to receive a higher score.
        // As such we compute the percentage the query has within the
        // label and add that to the baseScore.
        const prefixLengthBoost = Math.round((query.normalized.length / label.length) * 100);
        baseScore += prefixLengthBoost;
      } else {
        baseScore = LABEL_SCORE_THRESHOLD;
      }

      return { score: baseScore + labelScore, labelMatch: labelPrefixMatch || createMatchesFromPositions(labelPositions) };
    }
  }

  // Finally compute description + label scores if we have a description
  if (description) {
    let descriptionPrefix = description;
    if (!!path) {
      descriptionPrefix = `${description}${SEP}`; // assume this is a file path
    }

    const descriptionPrefixLength = descriptionPrefix.length;
    const descriptionAndLabel = `${descriptionPrefix}${label}`;

    const [labelDescriptionScore, labelDescriptionPositions] = scoreFuzzy(
      descriptionAndLabel,
      query.normalized,
      query.normalizedLowercase,
      allowNonContiguousMatches && !query.expectContiguousMatch);
    if (labelDescriptionScore) {
      const labelDescriptionMatches = createMatchesFromPositions(labelDescriptionPositions);
      const labelMatch: IMatch[] = [];
      const descriptionMatch: IMatch[] = [];

      // We have to split the matches back onto the label and description portions
      labelDescriptionMatches.forEach(h => {

        // Match overlaps label and description part, we need to split it up
        if (h.start < descriptionPrefixLength && h.end > descriptionPrefixLength) {
          labelMatch.push({ start: 0, end: h.end - descriptionPrefixLength });
          descriptionMatch.push({ start: h.start, end: descriptionPrefixLength });
        }

        // Match on label part
        else if (h.start >= descriptionPrefixLength) {
          labelMatch.push({ start: h.start - descriptionPrefixLength, end: h.end - descriptionPrefixLength });
        }

        // Match on description part
        else {
          descriptionMatch.push(h);
        }
      });

      return { score: labelDescriptionScore, labelMatch, descriptionMatch };
    }
  }

  return NO_ITEM_SCORE;
}

function createMatchesFromPositions(offsets: number[] | undefined): IMatch[] {
  const ret: IMatch[] = [];
  if (!offsets) {
    return ret;
  }

  let last: IMatch | undefined;
  for (const pos of offsets) {
    if (last && last.end === pos) {
      last.end += 1;
    } else {
      last = { start: pos, end: pos + 1 };
      ret.push(last);
    }
  }

  return ret;
}

function normalizeMatches(matches: IMatch[]): IMatch[] {

  // sort matches by start to be able to normalize
  const sortedMatches = matches.sort((matchA, matchB) => {
    return matchA.start - matchB.start;
  });

  // merge matches that overlap
  const normalizedMatches: IMatch[] = [];
  let currentMatch: IMatch | undefined = undefined;
  for (const match of sortedMatches) {

    // if we have no current match or the matches
    // do not overlap, we take it as is and remember
    // it for future merging
    if (!currentMatch || !matchOverlaps(currentMatch, match)) {
      currentMatch = match;
      normalizedMatches.push(match);
    }

    // otherwise we merge the matches
    else {
      currentMatch.start = Math.min(currentMatch.start, match.start);
      currentMatch.end = Math.max(currentMatch.end, match.end);
    }
  }

  return normalizedMatches;
}

function matchOverlaps(matchA: IMatch, matchB: IMatch): boolean {
  if (matchA.end < matchB.start) {
    return false;	// A ends before B starts
  }

  if (matchB.end < matchA.start) {
    return false; // B ends before A starts
  }

  return true;
}

//#endregion

//#region --- fuzzyScorer.ts: comparers ---

export function compareItemsByFuzzyScore<T>(itemA: T, itemB: T, query: IPreparedQuery, allowNonContiguousMatches: boolean, accessor: IItemAccessor<T>, cache: FuzzyScorerCache): number {
  const itemScoreA = scoreItemFuzzy(itemA, query, allowNonContiguousMatches, accessor, cache);
  const itemScoreB = scoreItemFuzzy(itemB, query, allowNonContiguousMatches, accessor, cache);

  const scoreA = itemScoreA.score;
  const scoreB = itemScoreB.score;

  // 1.) identity matches have highest score
  if (scoreA === PATH_IDENTITY_SCORE || scoreB === PATH_IDENTITY_SCORE) {
    if (scoreA !== scoreB) {
      return scoreA === PATH_IDENTITY_SCORE ? -1 : 1;
    }
  }

  // 2.) matches on label are considered higher compared to label+description matches
  if (scoreA > LABEL_SCORE_THRESHOLD || scoreB > LABEL_SCORE_THRESHOLD) {
    if (scoreA !== scoreB) {
      return scoreA > scoreB ? -1 : 1;
    }

    // prefer more compact matches over longer in label (unless this is a prefix match where
    // longer prefix matches are actually preferred)
    if (scoreA < LABEL_PREFIX_SCORE_THRESHOLD && scoreB < LABEL_PREFIX_SCORE_THRESHOLD) {
      const comparedByMatchLength = compareByMatchLength(itemScoreA.labelMatch, itemScoreB.labelMatch);
      if (comparedByMatchLength !== 0) {
        return comparedByMatchLength;
      }
    }

    // prefer shorter labels over longer labels
    const labelA = accessor.getItemLabel(itemA) || '';
    const labelB = accessor.getItemLabel(itemB) || '';
    if (labelA.length !== labelB.length) {
      return labelA.length - labelB.length;
    }
  }

  // 3.) compare by score in label+description
  if (scoreA !== scoreB) {
    return scoreA > scoreB ? -1 : 1;
  }

  // 4.) scores are identical: prefer matches in label over non-label matches
  const itemAHasLabelMatches = Array.isArray(itemScoreA.labelMatch) && itemScoreA.labelMatch.length > 0;
  const itemBHasLabelMatches = Array.isArray(itemScoreB.labelMatch) && itemScoreB.labelMatch.length > 0;
  if (itemAHasLabelMatches && !itemBHasLabelMatches) {
    return -1;
  } else if (itemBHasLabelMatches && !itemAHasLabelMatches) {
    return 1;
  }

  // 5.) scores are identical: prefer more compact matches (label and description)
  const itemAMatchDistance = computeLabelAndDescriptionMatchDistance(itemA, itemScoreA, accessor);
  const itemBMatchDistance = computeLabelAndDescriptionMatchDistance(itemB, itemScoreB, accessor);
  if (itemAMatchDistance && itemBMatchDistance && itemAMatchDistance !== itemBMatchDistance) {
    return itemBMatchDistance > itemAMatchDistance ? -1 : 1;
  }

  // 6.) scores are identical: start to use the fallback compare
  return fallbackCompare(itemA, itemB, query, accessor);
}

function computeLabelAndDescriptionMatchDistance<T>(item: T, score: IItemScore, accessor: IItemAccessor<T>): number {
  let matchStart: number = -1;
  let matchEnd: number = -1;

  // If we have description matches, the start is first of description match
  if (score.descriptionMatch && score.descriptionMatch.length) {
    matchStart = score.descriptionMatch[0].start;
  }

  // Otherwise, the start is the first label match
  else if (score.labelMatch && score.labelMatch.length) {
    matchStart = score.labelMatch[0].start;
  }

  // If we have label match, the end is the last label match
  // If we had a description match, we add the length of the description
  // as offset to the end to indicate this.
  if (score.labelMatch && score.labelMatch.length) {
    matchEnd = score.labelMatch[score.labelMatch.length - 1].end;
    if (score.descriptionMatch && score.descriptionMatch.length) {
      const itemDescription = accessor.getItemDescription(item);
      if (itemDescription) {
        matchEnd += itemDescription.length;
      }
    }
  }

  // If we have just a description match, the end is the last description match
  else if (score.descriptionMatch && score.descriptionMatch.length) {
    matchEnd = score.descriptionMatch[score.descriptionMatch.length - 1].end;
  }

  return matchEnd - matchStart;
}

function compareByMatchLength(matchesA?: IMatch[], matchesB?: IMatch[]): number {
  if ((!matchesA && !matchesB) || ((!matchesA || !matchesA.length) && (!matchesB || !matchesB.length))) {
    return 0; // make sure to not cause bad comparing when matches are not provided
  }

  if (!matchesB || !matchesB.length) {
    return -1;
  }

  if (!matchesA || !matchesA.length) {
    return 1;
  }

  // Compute match length of A (first to last match)
  const matchStartA = matchesA[0].start;
  const matchEndA = matchesA[matchesA.length - 1].end;
  const matchLengthA = matchEndA - matchStartA;

  // Compute match length of B (first to last match)
  const matchStartB = matchesB[0].start;
  const matchEndB = matchesB[matchesB.length - 1].end;
  const matchLengthB = matchEndB - matchStartB;

  // Prefer shorter match length
  return matchLengthA === matchLengthB ? 0 : matchLengthB < matchLengthA ? 1 : -1;
}

function fallbackCompare<T>(itemA: T, itemB: T, query: IPreparedQuery, accessor: IItemAccessor<T>): number {

  // check for label + description length and prefer shorter
  const labelA = accessor.getItemLabel(itemA) || '';
  const labelB = accessor.getItemLabel(itemB) || '';

  const descriptionA = accessor.getItemDescription(itemA);
  const descriptionB = accessor.getItemDescription(itemB);

  const labelDescriptionALength = labelA.length + (descriptionA ? descriptionA.length : 0);
  const labelDescriptionBLength = labelB.length + (descriptionB ? descriptionB.length : 0);

  if (labelDescriptionALength !== labelDescriptionBLength) {
    return labelDescriptionALength - labelDescriptionBLength;
  }

  // check for path length and prefer shorter
  const pathA = accessor.getItemPath(itemA);
  const pathB = accessor.getItemPath(itemB);

  if (pathA && pathB && pathA.length !== pathB.length) {
    return pathA.length - pathB.length;
  }

  // 7.) finally we have equal scores and equal length, we fallback to comparer

  // compare by label
  if (labelA !== labelB) {
    return compareAnything(labelA, labelB, query.normalized);
  }

  // compare by description
  if (descriptionA && descriptionB && descriptionA !== descriptionB) {
    return compareAnything(descriptionA, descriptionB, query.normalized);
  }

  // compare by path
  if (pathA && pathB && pathA !== pathB) {
    return compareAnything(pathA, pathB, query.normalized);
  }

  // equal
  return 0;
}

// --- compareAnything / compareFileNames (from vs/base/common/comparers.ts) ---

// A collator with numeric sorting enabled, and no sensitivity to case, accents or diacritics.
const intlFileNameCollatorBaseNumeric: { collator: Intl.Collator; collatorIsNumeric: boolean } = (() => {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return {
    collator,
    collatorIsNumeric: collator.resolvedOptions().numeric === true
  };
})();

function compareFileNames(one: string | null, other: string | null): number {
  const a = one || '';
  const b = other || '';
  const result = intlFileNameCollatorBaseNumeric.collator.compare(a, b);

  // Using the numeric option will make compare(`foo1`, `foo01`) === 0. Disambiguate.
  if (intlFileNameCollatorBaseNumeric.collatorIsNumeric && result === 0 && a !== b) {
    return a < b ? -1 : 1;
  }

  return result;
}

export function compareAnything(one: string, other: string, lookFor: string): number {
  const elementAName = one.toLowerCase();
  const elementBName = other.toLowerCase();

  // Sort prefix matches over non prefix matches
  const prefixCompare = compareByPrefix(one, other, lookFor);
  if (prefixCompare) {
    return prefixCompare;
  }

  // Sort suffix matches over non suffix matches
  const elementASuffixMatch = elementAName.endsWith(lookFor);
  const elementBSuffixMatch = elementBName.endsWith(lookFor);
  if (elementASuffixMatch !== elementBSuffixMatch) {
    return elementASuffixMatch ? -1 : 1;
  }

  // Understand file names
  const r = compareFileNames(elementAName, elementBName);
  if (r !== 0) {
    return r;
  }

  // Compare by name
  return elementAName.localeCompare(elementBName);
}

export function compareByPrefix(one: string, other: string, lookFor: string): number {
  const elementAName = one.toLowerCase();
  const elementBName = other.toLowerCase();

  // Sort prefix matches over non prefix matches
  const elementAPrefixMatch = elementAName.startsWith(lookFor);
  const elementBPrefixMatch = elementBName.startsWith(lookFor);
  if (elementAPrefixMatch !== elementBPrefixMatch) {
    return elementAPrefixMatch ? -1 : 1;
  }

  // Same prefix: Sort shorter matches to the top to have those on top that match more precisely
  else if (elementAPrefixMatch && elementBPrefixMatch) {
    if (elementAName.length < elementBName.length) {
      return -1;
    }

    if (elementAName.length > elementBName.length) {
      return 1;
    }
  }

  return 0;
}

//#endregion

//#region --- fuzzyScorer.ts: query normalizer (prepareQuery) ---

export interface IPreparedQueryPiece {

  /**
   * The original query as provided as input.
   */
  original: string;
  originalLowercase: string;

  /**
   * Original normalized to path separators (always '/' here).
   */
  pathNormalized: string;

  /**
   * In addition to the normalized path, will have
   * whitespace and wildcards removed.
   */
  normalized: string;
  normalizedLowercase: string;

  /**
   * The query is wrapped in quotes which means
   * this query must be a substring of the input.
   * In other words, no fuzzy matching is used.
   */
  expectContiguousMatch: boolean;
}

export interface IPreparedQuery extends IPreparedQueryPiece {

  /**
   * Query split by spaces into pieces.
   */
  values: IPreparedQueryPiece[] | undefined;

  /**
   * Whether the query contains path separator(s) or not.
   */
  containsPathSeparator: boolean;
}

const SEP = '/';

/*
 * If a query is wrapped in quotes, the user does not want to
 * use fuzzy search for this query.
 */
function queryExpectsExactMatch(query: string) {
  return query.startsWith('"') && query.endsWith('"');
}

/**
 * Helper function to prepare a search value for scoring by removing unwanted characters
 * and allowing to score on multiple pieces separated by whitespace character.
 */
const MULTIPLE_QUERY_VALUES_SEPARATOR = ' ';
export function prepareQuery(original: string): IPreparedQuery {
  if (typeof original !== 'string') {
    original = '';
  }

  const originalLowercase = original.toLowerCase();
  const { pathNormalized, normalized, normalizedLowercase } = normalizeQuery(original);
  const containsPathSeparator = pathNormalized.indexOf(SEP) >= 0;
  const expectExactMatch = queryExpectsExactMatch(original);

  let values: IPreparedQueryPiece[] | undefined = undefined;

  const originalSplit = original.split(MULTIPLE_QUERY_VALUES_SEPARATOR);
  if (originalSplit.length > 1) {
    for (const originalPiece of originalSplit) {
      const expectExactMatchPiece = queryExpectsExactMatch(originalPiece);
      const {
        pathNormalized: pathNormalizedPiece,
        normalized: normalizedPiece,
        normalizedLowercase: normalizedLowercasePiece
      } = normalizeQuery(originalPiece);

      if (normalizedPiece) {
        if (!values) {
          values = [];
        }

        values.push({
          original: originalPiece,
          originalLowercase: originalPiece.toLowerCase(),
          pathNormalized: pathNormalizedPiece,
          normalized: normalizedPiece,
          normalizedLowercase: normalizedLowercasePiece,
          expectContiguousMatch: expectExactMatchPiece
        });
      }
    }
  }

  return { original, originalLowercase, pathNormalized, normalized, normalizedLowercase, values, containsPathSeparator, expectContiguousMatch: expectExactMatch };
}

function normalizeQuery(original: string): { pathNormalized: string; normalized: string; normalizedLowercase: string } {
  // ShadRox paths are '/'-normalized; map any user-typed backslash onto '/'
  // (equivalent to the isWindows branch of the VSCode original).
  const pathNormalized = original.replace(/\\/g, SEP);

  // we remove quotes here because quotes are used for exact match search
  const normalized = stripWildcards(pathNormalized).replace(/\s|"/g, '');

  return {
    pathNormalized,
    normalized,
    normalizedLowercase: normalized.toLowerCase()
  };
}

export function pieceToQuery(piece: IPreparedQueryPiece): IPreparedQuery;
export function pieceToQuery(pieces: IPreparedQueryPiece[]): IPreparedQuery;
export function pieceToQuery(arg1: IPreparedQueryPiece | IPreparedQueryPiece[]): IPreparedQuery {
  if (Array.isArray(arg1)) {
    return prepareQuery(arg1.map(piece => piece.original).join(MULTIPLE_QUERY_VALUES_SEPARATOR));
  }

  return prepareQuery(arg1.original);
}

//#endregion

//#region --- ShadRox layer: `+`/`~` filter tokens + ranked-search entry points ---

export interface IQueryTokens {
  /** Tokens after `+`: the candidate text must contain each of them (substring). */
  include: string[];
  /** Tokens after `~`: the candidate text must not contain any of them (substring). */
  exclude: string[];
  /** The remaining fuzzy query (everything that was not a `+`/`~` token). */
  query: string;
}

/**
 * Split a raw quick-open/palette query into `+include` / `~exclude` filter
 * tokens plus the fuzzy part. `+` and `~` are only treated as filters when
 * they start a token and are followed by at least one character. A query
 * consisting only of filter tokens still filters (fzf-vim semantics).
 */
export function parseQueryTokens(raw: string): IQueryTokens {
  const include: string[] = [];
  const exclude: string[] = [];
  const rest: string[] = [];

  for (const token of raw.split(MULTIPLE_QUERY_VALUES_SEPARATOR)) {
    if (!token) {
      continue;
    }
    if ((token[0] === '+' || token[0] === '~') && token.length > 1) {
      const value = token.slice(1).toLowerCase();
      if (!value) continue;
      if (token[0] === '+') include.push(value);
      else exclude.push(value);
    } else {
      rest.push(token);
    }
  }

  return { include, exclude, query: rest.join(MULTIPLE_QUERY_VALUES_SEPARATOR).trim() };
}

function passesFilterTokens(tokens: IQueryTokens, text: string): boolean {
  const lower = text.toLowerCase();
  for (const needle of tokens.include) {
    if (!lower.includes(needle)) {
      return false;
    }
  }
  for (const needle of tokens.exclude) {
    if (lower.includes(needle)) {
      return false;
    }
  }
  return true;
}

export interface FuzzyRankedResult<T> {
  item: T;
  score: number;
  labelMatch?: IMatch[];
  descriptionMatch?: IMatch[];
}

/**
 * The drop-in ranking entry point: same shape as the old ad-hoc matchers
 * (query + candidates in, best-first ordered list out), with fzf-quality
 * scoring, path tie-breaks and match positions for highlighting.
 *
 * When the fuzzy part of the query is empty, every candidate that passes the
 * `+`/`~` filters is returned in input order.
 */
export function rankByFuzzy<T>(
  rawQuery: string,
  items: readonly T[],
  accessor: IItemAccessor<T>,
  options?: { limit?: number; allowNonContiguousMatches?: boolean }
): FuzzyRankedResult<T>[] {
  const tokens = parseQueryTokens(rawQuery.trim());

  const filtered = items.filter((item) => {
    const label = accessor.getItemLabel(item) ?? '';
    const description = accessor.getItemDescription(item);
    const path = accessor.getItemPath(item);
    const haystack = path ?? `${description ? `${description}/` : ''}${label}`;
    return passesFilterTokens(tokens, haystack);
  });

  if (!tokens.query) {
    return filtered.map((item) => ({ item, score: 1 }));
  }

  const preparedQuery = prepareQuery(tokens.query);
  const allowNonContiguous = options?.allowNonContiguousMatches ?? !preparedQuery.expectContiguousMatch;
  const cache: FuzzyScorerCache = Object.create(null);

  const scored = filtered
    .map((item) => ({ item, ...scoreItemFuzzy(item, preparedQuery, allowNonContiguous, accessor, cache) }))
    .filter((entry) => entry.score > 0);

  scored.sort((entryA, entryB) => compareItemsByFuzzyScore(entryA.item, entryB.item, preparedQuery, allowNonContiguous, accessor, cache));

  const limit = options?.limit;
  return typeof limit === 'number' ? scored.slice(0, limit) : scored;
}

/** '/'-aware basename/dirname — ShadRox workspace paths are always slash-normalized. */
export function pathBasename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? p : p.slice(idx + 1);
}

export function pathDirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? '' : p.slice(0, idx);
}

/**
 * Accessor for plain '/'-normalized path strings, mirroring the VSCode file
 * accessors: label = basename, description = dirname, path = full path. This
 * is what gives `fuzzyScorer` the win on `src/lib/search/fuzzyScorer.ts` and
 * lets `search/fuzzy` beat scattered single-letter matches.
 */
export const pathAccessor: IItemAccessor<string> = {
  getItemLabel: (path) => pathBasename(path),
  getItemDescription: (path) => {
    const dir = pathDirname(path);
    return dir || undefined;
  },
  getItemPath: (path) => path
};

/** Convenience wrapper over `rankByFuzzy` for file-path candidates. */
export function rankFilesByFuzzy(rawQuery: string, paths: readonly string[], limit?: number): FuzzyRankedResult<string>[] {
  return rankByFuzzy(rawQuery, paths, pathAccessor, { limit });
}

//#endregion
