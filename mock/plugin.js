/*
 * A stand-in for the device, so the interface can be built and looked at
 * without hardware attached.
 *
 * It answers the same endpoints as the firmware and pushes the same control
 * frames, which means every state the UI has to handle - no signal, no target
 * attached, a resolution change, a capability the hardware lacks - can be
 * produced on demand instead of waited for. Several of them are awkward to
 * reproduce on real hardware and would otherwise go untested until a user
 * found them.
 *
 * Enable with:  npm run dev:mock
 */

import { WebSocketServer } from "ws";

import { renderFrame } from "./frame.js";

/* Mirrors components/kvm_config/kvm_settings_table.c. */
const SCHEMA = [
  { key: "vid_codec", section: "video", title: "Stream codec", type: "enum",
    choices: ["mjpeg", "h264"], default: 0,
    help: "H.264 needs roughly a tenth of the bandwidth of MJPEG but requires a browser with WebCodecs." },
  { key: "jpg_quality", section: "video", title: "JPEG quality", type: "int", min: 1, max: 100,
    default: 70, requires: "mjpeg", help: "Higher is sharper and larger. Only affects the MJPEG codec." },
  { key: "h264_kbps", section: "video", title: "H.264 bitrate (kbit/s)", type: "int", min: 500,
    max: 20000, default: 4000, requires: "h264" },
  { key: "vid_fps_max", section: "video", title: "Frame rate limit", type: "int", min: 1, max: 60,
    default: 30, requires: "video" },
  { key: "vid_adapt", section: "video", title: "Skip unchanged frames", type: "bool", default: 1,
    requires: "video",
    help: "Stop encoding while the target's screen is static. Drops the bitrate to nearly zero on an idle desktop." },
  { key: "edid_prof", section: "video", title: "EDID profile", type: "enum",
    choices: ["full", "1080p30", "custom"], default: 0, requires: "video", reboot: true,
    help: "What the capture card claims to be." },

  { key: "ptr_engage", section: "input", title: "Start controlling on", type: "enum",
    choices: ["click", "hover"], default: 0, requires: "hid",
    help: "\"click\" waits for a click on the video before input reaches the target." },
  { key: "mouse_mode", section: "input", title: "Pointer mode", type: "enum",
    choices: ["absolute", "relative", "auto"], default: 0, requires: "hid" },
  { key: "mouse_sens", section: "input", title: "Relative sensitivity (%)", type: "int", min: 10,
    max: 400, default: 100, requires: "hid" },
  { key: "scroll_inv", section: "input", title: "Invert scroll wheel", type: "bool", default: 0,
    requires: "hid" },
  { key: "kbd_layout", section: "input", title: "Target keyboard layout", type: "enum",
    choices: ["en_us", "ru_ru"], default: 0, requires: "hid",
    help: "A KVM sends key positions, not characters." },
  { key: "type_delay", section: "input", title: "Paste keystroke delay (ms)", type: "int", min: 1,
    max: 200, default: 8, requires: "hid" },

  { key: "msc_enable", section: "storage", title: "Expose virtual media", type: "bool", default: 0,
    requires: "msc" },
  { key: "msc_mode", section: "storage", title: "Media type", type: "enum",
    choices: ["cdrom", "removable", "whole_sd"], default: 0, requires: "msc" },
  { key: "msc_image", section: "storage", title: "Mounted image", type: "string", maxLength: 63,
    default: "", requires: "msc" },

  { key: "atx_enable", section: "power", title: "Enable ATX control", type: "bool", default: 0,
    requires: "atx" },
  { key: "atx_long_ms", section: "power", title: "Force-off hold (ms)", type: "int", min: 1000,
    max: 15000, default: 5000, requires: "atx" },

  { key: "net_hostname", section: "network", title: "Hostname", type: "string", maxLength: 31,
    default: "espkvm", reboot: true },
  { key: "net_dhcp", section: "network", title: "Obtain address automatically", type: "bool",
    default: 1, reboot: true },
  { key: "net_ipv6", section: "network", title: "IPv6", type: "bool", default: 1, reboot: true,
    help: "Also answer on an IPv6 address, alongside IPv4. There is nothing to configure: the address comes from the router's advertisements." },

  { key: "sec_https", section: "security", title: "Serve over HTTPS", type: "bool", default: 1,
    requires: "https", reboot: true },
  { key: "sec_user", section: "security", title: "Username", type: "string", maxLength: 31,
    default: "admin", requires: "https" },

  { key: "upd_check", section: "system", title: "Offer firmware updates", type: "bool",
    default: 0, requires: "ota",
    help: "The browser asks the address below whether a newer build exists and offers to install it. The device never reaches out on its own." },
  { key: "upd_url", section: "system", title: "Update manifest", type: "string",
    default: "", maxLength: 200, requires: "ota",
    help: "URL of a manifest.json describing the newest build." },
  { key: "log_level", section: "system", title: "Log verbosity", type: "enum",
    choices: ["error", "warn", "info", "debug"], default: 2 },
  { key: "macros_json", section: "macros", title: "User key macros", type: "string",
    maxLength: 2000, default: "[]", requires: "hid" },
  { key: "runbooks_json", section: "runbooks", title: "Runbooks", type: "string",
    maxLength: 3000, default: "[]", requires: "runbooks" },
  { key: "sched_enable", section: "schedules", title: "Run schedules", type: "bool",
    default: 0, requires: "scheduler" },
  { key: "sched_ntp", section: "schedules", title: "Time server (NTP)", type: "string",
    maxLength: 64, default: "pool.ntp.org", requires: "scheduler" },
  { key: "sched_tz", section: "schedules", title: "Time zone (POSIX TZ)", type: "string",
    maxLength: 48, default: "UTC0", requires: "scheduler" },
  { key: "schedules_json", section: "schedules", title: "Schedules", type: "string",
    maxLength: 3000, default: "[]", requires: "scheduler" },
  { key: "notify_enable", section: "notify", title: "Send notifications", type: "bool",
    default: 0, requires: "notify" },
  { key: "notify_watch", section: "notify", title: "On a screen-watch phrase", type: "bool",
    default: 1, requires: "notify" },
  { key: "notify_flat", section: "notify", title: "On a blank screen", type: "bool",
    default: 0, requires: "notify" },
  { key: "notify_snap", section: "notify", title: "Attach a screenshot", type: "bool",
    default: 1, requires: "notify" },
  { key: "notify_log", section: "notify", title: "Attach recent log", type: "bool",
    default: 0, requires: "notify" },
  { key: "notify_tg_token", section: "notify", title: "Telegram bot token", type: "string",
    maxLength: 64, default: "", requires: "notify", secret: true },
  { key: "notify_tg_chat", section: "notify", title: "Telegram chat id", type: "string",
    maxLength: 32, default: "", requires: "notify" },
  { key: "notify_url", section: "notify", title: "Webhook URL", type: "string",
    maxLength: 200, default: "", requires: "notify" },
];

