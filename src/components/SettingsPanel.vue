<script setup lang="ts">
import Icon from "./Icon.vue";
/*
 * The settings panel renders itself from the schema the device serves, so a
 * setting added to the firmware table appears here with its title, range and
 * help text without any change in this file.
 *
 * A control whose capability the hardware lacks is shown disabled carrying the
 * device's own reason, rather than hidden. Hiding it would leave the operator
 * wondering whether the feature exists at all.
 */
import { computed, onMounted, reactive, ref } from "vue";

import {
  type SettingSection,
  type Capability,
  type PinInfo,
  type Setting,
  type TlsStatus,
  type Values,
  getTlsStatus,
  installCert,
  loadPins,
  type HeaderPin,
  resetSettings,
  restartDevice,
  revertCert,
  saveSettings,
  settingBlockedReason,
  findTelegramChats,
  loadNotifyStatus,
  type TelegramChats,
} from "../state/device";
import { changePassword, createViewToken, loadSession, logout, revokeViewToken } from "../state/auth";
import {
  buildFile,
  describePlan,
  fileName,
  planImport,
  readFile,
  type ImportPlan,
} from "../state/settingsFile";
import { runRestart } from "../state/restart";
import { TIME_ZONES, browserZone, zoneName, zoneOptions } from "../state/timezones";
import { toast } from "../state/toasts";
import { createSettingsEditor, groupSettings, type EditorState } from "../state/settingsEditor";

const props = defineProps<{
  schema: Setting[];
  /** Sections as the device describes them: id, title, what it is for. */
  sections: SettingSection[];
  values: Values;
  caps: Record<string, Capability>;
  /** The device's own WireGuard public key (from system info), to add to the hub. */
  wgPublicKey?: string;
  /** Tailnet state from system info, for the key's expiry date. */
  ts?: { keyExpiry?: number; keyExpired?: boolean };
  /** Firmware version, written into an exported file so it can be read later. */
  firmware?: string;
}>();

const emit = defineEmits<{ values: [Values]; passwordChanged: [] }>();

/*
 * A viewing token, for a dashboard that can only be given a URL.
 *
 * Home Assistant's camera integrations speak basic auth or nothing, and this
 * device speaks a session cookie - so putting a target's screen on a dashboard
 * used to mean turning the login off. The token is the alternative, and it is
 * deliberately narrow: the picture and the figures that describe it, no way to
 * touch the machine. The device keeps only a hash, so it is shown once.
 */
const tokenBusy = ref(false);
const tokenShown = ref("");
const tokenExists = ref(false);
/* Who is signed in, and whether anyone had to be: with the login off there is
   nothing to sign out of, so the button stays away. */
const sessionUser = ref("");
const signedIn = ref(false);
void loadSession()
  .then((s) => {
    tokenExists.value = Boolean(s.viewToken);
    sessionUser.value = s.user;
    signedIn.value = s.required && s.authenticated;
  })
  .catch(() => {
    /* the panel still works; the button simply offers to make one */
  });

async function makeViewToken() {
  tokenBusy.value = true;
  try {
    tokenShown.value = await createViewToken();
    tokenExists.value = true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    tokenBusy.value = false;
  }
}

async function dropViewToken() {
  if (!confirm("Revoke the viewing token? Anything using it stops working.")) return;
  tokenBusy.value = true;
  try {
    await revokeViewToken();
    tokenExists.value = false;
    tokenShown.value = "";
    toast.info("Viewing token revoked");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    tokenBusy.value = false;
  }
}

/* ---- time zone ---------------------------------------------------------- */
const tzOptions = zoneOptions();
const browserTz = browserZone();
/* Cities share strings (Berlin and Paris are both CET), so the one picked here,
   or the browser's own, is shown rather than the first in the list. */
const tzPicked = ref("");
/* The list entry for a stored string, or "" when it is not one of the list. */
function tzChoice(posix: string): string {
  if (tzPicked.value && TIME_ZONES[tzPicked.value] === posix) return tzPicked.value;
  if (browserTz.exact && browserTz.posix === posix) return browserTz.name;
  return zoneName(posix) ?? "";
}
function tzLabel(name: string): string {
  return tzOptions.find((z) => z.name === name)?.label ?? name;
}
function onTzPick(key: string, name: string) {
  if (!name) return;
  tzPicked.value = name;
  void write(key, TIME_ZONES[name]);
}

const sections = computed(() => {
  const present = new Set(props.schema.map((s) => s.section));
  const list = props.sections.filter((s) => present.has(s.id));
  /* The pin map is drawn from the board, not from a setting, so it is the one
     tab the device does not describe. */
  return [...list, { id: "pins", title: "Pins" }];
});

function sectionTitle(id: string): string {
  return sections.value.find((s) => s.id === id)?.title ?? id;
}

const sectionBlurb = computed(
  () => props.sections.find((s) => s.id === currentSection.value)?.blurb ?? "",
);

/* ---- finding one setting among a hundred ---------------------------------
 * The search runs over what the device published - title, help text and the
 * key itself - so it needs no list of its own and covers settings added to the
 * firmware later. */
const query = ref("");
const changedOnly = ref(false);

function isChanged(setting: Setting): boolean {
  const now = props.values[setting.key];
  if (now === undefined) return false;
  if (setting.secret) return false; /* never read back, so never comparable */
  return String(now) !== String(setting.default);
}

