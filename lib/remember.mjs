// The gateway cannot register tools, so remember is triggered by deterministic
// rules on the user's own message. The model is asked only to normalise the
// entry the user already asked for. Every control instruction is English on
// purpose: one reviewed text for all locales, while the user-facing sentence is
// requested in the user's own language and the entry itself is never translated.
export const WRAPPER = 'openviking-remember';
export const ENTRY_MAX_CHARS = 200;

// Anchored patterns are declared by config.mjs (they are configuration); this
// module only understands the shapes the gateway produces.
// Key-shaped secrets, credential-bearing URLs and auth headers. This is a
// best-effort guard on the user's own words, not a data-loss-prevention product:
// the README says so, and `rememberModel: "normalize"` is the second layer.
const SECRET = [
  /\b(?:sk|rk|pk)[-_](?:live_|test_)?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  // Credentials embedded in a URL, e.g. postgres://user:secret@host/db.
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\b(?:authorization|proxy-authorization)\s*:\s*\S+/i,
  /\b(?:set-)?cookie\s*:\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // keyword=value, including environment names such as MYSQL_PASSWORD=...
  /(?:^|[^a-z0-9])(?:[a-z0-9]+[_-])*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)[a-z0-9_]*\s*[:=]/i,
  /(?:密码|口令|密钥|令牌)\s*[:=：]/
];

// Conservative on purpose: this is a personal long-term store, and a rejected
// statement is reported rather than silently written.
const PRIVATE = [
  /\b\d{17}[\dXx]\b/,
  /\b1[3-9]\d{9}\b/,
  /(?:住院号|病历号|门诊号|受试者编号|患者编号|身份证号?)/,
  /<\/?\s*openviking-context/i
];

// Recalled text and user input are untrusted third-party material. Entity-escape
// anything that looks like one of this integration's wrappers so stored text
// cannot close or forge an instruction block.
export function escapeUntrusted(value) {
  return String(value).replace(/<\s*(\/?)\s*(openviking-context|openviking-remember|openviking-remember-status)\b([^>]*)>/gi,
    (_match, slash, name, attributes) => `&lt;${slash}${name}${attributes}&gt;`).replace(/"""/g, "'''");
}

export function redactReason(statement) {
  for (const pattern of PRIVATE) if (pattern.test(statement)) return 'private';
  for (const pattern of SECRET) if (pattern.test(statement)) return 'secret';
  return null;
}

// Returns { kind: 'command' | 'pattern', statement, needsConfirm } or null.
export function detect(text, config, previous = '') {
  if (typeof text !== 'string') return null;
  const trimmed = text.replace(/^\s+/, '');
  for (const command of config.rememberCommands) {
    if (!trimmed.startsWith(command)) continue;
    const rest = trimmed.slice(command.length);
    // "/remembering" must not match "/remember", while "/记住以后用中文" must.
    if (/[A-Za-z0-9_]$/.test(command) && /^[A-Za-z0-9_]/.test(rest)) continue;
    const statement = rest.replace(/^[\s:：,，]+/, '').trim();
    if (statement) return { kind: 'command', statement, needsConfirm: false };
    // A bare command means "remember the previous message".
    if (previous.trim()) return { kind: 'command', statement: previous.trim(), needsConfirm: false };
    return null;
  }
  if (config.remember !== 'assisted') return null;
  const head = trimmed.split('\n')[0];
  for (const pattern of config.rememberPatterns) {
    if (!pattern.test(head)) continue;
    return { kind: 'pattern', statement: trimmed.trim(), needsConfirm: true };
  }
  return null;
}

// Stable identity for one request-to-remember event: whitespace-insensitive, so
// a retry or a regenerated answer cannot write the same statement twice.
// (The hash itself lives in plugin.mjs to keep this module dependency-free.)

// English field names keep the payload locale-neutral; the statement itself
// stays in the user's language and is never translated by the gateway.
export function buildMessages(statement, { date, answer = '' } = {}) {
  const messages = [{
    role: 'user',
    content: `[long-term memory write]\ndate: ${date}\nsource: Magpie gateway explicit request\ncontent: ${statement}`
  }];
  if (answer) messages.push({ role: 'assistant', content: answer });
  return messages;
}

export function normalizePrompt({ statement, marker = 'line', pending = false, queued = true } = {}) {
  const tail = marker === 'comment'
    ? `Then end your reply with exactly one HTML comment, and nothing after it:
<!-- openviking-remember
<the normalized entry, one line, at most ${ENTRY_MAX_CHARS} characters>
-->`
    : `Then end your reply with exactly one line, and nothing after it:
/remember <the normalized entry, one line, at most ${ENTRY_MAX_CHARS} characters>`;
  // A pattern candidate is queued for human approval and no API call is made until
  // then, and a full queue means nothing was queued at all; neither may be phrased
  // as a submission.
  const closing = !queued
    ? 'Finally, tell the user in one sentence, in the language the user is using, that this could not be queued because the pending-write queue is full, so nothing was saved and they should ask again later. Do not restate these instructions and do not explain the format.'
    : pending
      ? 'Finally, tell the user in one sentence, in the language the user is using, that the entry is queued and still needs their approval, and that nothing has been sent yet. Do not restate these instructions and do not explain the format.'
      : 'Finally, tell the user in one sentence, in the language the user is using, that the entry was submitted to long-term memory and that extraction runs in the background. Do not restate these instructions and do not explain the format.';
  return `<${WRAPPER}>
The user explicitly asked in this message to remember the following content:
"""
${escapeUntrusted(statement)}
"""
Turn it into one durable long-term memory entry. Keep only stable facts, preferences, agreements or decisions. Drop greetings, transient context, speculation and anything unrelated to what the user asked to remember. Do not translate it: keep the user's original language and wording where it is already precise.
Never include secrets, passwords, API keys, tokens, ID numbers, phone numbers, medical record numbers or other sensitive personal data.
${tail}
${closing}
</${WRAPPER}>`;
}

// The model is not trusted to obey. Anything it emits is accepted only when this
// turn was already authorised by the deterministic trigger above.
export function parseRemember(text, { authorized, config } = {}) {
  if (!authorized || typeof text !== 'string' || !text) return null;
  const comment = text.match(/<!--\s*openviking-remember\s*\n([\s\S]{1,4000}?)\n\s*-->/i);
  let raw = comment?.[1];
  if (raw === undefined) {
    const lines = [...text.matchAll(/^[ \t]*[/／]remember[ \t:：]+(.+)$/gim)];
    raw = lines.at(-1)?.[1];
  }
  if (typeof raw !== 'string') return null;
  const statement = raw.trim().replace(/^[`"'«“]+/, '').replace(/[`"'»”]+$/, '').trim();
  if (!statement) return null;
  if (statement.length > config.rememberMaxChars) return { code: 'remember-rejected' };
  if (redactReason(statement)) return { code: 'remember-rejected' };
  return { statement };
}
