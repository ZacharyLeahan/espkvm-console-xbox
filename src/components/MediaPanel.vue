<script setup lang="ts">
/*
 * Virtual media, as its own panel: the list of what the target can boot from -
 * the on-flash rescue image and the files on the microSD card - with the active
 * one picked here rather than buried in settings. Choosing writes the msc_image
 * setting; whether the drive is exposed at all, and its type, stay in Settings.
 *
 * Uploads go to the card where the device can write it, and to the flash rescue
 * slot on every board. Where the card is read-only (a pre-3.0 chip without the
 * slot's IO LDO) the upload is shown disabled with the device's reason.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import {
  deleteImage,
  formatBytes,
  formatMhz,
  formatDuration,
  loadImages,
  saveSettings,
  uploadImage,
  uploadRescue,
  UploadCancelled,
  RESCUE_MEDIUM,
  WHOLE_SD_MEDIUM,
  type StorageInfo,
  type Values,
} from "../state/device";
import { toast } from "../state/toasts";
import UploadChart from "./UploadChart.vue";

const props = defineProps<{ values: Values; streamPaused?: boolean }>();
const emit = defineEmits<{ (e: "values", v: Values): void; (e: "pause-stream"): void }>();

/* Whether the drive is presented to the target at all. Selecting a medium below
 * only chooses what the drive holds; without this on, the target sees no drive. */
const exposed = computed(() => !!props.values.msc_enable);

async function toggleExpose(e: Event) {
  const on = (e.target as HTMLInputElement).checked;
  writes++;
  try {
    emit("values", await saveSettings({ msc_enable: on }));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

const storage = ref<StorageInfo | null>(null);
const loadingImages = ref(false);
const uploadingImage = ref(false);
const uploadPct = ref(0);
const uploadRate = ref(0);
const uploadEta = ref(Infinity);
const uploadFrac = ref(0);
const uploadingRescue = ref(false);

/* Speed per slice of progress, for the chart. */
const TRACE_SLICES = 120;
const uploadTrace = ref<number[]>([]);
const rescueTrace = ref<number[]>([]);
/* Each slice holds the mean of the samples that landed in it: the rate comes
   several times a slice, and the last one alone makes the line jitter. */
const traceCounts = new WeakMap<number[], number[]>();
function traceAt(trace: number[], fraction: number, bps: number) {
  if (bps <= 0) return;
  let counts = traceCounts.get(trace);
  if (!counts) {
    counts = new Array(TRACE_SLICES).fill(0);
    traceCounts.set(trace, counts);
  }
  const i = Math.min(TRACE_SLICES - 1, Math.floor(fraction * TRACE_SLICES));
  counts[i]++;
  trace[i] += (bps - trace[i]) / counts[i];
}
/* One upload runs at a time, so one controller covers both kinds. */
let uploadAbort: AbortController | null = null;

/* A reload or a closed tab ends the request, and a long upload with it. The
   browser shows its own "leave site?" prompt; the text is not ours to set. */
function holdPage(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = "";
}
watch(
  () => uploadingImage.value || uploadingRescue.value,
  (busy) => {
    if (busy) window.addEventListener("beforeunload", holdPage);
    else window.removeEventListener("beforeunload", holdPage);
  },
);
onUnmounted(() => window.removeEventListener("beforeunload", holdPage));

function cancelUpload() {
  uploadAbort?.abort();
}

function uploadFailed(err: unknown, name: string) {
  if (err instanceof UploadCancelled) toast.info(`${name}: upload cancelled`);
  else toast.error(err instanceof Error ? err.message : String(err));
}
const rescuePct = ref(0);
const rescueRate = ref(0);
const rescueEta = ref(Infinity);
const rescueFrac = ref(0);

/* A write started here beats a listing that was already in the air: the reply
   may describe the card as it was a moment before, and the choice must not jump
   back under the operator's hand. */
let writes = 0;

async function refreshImages(quiet = false) {
  if (!quiet) loadingImages.value = true;
  const seen = writes;
  try {
    const fresh = await loadImages();
    if (quiet && seen !== writes) return;
    storage.value = fresh;
  } catch (err) {
    /* A poll nobody asked for stays quiet about a card it could not read. */
    if (!quiet) toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    if (!quiet) loadingImages.value = false;
  }
}

/* The panel is only mounted when the operator opens it, so this reads the card
   on open rather than on every console load. It keeps reading while it is open:
   the medium can change elsewhere - another session, or the demo loading one by
   itself - and a panel saying "ejected" while the target boots is worse than a
   small request every few seconds. */
const POLL_MS = 3000;
let poll = 0;
onMounted(() => {
  void refreshImages();
  poll = window.setInterval(() => {
    if (document.hidden || loadingImages.value) return;
    if (uploadingImage.value || uploadingRescue.value) return;
    void refreshImages(true);
  }, POLL_MS);
});
onUnmounted(() => window.clearInterval(poll));

async function onImageChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploadingImage.value = true;
  uploadPct.value = 0;
  uploadRate.value = 0;
  uploadEta.value = Infinity;
  uploadFrac.value = 0;
  uploadTrace.value = new Array(TRACE_SLICES).fill(0);
  uploadAbort = new AbortController();
  try {
    await uploadImage(
      file,
      (p) => {
        uploadPct.value = Math.round(p.fraction * 100);
        uploadRate.value = p.bytesPerSec;
        uploadEta.value = p.secondsLeft;
        uploadFrac.value = p.fraction;
        traceAt(uploadTrace.value, p.fraction, p.bytesPerSec);
      },
      uploadAbort.signal,
    );
    toast.info(`${file.name} uploaded`);
    await refreshImages();
  } catch (err) {
    uploadFailed(err, file.name);
  } finally {
    uploadAbort = null;
    uploadingImage.value = false;
    input.value = "";
  }
}

async function onRescueChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const cap = storage.value?.rescue?.capacityBytes ?? 0;
  if (cap && file.size > cap) {
    toast.error(`${file.name} is larger than the ${formatBytes(cap)} rescue partition`);
    input.value = "";
    return;
  }
  uploadingRescue.value = true;
  rescuePct.value = 0;
  rescueRate.value = 0;
  rescueEta.value = Infinity;
  rescueFrac.value = 0;
  rescueTrace.value = new Array(TRACE_SLICES).fill(0);
  uploadAbort = new AbortController();
  try {
    storage.value = await uploadRescue(
      file,
      (p) => {
        rescuePct.value = Math.round(p.fraction * 100);
        rescueRate.value = p.bytesPerSec;
        rescueEta.value = p.secondsLeft;
        rescueFrac.value = p.fraction;
        traceAt(rescueTrace.value, p.fraction, p.bytesPerSec);
      },
      uploadAbort.signal,
    );
    toast.info(`Rescue image written (${file.name})`);
  } catch (err) {
    uploadFailed(err, file.name);
  } finally {
    uploadAbort = null;
    uploadingRescue.value = false;
    input.value = "";
  }
}

