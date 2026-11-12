// Checks the DRAFT dictation sentences (drafts/dictation-sentences/sentences.psv, task #4061).
// Rules from the task: every statutory form has one own sentence containing the form exactly once as a
// whole word; Y1/2 sentences up to 8 words, Y3-6 up to 14 (a form in both takes the stricter limit).
// Unpublished: lists.json stays schema 1 until the go decision (#3740) is recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lists = JSON.parse(readFileSync(new URL('../content/uk-statutory/lists.json', import.meta.url), 'utf8')).lists;
const rows = readFileSync(new URL('../drafts/dictation-sentences/sentences.psv', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((l) => {
    assert.equal(l.split('|').length, 3, `3 fields: ${l}`);
    const [form, sentence, conf] = l.split('|');
    return { form, sentence, conf: conf ? conf.split('/') : [] };
  });
const byForm = new Map(rows.map((r) => [r.form, r]));
const words = (s) => s.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];

test('no duplicate rows', () => assert.equal(byForm.size, rows.length));

test('every statutory form has a draft sentence, and nothing extra', () => {
  const forms = new Set(lists.flatMap((l) => l.entries.flatMap((e) => e.forms)));
  assert.deepEqual([...forms].filter((f) => !byForm.has(f)), []);
  assert.deepEqual([...byForm.keys()].filter((f) => !forms.has(f)), []);
});

test('each sentence has the form exactly once as a whole word, within the length limit', () => {
  const limit = new Map();
  for (const l of lists) {
    const n = /^y[12]-/.test(l.id) ? 8 : 14;
    for (const e of l.entries) for (const f of e.forms) limit.set(f, Math.min(limit.get(f) ?? 99, n));
  }
  for (const [form, r] of byForm) {
    const w = words(r.sentence);
    const same = /[A-Z]/.test(form) ? (x) => x === form : (x) => x.toLowerCase() === form;
    assert.equal(w.filter(same).length, 1, `${form}: "${r.sentence}"`);
    assert.ok(w.length <= limit.get(form), `${form}: ${w.length} words > ${limit.get(form)}`);
    assert.match(r.sentence, /[.?!]$/, `${form}: ends with punctuation`);
  }
});

test('confusable_with entries never repeat the form', () => {
  for (const [form, r] of byForm) assert.ok(!r.conf.includes(form), form);
});

test('confusable_with entries are lowercase (bar I) and trimmed', () => {
  for (const [form, r] of byForm) {
    for (const c of r.conf) {
      assert.equal(c, c.trim(), `${form}: ${c}`);
      assert.ok(/^(I|[a-z\u0027]+)$/.test(c), `${form}: ${c}`);
    }
  }
});
