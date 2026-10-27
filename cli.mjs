#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { configuration, stateDirectory } from './lib/config.mjs';
import { Store, unlockStale } from './lib/store.mjs';
import { drain, rememberNow, resolveRemember, reviewRemembers } from './lib/plugin.mjs';

const USAGE = [
  'Usage: node cli.mjs status /absolute/path/options.local.json [--watch]',
  '       node cli.mjs flush /absolute/path/options.local.json [--watch]',
  '       node cli.mjs remember /absolute/path/options.local.json --text "..." | --file path',
  '       node cli.mjs review /absolute/path/options.local.json',
  '       node cli.mjs resolve /absolute/path/options.local.json <event-id> --approve|--retry|--delivered [--state <state-id>]',
  '       node cli.mjs unlock [--force] [/absolute/path/options.local.json] [state-id]'
].join('\n');

const BOOLEAN = new Set(['--force', '--watch', '--approve', '--retry', '--delivered']);
const VALUED = new Set(['--text', '--file', '--state']);

const args = process.argv.slice(2);
const command = args.shift();
const flags = { force: false, watch: false, approve: false, retry: false, delivered: false, text: undefined, file: undefined, state: undefined };
const positional = [];
let unknown = false;
for (let i = 0; i < args.length; i++) {
  const argument = args[i];
  if (BOOLEAN.has(argument)) flags[argument.slice(2)] = true;
  else if (VALUED.has(argument)) {
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) { unknown = true; break; }
    flags[argument.slice(2)] = value;
  } else if (argument.startsWith('--')) { unknown = true; break; }
  else positional.push(argument);
}

const resolution = ['approve', 'retry', 'delivered'].filter(key => flags[key]);
const valid = {
  status: positional.length === 1 && !resolution.length && flags.text === undefined && flags.file === undefined,
  flush: positional.length === 1 && !resolution.length && flags.text === undefined && flags.file === undefined,
  remember: positional.length === 1 && !resolution.length && (flags.text === undefined) !== (flags.file === undefined),
  review: positional.length === 1 && !resolution.length && flags.text === undefined && flags.file === undefined,
  resolve: positional.length === 2 && resolution.length === 1 && flags.text === undefined && flags.file === undefined,
  unlock: positional.length <= 2 && !flags.watch && !resolution.length && flags.text === undefined && flags.file === undefined
};

async function readOptions(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function snapshot(store, config, now) {
  const rows = [];
  for (const id of await store.ids()) {
    await store.withState(id, async (state) => {
      if (state.binding !== config.binding) return;
      const pending = state.outbox.filter(e => e.kind !== 'remember' && e.status === 'pending');
      const remembers = state.outbox.filter(e => e.kind === 'remember');
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
        uncertain: state.outbox.filter(e => e.kind !== 'remember' && e.status === 'uncertain').length,
        // `sent` is a crash window the worker will never resolve by itself, so it
        // must be counted next to `uncertain` rather than as plain pending.
        rememberPending: remembers.filter(e => e.status !== 'sent' && e.status !== 'uncertain').length,
        rememberUncertain: remembers.filter(e => e.status === 'sent' || e.status === 'uncertain').length,
        rememberAwaitingReview: remembers.filter(e => e.needsConfirm).length,
        foreignBinding: state.binding !== config.binding
      });
    }, { create: false });
  }
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return rows;
}

if (!['status', 'flush', 'remember', 'review', 'resolve', 'unlock'].includes(command) || unknown || !valid[command]) {
  console.error(USAGE);
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
      const rows = await unlockStale(stateDirectory(options), { force: flags.force, id });
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
      if (command === 'remember') {
        const statement = flags.text ?? await readFile(flags.file, 'utf8');
        console.log(JSON.stringify(await rememberNow(options, statement), null, 2));
      } else if (command === 'review' || command === 'resolve') {
        if (command === 'review') console.log(JSON.stringify(await reviewRemembers(options), null, 2));
        else {
          const outcome = await resolveRemember(options, positional[1], resolution[0], { stateId: flags.state });
          console.log(JSON.stringify(outcome, null, 2));
          if (!outcome.changed) {
            console.error(`No change: ${outcome.reason}. Inspect the event with \`review\` first.`);
            process.exitCode = 1;
          }
        }
      } else {
        let running = true;
        process.on('SIGINT', () => { running = false; });
        process.on('SIGTERM', () => { running = false; });
        do {
          if (command === 'flush') console.log(JSON.stringify(await drain(options)));
          else console.log(JSON.stringify(await snapshot(new Store(config.stateDir), config, Date.now()), null, 2));
          if (flags.watch && running) await sleep(1000);
          else break;
        } while (running);
      }
    }
  } catch (error) {
    const known = {
      'statement rejected': 'Refused: the text looks like a secret or sensitive identifier.',
      'remember is off': 'Refused: remember is off in these options. Set "remember":"command" to allow explicit writes.',
      'event not found': 'No remember event with that id in this state directory.',
      'invalid resolution': 'Use exactly one of --approve, --retry or --delivered.'
    }[error?.message];
    console.error(known ?? 'Operation failed. Check the options, credential environment variable and local state permissions. No request content is printed.');
    process.exitCode = 1;
  }
}