async function selectImage(name: string) {
  writes++;
  try {
    emit("values", await saveSettings({ msc_image: name }));
    if (storage.value) storage.value.active = name;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

async function removeImage(name: string) {
  if (!confirm(`Delete ${name} from the card?`)) return;
  writes++;
  try {
    storage.value = await deleteImage(name);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}
</script>

<template>
  <div class="media-panel">
    <p v-if="loadingImages && !storage" class="setting-note">Reading media...</p>
    <p
      v-else-if="storage && !storage.mounted && !storage.rescue?.supported"
      class="section-blocked"
    >
      No microSD card and no built-in rescue partition. Insert a card formatted FAT32 or exFAT
      with your boot images copied on (exFAT for images over 4&nbsp;GB).
    </p>
    <template v-else-if="storage">
      <label class="expose-toggle">
        <input type="checkbox" :checked="exposed" @change="toggleExpose" />
        <span>Expose virtual media to the target</span>
      </label>
      <p class="setting-note">
        <template v-if="exposed"
          >The medium selected below is presented to the target as a USB drive it can boot
          from.</template
        >
        <template v-else
          >Off &mdash; the target sees no drive. Turn this on to present the selected
          medium.</template
        >
        Adding or removing the drive re-plugs USB, so switching this takes effect after a restart.
      </p>

      <p v-if="storage.handedOver" class="setting-note setting-note-blocked">
        The whole microSD card is handed to the target as a read-write drive. While it is,
        uploading and the file list here are paused so the target owns the card alone &mdash;
        select a different medium (or eject) to manage files from here again.
      </p>

      <ul class="image-list">
        <li
          v-if="storage.rescue?.supported"
          :class="['image-row', { 'image-active': storage.active === RESCUE_MEDIUM }]"
        >
          <label class="image-pick">
            <input
              type="radio"
              name="active-image"
              :checked="storage.active === RESCUE_MEDIUM"
              :disabled="!storage.rescue.hasImage"
              @change="selectImage(RESCUE_MEDIUM)"
            />
            <span class="image-text">
              <span class="image-name">Rescue image</span>
              <span class="muted image-sub">
                {{
                  storage.rescue.hasImage
                    ? `on flash · ${formatBytes(storage.rescue.capacityBytes)} slot`
                    : `empty · up to ${formatBytes(storage.rescue.capacityBytes)}`
                }}
              </span>
            </span>
          </label>
          <label :class="['btn', 'btn-sm', 'btn-quiet', { 'btn-disabled': uploadingRescue }]">
            {{
              uploadingRescue
                ? `${rescuePct}%...`
                : storage.rescue.hasImage
                  ? "Replace..."
                  : "Upload..."
            }}
            <input type="file" class="sr-only" :disabled="uploadingRescue" @change="onRescueChosen" />
          </label>
        </li>

        <li
          v-if="storage.mounted"
          :class="['image-row', { 'image-active': storage.active === WHOLE_SD_MEDIUM }]"
        >
          <label class="image-pick">
            <input
              type="radio"
              name="active-image"
              :checked="storage.active === WHOLE_SD_MEDIUM"
              @change="selectImage(WHOLE_SD_MEDIUM)"
            />
            <span class="image-text">
              <span class="image-name">Whole microSD card</span>
              <span class="muted image-sub">
                every file on the card · {{ formatBytes(storage.totalBytes) }}
              </span>
            </span>
          </label>
        </li>

        <li
          v-for="img in storage.images"
          :key="img.name"
          :class="['image-row', { 'image-active': img.name === storage.active }]"
        >
          <label class="image-pick">
            <input
              type="radio"
              name="active-image"
              :checked="img.name === storage.active"
              @change="selectImage(img.name)"
            />
            <span class="image-text">
              <span class="mono image-name">{{ img.name }}</span>
              <span class="muted image-sub">{{ formatBytes(img.size) }}</span>
            </span>
          </label>
          <button
            v-if="storage.writable"
            type="button"
            class="btn btn-sm btn-quiet"
            @click="removeImage(img.name)"
          >
            Delete
          </button>
        </li>
        <li
          v-if="storage.mounted && !storage.handedOver && storage.images.length === 0"
          class="muted image-empty"
        >
          No images on the card yet. Upload one below.
        </li>
      </ul>

      <UploadChart
        v-if="uploadingRescue"
        :trace="rescueTrace"
        :fraction="rescueFrac"
        :rate="rescueRate"
      />
      <p v-if="uploadingRescue" class="setting-note upload-stats">
        {{ rescueRate > 0 ? `${formatBytes(rescueRate)}/s` : "starting..." }}
        <span v-if="rescueRate > 0"> · ~{{ formatDuration(rescueEta) }} left</span>
        <button type="button" class="btn btn-sm btn-quiet" @click="cancelUpload">Cancel</button>
      </p>
      <p v-if="uploadingRescue && !streamPaused" class="setting-note">
        Video runs at 2 fps meanwhile -
        <button type="button" class="btn-link" @click="emit('pause-stream')">pause it</button>
        for full speed.
      </p>

      <p v-if="storage.rescue?.supported" class="setting-note">
        Need a rescue image? A small one fits the flash slot -
        <a href="https://netboot.xyz" target="_blank" rel="noreferrer">netboot.xyz</a>
        boots a menu of rescue systems and installers over the network. Download it, then use
        Upload above.
      </p>

      <label class="image-pick image-eject">
        <input
          type="radio"
          name="active-image"
          :checked="!storage.active"
          @change="selectImage('')"
        />
        <span>Eject - offer the target no medium</span>
      </label>

      <template v-if="storage.mounted && !storage.handedOver">
        <p class="setting-note">
          {{ formatBytes(storage.freeBytes) }} free of {{ formatBytes(storage.totalBytes) }} on the
          card.
          <template v-if="storage.busKhz">
            Bus {{ formatMhz(storage.busKhz) }}<template v-if="storage.busErrors">
              - slowed after {{ storage.busErrors }} failed
              {{ storage.busErrors === 1 ? "transfer" : "transfers" }}</template
            ><template v-if="storage.busRetryS && storage.busMaxKhz && storage.busKhz < storage.busMaxKhz"
              >; trying faster again in {{ formatDuration(storage.busRetryS) }}</template
            >.
          </template>
        </p>
        <p v-if="!storage.writable" class="setting-note setting-note-blocked">
          {{ storage.writeReason ?? "The card is read-only on this device." }}
        </p>
        <label
          v-if="storage.writable"
          :class="['btn', 'btn-sm', { 'btn-disabled': uploadingImage }]"
        >
          {{ uploadingImage ? `Uploading ${uploadPct}%...` : "Upload card image..." }}
          <input type="file" class="sr-only" :disabled="uploadingImage" @change="onImageChosen" />
        </label>
        <UploadChart
          v-if="uploadingImage"
          :trace="uploadTrace"
          :fraction="uploadFrac"
          :rate="uploadRate"
        />
        <p v-if="uploadingImage" class="setting-note upload-stats">
          {{ uploadRate > 0 ? `${formatBytes(uploadRate)}/s` : "starting..." }}
          <span v-if="uploadRate > 0"> · ~{{ formatDuration(uploadEta) }} left</span>
          <button type="button" class="btn btn-sm btn-quiet" @click="cancelUpload">Cancel</button>
        </p>
        <p v-if="uploadingImage && !streamPaused" class="setting-note">
          Video runs at 2 fps meanwhile -
          <button type="button" class="btn-link" @click="emit('pause-stream')">pause it</button>
          for full speed.
        </p>
      </template>
    </template>
  </div>
</template>
