import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');

function integer(value, fallback, min, max) {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) throw new Error('invalid option');
  return chosen;
}

export function configuration(options = {}, env = process.env) {
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
  const stateDir = resolve(options.stateDir ?? env.MAGPIE_OPENVIKING_STATE_DIR ?? resolve(homedir(), '.local/state/magpie-openviking'));
  return {
    baseUrl, apiKey, stateDir,
    binding: hash(`${baseUrl}\0${apiKey}`),
    capture: options.capture === true,
    maxTokens: integer(options.maxTokens, 1200, 64, 8000),
    timeoutMs: integer(options.timeoutMs, 1500, 100, 9000),
    maxRecallChars: integer(options.maxRecallChars, 16000, 256, 64000),
    maxWindowChars: integer(options.maxWindowChars, 60000, 1000, 500000),
    maxCaptureChars: integer(options.maxCaptureChars, 64000, 1000, 256000),
    idleSeconds: integer(options.idleSeconds, 600, 300, 86400),
    stateTtlDays: integer(options.stateTtlDays, 7, 1, 90),
    contextType: options.contextType === 'all' ? undefined : 'memory'
  };
}
