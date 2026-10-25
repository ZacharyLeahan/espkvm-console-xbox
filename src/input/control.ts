import { decodeControllers, type ControllerStatus } from "./controllers";
/*
 * The control channel to the device: protocol v2, defined in
 * components/kvm_web/http_server.c.
 *
 *   client -> device
 *     0x01 abs mouse   buttons, x:u16, y:u16 (0..32767), wheel:i8, pan:i8
 *     0x02 rel mouse   buttons, dx:i16, dy:i16, wheel:i8, pan:i8
 *     0x03 keyboard    modifier, six key usages
 *     0x04 consumer    usage:u16
 *     0x05 release all
 *     0x06 ping
 *     0x07 take control
 *   device -> client
 *     0x81 status      flags:u8 (bit0 target attached, bit1 bus alive), leds:u8
 *     0x82 pong
 *     0x83 control      state:u8 (0 held by another, 1 you hold it, 2 free)
 *
 * The device serves one control client at a time and drops whatever was held
 * down when the socket closes, so reconnecting is always safe.
 */

export const ABS_MAX = 32767;

const MSG_MOUSE_ABS = 0x01;
const MSG_MOUSE_REL = 0x02;
const MSG_KEYBOARD = 0x03;
const MSG_CONSUMER = 0x04;
const MSG_RELEASE_ALL = 0x05;
const MSG_PING = 0x06;
const MSG_TAKEOVER = 0x07;
const MSG_STATUS = 0x81;
const MSG_CONTROL = 0x83;
const MSG_UPDATE = 0x84;

/* How often to poll control/target state, so a viewer notices the session was
   freed or taken without needing to interact. */
const PING_INTERVAL_MS = 2500;

export interface TargetState {
  /** The target machine has enumerated our USB device. */
  attached: boolean;
  /**
   * There is a live USB bus on the target's side, enumerated or not. False is
   * a port with no power or a cable that is out - which re-plugging from the
   * device's end cannot fix, so the popup says so instead of offering it.
   */
  busAlive: boolean;
  /** False while the control channel is down: the device has not said either
   *  way, and reporting "no target" then blames the wrong thing. */
  known: boolean;
  /** Lock-key LEDs as the target reports them: bit0 num, bit1 caps, bit2 scroll. */
  leds: number;
}

export type ConnectionState = "connecting" | "open" | "closed";

/** Who holds the single control session: this client, nobody, or someone else. */
export type ControlState = "you" | "free" | "held";

/** What the device is doing to itself, told to every console at once. */
export interface UpdateState {
  phase: "receiving" | "verifying" | "restarting" | "failed";
  percent: number;
}

interface Handlers {
  onControllers?(state: ControllerStatus[]): void;
  onTarget(state: TargetState): void;
  onConnection(state: ConnectionState): void;
  onControl(state: ControlState): void;
  onUpdate(state: UpdateState): void;
}

export class Control {
  #ws: WebSocket | null = null;
  #retry: number | null = null;
  #ping: number | null = null;
  #closed = false;
  #handlers: Handlers;
  #backoff = 500;

  constructor(handlers: Handlers) {
    this.#handlers = handlers;
  }

