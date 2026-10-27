import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');

function integer(value, fallback, min, max) {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) throw new Error('invalid option');
  return chosen;
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
    contextType: options.contextType === 'all' ? undefined : 'memory'
  };
}
