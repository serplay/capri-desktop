'use strict';

// Hearing you: what you say into the microphone, written out by a speech-to-text model. Which one is
// config.json's `stt` (her menu › Her ears):
//
//   whispercpp  whisper.cpp's `whisper-server` on this PC (https://github.com/ggml-org/whisper.cpp):
//               Whisper, 99 languages (English, Spanish, Polish, French…). She starts it herself and
//               fetches its model the first time (large-v3-turbo, about 550 MB; `whisperModel` for another).
//   phonon      Phonon-2 (Fermion Research), `phonon serve` on this PC: small, fast, English only.
//   server      any OpenAI-compatible transcription server you run (speaches / faster-whisper-server,
//               LocalAI, vLLM…): `sttUrl`, and `sttModel` for the model it should use.
//   openai      OpenAI's, online (gpt-4o-mini-transcribe): your OpenAI key, the same one her chat uses.
//   groq        Groq's Whisper large-v3-turbo, online and fast: your Groq key.
//   auto        the first that's there: whisper.cpp, then Phonon-2, then an OpenAI or Groq key.
//
// `sttLang` is the language you talk to her in ('auto': Whisper works it out each time). Telling it
// helps on short sentences, which it sometimes takes for another language.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { app } = require('electron');

const WIN = process.platform === 'win32';

