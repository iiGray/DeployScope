import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
for (const folder of ['src', 'backend', 'scripts', 'tests', 'tests/fixtures']) {
  for (const file of await readdir(folder)) if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', `${folder}/${file}`], { stdio: 'inherit' });
}
execFileSync(process.execPath, ['--check', 'server.mjs'], { stdio: 'inherit' });
console.log('全部 JavaScript 语法检查通过');
