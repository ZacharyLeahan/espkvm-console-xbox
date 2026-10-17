// SPDX-FileCopyrightText: 2026 ESP-KVM contributors
// SPDX-License-Identifier: Apache-2.0
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createSettingsEditor, groupSettings, type EditorState } from '../src/state/settingsEditor.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('old saves preserve newer typing even when text returns to the submitted value', async () => {
  const state: EditorState = { pending: 0, drafts: {} };
  const request = deferred<object>();
  const editor = createSettingsEditor(state, () => request.promise, () => {}, () => {});
  editor.edit('fps', '30');
  const pending = editor.commit('fps', 30);
  await tick();
  editor.edit('fps', '20'); editor.edit('fps', '30');
  request.resolve({ fps: 30 });
  assert.equal(await pending, true);
  assert.equal(editor.shown('fps', '10'), '30');
  assert.ok(state.drafts.fps);
  assert.equal(state.pending, 0);
});

test('full-device replies serialize while drafts for other fields stay editable', async () => {
  const state: EditorState = { pending: 0, drafts: {} };
  const first = deferred<object>(), second = deferred<object>();
  const started: string[] = [], replies: object[] = [];
  const editor = createSettingsEditor(state, (key) => {
    started.push(key); return started.length === 1 ? first.promise : second.promise;
  }, (v) => replies.push(v), () => {});
  editor.edit('a', '1'); const a = editor.commit('a', 1);
  editor.edit('b', '2'); const b = editor.commit('b', 2);
  await tick();
  assert.deepEqual(started, ['a']);
  assert.equal(state.pending, 2);
  assert.equal(editor.shown('b', '0'), '2');
  first.resolve({ a: 1, b: 0 });
  await a; await tick();
  assert.deepEqual(started, ['a', 'b']); assert.equal(state.pending, 1);
  second.resolve({ a: 1, b: 2 }); await b;
  assert.deepEqual(replies, [{ a: 1, b: 0 }, { a: 1, b: 2 }]);
  assert.deepEqual(state.drafts, {}); assert.equal(state.pending, 0);
});

test('failed saves retain their draft and do not poison later saves', async () => {
  const state: EditorState = { pending: 0, drafts: {} };
  const failures: unknown[] = [];
  let attempts = 0;
  const editor = createSettingsEditor(state, async () => {
    if (++attempts === 1) throw new Error('device unavailable');
    return { name: 'kept' };
  }, () => {}, (e) => failures.push(e));
  editor.edit('name', 'kept');
  assert.equal(await editor.commit('name', 'kept'), false);
  assert.equal(editor.shown('name', 'old'), 'kept'); assert.equal(failures.length, 1);
  assert.equal(await editor.commit('name', 'kept'), true);
  assert.deepEqual(state.drafts, {});
});

test('same-field edits reach the device in order', async () => {
  const state: EditorState = { pending: 0, drafts: {} };
  const first = deferred<number>(); const values: unknown[] = [];
  const editor = createSettingsEditor(state, async (_key, value) => {
    values.push(value); return values.length === 1 ? first.promise : 2;
  }, () => {}, () => {});
  editor.edit('x', '1'); const a = editor.commit('x', 1);
  editor.edit('x', '2'); const b = editor.commit('x', 2);
  first.resolve(1); await a; await b;
  assert.deepEqual(values, [1, 2]); assert.deepEqual(state.drafts, {});
});

test('nonadjacent repeated groups have one stable heading', () => {
  const rows = [{ section: 'input', group: 'Target' }, { section: 'input', group: 'Pointer' },
    { section: 'input', group: 'Target' }, { section: 'input' }];
  assert.deepEqual(groupSettings(rows, false, (s) => s).map((g) => [g.key, g.rows.length]),
    [['group:Target', 2], ['group:Pointer', 1], ['group:', 1]]);
});

test('search groups distinguish sections with the same title', () => {
  const groups = groupSettings([{ section: 'one' }, { section: 'two' }], true, () => 'Same');
  assert.deepEqual(groups.map((g) => g.key), ['section:one', 'section:two']);
});
