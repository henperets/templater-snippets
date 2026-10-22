'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Sync = require('../src/sync');

const item = (id, name, extra) => Object.assign({ id, name, body: 'body of ' + name, type: 'client' }, extra);

test('parseLibrary accepts both the array and the { templates } formats', () => {
  const a = [item('1', 'One')];
  assert.equal(Sync.parseLibrary(a).length, 1);
  assert.equal(Sync.parseLibrary({ version: 1, templates: a }).length, 1);
});

test('parseLibrary rejects wrong shapes and drops invalid items', () => {
  assert.equal(Sync.parseLibrary({ nope: true }), null);
  assert.equal(Sync.parseLibrary('text'), null);
  const out = Sync.parseLibrary([item('1', 'Ok'), { id: '2', name: 'No body' }, item('3', '  ', {}), null]);
  assert.deepEqual(out.map((t) => t.id), ['1']);
});

test('parseLibrary maps legacy or unknown types to "client"', () => {
  const out = Sync.parseLibrary([item('1', 'A', { type: 'template' }), item('2', 'B', { type: undefined }), item('3', 'C', { type: 'guide' })]);
  assert.deepEqual(out.map((t) => t.type), ['client', 'client', 'guide']);
});

test('toLibraryJson strips personal state and round-trips', () => {
  const json = Sync.toLibraryJson([item('1', 'A', { favorited: true, shared: true })]);
  const parsed = JSON.parse(json);
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.templates[0]).sort(), ['body', 'createdAt', 'id', 'name', 'type']);
  assert.equal(Sync.parseLibrary(parsed).length, 1);
});

test('mergeRemote adds new items as shared and unfavorited', () => {
  const r = Sync.mergeRemote([], [item('1', 'A')], []);
  assert.equal(r.added, 1);
  assert.equal(r.list[0].shared, true);
  assert.equal(r.list[0].favorited, false);
});

test('mergeRemote updates shared items but keeps their favorite flag', () => {
  const local = [item('1', 'A', { shared: true, favorited: true })];
  const r = Sync.mergeRemote(local, [item('1', 'A', { body: 'new body' })], []);
  assert.equal(r.updated, 1);
  assert.equal(r.list[0].body, 'new body');
  assert.equal(r.list[0].favorited, true);
});

test('mergeRemote never overwrites a user-owned item with the same id', () => {
  const local = [item('1', 'A', { body: 'mine' })];
  const r = Sync.mergeRemote(local, [item('1', 'A', { body: 'remote' })], []);
  assert.equal(r.changed, false);
  assert.equal(r.list[0].body, 'mine');
});

test('mergeRemote skips remote items whose name matches a user-owned item', () => {
  const local = [item('mine', 'Same Name')];
  const r = Sync.mergeRemote(local, [item('other', 'same name')], []);
  assert.equal(r.added, 0);
  assert.equal(r.list.length, 1);
});

test('mergeRemote removes shared items deleted from the repo, but keeps owned ones', () => {
  const local = [item('1', 'Shared', { shared: true }), item('2', 'Owned')];
  const r = Sync.mergeRemote(local, [], []);
  assert.equal(r.removed, 1);
  assert.deepEqual(r.list.map((t) => t.id), ['2']);
});

test('mergeRemote does not resurrect dismissed items', () => {
  const r = Sync.mergeRemote([], [item('1', 'A')], ['1']);
  assert.equal(r.list.length, 0);
});

test('mergeRemote is idempotent', () => {
  const remote = [item('1', 'A'), item('2', 'B')];
  const first = Sync.mergeRemote([], remote, []);
  const second = Sync.mergeRemote(first.list, remote, []);
  assert.equal(second.changed, false);
});

test('bundled sample library is valid and has unique ids and names', () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates.json'), 'utf8'));
  const list = Sync.parseLibrary(file);
  assert.ok(list.length > 0);
  assert.equal(list.length, file.templates.length, 'every sample item must be valid');
  assert.equal(new Set(list.map((t) => t.id)).size, list.length);
  assert.equal(new Set(list.map((t) => t.name.toLowerCase())).size, list.length);
});
