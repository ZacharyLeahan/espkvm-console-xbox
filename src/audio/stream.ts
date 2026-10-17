// SPDX-License-Identifier: Apache-2.0
const MAX_CONSECUTIVE_FAILURES = 3;

class Disconnected extends Error {}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

type StreamOptions = {
  signal: AbortSignal;
  canPlay: () => boolean;
  onOpen: (rate: number, synthetic: boolean) => void;
  onChunk: (bytes: Uint8Array, rate: number) => number;
  onRetry: () => void;
  fetchStream?: typeof fetch;
  wait?: typeof abortableDelay;
};

/** Reconnect only after real PCM arrived, and never overlap server listeners. */
export async function receiveAudio(options: StreamOptions): Promise<void> {
  const { signal } = options;
  let established = false;
  let failures = 0;
  for (;;) {
    signal.throwIfAborted();
    if (!options.canPlay()) throw new Error("Playback suspended; enable audio again");
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort(signal.reason);
    signal.addEventListener("abort", abortAttempt, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let response: Response;
      try {
        response = await (options.fetchStream ?? fetch)("/audio.pcm", {
          signal: attempt.signal, cache: "no-store",
        });
      } catch {
        throw new Disconnected("Audio connection lost");
      }
      signal.throwIfAborted();
      // HTTP refusals (including another listener) need operator action.
      if (!response.ok) throw new Error((await response.text()) || `Audio unavailable (${response.status})`);
      const rate = Number(response.headers.get("X-Audio-Rate"));
      if (![32000, 44100, 48000, 88200, 96000].includes(rate) ||
          response.headers.get("X-Audio-Format") !== "s16le-stereo" || !response.body)
        throw new Error("Unsupported audio format");
      if (!options.canPlay()) throw new Error("Playback suspended; enable audio again");
      reader = response.body.getReader();
      options.onOpen(rate, response.headers.get("X-Audio-Synthetic") === "true");
      let receivedSeconds = 0;
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try { result = await reader.read(); }
        catch { throw new Disconnected("Audio connection lost"); }
        signal.throwIfAborted();
        if (!options.canPlay()) throw new Error("Playback suspended; enable audio again");
        if (result.done) throw new Disconnected("Audio stream ended");
        const frames = options.onChunk(result.value, rate);
        if (frames > 0) {
          established = true;
          receivedSeconds += frames / rate;
          // A working connection starts a fresh budget for the next interruption.
          if (receivedSeconds >= 2) failures = 0;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof Disconnected) || !established) throw error;
      if (++failures >= MAX_CONSECUTIVE_FAILURES)
        throw new Error("Audio connection lost; enable audio again");
    } finally {
      signal.removeEventListener("abort", abortAttempt);
      attempt.abort();
      if (reader) {
        try { await reader.cancel(); } catch { /* A disconnected stream is already closed. */ }
        reader.releaseLock();
      }
    }
    signal.throwIfAborted();
    if (!options.canPlay()) throw new Error("Playback suspended; enable audio again");
    options.onRetry();
    await (options.wait ?? abortableDelay)(250, signal);
  }
}