/* A pretend runbook engine: it walks the script's lines on a timer, a wait
   "matches" after two seconds, so the panel's polling and its Stop can be
   seen without a target. */
const runbook = { state: "idle", name: "", step: 0, steps: 0, line: "", message: "nothing has run", elapsedMs: 0 };
let runbookTimer = null;
let runbookStarted = 0;
function runbookStatus() {
  return { ...runbook, elapsedMs: runbook.state === "running" ? Date.now() - runbookStarted : runbook.elapsedMs };
}
function runbookStart(name, values) {
  let list = [];
  try { list = JSON.parse(values.runbooks_json || "[]"); } catch { list = []; }
  const rb = list.find((r) => r.name === name);
  if (!rb) return 404;
  if (runbook.state === "running") return 409;
  const lines = rb.script.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  Object.assign(runbook, { state: "running", name, step: 0, steps: lines.length, line: "", message: "running" });
  runbookStarted = Date.now();
  const advance = () => {
    if (runbook.step >= lines.length) {
      Object.assign(runbook, { state: "done", message: "done", elapsedMs: Date.now() - runbookStarted });
      runbookTimer = null;
      return;
    }
    runbook.step += 1;
    runbook.line = lines[runbook.step - 1];
    runbookTimer = setTimeout(advance, /^(wait|gone)\b/i.test(runbook.line) ? 2000 : 600);
  };
  advance();
  return 202;
}
function runbookStop() {
  if (runbook.state !== "running") return 409;
  clearTimeout(runbookTimer);
  runbookTimer = null;
  Object.assign(runbook, { state: "stopped", message: `stopped at step ${runbook.step}`, elapsedMs: Date.now() - runbookStarted });
  return 200;
}