  /*
   * Opening the socket waits for a session. Before the sign-in there is none,
   * and the device refuses the handshake and says so in its log every couple of
   * seconds - noise about a page that is only showing a password form.
   */
  start() {
    if (this.#ws || this.#closed) return;
    /*
     * A pending retry is not a reason to wait. This is called at the sign-in,
     * which is the event that removes what the socket was being refused for -
     * and by then a console left open overnight has backed off to the 30 s
     * ceiling. Waiting that out means no keyboard, no mouse and no target
     * status for half a minute after signing in, and whatever the device last
     * said about itself stays on screen because nothing arrives to replace it.
     */
    if (this.#retry !== null) {
      clearTimeout(this.#retry);
      this.#retry = null;
    }
    this.#backoff = 500;
    this.#connect();
  }

  get open(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  #connect() {
    if (this.#closed) return;
    this.#handlers.onConnection("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;

    ws.onopen = () => {
      this.#backoff = 500;
      this.#handlers.onConnection("open");
      /* The device cannot push during the handshake, so ask for the current
         target and control state rather than showing blank indicators until
         something happens to change them. Repeat on a timer so a viewer learns
         the session was freed or taken over without having to interact. */
      this.#send(new Uint8Array([MSG_PING]));
      this.#ping = window.setInterval(() => this.#send(new Uint8Array([MSG_PING])), PING_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const b = new Uint8Array(ev.data);
      if (b[0] === MSG_STATUS && b.length >= 3) {
        this.#handlers.onTarget({
          attached: (b[1] & 1) !== 0,
          busAlive: (b[1] & 2) !== 0,
          leds: b[2],
          known: true,
        });
      } else if (b[0] === 0x85) {
        const rows = decodeControllers(b.subarray(1));
        if (rows) {
          this.#handlers.onControllers?.(rows);
          if (this.#ping !== null) clearInterval(this.#ping);
          this.#ping = window.setInterval(() => this.#send(new Uint8Array([MSG_PING])), 500);
        }
      } else if (b[0] === MSG_CONTROL && b.length >= 2) {
        this.#handlers.onControl(b[1] === 1 ? "you" : b[1] === 2 ? "free" : "held");
      } else if (b[0] === MSG_UPDATE && b.length >= 3) {
        const phases = ["receiving", "verifying", "restarting", "failed"] as const;
        const phase = phases[b[1]] ?? "receiving";
        this.#handlers.onUpdate({ phase, percent: b[2] });
      }
    };

    ws.onerror = () => ws.close();

    ws.onclose = () => {
      this.#ws = null;
      if (this.#ping !== null) {
        clearInterval(this.#ping);
        this.#ping = null;
      }
      this.#handlers.onConnection("closed");
      /* Not "the target is gone" - we simply stopped being told. */
      this.#handlers.onTarget({ attached: false, busAlive: false, leds: 0, known: false });
      if (this.#closed) return;
      /* Back off so a device that is rebooting is not hammered, but stay
         responsive enough that a brief blip is invisible. The ceiling is high
         because the reason may not be temporary: a device that has signed this
         page out refuses the socket every time, and a page that keeps asking
         every few seconds for hours ends up unusable. */
      this.#retry = window.setTimeout(() => this.#connect(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 30000);
    };
  }

  dispose() {
    this.#closed = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    if (this.#ping !== null) clearInterval(this.#ping);
    this.#ws?.close();
    this.#ws = null;
  }

  /** Ask the device to make this client the controlling one, demoting any other. */
  takeControl() {
    this.#send(new Uint8Array([MSG_TAKEOVER]));
  }

  #send(data: Uint8Array) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(data.buffer as ArrayBuffer);
  }

  mouseAbsolute(buttons: number, x: number, y: number, wheel = 0, pan = 0) {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    dv.setUint8(0, MSG_MOUSE_ABS);
    dv.setUint8(1, buttons);
    dv.setUint16(2, clamp(x, 0, ABS_MAX), true);
    dv.setUint16(4, clamp(y, 0, ABS_MAX), true);
    dv.setInt8(6, clamp(wheel, -127, 127));
    dv.setInt8(7, clamp(pan, -127, 127));
    this.#send(b);
  }

  mouseRelative(buttons: number, dx: number, dy: number, wheel = 0, pan = 0) {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    dv.setUint8(0, MSG_MOUSE_REL);
    dv.setUint8(1, buttons);
    dv.setInt16(2, clamp(dx, -32768, 32767), true);
    dv.setInt16(4, clamp(dy, -32768, 32767), true);
    dv.setInt8(6, clamp(wheel, -127, 127));
    dv.setInt8(7, clamp(pan, -127, 127));
    this.#send(b);
  }

  keyboard(modifier: number, keys: number[]) {
    const b = new Uint8Array(8);
    b[0] = MSG_KEYBOARD;
    b[1] = modifier & 0xff;
    for (let i = 0; i < 6; i++) b[2 + i] = keys[i] ?? 0;
    this.#send(b);
  }

  consumer(usage: number) {
    const b = new Uint8Array(3);
    const dv = new DataView(b.buffer);
    dv.setUint8(0, MSG_CONSUMER);
    dv.setUint16(1, usage, true);
    this.#send(b);
  }

  releaseAll() {
    this.#send(new Uint8Array([MSG_RELEASE_ALL]));
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
