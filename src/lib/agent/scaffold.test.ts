import assert from 'node:assert/strict';
import test from 'node:test';
import { detectScaffoldIntent, detectAddPageIntent, scaffoldNudge, addPageNudge, previewNudge, SCAFFOLD_RULE, ADD_PAGE_RULE } from './scaffold';

test('a new-project ask is detected, in English and in the user\'s Hindi phrasing', () => {
  assert.equal(detectScaffoldIntent('build me a landing page'), true);
  assert.equal(detectScaffoldIntent('create a portfolio website'), true);
  assert.equal(detectScaffoldIntent('landing page bana do'), true);
  assert.equal(detectScaffoldIntent('ek dashboard banao'), true);
  assert.equal(detectScaffoldIntent('make a web app for my shop'), true);
});

test('a fix/change verb cancels the scaffold reading', () => {
  assert.equal(detectScaffoldIntent('fix the landing page header'), false);
  assert.equal(detectScaffoldIntent('update my website footer'), false);
  assert.equal(detectScaffoldIntent('refactor the dashboard'), false);
  assert.equal(detectScaffoldIntent('why does this app crash?'), false);
  assert.equal(detectScaffoldIntent(''), false);
});

test('a build verb without a project noun is not a scaffold', () => {
  assert.equal(detectScaffoldIntent('build the parser'), false);
  assert.equal(detectScaffoldIntent('create a function that sorts'), false);
});

test('adding a page is detected and is distinct from scaffolding', () => {
  assert.equal(detectAddPageIntent('add an about page'), true);
  assert.equal(detectAddPageIntent('add a contact section'), true);
  assert.equal(detectAddPageIntent('add a new page for pricing'), true);
  assert.equal(detectAddPageIntent('I need a new section for testimonials'), true);
  // A scaffold ask is not an add-page ask: "create ... page" reads as a new project.
  assert.equal(detectAddPageIntent('build me a landing page'), false);
  assert.equal(detectAddPageIntent('create a new page for pricing'), false);
  assert.equal(detectAddPageIntent('fix the about page'), false);
});

test('the scaffold nudge names the multi-file structure and the SVG logo', () => {
  const nudge = scaffoldNudge(1);
  assert.match(nudge, /finish refused/);
  assert.match(nudge, /only 1 file was created/);
  assert.match(nudge, /styles\.css/);
  assert.match(nudge, /script\.js/);
  assert.match(nudge, /SVG/);
  assert.ok(SCAFFOLD_RULE.includes('at least 3 files'));
});

test('the add-page nudge demands a new linked file, never an append', () => {
  const nudge = addPageNudge();
  assert.match(nudge, /no new file was created/);
  assert.match(nudge, /navigation links/);
  assert.ok(ADD_PAGE_RULE.includes('Never append'));
});

test('the preview nudge carries the verdict detail and the next step', () => {
  const nudge = previewNudge('2 console errors');
  assert.match(nudge, /2 console errors/);
  assert.match(nudge, /preview_control/);
});