// SPDX-License-Identifier: Apache-2.0
/** Reassemble arbitrary HTTP chunks, then keep the newest audio after stalls. */
export class StereoPcm {
  private carry = new Uint8Array(0);
  decode(chunk: Uint8Array, rate: number) {
    const bytes = new Uint8Array(this.carry.length + chunk.length);
    bytes.set(this.carry);
    bytes.set(chunk, this.carry.length);
    const aligned = bytes.length - bytes.length % 4;
    this.carry = bytes.slice(aligned);
    const first = Math.max(0, aligned - Math.floor(rate * 0.06) * 4);
    const frames = (aligned - first) / 4;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const view = new DataView(bytes.buffer, first, aligned - first);
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      left[i] = view.getInt16(i * 4, true) / 32768;
      right[i] = view.getInt16(i * 4 + 2, true) / 32768;
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }
    return { left, right, frames, peak, dropped: first / 4 };
  }
}

/** Only bounds the local playback queue; network/device latency is separate. */
export function playbackTime(now: number, cursor: number, dropped: boolean) {
  const reset = dropped || cursor - now > 0.12;
  return { reset, start: reset || cursor < now ? now + 0.02 : cursor };
}
