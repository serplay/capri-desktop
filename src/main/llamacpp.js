'use strict';

// Talking to her through llama.cpp (https://github.com/ggml-org/llama.cpp), the other way to run
// her model on this PC: no app, just its server (llama-server) and a model file. She installs it
// (winget), fetches a model from Hugging Face, and starts the server herself, on the port her
// llama.cpp provider talks to (llm.js). A server you started yourself there is used as it is.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { app } = require('electron');

const WIN = process.platform === 'win32';
const HOST = '127.0.0.1';
const PORT = 8080;
const base = () => `http://${HOST}:${PORT}`;

// The models she offers, from ggml-org on Hugging Face: the model and what lets it see pictures (mmproj)
const HF = 'https://huggingface.co';
const MODELS = [
  { name: 'gemma4:e4b', repo: 'ggml-org/gemma-4-E4B-it-GGUF', file: 'gemma-4-E4B-it-Q4_0.gguf', mmproj: 'mmproj-gemma-4-E4B-it-Q8_0.gguf', bytes: 5.15e9 },
  { name: 'gemma3:4b', repo: 'ggml-org/gemma-3-4b-it-GGUF', file: 'gemma-3-4b-it-Q4_K_M.gguf', mmproj: 'mmproj-model-f16.gguf', bytes: 3.34e9 },
  { name: 'gemma4:e2b', repo: 'ggml-org/gemma-4-E2B-it-GGUF', file: 'gemma-4-E2B-it-Q4_0.gguf', mmproj: 'mmproj-gemma-4-E2B-it-Q8_0.gguf', bytes: 3.4e9 },
];

const modelsDir = () => path.join(app.getPath('userData'), 'models');
// a model's files on this PC, by the name she offers it under; each in a folder of its own (two models share an mmproj name)
const filesOf = (m) => ({ model: path.join(modelsDir(), m.repo.replace('/', '_'), m.file), mmproj: path.join(modelsDir(), m.repo.replace('/', '_'), m.mmproj) });
const downloaded = () => MODELS.filter((m) => fs.existsSync(filesOf(m).model)).map((m) => m.name);

function which(cmd) {
  return new Promise((resolve) => {
    execFile(WIN ? 'where.exe' : 'which', [cmd], { windowsHide: true, timeout: 5000 }, (err, out) => (
      resolve(err ? null : String(out).split(/\r?\n/)[0].trim() || null)));
  });
}

// llama-server: on PATH, else where winget links it (PATH isn't updated for this run after an install)
async function serverFile() {
  const onPath = await which('llama-server');
  if (onPath) return onPath;
  const linked = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links', 'llama-server.exe');
  return WIN && fs.existsSync(linked) ? linked : null;
}

async function up() {
  const res = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  return Boolean(res?.ok);
}

// { running, installed, models, winget }: how far along llama.cpp is on this PC
async function state() {
  const [running, server, winget] = await Promise.all([up(), serverFile(), WIN ? which('winget') : null]);
  return { running, installed: running || Boolean(server), models: downloaded(), winget: Boolean(winget) };
}

