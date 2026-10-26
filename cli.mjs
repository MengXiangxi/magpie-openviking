#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { configuration } from './lib/config.mjs';
import { Store } from './lib/store.mjs';
import { drain } from './lib/plugin.mjs';

const [command, file, ...flags] = process.argv.slice(2);
if (!['status', 'flush'].includes(command) || !file || flags.some(f => f !== '--watch')) {
  console.error('Usage: node cli.mjs status|flush /absolute/path/options.local.json [--watch]');
  process.exitCode = 2;
} else {
  try {
    const options = JSON.parse(await readFile(file, 'utf8'));
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
        for (const id of await store.ids()) {
          await store.withState(id, async (state) => {
            if (state.binding === config.binding) rows.push({
              id, session: state.ovSession, replayRecords: Object.keys(state.records).length,
              candidate: Boolean(state.candidate),
              pending: state.outbox.filter(e => e.status === 'pending').length,
              uncertain: state.outbox.filter(e => e.status === 'uncertain').length
            });
          }, { create: false });
        }
        console.log(JSON.stringify(rows, null, 2));
      }
      if (flags.includes('--watch') && running) await sleep(1000);
      else break;
    } while (running);
  } catch {
    console.error('Operation failed. Check the options, credential environment variable and local state permissions. No request content is printed.');
    process.exitCode = 1;
  }
}
