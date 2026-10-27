import { hash } from './config.mjs';

export const MARKER = '<openviking-context source="magpie-openviking">';

// Domain-separated seed for the incremental prefix chain. Changing it resets
// every replay anchor once; see CHANGELOG.md for the v0.1.1 migration note.
export const ANCHOR_SEED = hash('magpie-openviking:anchor-v1');

function text(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => p && ['text', 'input_text', 'output_text'].includes(p.type) && typeof p.text === 'string')
    .map(p => p.text).join('\n');
}

function hasToolResult(content) {
  return Array.isArray(content) && content.some(p => p?.type === 'tool_result');
}

// Recalled text is untrusted third-party material. Entity-escape anything that
// looks like the wrapper tag so stored memory cannot close or forge a block.
export function sanitizeRecall(value) {
  return value.replace(/<\s*(\/?)\s*openviking-context\b([^>]*)>/gi,
    (_match, slash, attributes) => `&lt;${slash}openviking-context${attributes}&gt;`);
}

// The client owns tool declarations, tool loops, reasoning blocks and all images.
// We only append a text part to user messages in complete histories.
export function inspect(body, protocol) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  let items;
  if (protocol === 'chat' || protocol === 'anthropic') items = body.messages;
  else if (protocol === 'responses') {
    if (body.previous_response_id || body.conversation) return null;
    items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  } else if (protocol === 'gemini') items = body.contents;
  else return null;
  if (!Array.isArray(items) || items.length > 4096) return null;
  const turns = [];
  // Prefix anchors are a hash chain: anchor_i covers items 0..i at linear cost,
  // instead of serialising the complete prefix again for every user turn.
  let anchor = ANCHOR_SEED;
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    if (!m || typeof m !== 'object') return null;
    if (protocol === 'gemini' && m.parts !== undefined && !Array.isArray(m.parts)) return null;
    const content = protocol === 'gemini' ? (m.parts ?? []).filter(p => typeof p?.text === 'string').map(p => p.text).join('\n') : text(m.content);
    if (content.includes('<openviking-context')) return null; // another automatic integration, or echoed injection
    anchor = hash(`${anchor}\0${JSON.stringify(m)}`);
    const toolResult = protocol === 'gemini' ? m.parts?.some(p => p?.functionResponse) : hasToolResult(m.content);
    const role = protocol === 'gemini' ? (m.role ?? 'user') : m.role;
    const isUser = role === 'user' && !toolResult && content.trim();
    if (isUser) {
      // Include the complete preceding history: edits/forks cannot reuse a different turn's injection.
      turns.push({ index: i, anchor, text: content, assistantTexts: [] });
    } else if (turns.length && ['assistant', 'model'].includes(role) && content) {
      turns.at(-1).assistantTexts.push(content);
    }
  }
  if (!turns.length) return null;
  const last = turns.at(-1);
  return { items, turns, latest: last, isNewUserRequest: last.index === items.length - 1 };
}

// Appends one text block to a single user item. Shared by recall replay and the
// remember instruction so both keep identical content-shape rules.
function appendText(items, protocol, index, block) {
  const original = items[index];
  const m = { ...original };
  if (protocol === 'gemini') m.parts = [...(original.parts ?? []), { text: block }];
  else if (typeof original.content === 'string') m.content = `${original.content}\n\n${block}`;
  else m.content = [...(original.content ?? []), { type: protocol === 'responses' ? 'input_text' : 'text', text: block }];
  items[index] = m;
}

// Returns undefined when no turn has a recorded block, so the host can keep the
// original request object. Injected turns are copied shallowly (content arrays
// are rebuilt) rather than deep-cloning the body and its images.
export function inject(body, protocol, view, records) {
  let items;
  for (const turn of view.turns) {
    const block = records[turn.anchor]?.block;
    if (!block) continue;
    if (!items) items = view.items.slice();
    appendText(items, protocol, turn.index, block);
  }
  if (!items) return undefined;
  const copy = { ...body };
  if (protocol === 'responses') copy.input = items;
  else if (protocol === 'gemini') copy.contents = items;
  else copy.messages = items;
  return copy;
}

// The remember instruction is added only to the outgoing request, never to the
// client's own history, so replay anchors are unaffected. It operates on the
// body already in hand, so recalled blocks injected just above are preserved.
// A Responses request may still carry a bare string `input`; the inspected item
// array is then the only writable representation.
export function appendToLatest(body, protocol, view, block) {
  const key = protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : 'messages';
  const current = body[key];
  const items = Array.isArray(current) ? current.slice() : view.items.slice();
  appendText(items, protocol, view.latest.index, block);
  return { ...body, [key]: items };
}

// Text of the reply regardless of finish reason or tool calls. Only used to read
// back a remember marker, never to decide whether a turn is a final answer.
export function replyText(reply, protocol) {
  if (!reply || typeof reply !== 'object') return '';
  if (protocol === 'chat') return text(reply.choices?.[0]?.message?.content);
  if (protocol === 'anthropic') return text(reply.content);
  if (protocol === 'responses') return (reply.output ?? []).filter(p => p?.type === 'message').map(p => text(p.content)).join('\n');
  if (protocol === 'gemini') {
    const candidate = reply.candidates?.[0];
    return (candidate?.content?.parts ?? []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('\n');
  }
  return '';
}

export function finalAnswer(reply, protocol) {
  if (!reply || typeof reply !== 'object') return '';
  if (protocol === 'chat') {
    const choice = reply.choices?.[0];
    return choice?.finish_reason === 'stop' && !choice.message?.tool_calls?.length ? text(choice.message?.content) : '';
  }
  if (protocol === 'anthropic') return reply.stop_reason === 'end_turn' ? text(reply.content) : '';
  if (protocol === 'responses') {
    if (reply.status !== 'completed' || reply.output?.some(p => ['function_call', 'custom_tool_call', 'computer_call'].includes(p?.type))) return '';
    return (reply.output ?? []).filter(p => p?.type === 'message' && p.role === 'assistant').map(p => text(p.content)).filter(Boolean).join('\n');
  }
  if (protocol === 'gemini') {
    const candidate = reply.candidates?.[0];
    if (candidate?.finishReason !== 'STOP' || candidate.content?.parts?.some(p => p?.functionCall)) return '';
    return (candidate.content?.parts ?? []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('\n');
  }
  return '';
}
