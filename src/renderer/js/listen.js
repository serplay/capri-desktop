// Listening to you: the microphone, until you stop talking (or press Ctrl+Alt+V again), as a WAV
// that Whisper or Phonon-2 writes out (main/stt.js). Nothing is recorded before you ask.

const RATE = 16000;           // what speech models expect
const START_MS = 6000;        // time to start talking before she gives up
const SILENCE_MS = 1300;      // that long quiet after you spoke: you're done
const MAX_MS = 20000;         // one go at most
const LOUD = 0.02;            // RMS above this is you talking (over a laptop fan)

export class Listen {
  constructor({ host }) {
    this.host = host;
    this.active = null; // { stop } while the microphone is on
  }

  get listening() {
    return Boolean(this.active);
  }

  stop() {
    this.active?.stop();
  }

  // Records one thing you say: resolves with a 16-bit WAV (ArrayBuffer), or null when nothing was
  // said. Throws with a code: 'nomic' (no microphone, or not allowed).
  async record({ onLevel } = {}) {
    if (this.active) return null;
    if (!(await this.host.micAccess().catch(() => false))) throw Object.assign(new Error('microphone not allowed'), { code: 'nomic' });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      throw Object.assign(err, { code: 'nomic' });
    }
    const ctx = new AudioContext({ sampleRate: RATE }); // Chromium resamples the microphone to it
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor: old, but an AudioWorklet would need its own file loaded past the page's CSP
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    const began = performance.now();
    let spoke = 0;  // when you were last heard
    let heard = false;
    return new Promise((resolve) => {
      const finish = () => {
        if (!this.active) return;
        this.active = null;
        node.disconnect();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        ctx.close().catch(() => {});
        resolve(heard ? wav(chunks, ctx.sampleRate) : null);
      };
      this.active = { stop: finish };
      node.onaudioprocess = (e) => {
        const samples = new Float32Array(e.inputBuffer.getChannelData(0));
        chunks.push(samples);
        let sum = 0;
        for (const v of samples) sum += v * v;
        const level = Math.sqrt(sum / samples.length);
        onLevel?.(level);
        const now = performance.now();
        if (level > LOUD) {
          heard = true;
          spoke = now;
        }
        if ((!heard && now - began > START_MS) || (heard && now - spoke > SILENCE_MS) || now - began > MAX_MS) finish();
      };
      source.connect(node);
      node.connect(ctx.destination); // a ScriptProcessor only runs when connected (it outputs silence)
    });
  }
}

// mono float samples -> 16-bit PCM WAV
function wav(chunks, rate) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (at, s) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  let at = 44;
  for (const chunk of chunks) {
    for (const v of chunk) {
      const s = Math.max(-1, Math.min(1, v));
      view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      at += 2;
    }
  }
  return buffer;
}