const searchHits = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  return props.schema.filter((entry) => {
    if (entry.section === "storage_hidden") return false;
    const haystack =
      `${entry.title} ${entry.help ?? ""} ${entry.key}`.toLowerCase();
    return haystack.includes(q) && (!changedOnly.value || isChanged(entry));
  });
});

/* Which help texts are open. Help is a sentence or three, and a hundred of them
   at once is a wall - so it lives behind a question mark. */
const helpOpen = ref(new Set<string>());

function toggleHelp(key: string) {
  const next = new Set(helpOpen.value);
  if (!next.delete(key)) next.add(key);
  helpOpen.value = next;
}

async function resetSetting(setting: Setting) {
  await write(setting.key, setting.default);
}

/* ---- GPIO pin map --------------------------------------------------------
 * The device reports which pins its fixed peripherals reserve; the rest of the
 * map is computed here from the "pin"-flagged settings. This feeds both the
 * per-setting pin pickers (free GPIOs only) and the Pins tab's comb view. */
const pinInfo = ref<PinInfo | null>(null);
onMounted(async () => {
  try {
    pinInfo.value = await loadPins();
  } catch {
    /* pins tab and pickers just stay empty if this fails */
  }
});

/*
 * The pin settings that count when working out what is free.
 *
 * A setting the panel hides is one the operator cannot reach, and holding a pin
 * against them for it would be unfair: the round LCD's five pins are stored even
 * on a device running an I2C OLED, where they drive nothing at all. The device
 * applies the same rule when it refuses a pin claimed twice, so the two agree
 * about which pins are really spoken for.
 */
const pinSettings = computed(() =>
  props.schema.filter(
    (s) => s.pin && (!s.showIf || Number(props.values[s.showIf.key]) === s.showIf.eq),
  ),
);

const reservedPins = computed(() => {
  const m = new Map<number, string>();
  for (const r of pinInfo.value?.reserved ?? []) {
    if (!m.has(r.pin)) m.set(r.pin, r.use);
  }
  return m;
});

const assignedPins = computed(() => {
  const m = new Map<number, string>();
  for (const s of pinSettings.value) {
    const v = Number(props.values[s.key] ?? -1);
    if (v >= 0 && !m.has(v)) m.set(v, s.title);
  }
  return m;
});

/* GPIOs a pin setting may take: the usable range minus everything already held,
 * plus its own current value so the select shows it. */
function freePinsFor(key: string): number[] {
  const info = pinInfo.value;
  if (!info) return [];
  const cur = Number(props.values[key] ?? -1);
  const used = new Set<number>(reservedPins.value.keys());
  for (const s of pinSettings.value) {
    if (s.key === key) continue;
    const v = Number(props.values[s.key] ?? -1);
    if (v >= 0) used.add(v);
  }
  const out: number[] = [];
  for (let p = info.usableMin; p <= info.usableMax; p++) {
    if (!used.has(p) || p === cur) out.push(p);
  }
  return out;
}

/*
 * Which of the two Pins views is showing.
 *
 * The header is the one an operator wants when there is a wire in their hand:
 * it is the connector as it is printed on the board, and it leaves out the
 * GPIOs that never reach a pin. The comb of every usable GPIO answers the other
 * question - what is still free - so both are kept.
 */
const pinView = ref<"header" | "gpio">("header");

/** What a pin is doing, for one entry of a header column. */
function describePin(p: HeaderPin, index: number, odd: boolean, numbered: boolean) {
  const n = numbered ? index * 2 + (odd ? 1 : 2) : null;
  if (p.gpio === undefined) {
    const label = p.label ?? "";
    const kind = label === "GND" ? "ground" : label === "NC" || label === "" ? "nc" : "power";
    return { n, gpio: null, label, use: "", kind, note: p.note };
  }
  const g = p.gpio;
  const use = reservedPins.value.get(g) ?? assignedPins.value.get(g) ?? "free";
  const kind = reservedPins.value.has(g)
    ? "reserved"
    : assignedPins.value.has(g)
      ? "assigned"
      : "free";
  return { n, gpio: g, label: `GPIO ${g}`, use, kind, note: p.note };
}

/* Each header as rows of two, so the markup can put them side by side the way
   they sit on the board. */
const headerRows = computed(() => {
  return (pinInfo.value?.headers ?? []).map((h) => ({
    name: h.name,
    numbered: h.numbered,
    rows: h.left.map((l, i) => ({
      left: describePin(l, i, true, h.numbered),
      right: h.right?.[i] ? describePin(h.right[i], i, false, h.numbered) : null,
    })),
  }));
});

const hasHeaders = computed(() => (pinInfo.value?.headers?.length ?? 0) > 0);

/* The whole map for the Pins tab, each GPIO tagged reserved / assigned / free. */
const pinMap = computed(() => {
  const info = pinInfo.value;
  if (!info) return [] as { pin: number; use: string; kind: string }[];
  const rows: { pin: number; use: string; kind: string }[] = [];
  for (let p = info.usableMin; p <= info.usableMax; p++) {
    if (reservedPins.value.has(p)) {
      rows.push({ pin: p, use: reservedPins.value.get(p)!, kind: "reserved" });
    } else if (assignedPins.value.has(p)) {
      rows.push({ pin: p, use: assignedPins.value.get(p)!, kind: "assigned" });
    } else {
      rows.push({ pin: p, use: "free", kind: "free" });
    }
  }
  return rows;
});

