import assert from 'node:assert/strict';
import test from 'node:test';
import { describeKeyFormatProblem, getProviderMeta, looksLikeKeyFor } from './providers';

// Deliberately shorter than a real 39-char Gemini key: GitHub push protection
// treats a full-length AIza string as a leaked credential even inside a test.
const VALID_GEMINI = 'AIza-TEST-KEY-FORMAT-ONLY';
const VALID_GROQ = 'gsk_0123456789abcdefGHIJKLMNOP';
// Same reason: the detector treats a full-length OAuth token as a live
// credential, and the classifier only reads the AQ. prefix.
const SIGN_IN_TOKEN = 'AQ.EXAMPLE-SIGN-IN-TOKEN-NOT-REAL';

test('a well-formed key for its provider reports no problem', () => {
  assert.equal(describeKeyFormatProblem('gemini', VALID_GEMINI), null);
  assert.equal(describeKeyFormatProblem('groq', VALID_GROQ), null);
  assert.equal(looksLikeKeyFor('gemini', VALID_GROQ), false);
});

test('a Google sign-in token is named as one instead of a bad API key', () => {
  const message = describeKeyFormatProblem('gemini', SIGN_IN_TOKEN);
  assert.ok(message);
  assert.match(message, /sign-in token/);
  assert.match(message, /aistudio\.google\.com\/apikey/);
  assert.ok(!message.includes(SIGN_IN_TOKEN), 'the pasted credential must never be echoed back');
});

test('another vendor key explains the mismatch and never echoes the value', () => {
  const openAi = 'sk-proj-0123456789abcdefghij';
  const message = describeKeyFormatProblem('gemini', openAi);
  assert.ok(message);
  assert.match(message, /OpenAI/);
  assert.ok(!message.includes(openAi));
  const groqInGemini = describeKeyFormatProblem('gemini', VALID_GROQ);
  assert.match(groqInGemini ?? '', /Select Groq/);
  const geminiInGroq = describeKeyFormatProblem('groq', VALID_GEMINI);
  assert.match(geminiInGroq ?? '', /Select Google Gemini/);
});

test('anything else falls back to the expected prefix for the provider', () => {
  const message = describeKeyFormatProblem('groq', 'zzz-0123456789abcdefghij');
  assert.match(message ?? '', new RegExp(getProviderMeta('groq').keyPrefix));
  assert.match(message ?? '', /console\.groq\.com\/keys/);
});