/* Matches what the real device reports today: video and input work, the rest
 * is either absent hardware or not built yet. */
const CAPS = {
  video: { compiled: true, available: true, enabled: true, active: true },
  mjpeg: { compiled: true, available: true, enabled: true, active: true },
  h264: { compiled: true, available: true, enabled: true, active: true },
  hid: { compiled: true, available: true, enabled: true, active: true },
  runbooks: { compiled: true, available: true, enabled: true, active: true },
  scheduler: { compiled: true, available: true, enabled: true, active: true },
  notify: { compiled: true, available: true, enabled: true, active: true },
  msc: { compiled: true, available: false, enabled: false, active: false, setting: "msc_enable",
         reason: "virtual media not implemented yet" },
  atx: { compiled: true, available: false, enabled: false, active: false, setting: "atx_enable",
         reason: "power control not implemented yet" },
  audio: { compiled: false, available: false, enabled: false, active: false,
           reason: "not built into this firmware" },
  https: { compiled: true, available: false, enabled: true, active: false,
           reason: "TLS and login not implemented yet" },
  ota: { compiled: true, available: false, enabled: true, active: false,
         reason: "partition table has no second app slot" },
};

const values = Object.fromEntries(
  SCHEMA.map((s) => [s.key, s.type === "string" ? s.default : s.default]),
);

/** Scenario knobs, driven from /mock/state so states can be forced on demand. */
const state = {
  signal: true,
  attached: true,
  /* The target's port is live. Force it false to see what the console says
     when there is no bus at all, as against a host that stopped listening. */
  busAlive: true,
  leds: 0,
  width: 1920,
  height: 1080,
  modeChanges: 1,
  viewers: 1,
  /* Driven from /mock/state so the thermal states can be looked at without a
     hot chip. */
  tempC: 44.3,
  thermal: "normal",
};

