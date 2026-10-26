import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function walk(path) {
  const result = [];
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.state'].includes(e.name)) continue;
    const p = join(path, e.name);
    if (e.isDirectory()) result.push(...await walk(p));
    else if (e.name.endsWith('.mjs')) result.push(p);
  }
  return result;
}

for (const path of await walk('.')) {
  const r = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(1);
}
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.magpie?.hooks !== './hooks.mjs' || !manifest.keywords.includes('magpie-plugin') || manifest.license !== 'MIT') process.exit(1);
console.log('Syntax and Magpie package metadata checked.');