const active = ref("");
const currentSection = computed(() => active.value || sections.value[0]?.id || "video");
const bulkBusy = ref(false);
const editorState = reactive<EditorState>({ pending: 0, drafts: {} });
const busy = computed(() => bulkBusy.value || editorState.pending > 0);

const rows = computed(() => props.schema.filter((s) => s.section === currentSection.value));

/*
 * The VPN section is special. WireGuard and Tailscale are mutually exclusive on
 * the device, and showing every field of both at once means scrolling past the
 * backend you are not using. So the two enable toggles collapse into one
 * Off/WireGuard/Tailscale selector, and only the chosen backend's fields are
 * shown (nothing when Off).
 */
const VPN_WG_KEYS = new Set([
  "wg_address",
  "wg_private_key",
  "wg_peer_key",
  "wg_endpoint",
  "wg_keepalive",
  "wg_sntp",
  "wg_sntp_srv",
]);
const VPN_TS_KEYS = new Set(["ts_auth_key", "ts_hostname", "ts_ctrl_tls"]);

type VpnMode = "off" | "wg" | "ts";
const vpnMode = computed<VpnMode>(() =>
  props.values.wg_enable ? "wg" : props.values.ts_enable ? "ts" : "off",
);

/* Tailscale gives a node key six months at most; the device learns the date
   from the control plane and this is where an operator would look for it. */
const tsKeyNote = computed(() => {
  const ts = props.ts;
  if (!ts) return "";
  if (ts.keyExpired) {
    return "The tailnet key has run out - the device is off the tailnet until a fresh auth key is saved here.";
  }
  if (!ts.keyExpiry) return "";
  const when = new Date(ts.keyExpiry * 1000);
  const days = Math.ceil((when.getTime() - Date.now()) / 86400000);
  return `The tailnet key runs out on ${when.toLocaleString()} - in ${days} day${days === 1 ? "" : "s"}.`;
});

const displayRows = computed(() => {
  let list = rows.value;
  if (currentSection.value === "vpn") {
    const mode = vpnMode.value;
    list = list.filter((r) => {
      if (r.key === "wg_enable" || r.key === "ts_enable") return false;
      if (mode === "wg") return VPN_WG_KEYS.has(r.key);
      if (mode === "ts") return VPN_TS_KEYS.has(r.key);
      return false;
    });
  }
  /* Generic conditional visibility: a setting carrying showIf appears only while
   * the setting it names holds the given value. The GC9A01's SPI pins use this to
   * stay hidden unless the round LCD is the selected display type - an I2C OLED
   * has no pins to configure, so showing them would only mislead. */
  if (changedOnly.value) {
    list = list.filter(isChanged);
  }
  return list.filter(
    (r) => !r.showIf || Number(props.values[r.showIf.key]) === r.showIf.eq,
  );
});

/*
 * The rows as the device groups them: a heading, then its settings. A setting
 * with no group of its own comes first, under no heading at all.
 */
const grouped = computed(() => groupSettings(
  query.value.trim() ? searchHits.value : displayRows.value,
  Boolean(query.value.trim()), sectionTitle,
));

/* The I2C OLEDs (SSD1306/SH1106) ride the capture chip's I2C bus rather than pins
 * of their own - so there is nothing to configure, but the operator still needs to
 * know where to wire. Pull the real SDA/SCL out of the reserved-pin map, so the
 * note stays right even when a board overlay moves the capture bus. GC9A01 (index
 * 2) is SPI and has its own pin pickers, so it is excluded. */
const oledI2cNote = computed<{ sda: number; scl: number } | null>(() => {
  if (currentSection.value !== "display" || !props.values.disp_enable) return null;
  if (Number(props.values.disp_type ?? 0) === 2) return null;
  let sda: number | null = null;
  let scl: number | null = null;
  for (const [pin, use] of reservedPins.value) {
    if (/I2C SDA/i.test(use)) sda = pin;
    else if (/I2C SCL/i.test(use)) scl = pin;
  }
  return sda !== null && scl !== null ? { sda, scl } : null;
});

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.info("Copied to clipboard");
  } catch {
    toast.error("Could not copy - select and copy it manually");
  }
}

async function setVpnMode(mode: VpnMode) {
  if (mode === vpnMode.value) return;
  /* Enabling one backend clears the other on the device, so we only ever write a
     single flag; for Off we clear whichever is currently on. write() persists and
     refreshes values, so the visible fields follow the selection. */
  if (mode === "wg") await write("wg_enable", true);
  else if (mode === "ts") await write("ts_enable", true);
  else await write(props.values.wg_enable ? "wg_enable" : "ts_enable", false);
}

/* When one missing capability blocks the whole section, say so once at the top
   rather than repeating the same sentence under every control. */
const sectionBlocked = computed(() => {
  const blockers = rows.value.map((r) => settingBlockedReason(r, props.caps));
  return rows.value.length > 0 && blockers.every((b) => b !== null && b === blockers[0])
    ? blockers[0]
    : null;
});

function blockedFor(s: Setting): string | null {
  return sectionBlocked.value ? null : settingBlockedReason(s, props.caps);
}

const editor = createSettingsEditor(editorState,
  (key, value) => saveSettings({ [key]: value }),
  (values) => emit("values", values),
  (err) => toast.error(err instanceof Error ? err.message : String(err)),
);
const { write, commit, shown } = editor;