function json(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export function mockDevice() {
  return {
    name: "espkvm-mock-device",
    apply: "serve",
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });

      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (!req.url.startsWith("/ws")) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          const sendStatus = () =>
            ws.send(
              Buffer.from([
                0x81,
                (state.attached ? 1 : 0) | (state.busAlive ? 2 : 0),
                state.leds,
              ]),
            );
          ws.on("message", (data) => {
            const b = Buffer.from(data);
            if (b[0] === 0x06) {
              ws.send(Buffer.from([0x82]));
              sendStatus();
            }
          });
          state.wsSend = sendStatus;
        });
      });

      server.middlewares.use((req, res, next) => {
        const url = req.url.split("?")[0];

        /*
         * The device answers "who is asking?" before anything else, so the
         * mock has to as well - otherwise the console sits on its sign-in
         * screen forever, or worse, fails to start. The mock is always logged
         * in: there is nothing here worth protecting.
         */
        if (url === "/api/v1/auth/session") {
          return json(res, { required: true, authenticated: true, mustChange: false, user: "admin" });
        }
        if (url === "/api/v1/auth/login" && req.method === "POST") {
          return json(res, { mustChange: false });
        }
        if (url === "/api/v1/auth/logout" && req.method === "POST") {
          return json(res, { status: "logged out" });
        }
        if (url === "/api/v1/auth/password" && req.method === "POST") {
          return json(res, { status: "changed" });
        }

        if (url === "/api/v1/system/info") {
          return json(res, {
            project: "espkvm",
            version: "mock",
            built: "mock build",
            idf: "v6.0.1",
            partition: "ota_0",
            updatable: true,
            uptimeSeconds: Math.floor(process.uptime()),
            heapFree: 14_000_000,
            psramFree: 13_500_000,
            tempC: state.tempC,
            thermal: state.thermal,
            /* Enough for the network panel behind the footer's link pill: a name,
               an IPv4 address, and one of each kind of IPv6 address. */
            net: {
              up: true,
              mbps: 100,
              mode: "ethernet",
              hostname: "espkvm",
              ip4: "192.168.1.42",
              mac: "30:AE:A4:1B:9C:07",
              ipv6: [
                "2001:db8:1f0d:4a00:32ae:a4ff:fe1b:9c07",
                "fd7c:2b1e:6a44::32ae:a4ff:fe1b:9c07",
                "fe80::32ae:a4ff:fe1b:9c07",
              ],
            },
          });
        }
        if (url === "/api/v1/system/restart" && req.method === "POST") {
          return json(res, { status: "restarting" });
        }

        if (url === "/api/v1/audio/status") return json(res, { available: true, enabled: true, rate: 48000 });
        if (url === "/audio.pcm") {
          // Synthetic 440 Hz stereo tone, strictly confined to dev:mock.
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store",
            "X-Audio-Rate": "48000", "X-Audio-Format": "s16le-stereo", "X-Audio-Synthetic": "true" });
          req.socket.setNoDelay(true);
          let frame = 0;
          const timer = setInterval(() => {
            const pcm = Buffer.alloc(480 * 4);
            for (let i = 0; i < 480; i++, frame++) {
              const sample = Math.round(3276 * Math.sin(2 * Math.PI * 440 * frame / 48000));
              pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2);
            }
            if (!res.write(pcm)) res.destroy();
          }, 10);
          res.on("close", () => clearInterval(timer));
          return;
        }
        if (url === "/api/capabilities") return json(res, CAPS);
        if (url === "/api/v1/settings/schema") return json(res, SCHEMA);
        if (url === "/api/v1/settings" && req.method === "GET") return json(res, values);
        if (url === "/api/v1/settings" && req.method === "PUT") {
          return readBody(req).then((body) => {
            let patch;
            try {
              patch = JSON.parse(body);
            } catch {
              return json(res, { error: "body must be a JSON object" }, 400);
            }
            for (const [k, v] of Object.entries(patch)) {
              const entry = SCHEMA.find((s) => s.key === k);
              if (!entry) return json(res, { error: `unknown setting '${k}'` }, 404);
              if (entry.type === "int" && (v < entry.min || v > entry.max)) {
                return json(res, { error: `'${k}' must be between ${entry.min} and ${entry.max}` }, 400);
              }
              values[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
            }
            return json(res, values);
          });
        }
        if (url === "/api/v1/notify/status") {
          return json(res, { enabled: !!values.notify_enable, lastResult: "ok", lastAt: "2026-09-13 10:00:00" });
        }
        if (url === "/api/v1/notify/test" && req.method === "POST") {
          return json(res, { status: "queued" }, 202);
        }
        if (url === "/api/v1/schedules/status") {
          const on = !!values.sched_enable;
          const now = new Date();
          const pad = (n) => String(n).padStart(2, "0");
          return json(res, {
            enabled: on,
            clockValid: on,
            now: on ? `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` : "",
            tz: String(values.sched_tz || "UTC0"),
            count: (() => { try { return JSON.parse(values.schedules_json||"[]").length; } catch { return 0; } })(),
            lastName: "", lastAction: "", lastAt: "",
          });
        }
        if (url === "/api/v1/schedules/run" && req.method === "POST") {
          return readBody(req).then((body) => {
            let name = ""; try { name = JSON.parse(body).name; } catch { name = ""; }
            let found = false;
            try { found = JSON.parse(values.schedules_json||"[]").some((s) => s.name === name); } catch { found = false; }
            if (!found) return json(res, { error: "no schedule of that name" }, 404);
            return json(res, { status: "fired" }, 202);
          });
        }
        if (url === "/api/v1/runbooks/status") return json(res, runbookStatus());
        if (url === "/api/v1/runbooks/run" && req.method === "POST") {
          return readBody(req).then((body) => {
            let name = "";
            try { name = JSON.parse(body).name; } catch { name = ""; }
            const code = runbookStart(name, values);
            if (code === 404) return json(res, { error: "no runbook of that name" }, 404);
            if (code === 409) return json(res, { error: "a runbook is already running" }, 409);
            return json(res, { status: "started" }, 202);
          });
        }
        if (url === "/api/v1/runbooks/stop" && req.method === "POST") {
          if (runbookStop() !== 200) return json(res, { error: "no runbook is running" }, 409);
          return json(res, { ok: true });
        }
        if (url === "/api/v1/settings/reset" && req.method === "POST") {
          for (const s of SCHEMA) values[s.key] = s.default;
          return json(res, values);
        }
        if (url === "/api/v1/video/status") {
          const moving = Date.now() % 20000 < 10000;
          return json(res, {
            signal: state.signal,
            width: state.width,
            height: state.height,
            interlaced: false,
            fps: state.signal ? (moving ? 12.9 : 0) : 0,
            skippedFps: state.signal ? (moving ? 6.9 : 19) : 0,
            kbps: state.signal ? (moving ? 8507 : 0) : 0,
            modeChanges: state.modeChanges,
            sysStatus: state.signal ? 159 : 25,
            viewers: state.viewers,
            codec: "mjpeg",
          });
        }

        /* A text-mode screen the console can read, so the Select/Copy buttons
           can be exercised without a target sitting in its BIOS. Answers 204
           unless the mocked resolution is a text mode, exactly as the device
           does once the target has booted. */
        if (url === "/api/v1/screen/text") {
          const rows = state.height / 16;
          if ((state.width !== 640 && state.width !== 720) || !Number.isInteger(rows)) {
            res.statusCode = 204;
            return res.end();
          }
          const lines = [
            "Aptio Setup Utility - Copyright (C) 2026 American Megatrends, Inc.",
            "",
            "  Main   Advanced   Boot   Security   Save & Exit",
            "",
            "  System Date            [Thu 08/20/2026]",
            "  System Time            [20:11:43]",
            "",
            "  Serial Number          5CG9382KJ7",
            "  BIOS Version           F.42 Rev.A",
            "",
            "  Boot Option #1         [UEFI: Samsung SSD 990 PRO 2TB]",
            "  Boot Option #2         [UEFI: ESP-KVM Virtual CD]",
          ];
          return json(res, {
            cols: 80,
            rows,
            cellWidth: state.width / 80,
            cellHeight: 16,
            confidence: 100,
            ageMs: 120,
            text: lines.join("\n"),
          });
        }

        if (url === "/stream") {
          res.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=frame");
          res.setHeader("Cache-Control", "no-store");
          let tick = 0;
          let alive = true;
          const push = () => {
            if (!alive) return;
            if (!state.signal) {
              /* No signal means no frames at all, exactly as the firmware
                 behaves - the UI has to notice on its own. */
              setTimeout(push, 500);
              return;
            }
            const png = renderFrame(state.width, state.height, tick++);
            res.write(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${png.length}\r\n\r\n`);
            res.write(png);
            res.write("\r\n");
            setTimeout(push, 100);
          };
          req.on("close", () => {
            alive = false;
          });
          push();
          return;
        }

        /* Scenario control: POST /mock/state {"signal":false} and so on. */
        if (url === "/mock/state" && req.method === "POST") {
          return readBody(req).then((body) => {
            Object.assign(state, JSON.parse(body));
            state.wsSend?.();
            return json(res, state);
          });
        }
        if (url === "/mock/state") return json(res, state);

        return next();
      });
    },
  };
}
