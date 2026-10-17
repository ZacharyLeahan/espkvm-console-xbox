// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { receiveAudio, abortableDelay } from "../src/audio/stream.ts";

function pcmResponse(frames: number, format = "s16le-stereo") {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (frames) controller.enqueue(new Uint8Array(frames * 4));
      controller.close();
    },
  }), { headers: { "X-Audio-Rate": "48000", "X-Audio-Format": format } });
}

function options(controller = new AbortController()) {
  return {
    signal: controller.signal,
    canPlay: () => true,
    onOpen: () => {},
    onChunk: (bytes: Uint8Array) => bytes.length / 4,
    onRetry: () => {},
    wait: async () => {},
  };
}

test("an established stream closes each attempt before retry and stops after three consecutive failures", async () => {
  const signals: AbortSignal[] = [];
  let opens = 0;
  let retries = 0;
  await assert.rejects(receiveAudio({
    ...options(),
    fetchStream: async (_input, init) => {
      assert.ok(signals.every(signal => signal.aborted), "previous listener must be cancelled first");
      signals.push(init!.signal!);
      return pcmResponse(signals.length === 1 ? 240 : 0);
    },
    onOpen: () => { opens++; },
    onRetry: () => { retries++; },
  }), /Audio connection lost; enable audio again/);
  assert.equal(signals.length, 3);
  assert.equal(opens, 3);
  assert.equal(retries, 2);
  assert.ok(signals.every(signal => signal.aborted));
});

test("two seconds of received audio renews the consecutive failure budget", async () => {
  let requests = 0;
  await assert.rejects(receiveAudio({
    ...options(),
    fetchStream: async () => pcmResponse(++requests === 2 ? 96000 : requests === 1 ? 240 : 0),
  }), /Audio connection lost; enable audio again/);
  assert.equal(requests, 4);
});

test("initial connection errors never retry before PCM is received", async () => {
  let requests = 0;
  await assert.rejects(receiveAudio({
    ...options(),
    fetchStream: async () => { requests++; throw new TypeError("network failed"); },
    onRetry: () => assert.fail("initial connection must not retry"),
  }), /Audio connection lost/);
  assert.equal(requests, 1);
});

test("authorization, busy, unavailable, and format errors stop reconnecting", async () => {
  for (const status of [401, 403, 409, 503, 200]) {
    let requests = 0;
    await assert.rejects(receiveAudio({
      ...options(),
      fetchStream: async () => ++requests === 1 ? pcmResponse(240) : status === 200
        ? pcmResponse(240, "invalid") : new Response("Refused", { status }),
    }), status === 200 ? /Unsupported audio format/ : /Refused/);
    assert.equal(requests, 2);
  }
});

test("mute during retry delay cancels the timer and prevents another listener", async () => {
  const controller = new AbortController();
  let requests = 0;
  const cancelled = new Error("muted");
  await assert.rejects(receiveAudio({
    ...options(controller),
    fetchStream: async () => { requests++; return pcmResponse(240); },
    wait: (ms, signal) => {
      assert.equal(ms, 250);
      const pending = abortableDelay(ms, signal);
      controller.abort(cancelled);
      return pending;
    },
  }), error => error === cancelled);
  assert.equal(requests, 1);
});

test("mute while reader cleanup is pending cannot update retry state", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (++reads === 1) c.enqueue(new Uint8Array(960));
      else c.enqueue(new Uint8Array(0));
    },
    cancel() { cancelled = true; controller.abort(new Error("muted during cleanup")); },
  });
  await assert.rejects(receiveAudio({
    ...options(controller),
    fetchStream: async () => new Response(stream, { headers: { "X-Audio-Rate": "48000", "X-Audio-Format": "s16le-stereo" } }),
    onChunk: bytes => {
      if (!bytes.length) throw new Error("Playback suspended");
      return bytes.length / 4;
    },
    onRetry: () => assert.fail("cancelled playback must not touch retry state"),
  }), /Playback suspended/);
  assert.ok(cancelled);
});

test("playback suspension ends an established stream without reconnecting", async () => {
  let playing = true;
  let requests = 0;
  await assert.rejects(receiveAudio({
    ...options(),
    canPlay: () => playing,
    fetchStream: async () => { requests++; return pcmResponse(240); },
    onChunk: bytes => { playing = false; return bytes.length / 4; },
    onRetry: () => assert.fail("autoplay suspension must not retry"),
  }), /Playback suspended/);
  assert.equal(requests, 1);
});
