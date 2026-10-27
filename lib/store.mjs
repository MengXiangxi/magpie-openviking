import { mkdir, open, readFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class Busy extends Error {}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

// Windows antivirus, OneDrive and other file-sync agents commonly hold a file
// for a few milliseconds. Retry only transient filesystem codes.
export async function retryFs(operation, { attempts = 5, delayMs = 20, wait = delay } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await operation(); }
    catch (error) {
      last = error;
      if (!RETRYABLE.has(error?.code) || attempt === attempts - 1) throw error;
      await wait(delayMs * (attempt + 1));
    }
  }
  throw last;
}

const fileSystem = { mkdir, open, readFile, rename, unlink, readdir, stat };

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export class Store {
  constructor(directory, overrides = {}) {
    this.directory = directory;
    this.fs = { ...fileSystem, ...overrides };
  }

  async withState(id, operation, { create = true } = {}) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid state id');
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${id}.json`);
    const lock = `${file}.lock`;
    let handle;
    try { handle = await this.fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Never steal a lock: a slow writer or PID reuse must not corrupt replay.
      // Use `node cli.mjs unlock` to remove a lock whose recorded process is gone.
      throw new Busy();
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
      let state;
      try { state = JSON.parse(await this.fs.readFile(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!state && !create) return null;
      state ??= { version: 1, records: {}, outbox: [], delivered: [], remembered: [], candidate: null, updated: Date.now() };
      if (state.version !== 1 || !state.records || !Array.isArray(state.outbox) || !Array.isArray(state.delivered)) throw new Error('invalid state');
      // Added in v0.2: older files simply have no remember receipts yet.
      if (!Array.isArray(state.remembered)) state.remembered = [];
      const save = async () => {
        state.updated = Date.now();
        const temporary = `${file}.${randomUUID()}.tmp`;
        const f = await this.fs.open(temporary, 'wx', 0o600);
        try { await f.writeFile(JSON.stringify(state)); await f.sync(); }
        finally { await f.close(); }
        try { await retryFs(() => this.fs.rename(temporary, file)); }
        catch (error) {
          await retryFs(() => this.fs.unlink(temporary)).catch(() => {});
          throw error;
        }
      };
      return await operation(state, save, file);
    } finally {
      await handle.close();
      await retryFs(() => this.fs.unlink(lock)).catch(() => {});
    }
  }

  async ids() {
    try { return (await this.fs.readdir(this.directory)).filter(s => /^[a-f0-9]{64}\.json$/.test(s)).map(s => s.slice(0, -5)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
}

// Inspect and optionally remove stale per-state locks. A lock is removed only
// when its recorded process is confirmed gone on this host. Locks owned by
// another host, or whose owner payload is unreadable, require --force (and an
// unreadable lock must also be at least a minute old, so a writer that has not
// finished writing its payload is not raced).
export async function unlockStale(directory, { force = false, id, now = Date.now } = {}) {
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const target = id ? `${id}.json.lock` : null;
  const rows = [];
  for (const name of names.filter(n => n.endsWith('.json.lock'))) {
    if (target && name !== target) continue;
    const lock = join(directory, name);
    let owner = null;
    let ageMs = 0;
    try { owner = JSON.parse(await readFile(lock, 'utf8')); } catch {}
    try { ageMs = now() - (await stat(lock)).mtimeMs; } catch { continue; }
    const local = owner?.host === hostname();
    const live = local && processAlive(owner?.pid);
    const unreadable = !owner || typeof owner.host !== 'string';
    let action;
    if (live) action = 'refused';
    else if (unreadable && !force) action = 'manual';
    else if (unreadable && ageMs < 60000) action = 'manual';
    else if (!local && !force) action = 'manual';
    else action = 'removed';
    if (action === 'removed') await retryFs(() => unlink(lock));
    rows.push({
      id: name.slice(0, -'.json.lock'.length),
      lock,
      owner,
      ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
      action
    });
  }
  return rows;
}
