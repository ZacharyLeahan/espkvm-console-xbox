/*
 * Receives video over the WebSocket channel and hands each frame to the caller
 * as something a canvas can draw.
 *
 * Two payloads arrive on the same channel and the device may switch between
 * them while a viewer is connected, so the type is read per frame:
 *
 *   JPEG   decoded with createImageBitmap; works everywhere
 *   H.264  decoded with WebCodecs; Annex-B, SPS and PPS in front of every
 *          keyframe, so no side-channel configuration is needed
 *
 * The device also still serves the old multipart stream, and this falls back to
 * it when the channel produces nothing: an operator locked out of the picture
 * because a transport changed is a worse outcome than an older transport. That
 * fallback exists for JPEG only - the multipart endpoint cannot carry H.264 -
 * so a browser that cannot decode H.264 is told so instead of being left with
 * an empty rectangle.
 *
 * Frame layout is defined in components/kvm_web/http_server.c.
 */

const HEADER_LEN = 12;
const MAGIC = 0x4b;
const TYPE_JPEG = 1;
const TYPE_H264 = 2;
/* The device says it takes frame acks; older firmware would read each ack as
   a keyframe request, so none are sent until this arrives. */
const MSG_VIDEO_ACKS = 0x85;
const MSG_VIDEO_ACK = 0x09;

/** How long to wait for the first frame before deciding the channel is dead. */
const FIRST_FRAME_TIMEOUT_MS = 2500;

/*
 * A WebCodecs decoder can stall silently - stop producing frames without ever
 * firing its error callback (long uptime, a throttled/backgrounded tab, a GPU or
 * hardware-decoder hiccup). Frames keep arriving, so nothing else notices. If no
 * decoded frame has come out for this long while input is still flowing, treat
 * the decoder as wedged and rebuild it. The device sends a keyframe every ~2 s,
 * so this must comfortably exceed that or a slow decode would trip it.
 */
const DECODER_STALL_MS = 3000;
/** Consecutive rebuilds that fail to revive it before we give up on the channel. */
const MAX_STALL_REBUILDS = 3;

/*
 * The device treats a second message from a subscribed viewer as "send me a
 * keyframe". We need that whenever this side, not the device, is what broke the
 * reference chain: a delta dropped here is invisible to the device, so nothing
 * would repair the picture until the next scheduled IDR - and a decoder still
 * running behind drops that one too, which is how a tab comes back from the
 * background showing blocks that never clear.
 */
const RESYNC_MIN_GAP_MS = 500;

/** Decoder errors in a row, with no frame between, before the page says so. */
const MAX_DECODER_ERRORS = 3;

/** Anything a canvas can draw and that must be released afterwards. */
export type Drawable = (ImageBitmap | VideoFrame) & { close(): void };

export interface FrameInfo {
  image: Drawable;
  width: number;
  height: number;
  sequence: number;
  /** Device milliseconds when the frame was sent. */
  pts: number;
}

interface Handlers {
  onFrame(frame: FrameInfo): void;
  /** The channel produced nothing usable; the caller should show the fallback. */
  onUnavailable(reason: string): void;
  /** The stream is H.264 and this browser cannot play it. No fallback exists. */
  onCodecError(reason: string): void;
}

/**
 * Which Annex-B NAL units are in a frame, as far as we need to know: whether it
 * can be decoded on its own, and the sequence parameter set that says which
 * H.264 profile and level the decoder must support.
 */
export function inspectAnnexB(data: Uint8Array): { keyframe: boolean; sps: Uint8Array | null } {
  let keyframe = false;
  let sps: Uint8Array | null = null;
  let zeros = 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === 0) {
      zeros++;
      continue;
    }
    if (byte === 1 && zeros >= 2) {
      const nalType = data[i + 1] & 0x1f;
      if (nalType === 7 && !sps) sps = data.subarray(i + 1);
      /* 5 is an IDR slice, 1 a non-IDR one; the first slice settles it. */
      if (nalType === 5) keyframe = true;
      if (nalType === 1 || nalType === 5) break;
    }
    zeros = 0;
  }
  return { keyframe, sps };
}

