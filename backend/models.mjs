import { realpath, readdir, stat, access } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname, sep } from 'node:path';
import { ApiError } from './common.mjs';

export async function checkedRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new ApiError(400, '模型目录必须为绝对路径');
  try { const root = await realpath(path); if (!(await stat(root)).isDirectory()) throw new Error(); return root; }
  catch { throw new ApiError(400, '模型目录不存在或不可读'); }
}

export async function checkedDirectory(storageRoot, path) {
  const base = await checkedRoot(storageRoot); const target = await checkedRoot(path);
  const offset = relative(base, target);
  if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) throw new ApiError(400, '目录必须位于允许的模型存储目录内');
  return target;
}

export async function listDirectories(storageRoot, path) {
  const root = await checkedRoot(storageRoot); const directory = await checkedDirectory(root, path);
  let entries;
  try { entries = await readdir(directory, { withFileTypes:true }); }
  catch { throw new ApiError(400, '目录不存在或不可读取'); }
  const children = [];
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const child = join(directory,entry.name);
    try { await checkedDirectory(root,child); children.push({ name:entry.name, path:child }); }
    catch { continue; }
    if (children.length === 500) break;
  }
  return { root, path:directory, parent:directory===root ? null : dirname(directory), children };
}
export async function checkedModel(root, path) {
  const base = await checkedRoot(root);
  let target;
  try { target = await realpath(path); } catch { throw new ApiError(400, '模型路径不存在'); }
  const offset = relative(base, target);
  if (offset.startsWith('..') || isAbsolute(offset)) throw new ApiError(400, '模型路径必须位于当前模型目录内');
  try { if (!(await stat(target)).isDirectory()) throw new Error(); await access(join(target, 'config.json')); }
  catch { throw new ApiError(400, '模型目录缺少 config.json'); }
  return target;
}
export async function scanModels(path) {
  const root = await checkedRoot(path);
  const results = [];
  let visited = 0;
  async function scan(directory, depth) {
    if (visited++ > 500) return;
    try { await access(join(directory, 'config.json')); results.push({ alias: directory === root ? root.split('/').at(-1) : relative(root, directory), path: directory }); return; } catch {}
    if (depth === 0) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && visited <= 500) await scan(join(directory, entry.name), depth - 1);
  }
  await scan(root, 2);
  return results;
}
