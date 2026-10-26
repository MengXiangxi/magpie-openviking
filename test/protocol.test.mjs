import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, inject, finalAnswer } from '../lib/protocol.mjs';

const cases = [
  ['chat', { model: 'model', messages: [{ role: 'user', content: 'Question' }], tools: [{ type: 'function', function: { name: 'read' } }], stream: true },
    { choices: [{ finish_reason: 'stop', message: { content: 'Answer' } }] }],
  ['anthropic', { model: 'model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Question' }, { type: 'image', source: { type: 'base64', data: 'image' } }] }], max_tokens: 100, tools: [{ name: 'read' }] },
    { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Answer' }] }],
  ['responses', { model: 'model', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] }], tools: [{ type: 'function', name: 'read' }] },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] }] }],
  ['gemini', { contents: [{ role: 'user', parts: [{ text: 'Question' }, { inlineData: { mimeType: 'image/png', data: 'image' } }] }], tools: [{ functionDeclarations: [{ name: 'read' }] }] },
    { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ thought: true, text: 'private' }, { text: 'Answer' }] } }] }]
];

for (const [protocol, body, reply] of cases) {
  test(`${protocol}: append text without changing client tools, images, model or original body`, () => {
    const original = structuredClone(body);
    const view = inspect(body, protocol);
    assert.equal(view.latest.text, 'Question');
    const output = inject(body, protocol, view, { [view.latest.anchor]: { block: 'MEMORY' } });
    assert.deepEqual(body, original);
    assert.deepEqual(output.tools, original.tools);
    assert.equal(output.model, original.model);
    assert.equal(output.stream, original.stream);
    assert.match(JSON.stringify(output), /MEMORY/);
    assert.equal(finalAnswer(reply, protocol), 'Answer');
    if (protocol === 'gemini') assert.deepEqual(output.contents[0].parts[1], original.contents[0].parts[1]);
    if (protocol === 'anthropic') assert.deepEqual(output.messages[0].content[1], original.messages[0].content[1]);
  });
}

test('Responses string input becomes a valid user input item', () => {
  const body = { model: 'm', input: 'Question' };
  const view = inspect(body, 'responses');
  const output = inject(body, 'responses', view, { [view.latest.anchor]: { block: 'MEMORY' } });
  assert.deepEqual(output.input, [{ role: 'user', content: 'Question\n\nMEMORY' }]);
});

test('server-managed Responses history is untouched', () => {
  assert.equal(inspect({ input: 'q', previous_response_id: 'resp-1' }, 'responses'), null);
  assert.equal(inspect({ input: 'q', conversation: 'conv-1' }, 'responses'), null);
});

test('Gemini defaults a missing message role to user and rejects malformed parts', () => {
  assert.equal(inspect({ contents: [{ parts: [{ text: 'Question' }] }] }, 'gemini').latest.text, 'Question');
  assert.equal(inspect({ contents: [{ role: 'user', parts: 'invalid' }] }, 'gemini'), null);
});

test('tool results are never treated as a new human question', () => {
  const chat = inspect({ messages: [{ role: 'user', content: 'Question' }, { role: 'tool', content: 'result' }] }, 'chat');
  assert.equal(chat.isNewUserRequest, false);
  const anthropic = inspect({ messages: [{ role: 'user', content: 'Question' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'result' }] }] }, 'anthropic');
  assert.equal(anthropic.turns.length, 1);
  assert.equal(anthropic.isNewUserRequest, false);
});

test('edited history has different anchors and another OV injection is skipped', () => {
  const a = inspect({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'v1' }, { role: 'user', content: 'b' }] }, 'chat');
  const b = inspect({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'v2' }, { role: 'user', content: 'b' }] }, 'chat');
  assert.notEqual(a.latest.anchor, b.latest.anchor);
  assert.equal(inspect({ messages: [{ role: 'user', content: 'q <openviking-context source="other">x' }] }, 'chat'), null);
});

test('tool calls, truncation, reasoning and incomplete replies are not final answers', () => {
  assert.equal(finalAnswer({ choices: [{ finish_reason: 'tool_calls', message: { content: 'wait', tool_calls: [{}] } }] }, 'chat'), '');
  assert.equal(finalAnswer({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }, 'chat'), '');
  assert.equal(finalAnswer({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'wait' }] }, 'anthropic'), '');
  assert.equal(finalAnswer({ status: 'incomplete', output: [] }, 'responses'), '');
  assert.equal(finalAnswer({ status: 'completed', output: [{ type: 'function_call' }] }, 'responses'), '');
  assert.equal(finalAnswer({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: {} }] } }] }, 'gemini'), '');
});