/**
 * The codec string WebCodecs wants, e.g. "avc1.42E01F", taken from the SPS the
 * encoder emitted rather than assumed: profile and level change with the frame
 * size, and a wrong guess is rejected at configure() time.
 */
export function codecFromSps(sps: Uint8Array): string | null {
  if (sps.length < 4) return null;
  const hex = (v: number) => v.toString(16).padStart(2, "0").toUpperCase();
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

export class VideoStream {
  #ws: WebSocket | null = null;
  #handlers: Handlers;
  #stopped = false;
  #firstFrameTimer: number | null = null;
  #decodingJpeg = false;
  #decoder: VideoDecoder | null = null;
  #decoderCodec: string | null = null;
  /** Nothing before the first keyframe can be decoded. */
  #hadKeyframe = false;
  /** performance.now() of the last decoded frame the decoder handed back; the
      stall watchdog's clock. 0 means "no decoder to watch yet". */
  #lastOutputAt = 0;
  /** Rebuilds since the last frame actually came out; caps runaway stalls. */
  #stallRebuilds = 0;
  /** Decoder errors since the last frame came out. One is a broken reference
      chain that a keyframe repairs; only a run of them is worth showing. */
  #decoderErrors = 0;
  #lastMeta = { width: 0, height: 0, sequence: 0, pts: 0 };
  /** performance.now() of the last keyframe we asked the device for. */
  #lastResyncAt = -Infinity;
  /** The device takes frame acks (see MSG_VIDEO_ACKS). */
  #acks = false;
  #onVisibility = () => this.#visibilityChanged();

  constructor(handlers: Handlers) {
    this.#handlers = handlers;
    document.addEventListener("visibilitychange", this.#onVisibility);
    this.#connect();
  }

  /*
   * A hidden tab is throttled, and a throttled decoder falls behind until this
   * class starts dropping deltas into it. Nobody is looking at the picture
   * anyway, so let the decoder go while the tab is away and ask for a keyframe
   * when it comes back. Frames that arrive meanwhile are read and discarded:
   * the socket stays up, so control and the status bar keep working.
   */
  #visibilityChanged() {
    if (this.#stopped) return;
    if (document.visibilityState === "hidden") {
      this.#resetDecoder();
      this.#hadKeyframe = false;
      return;
    }
    this.#resync();
  }

  /** Ask the device for a keyframe, at most one every RESYNC_MIN_GAP_MS. */
  #resync() {
    const now = performance.now();
    if (now - this.#lastResyncAt < RESYNC_MIN_GAP_MS) return;
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#lastResyncAt = now;
    this.#ws.send(new Uint8Array([1]));
  }

  stop() {
    this.#stopped = true;
    document.removeEventListener("visibilitychange", this.#onVisibility);
    if (this.#firstFrameTimer !== null) clearTimeout(this.#firstFrameTimer);
    this.#resetDecoder();
    this.#ws?.close();
    this.#ws = null;
  }

  #connect() {
    if (this.#stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/video`);
    } catch {
      this.#handlers.onUnavailable("the video channel could not be opened");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    this.#acks = false;

    ws.onopen = () => {
      if (this.#stopped || this.#ws !== ws) return;
      /* Subscribing happens on our first message: the device cannot send
         during the handshake. */
      ws.send(new Uint8Array([1]));
      this.#firstFrameTimer = window.setTimeout(() => {
        this.#handlers.onUnavailable("no frames arrived on the video channel");
      }, FIRST_FRAME_TIMEOUT_MS);
    };

    ws.onmessage = (ev) => void this.#onMessage(ev);

    ws.onclose = () => {
      if (this.#stopped) return;
      this.#handlers.onUnavailable("the video channel closed");
    };
  }

  #resetDecoder() {
    if (this.#decoder) {
      if (this.#decoder.state !== "closed") this.#decoder.close();
      this.#decoder = null;
    }
    this.#decoderCodec = null;
    this.#lastOutputAt = 0; /* nothing to watch until a new decoder is configured */
  }

  async #onMessage(ev: MessageEvent) {
    /* A stopped stream's socket still delivers what was in flight; a keyframe
       there would build a decoder nobody closes. */
    if (this.#stopped) return;
    if (!(ev.data instanceof ArrayBuffer)) return;
    if (ev.data.byteLength === 1 && new Uint8Array(ev.data)[0] === MSG_VIDEO_ACKS) {
      this.#acks = true;
      return;
    }
    if (ev.data.byteLength <= HEADER_LEN) return;
    const view = new DataView(ev.data);
    if (view.getUint8(0) !== MAGIC) return;
    const type = view.getUint8(1);
    if (type !== TYPE_JPEG && type !== TYPE_H264) return;

    if (this.#firstFrameTimer !== null) {
      clearTimeout(this.#firstFrameTimer);
      this.#firstFrameTimer = null;
    }

    this.#lastMeta = {
      width: view.getUint16(2, true),
      height: view.getUint16(4, true),
      sequence: view.getUint32(6, true),
      pts: view.getUint16(10, true),
    };
    /* Acked on arrival: the device then keeps two frames on the way rather
       than a full buffer of old ones, so a slow link shows a fresh picture. */
    if (this.#acks && this.#ws?.readyState === WebSocket.OPEN) {
      const ack = new Uint8Array(5);
      ack[0] = MSG_VIDEO_ACK;
      new DataView(ack.buffer).setUint32(1, this.#lastMeta.sequence, true);
      this.#ws.send(ack);
    }

    if (type === TYPE_JPEG) {
      this.#resetDecoder();
      await this.#onJpeg(ev.data);
    } else if (type === TYPE_H264) {
      this.#onH264(new Uint8Array(ev.data, HEADER_LEN));
    }
  }

  async #onJpeg(buffer: ArrayBuffer) {
    /* Decoding is asynchronous; dropping frames that arrive mid-decode keeps
       latency from growing without bound on a slow client. */
    if (this.#decodingJpeg) return;
    this.#decodingJpeg = true;
    const meta = this.#lastMeta;
    try {
      const blob = new Blob([buffer.slice(HEADER_LEN)], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob);
      if (this.#stopped) bitmap.close();
      else this.#handlers.onFrame({ image: bitmap, ...meta });
    } catch {
      /* A corrupt frame is not worth reporting; the next one will do. */
    } finally {
      this.#decodingJpeg = false;
    }
  }

  #onH264(payload: Uint8Array) {
    if (typeof VideoDecoder === "undefined") {
      /*
       * Browsers expose WebCodecs in secure contexts only, so a device reached
       * over plain HTTP cannot decode H.264 however capable the browser is.
       * Saying "your browser does not support it" would send the operator
       * looking in the wrong place.
       */
      this.#handlers.onCodecError(
        window.isSecureContext
          ? "this browser has no WebCodecs, so it cannot decode H.264"
          : "H.264 needs a secure page - browsers offer WebCodecs over HTTPS only, and this " +
            "console was loaded over HTTP",
      );
      return;
    }

    /* Hidden tab: nothing is drawn, so nothing is decoded. #visibilityChanged
       asks for a keyframe when it comes back. */
    if (document.visibilityState === "hidden") return;

    const { keyframe, sps } = inspectAnnexB(payload);

    /* Stall watchdog: input is flowing (we are here) but the decoder has produced
       nothing for too long, so it is wedged. Tear it down here - before the SPS
       block below, so a keyframe in this very packet reconfigures a fresh decoder
       and resyncs at once; a delta waits for the next keyframe (<=2 s). If rebuilds
       keep failing, drop the channel so the app reconnects (or falls back to MJPEG)
       rather than sit on a frozen picture. */
    if (
      this.#hadKeyframe &&
      this.#lastOutputAt > 0 &&
      performance.now() - this.#lastOutputAt > DECODER_STALL_MS
    ) {
      this.#resetDecoder();
      this.#hadKeyframe = false;
      if (++this.#stallRebuilds >= MAX_STALL_REBUILDS) {
        this.#stallRebuilds = 0;
        this.#handlers.onUnavailable("the video decoder stalled and could not be revived");
        return;
      }
    }

    if (sps) {
      const codec = codecFromSps(sps);
      /* A resolution change produces a new SPS and usually a new level, which
         the running decoder was not configured for. */
      if (codec && codec !== this.#decoderCodec) {
        this.#resetDecoder();
        this.#configure(codec);
      }
    }
    if (!this.#decoder) return; /* waiting for a keyframe to configure from */
    if (this.#decoder.state !== "configured") return;

    /* The device holds back delta frames until a viewer has had a keyframe, so
       this should not trigger - but a decoder fed a delta frame it has no
       reference for produces artefacts that look like a hardware fault. */
    if (!keyframe && !this.#hadKeyframe) return;
    if (keyframe) this.#hadKeyframe = true;

    /* Frames queued behind a decoder that cannot keep up are latency, not
       smoothness - but a dropped delta breaks the reference chain, and every
       frame after it decodes into blocks. So stop feeding deltas until a
       keyframe arrives, and ask the device for one now. */
    if (this.#decoder.decodeQueueSize > 2 && !keyframe) {
      this.#hadKeyframe = false;
      this.#resync();
      return;
    }

    try {
      this.#decoder.decode(
        new EncodedVideoChunk({
          type: keyframe ? "key" : "delta",
          /* Microseconds, monotonic. The device timestamp wraps every minute,
             which the decoder would read as time running backwards. */
          timestamp: Math.round(performance.now() * 1000),
          data: payload,
        }),
      );
    } catch {
      this.#resetDecoder();
      this.#hadKeyframe = false;
      this.#resync();
    }
  }

  #configure(codec: string) {
    let decoder: VideoDecoder | null = null;
    try {
      decoder = new VideoDecoder({
        output: (frame) => {
          if (this.#stopped || this.#decoder !== decoder) {
            frame.close();
            return;
          }
          /* A frame came out: the decoder is alive, so refresh the watchdog clock
             and clear the rebuild count. */
          this.#lastOutputAt = performance.now();
          this.#stallRebuilds = 0;
          this.#decoderErrors = 0;
          const meta = this.#lastMeta;
          this.#handlers.onFrame({
            image: frame,
            width: frame.displayWidth || meta.width,
            height: frame.displayHeight || meta.height,
            sequence: meta.sequence,
            pts: meta.pts,
          });
        },
        error: (err) => {
          if (this.#stopped || this.#decoder !== decoder) return;
          this.#resetDecoder();
          this.#hadKeyframe = false;
          this.#resync();
          if (++this.#decoderErrors >= MAX_DECODER_ERRORS) {
            this.#handlers.onCodecError(`the H.264 decoder failed: ${err.message}`);
          }
        },
      });
      decoder.configure({ codec, optimizeForLatency: true });
    } catch (err) {
      if (decoder && decoder.state !== "closed") decoder.close();
      this.#handlers.onCodecError(
        `this browser refused the H.264 stream (${codec}): ${(err as Error).message}`,
      );
      return;
    }
    this.#decoder = decoder;
    this.#decoderCodec = codec;
    this.#hadKeyframe = false;
    /* Start the stall watchdog's clock now, so a decoder that never produces its
       first frame is caught too, not only one that stops partway. */
    this.#lastOutputAt = performance.now();
  }
}
