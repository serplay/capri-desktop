'use strict';

// Hearing you: what you say into the microphone, written out by Phonon-2 (Fermion Research), a small
// speech-to-text model that runs on this PC. `pip install "fermion-research[mlx]"` puts its `phonon`
// command here; `phonon serve` answers like OpenAI's /v1/audio/transcriptions. She starts it herself
// when it's installed and not running yet. sttUrl in config.json (or PHONON_URL) points elsewhere.
// English only, for now.

const { spawn, execFile } = require('node:child_process');

const MODEL = 'phonon-2';

function base(cfg = {}) {
  const url = cfg.sttUrl || process.env.PHONON_URL || 'http://127.0.0.1:8000/v1';
  return url.replace(/\/+$/, '');
}

function which(cmd) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], { windowsHide: true, timeout: 5000 }, (err, out) => (
      resolve(err ? null : String(out).split(/\r?\n/)[0].trim() || null)));
  });
}

// `phonon serve` in the background, once per run; its first start fetches the model (about 164 MB)
let starting = null;
function startServer() {
  starting ||= (async () => {
    const cli = await which('phonon');
    if (!cli) throw Object.assign(new Error('Phonon is not installed'), { code: 'nophonon' });
    spawn(cli, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  })().catch((err) => {
    starting = null;
    throw err;
  });
  return starting;
}

async function post(cfg, wav) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', MODEL);
  form.append('response_format', 'json');
  const res = await fetch(`${base(cfg)}/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = body.slice(0, 200) || `Phonon answered ${res.status}`;
    try {
      const err = JSON.parse(body).error;
      if (err) message = typeof err === 'string' ? err : err.message || message;
    } catch {
      // not JSON: the start of the body says it
    }
    throw new Error(message);
  }
  const body = await res.json().catch(() => ({}));
  return String(body.text ?? '').trim();
}

// What was said in `wav` (16-bit PCM WAV), as text. Throws with a code: 'nophonon' (not installed),
// 'offline' (installed, but its server never answered).
async function transcribe(cfg, wav) {
  try {
    return await post(cfg, wav);
  } catch (err) {
    // not refused: it answered, and that's what it said
    if (err.cause?.code !== 'ECONNREFUSED' || cfg.sttUrl || process.env.PHONON_URL) throw err;
  }
  await startServer();
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      return await post(cfg, wav);
    } catch (err) {
      if (err.cause?.code !== 'ECONNREFUSED') throw err;
    }
  }
  throw Object.assign(new Error('Phonon did not answer'), { code: 'offline' });
}

module.exports = { transcribe, base };
