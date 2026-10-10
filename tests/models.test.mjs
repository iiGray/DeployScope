import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as modelsApi from '../backend/models.mjs';
import { fixtureDirectory } from './fixtures/helpers.mjs';

test('directory browsing lists only immediate folders, not files or grandchildren', async t => {
  const { models } = await fixtureDirectory(t);
  await mkdir(join(models, 'Group', 'Nested'), { recursive:true });
  await writeFile(join(models, 'notes.txt'), 'not a folder');
  assert.equal(typeof modelsApi.listDirectories, 'function');
  const result = await modelsApi.listDirectories(models, models);
  assert.equal(result.parent, null);
  assert.deepEqual(result.children.map(c=>c.name), ['Group', 'Qwen']);
  const next = await modelsApi.listDirectories(models, join(models, 'Group'));
  assert.equal(next.parent, result.path);
  assert.deepEqual(next.children.map(c=>c.name), ['Nested']);
});

test('directory browsing refuses traversal, files and links escaping its allowed storage root', async t => {
  const { directory, models } = await fixtureDirectory(t);
  const outside = join(directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(models, 'Escape'), 'dir');
  await symlink(join(models, 'Qwen'), join(models, 'QwenLink'), 'dir');
  assert.equal(typeof modelsApi.listDirectories, 'function');
  const result = await modelsApi.listDirectories(models, models);
  assert.deepEqual(result.children.map(c=>c.name), ['Qwen', 'QwenLink']);
  for (const path of [outside, join(models, 'Escape'), 'relative', join(models,'Qwen/config.json')]) {
    await assert.rejects(modelsApi.listDirectories(models, path), cause=>cause.status===400);
  }
});

test('an empty folder returns an explicit empty next level', async t => {
  const { models } = await fixtureDirectory(t); await mkdir(join(models, 'Empty'));
  assert.equal(typeof modelsApi.listDirectories, 'function');
  assert.deepEqual((await modelsApi.listDirectories(models, join(models, 'Empty'))).children, []);
});
