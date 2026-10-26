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

// Where each call's one-line summary goes: the console by default, and the
// run's log file while a run is going (runner.js swaps it in via setLogger —
// one run at a time per worker, so a module-level hook is enough).
let logLine = (level, line) => console.log(line);

export function setLogger(fn) {
  logLine = fn || ((level, line) => console.log(line));
}

function logCall(label, msg, ms) {
  const u = msg.usage;
  logLine('info', `model ${label}: ${(ms / 1000).toFixed(1)}s stop=${msg.stop_reason} `
    + `in=${u.input_tokens} cache_write=${u.cache_creation_input_tokens ?? 0} `
    + `cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`);
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
  const began = Date.now();
  let msg;
  try {
    const stream = await getClient().messages.stream(params);
    msg = await stream.finalMessage();
  } catch (err) {
    logLine('error', `model ${label}: failed after ${((Date.now() - began) / 1000).toFixed(1)}s — `
      + `${err && err.name}: ${err && err.message}`);
    throw err;
  }
  logCall(label, msg, Date.now() - began);
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
