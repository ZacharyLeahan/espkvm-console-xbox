// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { VideoStream } from "../src/video/stream.ts";

function fixture(t: any) {
  let now = 0;
  let rejectConfigure = false;
  let resolveBitmap: (value: any) => void = () => {};
  const sockets: any[] = [], decoders: any[] = [], frames: any[] = [], errors: string[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent: Uint8Array[] = [];
    onopen: any; onmessage: any; onclose: any;
    constructor() { sockets.push(this); }
    send(data: Uint8Array) { this.sent.push(data.slice()); }
    close() { this.readyState = 3; }
    receive(data: ArrayBuffer) { this.onmessage({ data }); }
  }
  class Decoder {
    state = "unconfigured";
    decodeQueueSize = 0;
    chunks: any[] = [];
    callbacks: any;
    throwDecode = false;
    constructor(callbacks: any) { this.callbacks = callbacks; decoders.push(this); }
    configure() { if (rejectConfigure) throw Error("unsupported"); this.state = "configured"; }
    decode(chunk: any) { if (this.throwDecode) throw Error("decode failed"); this.chunks.push(chunk); }
    close() { this.state = "closed"; }
  }
  const globals: Record<string, any> = {
    WebSocket: Socket, VideoDecoder: Decoder,
    createImageBitmap: () => new Promise(resolve => { resolveBitmap = resolve; }),
    EncodedVideoChunk: class { constructor(init: any) { Object.assign(this, init); } },
    location: { protocol: "https:", host: "test.local" },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    window: { setTimeout: () => 123, isSecureContext: true },
    performance: { now: () => now },
  };
  const restores: (() => void)[] = [];
  const streams: VideoStream[] = [];
  t.after(() => { for (const stream of streams) stream.stop(); for (const restore of restores) restore(); });
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restores.push(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name));
  }
  const handlers = { onFrame: (f: any) => frames.push(f), onCodecError: (e: string) => errors.push(e), onUnavailable: (e: string) => errors.push(e) };
  const stream = new VideoStream(handlers);
  streams.push(stream);
  const socket = sockets[0];
  socket.onopen();
  return { stream, streams, socket, sockets, handlers, decoders, frames, errors,
    rejectConfigure: () => { rejectConfigure = true; },
    finishBitmap: (bitmap: any) => resolveBitmap(bitmap), advance: (ms: number) => { now += ms; } };
}
function packet(key = true, seq = 42, type = 2) {
  const payload = key ? [0, 0, 1, 0x67, 0x42, 0, 0x1f, 0, 0, 1, 0x65, 1] : [0, 0, 1, 0x41, 1];
  const buffer = new ArrayBuffer(12 + payload.length);
  const v = new DataView(buffer);
  v.setUint8(0, 0x4b); v.setUint8(1, type);
  v.setUint16(2, 1280, true); v.setUint16(4, 720, true); v.setUint32(6, seq, true);
  new Uint8Array(buffer, 12).set(payload);
  return buffer;
}

test("ACKs require advertisement and carry sequence; new viewers negotiate independently", t => {
  const f = fixture(t);
  f.socket.receive(packet());
  assert.equal(f.socket.sent.length, 1);
  f.socket.receive(new Uint8Array([0x85]).buffer);
  f.socket.receive(packet(false, 0x12345678));
  assert.deepEqual([...f.socket.sent.at(-1)], [9, 0x78, 0x56, 0x34, 0x12]);
  const count = f.socket.sent.length;
  f.socket.receive(packet(false, 9, 99));
  f.socket.receive(new Uint8Array([0x4b, 2]).buffer);
  assert.equal(f.socket.sent.length, count);
  f.stream.stop();
  const other = new VideoStream(f.handlers);
  f.streams.push(other);
  f.sockets[1].onopen();
  f.sockets[1].receive(packet());
  assert.equal(f.sockets[1].sent.length, 1);
});

test("decoder errors request bounded repair, wait for IDR and report only repeated failures", t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    f.socket.receive(packet());
    const d = f.decoders.at(-1);
    d.callbacks.error(Error("lost reference"));
    assert.equal(d.state, "closed");
    f.socket.receive(packet(false));
    assert.equal(f.decoders.length, i + 1);
  }
  assert.equal(f.socket.sent.length, 2, "repair burst is rate limited at time zero");
  assert.equal(f.errors.length, 1);
  f.advance(501);
  f.socket.receive(packet());
  f.decoders.at(-1).callbacks.output({ close() {}, displayWidth: 1280, displayHeight: 720 });
  f.decoders.at(-1).callbacks.error(Error("new isolated error"));
  assert.equal(f.errors.length, 1, "successful output resets error count");
  assert.equal(f.socket.sent.length, 3);
});

test("decode exceptions request IDR; stale callbacks cannot reset a replacement decoder", t => {
  const f = fixture(t);
  f.socket.receive(packet());
  const old = f.decoders[0];
  old.throwDecode = true;
  f.socket.receive(packet(false));
  assert.equal(old.state, "closed");
  assert.equal(f.socket.sent.length, 2);
  f.socket.receive(packet());
  const replacement = f.decoders[1];
  let closed = false;
  old.callbacks.output({ close() { closed = true; } });
  old.callbacks.error(Error("late"));
  assert.ok(closed);
  assert.equal(replacement.state, "configured");
  assert.equal(f.frames.length, 0);
});

test("stopped streams ignore queued open, frames and decoder callbacks", t => {
  const f = fixture(t);
  f.socket.receive(packet());
  f.stream.stop();
  const sent = f.socket.sent.length;
  f.socket.onopen();
  f.socket.receive(packet());
  f.decoders[0].callbacks.error(Error("late"));
  let closed = false;
  f.decoders[0].callbacks.output({ close() { closed = true; } });
  assert.ok(closed);
  assert.equal(f.socket.sent.length, sent);
  assert.equal(f.decoders.length, 1);
  assert.equal(f.frames.length, 0);
  assert.equal(f.errors.length, 0);
});


test("JPEG completion after stop releases the bitmap without displaying it", async t => {
  const f = fixture(t);
  f.socket.receive(packet(true, 42, 1));
  f.stream.stop();
  let closed = false;
  f.finishBitmap({ close() { closed = true; } });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(closed);
  assert.equal(f.frames.length, 0);
});

test("rejected codec configuration closes the newly allocated decoder", t => {
  const f = fixture(t);
  f.rejectConfigure();
  f.socket.receive(packet());
  assert.equal(f.decoders[0].state, "closed");
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /refused/);
});