const ENGINES = {
  whispercpp: { label: 'Whisper (whisper.cpp, this PC)', url: 'http://127.0.0.1:8178', local: true, multilingual: true },
  phonon: { label: 'Phonon-2 (this PC, English only)', url: 'http://127.0.0.1:8000/v1', model: 'phonon-2', local: true },
  server: { label: 'Whisper server (sttUrl in config)', url: 'http://127.0.0.1:8000/v1', model: 'deepdml/faster-whisper-large-v3-turbo-ct2', local: true, multilingual: true },
  openai: { label: 'OpenAI (online)', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', env: 'OPENAI_API_KEY', multilingual: true },
  groq: { label: 'Groq Whisper (online)', url: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', env: 'GROQ_API_KEY', multilingual: true },
};

// The languages her menu offers for `sttLang`; Whisper takes any ISO 639-1 code in config.json.
const LANGUAGES = [
  ['en', 'English'], ['es', 'Español'], ['pl', 'Polski'], ['fr', 'Français'], ['pt', 'Português'],
  ['de', 'Deutsch'], ['it', 'Italiano'], ['ru', 'Русский'], ['uk', 'Українська'], ['ja', '日本語'],
];

// whisper.cpp's models, from ggerganov/whisper.cpp on Hugging Face (q5: a third of the size, nearly as good)
const WHISPER_MODELS = {
  'large-v3-turbo-q5_0': { file: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574e6 }, // the best for Polish and Spanish
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', bytes: 1.62e9 },
  'medium-q5_0': { file: 'ggml-medium-q5_0.bin', bytes: 539e6 },
  'small-q5_1': { file: 'ggml-small-q5_1.bin', bytes: 190e6 }, // a slow PC: fine for English and Spanish
  'base-q5_1': { file: 'ggml-base-q5_1.bin', bytes: 60e6 },
};
const WHISPER_DEFAULT = 'large-v3-turbo-q5_0';
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

const fail = (message, code) => Object.assign(new Error(message), { code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refused = (err) => err?.cause?.code === 'ECONNREFUSED';

function which(cmd) {
  return new Promise((resolve) => {
    execFile(WIN ? 'where.exe' : 'which', [cmd], { windowsHide: true, timeout: 5000 }, (err, out) => (
      resolve(err ? null : String(out).split(/\r?\n/)[0].trim() || null)));
  });
}

const whisperDir = () => path.join(app.getPath('userData'), 'whisper');

function keyOf(id, cfg) {
  return cfg.apiKeys?.[id] || (ENGINES[id]?.env && process.env[ENGINES[id].env]) || '';
}

// where it's sent, for an engine
function base(cfg = {}, id = engineOf(cfg)) {
  let url = ENGINES[id]?.url || '';
  if (id === 'phonon') url = cfg.sttUrl || process.env.PHONON_URL || url; // sttUrl: Phonon's, before there were others
  if (id === 'server') url = cfg.sttUrl || url;
  return url.replace(/\/+$/, '');
}

// the engine `stt` names; 'auto' (or nothing) is worked out by pick()
function engineOf(cfg) {
  return ENGINES[cfg.stt] ? cfg.stt : 'auto';
}

// ---------- whisper.cpp ----------

// whisper-server: on the PATH (brew install whisper-cpp; its Windows release zip), or dropped in her
// whisper folder; older builds called it `server`.
async function whisperServer() {
  const local = path.join(whisperDir(), WIN ? 'whisper-server.exe' : 'whisper-server');
  if (fs.existsSync(local)) return local;
  return (await which('whisper-server')) || (await which('whisper.cpp-server'));
}

// The model file: `whisperModel` is one of WHISPER_MODELS or the path to a ggml .bin of yours
function whisperModelFile(cfg) {
  const want = cfg.whisperModel || WHISPER_DEFAULT;
  if (/[\\/]/.test(want) || want.endsWith('.bin')) return { file: want, known: null };
  const known = WHISPER_MODELS[want] || WHISPER_MODELS[WHISPER_DEFAULT];
  return { file: path.join(whisperDir(), known.file), known };
}

async function download(url, to, onProgress) {
  const part = `${to}.part`;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(part);
  let have = 0;
  try {
    for await (const chunk of res.body) {
      have += chunk.length;
      onProgress?.({ completed: have, total });
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  fs.renameSync(part, to);
}

let whisper = null; // { child, model } while hers runs; stopped when she quits
let whisperStarting = null;

function whisperStart(cfg, onProgress) {
  whisperStarting ||= (async () => {
    if (whisper) return; // hers, still loading its model
    const cli = await whisperServer();
    if (!cli) throw fail('whisper.cpp is not installed', 'nowhisper');
    const { file, known } = whisperModelFile(cfg);
    if (!fs.existsSync(file)) {
      if (!known) throw fail(`no Whisper model at ${file}`, 'nowhisper');
      onProgress?.({ kind: 'model', bytes: known.bytes });
      await download(`${HF}/${known.file}`, file, onProgress);
    }
    const { port, hostname } = new URL(base(cfg, 'whispercpp'));
    const lang = cfg.sttLang && cfg.sttLang !== 'auto' ? cfg.sttLang : 'auto';
    const child = spawn(cli, ['-m', file, '--host', hostname, '--port', port || '8178', '-l', lang, '-t', '4', '-sns'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.on('exit', () => { if (whisper?.child === child) whisper = null; });
    whisper = { child, model: file };
  })().catch((err) => {
    whisperStarting = null;
    throw err;
  }).then(() => { whisperStarting = null; });
  return whisperStarting;
}

function stop() {
  whisper?.child.kill();
  whisper = null;
}

// whisper.cpp answers on /inference, not /v1/audio/transcriptions
async function postWhisperCpp(cfg, wav) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append('language', cfg.sttLang && cfg.sttLang !== 'auto' ? cfg.sttLang : 'auto');
  const res = await fetch(`${base(cfg, 'whispercpp')}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw await failure(res, 'whisper.cpp');
  const body = await res.json().catch(() => ({}));
  return clean(body.text);
}

// ---------- OpenAI-compatible: Phonon-2, a Whisper server, OpenAI, Groq ----------

async function postOpenAI(cfg, id, wav) {
  const engine = ENGINES[id];
  const key = keyOf(id, cfg);
  if (engine.env && !key) throw fail(`no ${engine.label} key`, 'nokey');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', (id === 'server' && cfg.sttModel) || engine.model);
  form.append('response_format', 'json');
  if (engine.multilingual && cfg.sttLang && cfg.sttLang !== 'auto') form.append('language', cfg.sttLang);
  const res = await fetch(`${base(cfg, id)}/audio/transcriptions`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(30000), headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) throw await failure(res, engine.label);
  const body = await res.json().catch(() => ({}));
  return clean(body.text);
}

async function failure(res, who) {
  const body = await res.text().catch(() => '');
  let message = body.slice(0, 200) || `${who} answered ${res.status}`;
  try {
    const err = JSON.parse(body).error;
    if (err) message = typeof err === 'string' ? err : err.message || message;
  } catch {
    // not JSON: the start of the body says it
  }
  return Object.assign(new Error(message), { status: res.status });
}

// Whisper hears silence as "[BLANK_AUDIO]", "(music)", or a YouTube outro ("Thanks for watching!")
const HALLUCINATIONS = /^(\[[^\]]*\]|\([^)]*\)|thanks? (you )?for watching[.!]*|subt[ií]tulos? .*|napisy .*)$/i;
function clean(text) {
  const out = String(text ?? '').replace(/\[BLANK_AUDIO\]/gi, '').replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.test(out) ? '' : out;
}

// `phonon serve` in the background, once per run; its first start fetches the model (about 164 MB)
let phononStarting = null;
function phononStart() {
  phononStarting ||= (async () => {
    const cli = await which('phonon');
    if (!cli) throw fail('Phonon is not installed', 'nophonon');
    spawn(cli, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  })().catch((err) => {
    phononStarting = null;
    throw err;
  });
  return phononStarting;
}

// ---------- which one ----------

async function up(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}

// 'auto': a Whisper running or installed here beats Phonon-2 (it understands more than English),
// then Phonon-2, then a key for an online one. Nothing: 'nostt'.
async function pick(cfg) {
  const id = engineOf(cfg);
  if (id !== 'auto') return id;
  if (cfg.sttUrl || process.env.PHONON_URL) return 'phonon'; // set up before there was a choice
  if (whisper || (await up(base(cfg, 'whispercpp'))) || (await whisperServer())) return 'whispercpp';
  if ((await up(base(cfg, 'phonon'))) || (await which('phonon'))) return 'phonon';
  if (keyOf('groq', cfg)) return 'groq';
  if (keyOf('openai', cfg)) return 'openai';
  throw fail('no speech-to-text model', 'nostt');
}

// Sends it, and when a server of hers isn't up yet, starts it and waits for it (a model loading:
// up to a minute and a half).
async function viaLocal(cfg, id, wav, start) {
  const post = () => (id === 'whispercpp' ? postWhisperCpp(cfg, wav) : postOpenAI(cfg, id, wav));
  try {
    return await post();
  } catch (err) {
    if (!refused(err) || !start) throw err; // not refused: it answered, and that's what it said
  }
  await start();
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    try {
      return await post();
    } catch (err) {
      if (!refused(err)) throw err;
    }
  }
  throw fail(`${ENGINES[id].label} did not answer`, 'offline');
}

// What was said in `wav` (16-bit PCM WAV), as text. onProgress({ kind: 'model', bytes }) then
// ({ completed, total }) while whisper.cpp's model is fetched, the first time. Throws with a code:
// 'nowhisper' / 'nophonon' (not installed), 'nokey' (an online one, no key), 'nostt' (auto, nothing
// found), 'offline' (installed, but its server never answered).
async function transcribe(cfg, wav, { onProgress } = {}) {
  const id = await pick(cfg);
  if (id === 'whispercpp') return viaLocal(cfg, id, wav, () => whisperStart(cfg, onProgress));
  // Phonon-2: hers to start, unless you pointed her elsewhere
  if (id === 'phonon') return viaLocal(cfg, id, wav, cfg.sttUrl || process.env.PHONON_URL ? null : phononStart);
  return postOpenAI(cfg, id, wav);
}

module.exports = { transcribe, base, stop, pick, whisperDir, clean, ENGINES, LANGUAGES, WHISPER_MODELS };
