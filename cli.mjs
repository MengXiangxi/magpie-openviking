#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { configuration, stateDirectory } from './lib/config.mjs';
import { Store, unlockStale } from './lib/store.mjs';
import { drain } from './lib/plugin.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const force = args.includes('--force');
const watch = args.includes('--watch');
const positional = args.filter(argument => !argument.startsWith('--'));
const knownFlags = new Set(['--force', '--watch']);
const unknownFlag = args.some(argument => argument.startsWith('--') && !knownFlags.has(argument));
const validArity = command === 'unlock'
  ? positional.length <= 2 && !watch
  : positional.length === 1 && !force;

async function readOptions(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

if (!['status', 'flush', 'unlock'].includes(command) || unknownFlag || !validArity) {
  console.error('Usage: node cli.mjs status|flush /absolute/path/options.local.json [--watch]');
  console.error('       node cli.mjs unlock [--force] [/absolute/path/options.local.json] [state-id]');
  process.exitCode = 2;
} else {
  try {
    if (command === 'unlock') {
      let options = {};
      let id;
      for (const value of positional) {
        if (/^[a-f0-9]{64}$/.test(value)) id = value;
        else if (value.endsWith('.json')) options = await readOptions(value);
        else throw new Error('invalid unlock argument');
      }
      const rows = await unlockStale(stateDirectory(options), { force, id });
      console.log(JSON.stringify(rows, null, 2));
      if (rows.some(row => row.action === 'refused')) {
        console.error('A live process still owns at least one lock. Stop every host/worker using this directory, then retry.');
        process.exitCode = 1;
      } else if (rows.some(row => row.action === 'manual')) {
        console.error('Some locks could not be verified as stale. Inspect them, then retry with --force only if certain no process is running.');
        process.exitCode = 1;
      }
    } else {
      if (!positional.length) throw new Error('missing options file');
      const file = positional[0];
      const options = await readOptions(file);
      const config = configuration(options);
      if (!config) throw new Error('disabled');
      let running = true;
      process.on('SIGINT', () => { running = false; });
      process.on('SIGTERM', () => { running = false; });
      do {
        if (command === 'flush') console.log(JSON.stringify(await drain(options)));
        else {
          const rows = [];
          const store = new Store(config.stateDir);
          const now = Date.now();
          for (const id of await store.ids()) {
            await store.withState(id, async (state) => {
              if (state.binding !== config.binding) return;
              const pending = state.outbox.filter(e => e.status === 'pending');
              const ages = state.outbox.map(e => e.at).filter(at => Number.isFinite(at));
              rows.push({
                id,
                label: state.label ?? null,
                ovSession: state.ovSession,
                createdAt: state.createdAt ? new Date(state.createdAt).toISOString() : null,
                lastUsedAt: state.updated ? new Date(state.updated).toISOString() : null,
                replayRecords: Object.keys(state.records).length,
                candidate: Boolean(state.candidate),
                candidateAgeSeconds: state.candidate?.at ? Math.max(0, Math.round((now - state.candidate.at) / 1000)) : null,
                pending: pending.length,
                pendingOldestAgeSeconds: ages.length ? Math.max(0, Math.round((now - Math.min(...ages)) / 1000)) : null,
                uncertain: state.outbox.filter(e => e.status === 'uncertain').length
              });
            }, { create: false });
          }
          rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
          console.log(JSON.stringify(rows, null, 2));
        }
        if (watch && running) await sleep(1000);
        else break;
      } while (running);
    }
  } catch {
    console.error('Operation failed. Check the options, credential environment variable and local state permissions. No request content is printed.');
    process.exitCode = 1;
  }
}
