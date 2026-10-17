// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { StereoPcm, playbackTime } from "../src/audio/pcm.ts";

test("stereo PCM survives every possible network chunk split", () => {
  const bytes = new Uint8Array([0, 128, 255, 127, 0, 0, 0, 64, 0, 192, 0, 32]);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new StereoPcm();
    const a = decoder.decode(bytes.slice(0, split), 48000);
    const b = decoder.decode(bytes.slice(split), 48000);
    assert.deepEqual([...a.left, ...b.left], [-1, 0, -0.5]);
    assert.deepEqual([...a.right, ...b.right], [32767 / 32768, 0.5, 0.25]);
    assert.equal(Math.max(a.peak, b.peak), 1);
  }
});
test("coalesced backlog keeps the newest 60 ms", () => {
  const bytes = new Uint8Array(48000 * 4);
  const view = new DataView(bytes.buffer);
  view.setInt16(bytes.length - 4, 16384, true);
  const pcm = new StereoPcm().decode(bytes, 48000);
  assert.equal(pcm.frames, 2880);
  assert.equal(pcm.dropped, 45120);
  assert.equal(pcm.left.at(-1), 0.5);
});
test("silent samples differ from incomplete data", () => {
  const decoder = new StereoPcm();
  assert.equal(decoder.decode(new Uint8Array(3), 48000).frames, 0);
  const silence = decoder.decode(new Uint8Array(1), 48000);
  assert.equal(silence.frames, 1);
  assert.equal(silence.peak, 0);
});
test("queue bounds recover from underrun and excessive delay", () => {
  assert.deepEqual(playbackTime(10, 9, false), { reset: false, start: 10.02 });
  assert.deepEqual(playbackTime(10, 10.05, false), { reset: false, start: 10.05 });
  assert.deepEqual(playbackTime(10, 10.2, false), { reset: true, start: 10.02 });
  assert.deepEqual(playbackTime(10, 10.05, true), { reset: true, start: 10.02 });
});
