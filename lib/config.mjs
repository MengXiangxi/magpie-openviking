import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Anchored patterns only. They are advisory (a pattern candidate needs
// confirmation), so a false positive costs a review entry, never a memory.
export const DEFAULT_REMEMBER_PATTERNS = Object.freeze([
  '^(?:please\\s+)?remember\\b',
  '^from now on\\b',
  '^note that\\b',
  '^(?:请)?记住(?:[：:，,\\s]|$)',
  '^(?:以后都|之后都|今后都)[^。\\n]{2,}$',
  '^(?:不要再|别再|以后别)[^。\\n]{2,}$'
]);

export const hash = (value) => createHash('sha256').update(value).digest('hex');

function integer(value, fallback, min, max) {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) throw new Error('invalid option');
  return chosen;
}

function oneOf(value, fallback, choices) {
  const chosen = value ?? fallback;
  if (!choices.includes(chosen)) throw new Error('invalid option');
  return chosen;
}

function commands(value) {
  if (value === undefined) return ['/remember', '/记住'];
  if (!Array.isArray(value) || !value.length || value.length > 8) throw new Error('invalid rememberCommands');
  return value.map(entry => {
    if (typeof entry !== 'string' || !entry.length || entry.length > 32 || /\s/.test(entry)) throw new Error('invalid rememberCommands');
    return entry;
  });
}

function patterns(value) {
  const list = value === undefined || value === null ? DEFAULT_REMEMBER_PATTERNS : value;
  if (!Array.isArray(list) || !list.length || list.length > 16) throw new Error('invalid rememberPatterns');
  return list.map(source => {
    if (typeof source !== 'string' || !source.length || source.length > 200) throw new Error('invalid rememberPatterns');
    try { return new RegExp(source, 'i'); }
    catch { throw new Error('invalid rememberPatterns'); }
  });
}

export function stateDirectory(options = {}, env = process.env) {
  return resolve(options.stateDir ?? env.MAGPIE_OPENVIKING_STATE_DIR ?? resolve(homedir(), '.local/state/magpie-openviking'));
}

export function configuration(options = {}, env = process.env, { worker = false } = {}) {
  if (options.enabled !== true) return null;
  if (options.capture !== undefined && typeof options.capture !== 'boolean') throw new Error('invalid capture');
  const url = new URL(options.url ?? env.OPENVIKING_URL ?? 'http://127.0.0.1:1933');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid endpoint');
  }
  const keyName = options.apiKeyEnv ?? 'OPENVIKING_API_KEY';
  if (typeof keyName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) throw new Error('invalid key variable');
  const apiKey = env[keyName];
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('missing credential');
  const baseUrl = url.href.replace(/\/$/, '');
  const stateDir = stateDirectory(options, env);
  const explicitTimeoutMs = integer(options.timeoutMs, 1500, 100, 9000);
  // Magpie aborts a hook at its own gatewayTimeoutMs. Leave a small margin so a
  // default install returns before the host kills the request. The worker has
  // no host budget, so it keeps the explicit upper bound.
  const gatewayTimeoutMs = worker ? null : integer(options.gatewayTimeoutMs, 1000, 100, 10000);
  const timeoutMs = worker ? explicitTimeoutMs : Math.min(explicitTimeoutMs, Math.max(200, gatewayTimeoutMs - 200));
  return {
    baseUrl, apiKey, stateDir,
    binding: hash(`${baseUrl}\0${apiKey}`),
    capture: options.capture === true,
    maxTokens: integer(options.maxTokens, 1200, 64, 8000),
    timeoutMs,
    gatewayTimeoutMs,
    timeoutTooShort: !worker && timeoutMs < 500,
    maxRecallChars: integer(options.maxRecallChars, 16000, 256, 64000),
    maxWindowChars: integer(options.maxWindowChars, 60000, 1000, 500000),
    maxCaptureChars: integer(options.maxCaptureChars, 64000, 1000, 256000),
    idleSeconds: integer(options.idleSeconds, 600, 300, 86400),
    stateTtlDays: integer(options.stateTtlDays, 7, 1, 90),
    contextType: options.contextType === 'all' ? undefined : 'memory',
    ...rememberOptions(options, worker, gatewayTimeoutMs)
  };
}

// Remember has its own budget: it is two requests (batch, then commit) issued
// from the completion callback, so the host budget must cover both.
function rememberOptions(options, worker, gatewayTimeoutMs) {
  const remember = oneOf(options.remember, 'off', ['off', 'command', 'assisted']);
  const explicit = integer(options.rememberTimeoutMs, 1000, 200, 9000);
  const rememberTimeoutMs = worker ? explicit : Math.min(explicit, Math.max(200, Math.floor((gatewayTimeoutMs - 400) / 2)));
  return {
    remember,
    rememberModel: oneOf(options.rememberModel, 'off', ['off', 'normalize']),
    rememberMarker: oneOf(options.rememberMarker, 'comment', ['line', 'comment']),
    rememberMaxChars: integer(options.rememberMaxChars, 4000, 256, 8000),
    rememberTimeoutMs,
    rememberTimeoutTooShort: remember !== 'off' && !worker && rememberTimeoutMs < 400,
    rememberCommands: commands(options.rememberCommands),
    rememberPatterns: patterns(options.rememberPatterns),
    // The model may only normalise an entry the user already asked for. Falling
    // back to the user's own words keeps a request from being silently dropped.
    rememberRawFallback: options.rememberRawFallback === undefined ? true : options.rememberRawFallback === true,
    rememberIncludeAnswer: options.rememberIncludeAnswer === true
  };
}
