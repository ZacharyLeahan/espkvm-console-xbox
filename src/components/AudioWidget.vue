<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { onMounted, onUnmounted, ref } from "vue";
import { StereoPcm, playbackTime } from "../audio/pcm";
import { abortableDelay, receiveAudio } from "../audio/stream";

const active = ref(false);
const available = ref(true);
const message = ref("Audio off");
const volume = ref(0.7);
const peak = ref(0);
const queued = ref(0);
const resets = ref(0);
type Playback = {
  abort: AbortController;
  context: AudioContext;
  gain: GainNode;
  cursor: number;
  sources: Set<AudioBufferSourceNode>;
  receiving?: Promise<void>;
};
let playback: Playback | null = null;
let previousReceiving: Promise<void> | undefined;
const statusAbort = new AbortController();

function clearQueue(session: Playback) {
  for (const source of session.sources) {
    source.onended = null;
    source.stop();
    source.disconnect();
  }
  session.sources.clear();
}
function stop() {
  const previous = playback;
  playback = null;
  active.value = false;
  if (previous) {
    previous.abort.abort();
    clearQueue(previous);
    void previous.context.close().catch(() => {});
  }
  peak.value = queued.value = 0;
  message.value = "Audio off";
  // Retain cleanup across a separate Mute click followed quickly by Enable.
  if (previous?.receiving) previousReceiving = previous.receiving.catch(() => {});
  return previousReceiving;
}
function setVolume() {
  if (playback) playback.gain.gain.setTargetAtTime(volume.value, playback.context.currentTime, 0.01);
}
async function start() {
  const previous = stop();
  const controller = new AbortController();
  let session: Playback | null = null;
  active.value = true;
  resets.value = 0;
  message.value = "Connecting audio...";
  try {
    // Created in the click handler so autoplay policy permits playback.
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const gain = ctx.createGain();
    gain.gain.value = volume.value;
    gain.connect(ctx.destination);
    const current: Playback = { abort: controller, context: ctx, gain, cursor: 0, sources: new Set() };
    session = playback = current;
    await ctx.resume();
    if (previous) {
      await previous;
      // Let the server observe the old listener's close before claiming its slot.
      await abortableDelay(250, controller.signal);
    }
    controller.signal.throwIfAborted();
    ctx.onstatechange = () => {
      if (playback === current && ctx.state !== "running") {
        stop();
        message.value = "Playback suspended; enable audio again";
      }
    };
    let decoder = new StereoPcm();
    let synthetic = false;
    if (previousReceiving === previous) previousReceiving = undefined;
    current.receiving = receiveAudio({
      signal: controller.signal,
      canPlay: () => playback === current && ctx.state === "running",
      onOpen: (_rate, isSynthetic) => {
        clearQueue(current);
        decoder = new StereoPcm();
        synthetic = isSynthetic;
        current.cursor = ctx.currentTime + 0.03;
      },
      onRetry: () => {
        clearQueue(current);
        peak.value = queued.value = 0;
        message.value = "Reconnecting audio...";
      },
      onChunk: (value, rate) => {
        const pcm = decoder.decode(value, rate);
        if (!pcm.frames) return 0;
        const timing = playbackTime(ctx.currentTime, current.cursor, pcm.dropped > 0);
        if (timing.reset) {
          clearQueue(current);
          resets.value++;
        }
        current.cursor = timing.start;
        const buffer = ctx.createBuffer(2, pcm.frames, rate);
        buffer.copyToChannel(pcm.left, 0);
        buffer.copyToChannel(pcm.right, 1);
        peak.value = pcm.peak;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.onended = () => { current.sources.delete(source); source.disconnect(); };
        source.start(current.cursor);
        current.sources.add(source);
        current.cursor += pcm.frames / rate;
        queued.value = Math.round((current.cursor - ctx.currentTime) * 1000);
        message.value = synthetic ? "Synthetic test tone" : pcm.peak > 0.001 ? "Audio active" : "Audio samples received - quiet";
        return pcm.frames;
      },
    });
    await current.receiving;
  } catch (error) {
    if (controller.signal.aborted || playback !== session) return;
    stop();
    message.value = error instanceof Error ? error.message : "Audio failed";
  }
}
onMounted(async () => {
  try {
    const response = await fetch("/api/v1/audio/status", { signal: statusAbort.signal, cache: "no-store" });
    if (!response.ok) return;
    const status = await response.json();
    if (status.available === false && !active.value) {
      available.value = false;
      message.value = status.reason || "Audio receiver unavailable; check firmware pin configuration";
    }
  } catch { /* The regular connection indicator handles an unreachable device. */ }
});
onUnmounted(() => { statusAbort.abort(); stop(); });
</script>

<template>
  <span class="audio-widget">
    <button type="button" :disabled="!available" @click="active ? stop() : start()">{{ active ? "Mute audio" : "Enable audio" }}</button>
    <template v-if="active">
      <input v-model.number="volume" type="range" min="0" max="1" step="0.01" aria-label="Audio volume" @input="setVolume" />
      <meter :value="peak" min="0" max="1" aria-label="Source audio peak" />
    </template>
    <span class="audio-status" role="status" :title="`Playback buffer: ${queued} ms; backlog resets: ${resets}. Excludes network and hardware delay.`">{{ message }}</span>
  </span>
</template>

<style scoped>
.audio-widget { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; }
.audio-status { max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input { width: 65px; }
meter { width: 45px; }
button { white-space: nowrap; cursor: pointer; }
</style>
