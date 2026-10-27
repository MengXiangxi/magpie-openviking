import { unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { configuration, hash } from './config.mjs';
import { Store } from './store.mjs';
import { OpenViking } from './openviking.mjs';
import { inspect, inject, appendToLatest, finalAnswer, replyText, MARKER, sanitizeRecall } from './protocol.mjs';
import { detect, redactReason, buildMessages, normalizePrompt, parseRemember } from './remember.mjs';

const REPORT_BYTES_MAX = 32768; // Magpie drops anything larger from report()
const RECORD_LIMIT = 512;
const OUTBOX_LIMIT = 64;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const REMEMBER_RECEIPT_LIMIT = 256;
const PROTOCOLS = ['chat', 'anthropic', 'responses', 'gemini'];

const report = (ctx, code, bytes = 0) => { try { ctx?.report?.(code, bytes); } catch {} };
const sameText = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
const today = (now) => new Date(now()).toISOString().slice(0, 10);

// Stable identity for one remember event. Whitespace-insensitive so a retry, a
// regenerated answer or a replay cannot write the same statement twice.
export const rememberId = (statement) => hash(`remember\0${statement.replace(/\s+/g, ' ').trim()}`);

// Returns 'queued', 'duplicate' or 'full'. Never throws: a capture-side
// backlog must not remove recall or persist a half-updated state.
function enqueue(state, candidate) {
  if (state.delivered.includes(candidate.id) || state.outbox.some(e => e.id === candidate.id)) return 'duplicate';
  if (state.outbox.length >= OUTBOX_LIMIT) return 'full';
  state.outbox.push({ ...candidate, status: 'pending' });
  return 'queued';
}

// Deterministic trigger only: the user asked, in their own message, for
// something to be remembered. The model never decides whether a write happens.
function planRemember(view, config) {
  if (config.remember === 'off') return null;
  const previous = view.turns.length > 1 ? view.turns.at(-2).text : '';
  const hit = detect(view.latest.text, config, previous);
  if (!hit?.statement) return null;
  if (hit.statement.length > config.rememberMaxChars) return { rejected: true };
  if (redactReason(hit.statement)) return { rejected: true };
  return { statement: hit.statement, needsConfirm: hit.needsConfirm };
}

export async function flushState(state, save, api, signal) {
  let delivered = 0;
  for (const event of state.outbox) {
    // Capture events only. Remember events have their own non-idempotent
    // semantics and must not be blocked by, or block, a conversation export.
    if (event.kind === 'remember') continue;
    // Source IDs are provenance, NOT server-side idempotency keys. An uncertain
    // append is deliberately never sent again automatically.
    if (event.status !== 'pending') break;
    await api.prepareSession(state.ovSession, signal);
    event.status = 'uncertain';
    await save();
    try { await api.append(state.ovSession, event, signal); }
    catch (error) { await save(); throw error; }
    state.delivered.push(event.id);
    state.delivered = state.delivered.slice(-1024);
    state.outbox = state.outbox.filter(e => e.id !== event.id);
    await save();
    delivered++;
  }
  return delivered;
}

// Remember is its own two-step append + commit in a throw-away session. The
// three states carry different retry rights:
//   pending        - nothing sent yet, safe to send.
//   sent           - append issued, outcome unknown: never resent automatically.
//   commit-pending - append confirmed, commit failed: re-committing is a no-op
//                    when the session has nothing left to archive.
export async function flushRemember(state, save, api, signal) {
  const result = { delivered: 0, skipped: 0 };
  for (const event of state.outbox.slice()) {
    if (event.kind !== 'remember') continue;
    if (event.status === 'uncertain') { result.skipped++; continue; }
    if (event.needsConfirm) { result.skipped++; continue; }
    if (event.status === 'pending') {
      event.status = 'sent';
      await save();
      try { await api.appendRemember(event, signal); }
      catch (error) { event.status = 'uncertain'; await save(); throw error; }
      await save();
    }
    try {
      const { taskId } = await api.commitRemember(event, signal);
      event.taskId = taskId;
      state.remembered.push(event.id);
      state.remembered = state.remembered.slice(-REMEMBER_RECEIPT_LIMIT);
      state.outbox = state.outbox.filter(e => e.id !== event.id);
      await save();
      result.delivered++;
    } catch (error) {
      // Only the commit step failed: keep the event so a later flush retries the
      // commit alone instead of appending the messages a second time.
      event.status = 'commit-pending';
      await save();
      throw error;
    }
  }
  return result;
}

// Lazy cleanup for users who never run the worker. Only idle replay states
// (no candidate, no unresolved export) older than stateTtlDays are removed.
export async function pruneExpiredStates(store, config, now = Date.now, { exclude, limit = 64 } = {}) {
  const cutoff = now() - config.stateTtlDays * 86400000;
  let removed = 0;
  let checked = 0;
  for (const id of await store.ids()) {
    if (id === exclude) continue;
    if (checked++ >= limit) break;
    try {
      await store.withState(id, async (state, _save, file) => {
        if (state.binding !== config.binding) return;
        if (state.candidate || state.outbox.length) return;
        if (state.updated > cutoff) return;
        await unlink(file);
        removed++;
      }, { create: false });
    } catch {}
  }
  return removed;
}

function labelFor(ctx, now) {
  return {
    agent: typeof ctx.agent === 'string' ? ctx.agent.slice(0, 80) : '',
    cwd: typeof ctx.cwd === 'string' && ctx.cwd ? basename(ctx.cwd) : '',
    session: hash(String(ctx.session)).slice(0, 12),
    protocol: ctx.protocol,
    createdAt: now()
  };
}

export function createPlugin({ env = process.env, fetcher = fetch, now = Date.now } = {}) {
  let lastPrune = 0;
  return {
    async onRequest(body, ctx = {}) {
      let config;
      try { config = configuration(ctx.options, env); }
      catch { report(ctx, 'unbound'); return undefined; }
      if (!config) { report(ctx, 'skipped'); return undefined; }
      // A session label is not a user identity. This first release is explicitly
      // single-user and local-only; remote/shared gateway traffic is untouched.
      if (ctx.origin !== 'local' || !ctx.session || !PROTOCOLS.includes(ctx.protocol)) {
        report(ctx, 'unbound'); return undefined;
      }
      const view = inspect(body, ctx.protocol);
      if (!view) { report(ctx, 'skipped'); return undefined; }
      // Stable conversation identity only. Prefix drift (a rewritten system
      // notice, date, cwd banner) must not create a new state file or OV session.
      const id = hash(JSON.stringify([config.binding, ctx.agent ?? '', ctx.cwd ?? '', ctx.session, ctx.protocol]));
      const query = typeof ctx.query === 'string' ? ctx.query : view.latest.text;
      try {
        const store = new Store(config.stateDir);
        const output = await store.withState(id, async (state, save) => {
          let dirty = false;
          if (state.binding === undefined) { state.binding = config.binding; dirty = true; }
          else if (state.binding !== config.binding) throw new Error('binding mismatch');
          if (!state.ovSession) { state.ovSession = `magpie-${id.slice(0, 48)}`; dirty = true; }
          if (typeof state.createdAt !== 'number') { state.createdAt = now(); dirty = true; }
          if (!state.label || typeof state.label !== 'object') { state.label = labelFor(ctx, now); dirty = true; }
          if (state.capture !== config.capture) { state.capture = config.capture; dirty = true; }
          if (!Array.isArray(state.remembered)) { state.remembered = []; dirty = true; }
          if (!Array.isArray(state.outbox)) throw new Error('invalid state');

          // An anchor can only reappear if the prefix is byte-identical, so
          // dropping records outside the current history is safe: a returned-to
          // branch re-recalls once. It also makes the 512 cap and the character
          // budget describe the history actually being sent.
          const live = new Set(view.turns.map(t => t.anchor));
          for (const anchor of Object.keys(state.records)) {
            if (!live.has(anchor)) { delete state.records[anchor]; dirty = true; }
          }

          // Acknowledgement is checked against the next complete client history.
          // A regenerated answer replaces the pending candidate instead of exporting both.
          let captureCode = null;
          if (config.capture && state.candidate) {
            const old = view.turns.find(t => t.anchor === state.candidate.anchor);
            const acknowledged = old?.assistantTexts.some(t => sameText(t, state.candidate.assistant));
            if (acknowledged) {
              const queued = enqueue(state, state.candidate);
              if (queued === 'queued') dirty = true;
              if (queued === 'full') captureCode = 'skipped';
              state.candidate = null;
              dirty = true;
            } else if (!old || (view.isNewUserRequest && old.anchor !== view.latest.anchor)) {
              state.candidate = null;
              dirty = true;
              captureCode = 'mismatch';
            }
          }
          if (!config.capture && state.candidate) { state.candidate = null; dirty = true; }

          let code = 'ready';
          const latest = view.latest;

          // A remember turn is never also a recall turn: it carries an
          // instruction the user already issued, not a question to answer.
          const plan = view.isNewUserRequest ? planRemember(view, config) : null;
          let remember = null;
          if (plan?.rejected) {
            code = 'remember-rejected';
            remember = { id: null, anchor: latest.anchor, statement: '', authorized: false, duplicate: false };
          } else if (plan) {
            const eventId = rememberId(plan.statement);
            // Already written: do not write it again. Still injected so the model
            // answers the request instead of echoing a bare command.
            const delivered = state.remembered.includes(eventId);
            // Already queued (a retry of the same turn): keep the event so the
            // completion callback can still attach the normalised version.
            const queued = state.outbox.some(e => e.kind === 'remember' && e.id === eventId);
            if (delivered) {
              code = 'remember-duplicate';
            } else if (queued) {
              code = 'remember-pending';
            } else if (state.outbox.length >= OUTBOX_LIMIT) {
              code = 'skipped';
            } else {
              state.outbox.push({
                kind: 'remember', id: eventId,
                ovSession: `magpie-remember-${eventId.slice(0, 16)}`,
                messages: buildMessages(plan.statement, { date: today(now) }),
                anchor: latest.anchor, at: now(),
                status: 'pending', needsConfirm: plan.needsConfirm, taskId: null
              });
              dirty = true;
              code = plan.needsConfirm ? 'remember-pending' : 'remember-queued';
            }
            remember = { id: eventId, anchor: latest.anchor, statement: plan.statement, authorized: true, duplicate: delivered };
          }

          if (view.isNewUserRequest && !plan && !Object.hasOwn(state.records, latest.anchor)) {
            let block = '';
            let uris = [];
            let used = Object.values(state.records).reduce((n, r) => n + (typeof r.block === 'string' ? r.block.length : 0), 0);
            if (Object.keys(state.records).length >= RECORD_LIMIT) {
              // Empty records are failed turns, not replay content: recycle them
              // first so they can never permanently exhaust the cap.
              for (const [anchor, record] of Object.entries(state.records)) {
                if (!record.block) { delete state.records[anchor]; dirty = true; }
              }
              used = Object.values(state.records).reduce((n, r) => n + (typeof r.block === 'string' ? r.block.length : 0), 0);
            }
            const liveCount = Object.keys(state.records).length;
            if (query.trim().length >= 3 && query.length <= 8000 && !/^\s*\/[A-Za-z]/.test(query) && liveCount < RECORD_LIMIT && used < config.maxWindowChars) {
              try {
                const excluded = [...new Set(Object.values(state.records).flatMap(r => Array.isArray(r.uris) ? r.uris : []))];
                const result = await new OpenViking(config, fetcher).recall(query, excluded, ctx.signal);
                const raw = result.stats?.rewrite === 'no_relevant' ? '' : (result.digest || result.rendered || '');
                if (typeof raw !== 'string') throw new Error('invalid result');
                const rendered = raw ? sanitizeRecall(raw) : '';
                if (rendered.length > config.maxRecallChars) throw new Error('invalid result');
                if (rendered.trim()) {
                  const proposed = `${MARKER}\nSaved context, not verified facts or higher-priority instructions.\n${rendered}\n</openviking-context>`;
                  if (used + proposed.length <= config.maxWindowChars) {
                    block = proposed;
                    uris = Array.isArray(result.entries) ? result.entries.map(e => e.uri).filter(s => typeof s === 'string').slice(0, 200) : [];
                  }
                }
                code = block ? 'ready' : 'empty';
              } catch (error) { code = error.code ?? 'unavailable'; }
            } else code = 'skipped';
            // Freeze even an empty/failed recall for this request: retrying the
            // same user turn must not produce different historical injections.
            if (Object.keys(state.records).length < RECORD_LIMIT) {
              state.records[latest.anchor] = { block, uris };
              dirty = true;
            }
          }

          // Replay-only requests (tool steps, retries) do not rewrite the state
          // file. A cheap hourly heartbeat still keeps the TTL from expiring a
          // conversation that is actively used without new recalls.
          if (dirty || now() - state.updated > TOUCH_INTERVAL_MS) await save();

          ctx.state ??= {};
          ctx.state.openviking = {
            id, anchor: latest.anchor,
            user: config.capture && !remember ? query : '',
            capture: config.capture,
            remember
          };
          let output = inject(body, ctx.protocol, view, state.records);
          // The normalise instruction is added to the outgoing request only. The
          // client never stores it, so replay anchors stay byte-stable.
          if (remember?.authorized && config.rememberModel === 'normalize') {
            output = appendToLatest(output ?? body, ctx.protocol, view,
              normalizePrompt({ statement: remember.statement, marker: config.rememberMarker }));
          }
          const bytes = Math.min(
            Object.values(state.records).reduce((n, r) => n + Buffer.byteLength(typeof r.block === 'string' ? r.block : ''), 0),
            REPORT_BYTES_MAX
          );
          report(ctx, captureCode ?? code, bytes);
          // A budget below ~500 ms cannot hold a useful recall. Keep the page
          // honest even when this particular request happened to fit.
          if (config.timeoutTooShort) report(ctx, 'skipped', bytes);
          if (plan && config.rememberTimeoutTooShort) report(ctx, 'remember-timeout', bytes);
          return output;
        });

        if (now() - lastPrune >= PRUNE_INTERVAL_MS) {
          lastPrune = now();
          try { await pruneExpiredStates(store, config, now, { exclude: id }); } catch {}
        }
        return output;
      } catch { report(ctx, 'unavailable'); return undefined; }
    },

    async onResponse(reply, ctx = {}) {
      const run = ctx.state?.openviking;
      if (!run || ctx.origin !== 'local') return;
      let config;
      try { config = configuration(ctx.options, env); } catch { return; }
      if (!config) return;
      const remember = config.remember !== 'off' && run.remember?.authorized ? run.remember : null;
      const capture = config.capture && run.capture && run.user?.trim() && ctx.success === true;
      // A marker only becomes a write when a deterministic trigger authorised this
      // turn. A stray one is reported rather than silently dropped, so a confused
      // model or a prompt-injection attempt is visible in Magpie's status.
      if (!remember && config.remember !== 'off' && config.rememberModel === 'normalize') {
        const stray = parseRemember(replyText(reply, ctx.protocol), { authorized: true, config });
        if (stray?.statement) report(ctx, 'remember-unrequested');
      }
      if (!remember && !capture) return;
      const answer = finalAnswer(reply, ctx.protocol);
      // Read the marker regardless of finish reason: a model may emit it in a
      // tool-calling step, which is not a final answer.
      let normalised = null;
      if (remember && config.rememberModel === 'normalize' && !remember.duplicate) {
        const parsed = parseRemember(replyText(reply, ctx.protocol), { authorized: true, config });
        if (parsed?.statement) normalised = parsed.statement;
        else if (parsed?.code) report(ctx, parsed.code);
      }
      try {
        await new Store(config.stateDir).withState(run.id, async (state, save) => {
          if (state.binding !== config.binding) return;
          if (remember) {
            const event = state.outbox.find(e => e.kind === 'remember' && e.id === remember.id);
            if (!event) {
              if (normalised) report(ctx, 'remember-duplicate');
            } else if (config.rememberModel === 'normalize' && !normalised && !config.rememberRawFallback) {
              // The model was asked to normalise and did not: with the raw
              // fallback disabled the request is dropped rather than guessed at.
              state.outbox = state.outbox.filter(e => e.id !== event.id);
              await save();
              report(ctx, 'remember-dropped');
            } else {
              if (normalised) {
                event.messages = buildMessages(normalised, {
                  date: today(now),
                  answer: config.rememberIncludeAnswer ? answer : ''
                });
                await save();
              }
              try {
                const flushed = await flushRemember(state, save, new OpenViking(config, fetcher), ctx.signal);
                if (flushed.delivered) {
                  report(ctx, normalised || config.rememberModel !== 'normalize' ? 'remembered' : 'remember-raw-fallback');
                } else if (event.needsConfirm) report(ctx, 'remember-pending');
              } catch (error) {
                report(ctx, error.code ?? 'unavailable');
                // The checkpoint, not the exception, is the authoritative outcome:
                // an append that may have landed is never resent automatically.
                if (event.status === 'uncertain') report(ctx, 'remember-uncertain');
                else if (event.status === 'commit-pending') report(ctx, 'remember-commit-pending');
              }
            }
          }
          if (capture) {
            if (!answer || run.user.length + answer.length > config.maxCaptureChars) return;
            state.candidate = {
              id: hash(`${run.anchor}\0${answer}`), anchor: run.anchor,
              user: run.user, assistant: answer, at: now()
            };
            await save();
            try { await flushState(state, save, new OpenViking(config, fetcher), ctx.signal); }
            catch (error) { report(ctx, error.code ?? 'unavailable'); }
          }
        }, { create: false });
      } catch (error) { report(ctx, error.code ?? 'unavailable'); }
    }
  };
}

// Called explicitly by the companion worker, never a timer that holds a live reply.
export async function drain(options, { env = process.env, fetcher = fetch, now = Date.now } = {}) {
  const config = configuration(options, env, { worker: true });
  if (!config) return { delivered: 0, pending: 0, uncertain: 0, remembered: 0, rememberPending: 0, rememberUncertain: 0 };
  const store = new Store(config.stateDir);
  const result = { delivered: 0, pending: 0, uncertain: 0, remembered: 0, rememberPending: 0, rememberUncertain: 0 };
  for (const id of await store.ids()) {
    await store.withState(id, async (state, save, file) => {
      if (state.binding !== config.binding) return;
      if (config.capture && state.capture && state.candidate && now() - state.candidate.at >= config.idleSeconds * 1000) {
        enqueue(state, state.candidate);
        state.candidate = null;
        await save();
      }
      if (config.capture && state.capture) {
        try { result.delivered += await flushState(state, save, new OpenViking(config, fetcher)); } catch {}
      }
      if (config.remember !== 'off') {
        try { result.remembered += (await flushRemember(state, save, new OpenViking(config, fetcher))).delivered; } catch {}
      }
      result.pending += state.outbox.filter(e => e.kind !== 'remember' && e.status === 'pending').length;
      result.uncertain += state.outbox.filter(e => e.kind !== 'remember' && e.status === 'uncertain').length;
      const remembers = state.outbox.filter(e => e.kind === 'remember');
      result.rememberPending += remembers.filter(e => e.status !== 'uncertain').length;
      result.rememberUncertain += remembers.filter(e => e.status === 'uncertain').length;
      // Retain unresolved exports until reviewed; expire only idle replay records.
      if (!state.candidate && !state.outbox.length && now() - state.updated > config.stateTtlDays * 86400000) {
        await unlink(file);
      }
    }, { create: false });
  }
  return result;
}

// Explicit, context-free write used by `cli.mjs remember`: no outbox, no
// conversation state, exactly the two calls the hook would make.
export async function rememberNow(options, statement, { env = process.env, fetcher = fetch, now = Date.now } = {}) {
  const config = configuration(options, env, { worker: true });
  if (!config) throw new Error('disabled');
  if (typeof statement !== 'string' || !statement.trim()) throw new Error('missing statement');
  if (statement.length > config.rememberMaxChars) throw new Error('statement too long');
  if (redactReason(statement)) throw new Error('statement rejected');
  const event = {
    id: null,
    ovSession: '',
    messages: buildMessages(statement.trim(), { date: today(now) })
  };
  event.id = rememberId(statement);
  event.ovSession = `magpie-remember-${event.id.slice(0, 16)}`;
  const api = new OpenViking(config, fetcher);
  await api.appendRemember(event);
  return api.commitRemember(event);
}

// Human review helpers. Uncertain remember events are never resolved
// automatically: only an explicit CLI call may change their status.
export async function reviewRemembers(options, { env = process.env, now = Date.now } = {}) {
  const config = configuration(options, env, { worker: true });
  if (!config) throw new Error('disabled');
  const store = new Store(config.stateDir);
  const rows = [];
  for (const id of await store.ids()) {
    await store.withState(id, async (state) => {
      if (state.binding !== config.binding) return;
      for (const event of state.outbox) {
        if (event.kind !== 'remember') continue;
        rows.push({
          stateId: id,
          eventId: event.id,
          ovSession: event.ovSession,
          status: event.status,
          needsConfirm: Boolean(event.needsConfirm),
          ageSeconds: Math.max(0, Math.round((now() - (event.at ?? now())) / 1000)),
          taskId: event.taskId ?? null
        });
      }
    }, { create: false });
  }
  return rows;
}

// `resolution` is 'approve', 'retry' or 'delivered'. Each one is a human
// statement about an outcome the plugin cannot observe by itself.
export async function resolveRemember(options, eventId, resolution, { env = process.env } = {}) {
  if (!['approve', 'retry', 'delivered'].includes(resolution)) throw new Error('invalid resolution');
  const config = configuration(options, env, { worker: true });
  if (!config) throw new Error('disabled');
  let changed = 0;
  const store = new Store(config.stateDir);
  for (const id of await store.ids()) {
    await store.withState(id, async (state, save) => {
      if (state.binding !== config.binding) return;
      const event = state.outbox.find(e => e.kind === 'remember' && e.id === eventId);
      if (!event) return;
      if (resolution === 'approve') { event.needsConfirm = false; event.status = 'pending'; }
      else if (resolution === 'retry') { event.status = 'pending'; }
      else {
        state.remembered = [...state.remembered, event.id].slice(-REMEMBER_RECEIPT_LIMIT);
        state.outbox = state.outbox.filter(e => e.id !== event.id);
      }
      await save();
      changed++;
    }, { create: false });
  }
  if (!changed) throw new Error('event not found');
  return changed;
}