// Installs llama.cpp with winget; onLine(text) for what it prints.
function install(onLine) {
  return new Promise((resolve) => {
    const child = spawn('winget', [
      'install', '--id', 'ggml.llamacpp', '--exact', '--silent',
      '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity',
    ], { windowsHide: true });
    const read = (chunk) => String(chunk).split(/[\r\n]+/).map((l) => l.trim()).filter((l) => /[a-z]{3}/i.test(l)).forEach((l) => onLine?.(l));
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

const STALL = 30000; // no byte for that long: the connection is gone, not slow
const TRIES = 5;     // a connection that drops (a train, bad Wi-Fi) picks up where it was, this many times

// Fetches a model and its mmproj: onProgress({ completed, total }) over both, so the bar fills once.
// Written as .part, renamed once whole: a download cut short is never taken for a model, and the
// next try (or the next time you ask) resumes it instead of starting over.
async function download(name, onProgress, signal) {
  const m = MODELS.find((x) => x.name === name);
  if (!m) throw new Error('unknown model');
  const files = filesOf(m);
  const parts = [[m.mmproj, files.mmproj], [m.file, files.model]].filter(([, to]) => !fs.existsSync(to));
  const url = (file) => `${HF}/${m.repo}/resolve/main/${file}`;
  const sizes = await Promise.all(parts.map(async ([file]) => {
    const res = await fetch(url(file), { method: 'HEAD', signal: anyOf(signal, AbortSignal.timeout(15000)) });
    return Number(res.headers.get('content-length')) || 0;
  }));
  const total = sizes.reduce((a, b) => a + b, 0);
  let done = 0; // the files already whole
  for (const [i, [file, to]] of parts.entries()) {
    for (let tries = 1; ; tries++) {
      try {
        await fetchFile(url(file), to, (have) => onProgress?.({ completed: done + have, total }), signal);
        break;
      } catch (err) {
        if (signal?.aborted || tries >= TRIES || err.fatal) throw err;
        await new Promise((r) => setTimeout(r, 2000 * tries));
      }
    }
    done += sizes[i];
  }
}

const anyOf = (...signals) => AbortSignal.any(signals.filter(Boolean));

// One file, from where its .part left off: onBytes(have) with how much of it is here.
async function fetchFile(url, to, onBytes, signal) {
  const part = `${to}.part`;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), STALL);
  try {
    const res = await fetch(url, { signal: anyOf(signal, stall.signal), headers: have ? { range: `bytes=${have}-` } : {} });
    if (res.status === 416 && have) return fs.renameSync(part, to); // the .part was whole already
    if (!res.ok) throw Object.assign(new Error(`Hugging Face answered ${res.status}`), { fatal: res.status < 500 && res.status !== 429 });
    if (res.status !== 206) have = 0; // the server ignored the range: from the start
    // pipeline: cut off, what reached the disk stays in the .part (and nothing throws out of turn)
    await pipeline(Readable.fromWeb(res.body), async function* (chunks) {
      for await (const chunk of chunks) {
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(), STALL);
        have += chunk.length;
        onBytes(have);
        yield chunk;
      }
    }, fs.createWriteStream(part, { flags: have ? 'a' : 'w' }));
  } catch (err) {
    if (stall.signal.aborted && !signal?.aborted) throw new Error('the download stalled (nothing came for 30 s)');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  fs.renameSync(part, to);
}

// The server she started, and on which model: stopped when she quits (it holds the model in memory)
let server = null; // { child, name }

// Starts llama-server on that model (stopping hers on another one first) and waits for it to answer.
// A server already there that isn't hers is left alone: it's yours. One start at a time, in turn
// (asked twice for the same model, the second finds it up).
let starting = Promise.resolve();
function start(name) {
  const next = starting.then(() => run(name));
  starting = next.catch(() => {});
  return next;
}

async function run(name) {
  if (server?.name === name && (await up())) return { ok: true };
  if (!server && (await up())) return { ok: true };
  const m = MODELS.find((x) => x.name === name);
  if (!m || !fs.existsSync(filesOf(m).model)) return { ok: false, error: 'no model' };
  const file = await serverFile();
  if (!file) return { ok: false, error: 'llama-server not found' };
  stop();
  const { model, mmproj } = filesOf(m);
  // --alias: the name her menu shows for it, the one she offers it under
  const args = ['-m', model, '--alias', name, '--host', HOST, '--port', String(PORT), '--jinja', '-c', '8192'];
  if (fs.existsSync(mmproj)) args.push('--mmproj', mmproj);
  const child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
  let exited = false;
  child.on('error', () => { exited = true; });
  child.on('exit', () => {
    exited = true;
    if (server?.child === child) server = null;
  });
  server = { child, name };
  // loading the model into memory: seconds, up to a couple of minutes on a slow disk
  for (let i = 0; i < 240 && !exited; i++) {
    if (await up()) return { ok: true };
    await new Promise((r) => setTimeout(r, 750));
  }
  if (!exited) stop();
  return { ok: false, error: 'llama.cpp did not answer' };
}

function stop() {
  server?.child.kill();
  server = null;
}

module.exports = { MODELS, base, state, install, download, start, stop, downloaded };