/* A focused native <select> or number <input> changes its value on mouse-wheel,
 * so idly scrolling the settings page while the cursor passes over one silently
 * flips a setting - e.g. the display type, which then leaves the panel driving the
 * wrong controller. Drop focus on wheel so the wheel scrolls the page instead of
 * editing the control (which is what almost everyone actually meant). */
function guardWheel(e: WheelEvent) {
  (e.target as HTMLElement).blur();
}

/*
 * A secret (a VPN key) is write-only: the device never sends it back, so the
 * field always shows empty. Submitting an empty field would clear the stored
 * value, which is never what a blank means here - blank means "keep what's
 * there". So only write when something was typed, and wipe the field afterwards
 * so the secret does not linger in the DOM.
 */
async function writeSecret(key: string, el: HTMLInputElement) {
  const value = el.value;
  if (!value) return;
  el.value = "";
  await write(key, value);
}

/*
 * Finding the Telegram chat id. A bot cannot list its chats, but the device
 * can read who wrote to it lately, so the id is picked rather than looked up.
 * The device asks Telegram with the saved token; the token never comes here.
 */
const tgFind = ref<TelegramChats | null>(null);
const tgFinding = ref(false);
async function findChats() {
  tgFinding.value = true;
  try {
    await findTelegramChats();
    // Two HTTPS requests on the device; give it up to half a minute.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = (await loadNotifyStatus()).telegram;
      if (!st) break;
      tgFind.value = st;
      if (st.state !== "running") break;
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    tgFinding.value = false;
  }
}

/*
 * Signing out ends this session on the device and reloads the page: the
 * keyboard and video sockets go with the page, so nothing is left knocking on
 * a door that is now shut. Other open consoles keep their own sessions.
 */
const signingOut = ref(false);
async function signOut() {
  signingOut.value = true;
  try {
    await logout();
    location.reload();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
    signingOut.value = false;
  }
}

/*
 * Changing the password.
 *
 * It is not a setting and deliberately so: the settings API reads and writes
 * plain values, and a password that can be read back is not a password. It
 * goes to its own endpoint, which demands the current one and stores only a
 * salted hash.
 */
const currentPassword = ref("");
const newPassword = ref("");
const repeatPassword = ref("");
const changingPassword = ref(false);

const passwordTooShort = computed(
  () => newPassword.value.length > 0 && newPassword.value.length < 8,
);
const passwordMismatch = computed(
  () => repeatPassword.value.length > 0 && newPassword.value !== repeatPassword.value,
);

async function submitPassword() {
  if (passwordTooShort.value || passwordMismatch.value || !newPassword.value) return;
  changingPassword.value = true;
  try {
    await changePassword(currentPassword.value, newPassword.value);
    currentPassword.value = "";
    newPassword.value = "";
    repeatPassword.value = "";
    /* Every session ended, including this one - the console has to send the
     * operator back to the sign-in form rather than pretend otherwise. */
    emit("passwordChanged");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    changingPassword.value = false;
  }
}

async function doRestart() {
  if (!confirm("Restart the device? It drops off the network for a few seconds. The target is not affected.")) {
    return;
  }
  try {
    if (await runRestart("Restarting the device", restartDevice, { kind: "manual" })) {
      location.reload();
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

/* Settings to a file and back. The device already decides what may leave it, so
   this is just what is on screen plus a header naming firmware and board. */
const importReport = ref<string[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);

function doExport() {
  const file = buildFile(props.values, props.schema, {
    firmware: props.firmware,
    board: pinInfo.value?.board,
  });
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(pinInfo.value?.board);
  a.click();
  URL.revokeObjectURL(url);
  toast.info("Settings saved to a file");
}

/* Read, plan, show what it would do, and only then write. The confirm is the
   point: an import that silently skipped half a file would be worse than none. */
async function onSettingsFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const chosen = input.files?.[0];
  input.value = ""; /* so the same file can be picked again after a fix */
  if (!chosen) return;
  let plan: ImportPlan;
  try {
    plan = planImport(readFile(await chosen.text()), props.schema, props.values, {
      board: pinInfo.value?.board,
    });
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
    return;
  }
  importReport.value = [];
  if (!Object.keys(plan.apply).length) {
    importReport.value = describePlan(plan, false);
    toast.info("Nothing in that file to change");
    return;
  }
  if (!confirm(`Apply this file?\n\n${describePlan(plan, false).join("\n\n")}`)) return;
  bulkBusy.value = true;
  try {
    await editor.flush();
    emit("values", await saveSettings(plan.apply));
    for (const key of Object.keys(plan.apply)) delete editorState.drafts[key];
    importReport.value = describePlan(plan, true);
    toast.info("Settings loaded from the file");
  } catch (err) {
    importReport.value = [];
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    bulkBusy.value = false;
  }
}

async function doReset() {
  if (!confirm("Restore every setting to its default?")) return;
  bulkBusy.value = true;
  try {
    await editor.flush();
    emit("values", await resetSettings());
    for (const key of Object.keys(editorState.drafts)) delete editorState.drafts[key];
    toast.info("Settings restored to defaults");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    bulkBusy.value = false;
  }
}

/*
 * Bring-your-own TLS certificate. Not a setting: it is a PEM blob validated and
 * stored on its own endpoint, and installing or removing it restarts the device.
 * `tls` stays null on firmware without the endpoint, so the panel just shows the
 * CA download in that case.
 */
const tls = ref<TlsStatus | null>(null);
const certText = ref("");
const tlsBusy = ref(false);

onMounted(async () => {
  try {
    tls.value = await getTlsStatus();
  } catch {
    /* older firmware without /api/v1/tls: leave null, show the CA download only */
  }
});

async function loadCertFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) certText.value = await file.text();
}

