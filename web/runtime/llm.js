/** Anthropic client and call helpers.
 *
 * Two entry points, as in pipeline/llm.py:
 *   - callWithTranscript() caches the (large) transcript as a shared prefix.
 *     The frozen preamble + transcript sit in the system block behind one cache
 *     breakpoint; the per-task instruction rides in the user turn after it.
 *   - call() is a plain call for the small steps (captions, targeted summaries).
 *
 * Both default to adaptive thinking. Pass a JSON schema to get a parsed object
 * back instead of text.
 *
 * Browser note: the SDK sends `anthropic-dangerous-direct-browser-access`, which
 * is what opts the request into CORS. The key is the user's own, held in
 * IndexedDB — see store.js. Verified working 2026-09-22.
 */

import Anthropic from '../vendor/anthropic.js';
import { MODEL } from './config.js';

let client = null;

export function setApiKey(key) {
  client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
}

function getClient() {
  if (!client) throw new Error('No Anthropic API key set. Add yours in settings.');
  return client;
}

/** The first text block, skipping thinking blocks.
 *
 * A truncated response (stop_reason "max_tokens") can carry thinking blocks and
 * no text block at all — adaptive thinking spent the whole budget. Fail with the
 * reason rather than returning undefined. */
function textOf(msg) {
  const block = msg.content.find((b) => b.type === 'text');
  if (block) return block.text;
  throw new Error(
    `No text block in response (stop_reason=${msg.stop_reason}, ` +
    `output_tokens=${msg.usage.output_tokens}). If this is 'max_tokens', ` +
    'raise maxTokens for this call.');
}

function logCache(label, msg) {
  const u = msg.usage;
  console.log(`  [${label}] in=${u.input_tokens} ` +
    `cache_write=${u.cache_creation_input_tokens ?? 0} ` +
    `cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`);
}

async function request(label, system, messages, schema, maxTokens) {
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    system,
    messages,
  };
  if (schema) params.output_config = { format: { type: 'json_schema', schema } };
  // Always stream. The SDK refuses a non-streaming request whose max_tokens
  // could take it past the HTTP timeout, and clip selection runs at 32k. We
  // want the whole message, so drain it with finalMessage().
  const stream = await getClient().messages.stream(params);
  const msg = await stream.finalMessage();
  logCache(label, msg);
  const text = textOf(msg);
  return schema ? JSON.parse(text) : text;
}

/** Run a task against the cached transcript prefix. */
export function callWithTranscript({ label, preamble, transcript, task, schema = null, maxTokens = 16000 }) {
  const system = [
    { type: 'text', text: preamble },
    { type: 'text', text: transcript, cache_control: { type: 'ephemeral' } },
  ];
  return request(label, system, [{ role: 'user', content: task }], schema, maxTokens);
}

/** Plain call for the small steps (no transcript). */
export function call({ label, system, user, schema = null, maxTokens = 4000 }) {
  return request(label, system, [{ role: 'user', content: user }], schema, maxTokens);
}
