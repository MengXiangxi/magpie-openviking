import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPlugin, drain } from '../lib/plugin.mjs';

async function setup(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-ov-test-'));
  const calls = []; const batches = [];
  const control = { search: null, dropAppend: false, delay: 0, redirectUrl: null };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ path: req.url, method: req.method, body, key: req.headers['x-api-key'] });
    let result = {};
    if (req.url === '/api/v1/search/search') {
      if (control.redirectUrl) { res.writeHead(302, { location: control.redirectUrl }); res.end(); return; }
      if (control.delay) await sleep(control.delay);
      result = control.search ?? { rendered: `Memory for ${body.query}`, entries: [{ uri: `viking://user/test/memories/${calls.filter(x => x.path.includes('search')).length}` }], stats: { rewrite: 'off' } };
    } else if (req.url.endsWith('/messages/batch')) {
      batches.push(body);
      if (control.dropAppend) { req.socket.destroy(); return; }
      result = { added: 2, pending_tokens: 20 };
    } else result = { session_id: 'mock', pending_tokens: 0 };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const env = { OPENVIKING_API_KEY: 'test-credential-not-real' };
  const options = { enabled: true, capture: false, url: `http://127.0.0.1:${server.address().port}`, stateDir: directory, timeoutMs: 300, ...overrides };
  const reports = [];
  const context = (query = 'Question', extra = {}) => ({ origin: 'local', session: 'session-1', agent: 'test-agent', cwd: '/workspace', protocol: 'chat', query, options, state: {}, report: (code, bytes) => reports.push({ code, bytes }), ...extra });
  const plugin = createPlugin({ env });
  const body = (question = 'Question') => ({ model: 'test/model', stream: true, messages: [{ role: 'user', content: question }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] });
  const reply = (answer = 'Answer') => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] });
  const states = async () => {
    const names = (await readdir(directory)).filter(n => n.endsWith('.json'));
    return Promise.all(names.map(async n => JSON.parse(await readFile(join(directory, n), 'utf8'))));
  };
  return { directory, calls, batches, control, env, options, reports, context, plugin, body, reply, states };
}

test('disabled, missing credentials, remote and shared-key traffic make no OV calls', async t => {
  const x = await setup(t);
  for (const ctx of [x.context('Question', { options: { ...x.options, enabled: false } }), x.context('Question', { origin: 'remote' }), x.context('Question', { origin: 'gateway-key' }), x.context('Question', { origin: undefined }), x.context('Question', { session: '' })]) {
    assert.equal(await x.plugin.onRequest(x.body(), ctx), undefined);
  }
  assert.equal(await createPlugin({ env: {} }).onRequest(x.body(), x.context()), undefined);
  assert.equal(x.calls.length, 0);
  assert.equal((await readdir(x.directory)).length, 0);
});

test('real HTTP recall preserves the request and freezes retry results', async t => {
  const x = await setup(t);
  const input = x.body(); const original = structuredClone(input);
  const first = await x.plugin.onRequest(input, x.context());
  assert.deepEqual(input, original);
  assert.deepEqual(first.tools, original.tools);
  assert.match(first.messages[0].content, /Memory for Question/);
  const again = await createPlugin({ env: x.env }).onRequest(input, x.context());
  assert.deepEqual(first, again);
  assert.equal(x.calls.length, 1);
  assert.deepEqual(x.calls[0].body, { mode: 'context', query: 'Question', max_tokens: 1200, context_type: 'memory', query_expansion: 'off', rewrite: false, exclude_uris: [] });
  const raw = JSON.stringify(await x.states());
  assert.ok(!raw.includes(x.env.OPENVIKING_API_KEY));
  const files = await readdir(x.directory);
  // Windows has no POSIX mode bits: Node (and Bun) report 0o666 for any file there.
  // The privacy claim in the README is POSIX-only; on Windows the file relies on ACLs.
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(x.directory, files.find(f => f.endsWith('.json'))))).mode & 0o777, 0o600);
  }
});

