import test from 'node:test';
import assert from 'node:assert/strict';
import { cutMp3, mp3Frame, validateCuts } from '../worker/program-mp3-cut.ts';

const header = new Uint8Array([0xff, 0xfb, 0x90, 0]);
const frame = mp3Frame(header, 0);

test('MP3 edit removes only chosen frames, preserves source, and yields a playable frame stream', async () => {
  assert.ok(frame);
  const source = new Uint8Array(frame.length * 250);
  for (let i = 0; i < 250; i++) source.set(header, i * frame.length);
  const original = source.slice();
  let edited;
  const media = {
    async get(_key, { range }) { return { arrayBuffer: async () => source.slice(range.offset, range.offset + range.length).buffer }; },
    async createMultipartUpload() {
      const parts = new Map();
      return {
        async uploadPart(number, bytes) { parts.set(number, bytes); return { partNumber: number, etag: String(number) }; },
        async complete(list) { edited = new Uint8Array(list.reduce((size, p) => size + parts.get(p.partNumber).length, 0)); let at = 0; for (const p of list) { const chunk = parts.get(p.partNumber); edited.set(chunk, at); at += chunk.length; } },
        async abort() { throw Error('Unexpected abort'); },
      };
    },
  };
  const result = await cutMp3(media, 'source', source.length, validateCuts([{ start: 2, end: 3 }], frame.seconds * 250), 'destination');
  assert.ok(result.skipped > 30);
  assert.equal(edited.length, (250 - result.skipped) * frame.length);
  assert.deepEqual(source, original);
  for (let i = 0; i < edited.length; i += frame.length) assert.equal(mp3Frame(edited, i)?.length, frame.length);
});

test('invalid overlapping cuts are rejected before touching audio', () => {
  assert.throws(() => validateCuts([{ start: 1, end: 4 }, { start: 3, end: 5 }], 10));
  assert.throws(() => validateCuts([{ start: 0, end: 11 }], 10));
});
