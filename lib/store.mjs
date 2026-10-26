import { mkdir, open, readFile, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export class Busy extends Error {}

export class Store {
  constructor(directory) { this.directory = directory; }

  async withState(id, operation, { create = true } = {}) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid state id');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${id}.json`);
    const lock = `${file}.lock`;
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Never steal a lock: a slow writer or PID reuse must not corrupt replay.
      // After a crash, stop every host using this directory before removing a stale .lock.
      throw new Busy();
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
      let state;
      try { state = JSON.parse(await readFile(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!state && !create) return null;
      state ??= { version: 1, records: {}, outbox: [], delivered: [], candidate: null, updated: Date.now() };
      if (state.version !== 1 || !state.records || !Array.isArray(state.outbox) || !Array.isArray(state.delivered)) throw new Error('invalid state');
      const save = async () => {
        state.updated = Date.now();
        const temporary = `${file}.${randomUUID()}.tmp`;
        const f = await open(temporary, 'wx', 0o600);
        try { await f.writeFile(JSON.stringify(state)); await f.sync(); }
        finally { await f.close(); }
        await rename(temporary, file);
      };
      return await operation(state, save, file);
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }

  async ids() {
    try { return (await readdir(this.directory)).filter(s => /^[a-f0-9]{64}\.json$/.test(s)).map(s => s.slice(0, -5)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
}
