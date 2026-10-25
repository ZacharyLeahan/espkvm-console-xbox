<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { controllerLabel, type ControllerStatus } from '../input/controllers';
const emit = defineEmits<{ inspect: [] }>();
const props = defineProps<{ players: ControllerStatus[]; connected: boolean }>();
const position = ref({ left: 8, top: 56 });
function toggle(player: number, event: MouseEvent) {
  selected.value = selected.value === player ? null : player;
  if (selected.value !== null) emit('inspect');
  const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
  position.value = { left: Math.max(8, Math.min(r.left, window.innerWidth - 374)), top: r.bottom + 8 };
}
function outside(event: Event) { if (event.target instanceof Element && !event.target.closest('.controllers, .controller-detail')) selected.value = null; }
const selected = ref<number | null>(null), now = ref(Date.now()), received = ref(Date.now());
watch(() => props.players, () => { received.value = Date.now(); });
let timer: ReturnType<typeof setInterval>;
onMounted(() => { document.addEventListener('pointerdown', outside); timer = setInterval(() => { now.value = Date.now(); }, 250); });
onUnmounted(() => { clearInterval(timer); document.removeEventListener('pointerdown', outside); });
const known = computed(() => props.connected && now.value - received.value < 3000);
const current = computed(() => props.players.find(p => p.player === selected.value));
const age = (n: number) => n < 0 ? 'Not observed' : `${((n + Math.max(0, now.value - received.value)) / 1000).toFixed(1)} s ago`;
const pulse = (p: ControllerStatus) => known.value && p.activityAgeMs >= 0 && p.activityAgeMs + now.value - received.value < 1000;
const staleBeacon = (p: ControllerStatus) => p.seen && p.beaconAgeMs + now.value - received.value >= 4000;
</script>
<template>
  <div class="controllers" @keydown.esc="selected = null">
    <div class="controller-pills" aria-label="Xbox controllers">
      <button v-for="p in players" :key="p.player" type="button" class="player-pill"
        :class="{ ready: known && p.connection === 2, waiting: known && (p.connection === 1 || p.connection === 3), pulse: pulse(p) }"
        :aria-label="`Player ${p.player}: ${controllerLabel(p, known)}${pulse(p) ? ', input sent' : ''}`"
        :aria-expanded="selected === p.player" :title="controllerLabel(p, known)"
        @click="toggle(p.player, $event)">
        <span class="player-dot" aria-hidden="true" />P{{ p.player }}<span v-if="known && staleBeacon(p)" class="beacon-warning" aria-label="Discovery stale">!</span>
      </button>
    </div>
    <Teleport to="body"><section v-if="current" class="controller-detail" :style="{ left: `${position.left}px`, top: `${position.top}px` }" @keydown.esc="selected = null" :aria-label="`Player ${current.player} details`">
      <div class="detail-heading"><strong>Player {{ current.player }}</strong><button type="button" aria-label="Close controller details" @click="selected = null">&#215;</button></div>
      <p>{{ controllerLabel(current, known) }}</p>
      <p v-if="!known" role="status">Waiting for current status from the main ESP.</p>
      <dl v-else>
        <dt>Receiver</dt><dd>{{ current.ip || 'Not discovered' }}</dd>
        <dt>Discovery</dt><dd>{{ age(current.beaconAgeMs) }}{{ staleBeacon(current) ? ' - stale; unicast may still work' : '' }}</dd>
        <dt>Input sent</dt><dd>{{ current.held === '-' ? 'Neutral' : current.held || 'Not observed' }}<span v-if="current.activityAgeMs >= 0"> - last active {{ age(current.activityAgeMs) }}</span></dd>
        <dt>Reports sent</dt><dd>{{ current.sent }}<span v-if="current.sendErrors"> - {{ current.sendErrors }} send errors</span></dd>
        <dt>USB submitted</dt><dd>{{ current.submitted ?? 'Not observed' }}</dd>
        <dt>Xbox consumed</dt><dd>{{ current.consumed ?? 'Not observed' }}<span v-if="current.completionAgeMs >= 0"> - advanced {{ age(current.completionAgeMs) }}</span></dd>
        <dt>Receiver sample</dt><dd>{{ age(current.diagnosticAgeMs) }}</dd>
      </dl>
      <p class="controller-note">USB configuration and report completion do not prove a game is responding. The pulse means the main ESP sent input.</p>
    </section></Teleport>
  </div>
</template>
<style scoped>
.controllers { position: relative; flex-shrink: 0; }
.controller-pills { display: flex; gap: 3px; }
.player-pill { display: inline-flex; align-items: center; gap: 4px; min-height: 30px; padding: 4px 7px; border: 1px solid #7d849355; border-radius: 7px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.player-dot { width: 7px; height: 7px; border-radius: 50%; background: #8a909b; }
.ready .player-dot { background: #32b879; }.waiting .player-dot { background: #e4a83c; }
.pulse { box-shadow: inset 0 0 0 2px #50a8eb; background: #50a8eb22; }
.beacon-warning { color: #d38f19; font-weight: bold; }
.controller-detail { position: fixed; max-height: calc(100dvh - 80px); overflow: auto; z-index: 100; width: min(350px, calc(100vw - 24px)); padding: 14px; border-radius: 10px; border: 1px solid #7d849366; background: var(--bg-overlay, #20242b); color: var(--text, #eef1f5); box-shadow: 0 8px 28px #0005; font-size: 12px; }
.detail-heading { display: flex; justify-content: space-between; align-items: center; font-size: 14px; }.detail-heading button { background: transparent; color: inherit; border: 0; font-size: 22px; cursor: pointer; }
dl { display: grid; grid-template-columns: 100px 1fr; gap: 7px; }dt { opacity: .7; }dd { margin: 0; overflow-wrap: anywhere; }.controller-note { opacity: .7; line-height: 1.45; }
@media (max-width: 600px) { .player-pill { padding: 4px; gap: 3px; } }
</style>