async function doInstallCert() {
  if (!certText.value.trim()) return;
  tlsBusy.value = true;
  try {
    await installCert(certText.value);
    certText.value = "";
    tls.value = { https: true, custom: true };
    toast.info("Certificate installed - the device is restarting to apply it");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    tlsBusy.value = false;
  }
}

async function doRevertCert() {
  if (!confirm("Remove your certificate and go back to the self-signed one? The device restarts.")) {
    return;
  }
  tlsBusy.value = true;
  try {
    await revertCert();
    tls.value = { https: true, custom: false };
    toast.info("Reverting to the self-signed certificate - the device is restarting");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    tlsBusy.value = false;
  }
}
</script>

<template>
  <div class="settings">
    <div class="tabs" role="tablist">
      <button
        v-for="s in sections"
        :key="s.id"
        type="button"
        role="tab"
        :aria-selected="s.id === currentSection"
        :class="['tab', { 'tab-active': s.id === currentSection }]"
        @click="active = s.id"
      >
        {{ s.title }}
      </button>
    </div>

    <!-- Beside the section list: the settings, and the buttons that act on
         all of them pinned under the scroll. -->
    <div class="settings-right">
      <!-- Everything but the section list: its own column in the window, the
           whole width in the panel. -->
      <div class="settings-main">
        <div class="settings-find">
          <!-- Named and marked off, or a browser takes the box above a password
               field for a username box and fills in the saved login. -->
          <input
            v-model="query"
            type="search"
            class="settings-search"
            name="setting-filter"
            autocomplete="off"
            data-1p-ignore
            data-lpignore="true"
            placeholder="Find a setting"
            aria-label="Find a setting"
          />
          <button
            type="button"
            :class="['btn', 'btn-sm', { 'btn-on': changedOnly }]"
            :aria-pressed="changedOnly"
            title="Only the settings that differ from the factory values"
            @click="changedOnly = !changedOnly"
          >
            Changed
          </button>
        </div>

        <p v-if="query.trim()" class="setting-note">
          {{ searchHits.length }} of {{ schema.length }} settings match.
        </p>
        <p v-else-if="sectionBlurb" class="setting-note">{{ sectionBlurb }}</p>

        <p v-if="sectionBlocked && !query.trim()" class="section-blocked">
          {{ sectionBlocked }}
        </p>

        <div class="settings-list">
          <div v-if="currentSection === 'vpn'" class="setting">
            <div class="setting-head">
              <label class="setting-title" for="vpn-mode">VPN backend</label>
            </div>
            <div class="setting-control">
              <select
                id="vpn-mode"
                :value="vpnMode"
                :disabled="busy"
                @change="
                  setVpnMode(
                    ($event.target as HTMLSelectElement).value as VpnMode,
                  )
                "
                @wheel="guardWheel"
              >
                <option value="off">Off</option>
                <option value="wg">WireGuard</option>
                <option value="ts">Tailscale</option>
              </select>
            </div>
            <p class="setting-note">
              Only one VPN runs at a time; choosing one shows just its settings.
            </p>
          </div>

          <template v-for="block in grouped" :key="block.key">
            <h3 v-if="block.name" class="settings-group">{{ block.name }}</h3>
            <div
              v-for="s in block.rows"
              :key="s.key"
              :class="[
                'setting',
                { 'setting-blocked': busy || sectionBlocked || blockedFor(s) },
              ]"
            >
              <div class="setting-head">
                <label class="setting-title" :for="`set-${s.key}`">{{
                  s.title
                }}</label>
                <span
                  v-if="s.reboot"
                  class="badge"
                  title="Applies after a restart"
                  >restart</span
                >
                <span class="setting-head-actions">
                  <button
                    v-if="s.help"
                    type="button"
                    class="icon-btn"
                    :aria-label="`What ${s.title} does`"
                    :aria-expanded="helpOpen.has(s.key)"
                    title="What this does"
                    @click="toggleHelp(s.key)"
                  >
                    <Icon name="info" :size="14" />
                  </button>
                  <button
                    v-if="isChanged(s) && !blockedFor(s)"
                    type="button"
                    class="icon-btn"
                    :aria-label="`Put ${s.title} back to the factory value`"
                    title="Back to the factory value"
                    :disabled="busy"
                    @click="resetSetting(s)"
                  >
                    <Icon name="undo" :size="14" />
                  </button>
                </span>
              </div>

              <div class="setting-control">
                <label v-if="s.type === 'bool'" class="switch">
                  <input
                    :id="`set-${s.key}`"
                    type="checkbox"
                    :checked="Boolean(values[s.key])"
                    :disabled="busy || !!sectionBlocked || !!blockedFor(s)"
                    @change="
                      write(s.key, ($event.target as HTMLInputElement).checked)
                    "
                  />
                  <span class="muted">{{ values[s.key] ? "On" : "Off" }}</span>
                </label>

                <select
                  v-else-if="s.type === 'enum'"
                  :id="`set-${s.key}`"
                  :disabled="busy || !!sectionBlocked || !!blockedFor(s)"
                  :value="String(Number(values[s.key] ?? 0))"
                  @change="
                    write(
                      s.key,
                      Number(($event.target as HTMLSelectElement).value),
                    )
                  "
                  @wheel="guardWheel"
                >
                  <option
                    v-for="(c, i) in s.choices ?? []"
                    :key="c"
                    :value="String(i)"
                  >
                    {{ c }}
                  </option>
                </select>

                <select
                  v-else-if="s.pin"
                  :id="`set-${s.key}`"
                  class="num-input"
                  :disabled="busy || !!sectionBlocked || !!blockedFor(s)"
                  :value="String(Number(values[s.key] ?? -1))"
                  @change="
                    write(
                      s.key,
                      Number(($event.target as HTMLSelectElement).value),
                    )
                  "
                  @wheel="guardWheel"
                >
                  <option value="-1">None</option>
                  <option
                    v-for="p in freePinsFor(s.key)"
                    :key="p"
                    :value="String(p)"
                  >
                    GPIO {{ p }}
                  </option>
                </select>

                <input
                  v-else-if="s.type === 'int'"
                  :id="`set-${s.key}`"
                  type="number"
                  class="num-input"
                  :min="s.min"
                  :max="s.max"
                  :value="shown(s.key, String(Number(values[s.key] ?? 0)))"
                  :disabled="bulkBusy || !!sectionBlocked || !!blockedFor(s)"
                  @input="editor.edit(s.key, ($event.target as HTMLInputElement).value)"
                  @change="
                    commit(
                      s.key,
                      Number(($event.target as HTMLInputElement).value),
                    )
                  "
                  @wheel="guardWheel"
                />

                <!-- Read-only until focused: browsers do not autofill a read-only
                     field, and some ignore "new-password" and fill the console's
                     own password into the MQTT one. -->
                <input
                  v-else-if="s.secret"
                  :id="`set-${s.key}`"
                  type="password"
                  :name="`secret-${s.key}`"
                  autocomplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                  readonly
                  @focus="($event.target as HTMLInputElement).readOnly = false"
                  :maxlength="s.maxLength"
                  placeholder="Leave blank to keep the current value"
                  :disabled="busy || !!sectionBlocked || !!blockedFor(s)"
                  @change="writeSecret(s.key, $event.target as HTMLInputElement)"
                />

                <!-- The time zone: one list of cities over the POSIX string the device takes. -->
                <select
                  v-else-if="s.key === 'sched_tz'"
                  :id="`set-${s.key}`"
                  :disabled="busy || !!sectionBlocked || !!blockedFor(s)"
                  :value="tzChoice(String(values[s.key] ?? ''))"
                  @change="
                    onTzPick(s.key, ($event.target as HTMLSelectElement).value)
                  "
                  @wheel="guardWheel"
                >
                  <option v-if="browserTz.exact" :value="browserTz.name">
                    This browser: {{ tzLabel(browserTz.name) }}
                  </option>
                  <option
                    v-if="!tzChoice(String(values[s.key] ?? ''))"
                    :value="''"
                  >
                    {{ String(values[s.key] ?? "") || "Not set" }} (set another
                    way)
                  </option>
                  <option v-for="z in tzOptions" :key="z.name" :value="z.name">
                    {{ z.label }}
                  </option>
                </select>

                <!-- Not a login form: without these a browser puts the console's own
                     saved user name into fields like the MQTT user. -->
                <input
                  v-else
                  :id="`set-${s.key}`"
                  type="text"
                  :name="`field-${s.key}`"
                  autocomplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                  :maxlength="s.maxLength"
                  :value="shown(s.key, String(values[s.key] ?? ''))"
                  :disabled="bulkBusy || !!sectionBlocked || !!blockedFor(s)"
                  @input="editor.edit(s.key, ($event.target as HTMLInputElement).value)"
                  @change="
                    commit(s.key, ($event.target as HTMLInputElement).value)
                  "
                />
              </div>

              <p v-if="blockedFor(s)" class="setting-note setting-note-blocked">
                {{ blockedFor(s) }}
              </p>
              <p v-else-if="s.help && helpOpen.has(s.key)" class="setting-note">
                {{ s.help }}
              </p>

              <div
                v-if="s.key === 'notify_tg_chat' && !blockedFor(s)"
                class="tg-find"
              >
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="busy || tgFinding"
                  @click="findChats"
                >
                  {{ tgFinding ? "Asking Telegram..." : "Find chats" }}
                </button>
                <p
                  v-if="tgFind?.state === 'error'"
                  class="setting-note setting-note-blocked"
                >
                  {{ tgFind.error }}
                </p>
                <template v-else-if="tgFind?.state === 'ok'">
                  <p v-if="!tgFind.chats.length" class="setting-note">
                    No chats yet. Send any message to
                    <b>@{{ tgFind.bot }}</b
                    >, or add it to a group, then press Find chats again.
                  </p>
                  <ul v-else class="tg-chats">
                    <li v-for="c in tgFind.chats" :key="c.id">
                      <button
                        type="button"
                        :class="[
                          'btn',
                          'btn-sm',
                          { 'btn-on': String(values[s.key] ?? '') === c.id },
                        ]"
                        :disabled="busy"
                        @click="write(s.key, c.id)"
                      >
                        {{ c.name || c.id }}
                      </button>
                      <span class="muted">{{ c.type }} &middot; {{ c.id }}</span>
                    </li>
                  </ul>
                </template>
              </div>
            </div>
          </template>

          <p v-if="oledI2cNote" class="setting-note">
            This I²C OLED shares the capture chip's I²C bus — wire it to
            <b>SDA {{ oledI2cNote.sda }}</b> ·
            <b>SCL {{ oledI2cNote.scl }}</b> (plus 3V3 and GND). Those are the
            board's capture pins, so there's nothing to set here; the panel is
            auto-detected at 0x3C/0x3D.
          </p>

          <div v-if="currentSection === 'pins'" class="pinmap">
            <div v-if="hasHeaders" class="pin-views">
              <button
                type="button"
                :class="['pin-view-btn', { on: pinView === 'header' }]"
                @click="pinView = 'header'"
              >
                Header
              </button>
              <button
                type="button"
                :class="['pin-view-btn', { on: pinView === 'gpio' }]"
                @click="pinView = 'gpio'"
              >
                All GPIO
              </button>
            </div>

            <template v-if="hasHeaders && pinView === 'header'">
              <p class="setting-note">
                The expansion header of the {{ pinInfo?.board }}, laid out as it
                is on the board - so a pin here is a place to put a wire.
                <b>Reserved</b> pins are the board's fixed peripherals;
                <b>assigned</b> are set by the pin pickers on the other tabs;
                <b>free</b> pins are what those pickers offer.
              </p>
              <p
                v-if="pinInfo?.headerVerified === false"
                class="setting-note pin-caveat"
              >
                This pinout comes from the vendor's diagram and has not been
                checked against a board in hand. Confirm against the silkscreen
                before you wire anything.
              </p>
              <div v-for="h in headerRows" :key="h.name" class="pin-header">
                <h4 v-if="h.name" class="pin-header-name">{{ h.name }}</h4>
                <ul class="pin-rows">
                  <li
                    v-for="(row, i) in h.rows"
                    :key="i"
                    :class="['pin-row', { numbered: h.numbered }]"
                  >
                    <span
                      :class="['pin-side', 'pin-left', `pin-${row.left.kind}`]"
                      :title="row.left.note"
                    >
                      <span class="pin-name">{{ row.left.label }}</span>
                      <span v-if="row.left.kind !== 'free'" class="pin-use">{{
                        row.left.use
                      }}</span>
                    </span>
                    <span v-if="h.numbered" class="pin-n">{{ row.left.n }}</span>
                    <span v-if="h.numbered" class="pin-n">{{
                      row.right?.n
                    }}</span>
                    <span
                      v-if="row.right"
                      :class="['pin-side', 'pin-right', `pin-${row.right.kind}`]"
                      :title="row.right.note"
                    >
                      <span class="pin-name">{{ row.right.label }}</span>
                      <span v-if="row.right.kind !== 'free'" class="pin-use">{{
                        row.right.use
                      }}</span>
                    </span>
                  </li>
                </ul>
              </div>
            </template>

            <template v-else>
              <p class="setting-note">
                Every usable GPIO and what holds it. <b>Reserved</b> pins are the
                board's fixed peripherals; <b>assigned</b> are set by the pin
                pickers on the other tabs; <b>free</b>
                pins are what those pickers offer. Change a pin on its own tab.
              </p>
              <p v-if="!hasHeaders && pinInfo?.board" class="setting-note">
                No pinout is known for the {{ pinInfo.board }}, so there is no
                header to draw.
              </p>
              <ul class="pin-comb">
                <li
                  v-for="p in pinMap"
                  :key="p.pin"
                  :class="['pin-cell', `pin-${p.kind}`]"
                >
                  <span class="pin-num">{{ p.pin }}</span>
                  <span class="pin-use">{{ p.use }}</span>
                </li>
              </ul>
            </template>
            <p v-if="pinMap.length === 0" class="setting-note">
              Reading the pin map...
            </p>
          </div>

          <!-- A tailnet key lasts six months at most, so the date is worth
               saying out loud rather than leaving in the admin console. -->
          <div
            v-if="currentSection === 'vpn' && vpnMode === 'ts' && tsKeyNote"
            class="setting"
          >
            <div class="setting-head">
              <label class="setting-title">Key</label>
            </div>
            <p class="setting-note">{{ tsKeyNote }}</p>
          </div>

          <div
            v-if="currentSection === 'vpn' && vpnMode === 'wg' && wgPublicKey"
            class="setting"
          >
            <div class="setting-head">
              <label class="setting-title">Device public key</label>
            </div>
            <div class="setting-control pubkey-row">
              <input
                class="pubkey-field mono"
                type="text"
                :value="wgPublicKey"
                readonly
              />
              <button
                type="button"
                class="btn btn-sm"
                @click="copyText(wgPublicKey!)"
              >
                Copy
              </button>
            </div>
            <p class="setting-note">
              Add this to your WireGuard hub as this device's peer public key.
            </p>
          </div>
        </div>

        <div v-if="currentSection === 'security' && signedIn" class="firmware">
          <h3>Session</h3>
          <p class="setting-note">
            Signed in as <strong>{{ sessionUser }}</strong
            >. Signing out ends this session only; other open consoles keep
            theirs.
          </p>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="signingOut"
            @click="signOut"
          >
            {{ signingOut ? "Signing out..." : "Sign out" }}
          </button>
        </div>

        <form
          v-if="currentSection === 'security'"
          class="firmware"
          @submit.prevent="submitPassword"
        >
          <h3>Password</h3>
          <p class="setting-note">
            Not listed above with the other settings: those can be read back, and
            a password that can be read back is not one. Changing it signs out
            every open console.
          </p>
          <label class="field">
            <span>Current password</span>
            <input
              v-model="currentPassword"
              type="password"
              autocomplete="current-password"
            />
          </label>
          <label class="field">
            <span>New password</span>
            <input
              v-model="newPassword"
              type="password"
              autocomplete="new-password"
            />
          </label>
          <label class="field">
            <span>Repeat it</span>
            <input
              v-model="repeatPassword"
              type="password"
              autocomplete="new-password"
            />
          </label>
          <p v-if="passwordTooShort" class="setting-note">
            At least 8 characters.
          </p>
          <p v-else-if="passwordMismatch" class="setting-note">
            The two do not match.
          </p>
          <button
            type="submit"
            class="btn btn-sm"
            :disabled="
              changingPassword ||
              passwordTooShort ||
              passwordMismatch ||
              !newPassword
            "
          >
            {{ changingPassword ? "Changing..." : "Change password" }}
          </button>
        </form>

        <div v-if="currentSection === 'security'" class="firmware">
          <h3>Viewing token</h3>
          <p class="setting-note">
            One long string that opens the picture and nothing else - the MJPEG
            stream, a single frame, and the capture's figures. It is for a
            dashboard that can only be handed a URL, such as a camera card in Home
            Assistant. It cannot press a key, touch the power, or change a
            setting, and the device keeps only a hash of it, so it is shown once.
          </p>
          <p v-if="tokenShown" class="setting-note mono token-shown">
            {{ tokenShown }}
          </p>
          <p v-if="tokenShown" class="setting-note">
            Copy it now. Use it as <span class="mono">?token=...</span> on
            <span class="mono">/stream</span>, or as an
            <span class="mono">Authorization: Bearer</span> header.
          </p>
          <p v-else-if="tokenExists" class="setting-note">
            A token exists. Making a new one replaces it; whatever used the old
            one stops working.
          </p>
          <div class="token-buttons">
            <button
              type="button"
              class="btn btn-sm"
              :disabled="tokenBusy"
              @click="makeViewToken"
            >
              {{ tokenExists ? "Replace the token" : "Create a token" }}
            </button>
            <button
              v-if="tokenExists"
              type="button"
              class="btn btn-sm btn-danger"
              :disabled="tokenBusy"
              @click="dropViewToken"
            >
              Revoke
            </button>
          </div>
        </div>

        <div v-if="currentSection === 'security'" class="firmware">
          <h3>Device certificate</h3>

          <template v-if="tls?.custom">
            <p class="setting-note">
              The device is serving your own certificate. Whatever issued it is
              trusted elsewhere, so there is no CA to import here. Remove it to go
              back to the self-signed certificate.
            </p>
            <button
              type="button"
              class="btn btn-sm"
              :disabled="tlsBusy"
              @click="doRevertCert"
            >
              {{
                tlsBusy ? "Reverting..." : "Revert to the self-signed certificate"
              }}
            </button>
          </template>

          <template v-else>
            <p class="setting-note">
              The device is its own certificate authority, so a browser warns
              until you trust it - and refuses the WebSocket and the H.264 decoder
              until you do. Download the CA and add it to your operating system or
              browser's trusted authorities (not "your certificates"), then reach
              the device by its name. That clears the warning and enables H.264.
            </p>
            <a class="btn btn-sm" href="/cert.pem" download="espkvm-ca.pem"
              >Download CA certificate</a
            >

            <template v-if="tls">
              <p class="setting-note" style="margin-top: 16px">
                Or install your own certificate - from an internal CA, or a real
                one for a name that resolves to the device - so the browser trusts
                it without importing anything. Paste the certificate (chain, leaf
                first) followed by its private key, or pick a combined PEM file.
                The device restarts to apply it.
              </p>
              <textarea
                v-model="certText"
                class="cert-input"
                rows="6"
                spellcheck="false"
                autocapitalize="off"
                autocomplete="off"
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----&#10;-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
              ></textarea>
              <div class="cert-actions">
                <input
                  type="file"
                  accept=".pem,.crt,.cer,.key,.txt"
                  @change="loadCertFile"
                />
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="tlsBusy || !certText.trim()"
                  @click="doInstallCert"
                >
                  {{ tlsBusy ? "Installing..." : "Install certificate" }}
                </button>
              </div>
            </template>
          </template>
        </div>

        <p v-for="(line, i) in importReport" :key="i" class="setting-note">
          {{ line }}
        </p>

      </div>

      <div class="settings-footer">
        <button
          type="button"
          class="btn btn-sm"
          :disabled="busy"
          @click="doExport"
        >
          Save settings to a file
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :disabled="busy"
          @click="fileInput?.click()"
        >
          Load from a file
        </button>
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          hidden
          @change="onSettingsFile"
        />
        <button type="button" class="btn btn-sm" @click="doRestart">
          Restart device
        </button>
        <button
          type="button"
          class="btn btn-sm btn-danger"
          :disabled="busy"
          @click="doReset"
        >
          Restore defaults
        </button>
      </div>
    </div>
  </div>
</template>