test('historical injection is replayed byte-for-byte before a new turn', async t => {
  const x = await setup(t);
  const first = await x.plugin.onRequest(x.body(), x.context());
  const next = x.body(); next.messages.push({ role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Another question' });
  const second = await x.plugin.onRequest(next, x.context('Another question'));
  assert.equal(second.messages[0].content, first.messages[0].content);
  assert.equal(x.calls.length, 2);
  assert.equal(x.calls[1].body.exclude_uris.length, 1);
  const tool = structuredClone(next); tool.messages.push({ role: 'assistant', tool_calls: [{}] }, { role: 'tool', content: 'tool result' });
  const duringTool = await x.plugin.onRequest(tool, x.context('Another question'));
  assert.equal(duringTool.messages[2].content, second.messages[2].content);
  assert.equal(x.calls.length, 2);
});

test('a recall timeout keeps the main request intact and is not retried on that turn', async t => {
  const x = await setup(t, { timeoutMs: 100 }); x.control.delay = 220;
  const input = x.body();
  assert.deepEqual(await x.plugin.onRequest(input, x.context()), input);
  assert.deepEqual(await x.plugin.onRequest(input, x.context()), input);
  assert.equal(x.calls.length, 1);
  assert.ok(x.reports.some(r => r.code === 'unavailable'));
});

test('no_relevant and oversized or malformed results never inject raw fallback content', async t => {
  const x = await setup(t);
  x.control.search = { rendered: 'should not be injected', digest: '', entries: [{ text: 'raw evidence' }], stats: { rewrite: 'no_relevant' } };
  assert.deepEqual(await x.plugin.onRequest(x.body(), x.context()), x.body());
  x.control.search = { rendered: { invalid: true } };
  assert.deepEqual(await x.plugin.onRequest(x.body('Different'), x.context('Different')), x.body('Different'));
  x.control.search = { rendered: 'x'.repeat(20000) };
  assert.deepEqual(await x.plugin.onRequest(x.body('Third question'), x.context('Third question')), x.body('Third question'));
});

test('capture waits for client acknowledgement, drains the final idle turn and does not duplicate', async t => {
  const x = await setup(t, { capture: true });
  const ctx = x.context(); await x.plugin.onRequest(x.body(), ctx);
  await x.plugin.onResponse(x.reply(), { ...ctx, success: true });
  assert.equal(x.batches.length, 0);
  const next = x.body(); next.messages.push({ role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Another question' });
  const ctx2 = x.context('Another question'); await x.plugin.onRequest(next, ctx2);
  await x.plugin.onResponse(x.reply('Second answer'), { ...ctx2, success: true });
  assert.equal(x.batches.length, 1);
  assert.equal(x.batches[0].messages[0].content, 'Question');
  assert.equal(x.batches[0].messages[1].content, 'Answer');
  assert.ok(!JSON.stringify(x.batches).includes('Memory for'));
  const result = await drain(x.options, { env: x.env, now: () => Date.now() + 601000 });
  assert.equal(result.delivered, 1);
  assert.equal(x.batches.length, 2);
  await drain(x.options, { env: x.env, now: () => Date.now() + 602000 });
  assert.equal(x.batches.length, 2);
  assert.ok(x.calls.some(c => c.method === 'PATCH' && c.body.auto_commit_policy.idle_timeout_seconds === 600));
  assert.ok(x.calls.every(c => c.key === x.env.OPENVIKING_API_KEY));
});

test('regeneration replaces the unconfirmed answer and failed replies are not captured', async t => {
  const x = await setup(t, { capture: true }); const ctx = x.context();
  await x.plugin.onRequest(x.body(), ctx);
  await x.plugin.onResponse(x.reply('Discarded answer'), { ...ctx, success: true });
  await x.plugin.onRequest(x.body(), ctx);
  await x.plugin.onResponse(x.reply('Kept answer'), { ...ctx, success: true });
  const next = x.body(); next.messages.push({ role: 'assistant', content: 'Kept answer' }, { role: 'user', content: 'Next question' });
  const ctx2 = x.context('Next question'); await x.plugin.onRequest(next, ctx2);
  await x.plugin.onResponse(x.reply('Incomplete'), { ...ctx2, success: false });
  await drain(x.options, { env: x.env });
  assert.equal(x.batches.length, 1);
  assert.equal(x.batches[0].messages[1].content, 'Kept answer');
});

test('uncertain append is retained for review and never automatically resent', async t => {
  const x = await setup(t, { capture: true }); const ctx = x.context();
  await x.plugin.onRequest(x.body(), ctx);
  await x.plugin.onResponse(x.reply(), { ...ctx, success: true });
  x.control.dropAppend = true;
  const result = await drain(x.options, { env: x.env, now: () => Date.now() + 601000 });
  assert.equal(result.uncertain, 1);
  assert.equal(x.batches.length, 1);
  x.control.dropAppend = false;
  assert.equal((await drain(x.options, { env: x.env, now: () => Date.now() + 602000 })).uncertain, 1);
  assert.equal(x.batches.length, 1);
});

test('different OV credentials cannot share replay or capture state', async t => {
  const x = await setup(t);
  await x.plugin.onRequest(x.body(), x.context());
  await createPlugin({ env: { OPENVIKING_API_KEY: 'another-not-real-key' } }).onRequest(x.body(), x.context());
  assert.equal(x.calls.length, 2);
  assert.equal((await x.states()).length, 2);
});

test('in-flight writes do not get their locks stolen', async t => {
  const x = await setup(t); x.control.delay = 80;
  const first = x.plugin.onRequest(x.body(), x.context());
  while (!x.calls.length) await sleep(5);
  assert.equal(await x.plugin.onRequest(x.body(), x.context()), undefined);
  await first;
  assert.equal(x.calls.length, 1);
});

test('replay-only states can be expired by explicit worker without exporting anything', async t => {
  const x = await setup(t);
  await x.plugin.onRequest(x.body(), x.context());
  const n = x.calls.length;
  await drain(x.options, { env: x.env, now: () => Date.now() + 8 * 86400000 });
  assert.equal((await x.states()).length, 0);
  assert.equal(x.calls.length, n);
});

test('redirects are rejected rather than forwarding the OV credential', async t => {
  const x = await setup(t); let touched = false;
  const sink = createServer((_q, r) => { touched = true; r.end('{}'); });
  sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
  t.after(async () => { sink.closeAllConnections(); await new Promise(resolve => sink.close(resolve)); });
  x.control.redirectUrl = `http://127.0.0.1:${sink.address().port}/leak`;
  assert.deepEqual(await x.plugin.onRequest(x.body(), x.context()), x.body());
  assert.equal(touched, false);
});
