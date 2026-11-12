// Records from the microphone with MediaRecorder.
// The sound arrives in pieces every few seconds (onChunk), which the app saves
// right away.

// Preferred formats, best first. .m4a matches the phone's own recorder app.
const FORMATS = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

export function supportedFormats() {
  if (!window.MediaRecorder) return [];
  return FORMATS.filter(f => MediaRecorder.isTypeSupported(f));
}

export function extFor(mime) {
  if (/mp4|m4a|aac/i.test(mime)) return "m4a";
  if (/ogg/i.test(mime)) return "ogg";
  if (/mpeg|mp3/i.test(mime)) return "mp3";
  if (/wav/i.test(mime)) return "wav";
  return "webm";
}

const CHUNK_MS = 5000;

export class Recorder {
  constructor({ onChunk, onEnd }) {
    this.onChunk = onChunk;
    this.onEnd = onEnd;
    this.level = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Plain sound like a voice recorder app, without call-style processing.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const mime = supportedFormats()[0];
    const opts = { audioBitsPerSecond: 128000 };
    if (mime) opts.mimeType = mime;
    this.mr = new MediaRecorder(this.stream, opts);
    this.mime = this.mr.mimeType || mime || "audio/webm";
    this.ext = extFor(this.mime);

    this.stopped = new Promise(resolve => { this.mr.onstop = resolve; });
    this.mr.ondataavailable = e => { if (e.data && e.data.size) this.onChunk(e.data); };
    this.mr.onerror = e => this.onEnd("error", e.error);
    for (const track of this.stream.getAudioTracks()) {
      // The microphone was taken away (phone call, other app...).
      track.onended = () => this.onEnd("mic-ended");
    }

    this.startMeter();
    this.mr.start(CHUNK_MS);
    this.accum = 0;
    this.since = performance.now();
    this.paused = false;
  }

  // Seconds recorded so far, pauses excluded.
  elapsed() {
    return this.accum + (this.paused ? 0 : (performance.now() - this.since) / 1000);
  }

  pause() {
    if (this.paused || this.mr.state !== "recording") return;
    this.mr.pause();
    this.accum += (performance.now() - this.since) / 1000;
    this.paused = true;
  }

  resume() {
    if (!this.paused) return;
    this.mr.resume();
    this.since = performance.now();
    this.paused = false;
  }

  async stop() {
    const duration = this.elapsed();
    if (this.mr && this.mr.state !== "inactive") {
      this.mr.stop();
      await this.stopped;
    }
    this.stream?.getTracks().forEach(t => t.stop());
    this.meterCtx?.close().catch(() => {});
    return duration;
  }

  // A simple input level, so you can see the microphone is hearing you.
  startMeter() {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(this.stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      this.meterCtx = ctx;
      this.readLevel = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        this.level = Math.min(1, peak / 100);
        return this.level;
      };
    } catch {
      this.readLevel = () => 0;
    }
  }
}
