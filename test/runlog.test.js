import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLine, describeEvent, levelOf, coverageWarning } from '../web/runtime/runlog.js';

const AT = new Date('2026-10-26T09:12:03.120Z');

test('a log line is ISO time, a padded level, then the message', () => {
  assert.equal(formatLine('info', 'Run started', AT), '2026-10-26T09:12:03.120Z INFO  Run started');
  assert.equal(formatLine('error', 'boom', AT), '2026-10-26T09:12:03.120Z ERROR boom');
});

test('run events read as one line each', () => {
  assert.equal(
    describeEvent({ type: 'stage', key: 'transcript', status: 'done', label: 'Reading transcript', detail: '1685 cues' }),
    'stage transcript done — Reading transcript — 1685 cues');
  assert.equal(describeEvent({ type: 'count', key: 'clips', total: 14 }), 'count clips: 14');
  assert.equal(
    describeEvent({ type: 'clip', status: 'skipped', base: 'clip-03', reason: 'too short', done: 2 }),
    'clip skipped clip-03 — too short');
  assert.equal(describeEvent({ type: 'note', level: 'warn', message: 'Heads up' }), 'Heads up');
});

test('warnings and failures are levelled so they stand out', () => {
  assert.equal(levelOf({ type: 'note', level: 'warn', message: '' }), 'warn');
  assert.equal(levelOf({ type: 'clip', status: 'skipped' }), 'warn');
  assert.equal(levelOf({ type: 'clip', status: 'error' }), 'error');
  assert.equal(levelOf({ type: 'stage', status: 'failed' }), 'error');
  assert.equal(levelOf({ type: 'stage', status: 'done' }), 'info');
});

test('coverage warning fires on the 25-seconds-of-96-minutes failure', () => {
  const w = coverageWarning('Extracted audio', 25.6, 5754.2);
  assert.match(w, /Extracted audio covers 0:26 of 1:35:54 \(0%\)/);
});

test('coverage warning stays quiet for normal trailing silence', () => {
  assert.equal(coverageWarning('Transcript', 5600, 5754.2), null); // 97%
  assert.equal(coverageWarning('Transcript', 100, null), null);    // nothing to compare to
});

// A minimal in-memory stand-in for an OPFS directory handle — just the calls
// fsroot.js makes (getDirectoryHandle, getFileHandle, getFile, createWritable).
function memoryRoot() {
  const dirHandle = (entries) => ({
    async getDirectoryHandle(name, { create } = {}) {
      if (!entries.has(name)) {
        if (!create) throw Object.assign(new Error(name), { name: 'NotFoundError' });
        entries.set(name, new Map());
      }
      return dirHandle(entries.get(name));
    },
    async getFileHandle(name, { create } = {}) {
      if (!entries.has(name)) {
        if (!create) throw Object.assign(new Error(name), { name: 'NotFoundError' });
        entries.set(name, '');
      }
      return {
        getFile: async () => ({ text: async () => entries.get(name) }),
        createWritable: async () => {
          let buf = '';
          return { write: async (t) => { buf += t; }, close: async () => { entries.set(name, buf); } };
        },
      };
    },
  });
  return dirHandle(new Map());
}

test('attempts append to one file, in order, under their own headers', async () => {
  const { createRunLog, logPath } = await import('../web/runtime/runlog.js');
  const { readText } = await import('../web/runtime/fsroot.js');
  const root = memoryRoot();

  const first = createRunLog(root, 'webinar15');
  first.header('run 1');
  first.event({ type: 'stage', key: 'transcript', status: 'running', label: 'Reading' });
  first.event({ type: 'note', level: 'warn', message: 'Extracted audio covers 0:26 of 1:35:54' });
  first.error('run failed: boom');
  await first.flush();

  const second = createRunLog(root, 'webinar15');
  second.header('export');
  second.info('export finished');
  await second.flush();

  const text = await readText(root, logPath('webinar15'));
  const lines = text.trim().split('\n');
  assert.equal(lines[0], '==== run 1 ====');
  assert.match(lines[1], /INFO  stage transcript running — Reading$/);
  assert.match(lines[2], /WARN  Extracted audio covers 0:26/);
  assert.match(lines[3], /ERROR run failed: boom$/);
  assert.equal(lines[5], '==== export ====');
  assert.match(lines[6], /INFO  export finished$/);
});
