/*
 * browser.js — just enough browser for the club's own code to run under node.
 *
 * WHY THIS SHAPE. calibrate.html measures the strength that ships, so nothing
 * here may re-implement a decision: `bot.js`, `engines.js`, the three workers
 * and the calibrator's own <script> are all loaded VERBATIM into vm contexts,
 * and this file supplies only the environment they expect — Worker, fetch,
 * importScripts, indexedDB, a fake DOM. The one substitution is the ONNX
 * runtime: `importScripts('ort/ort.wasm.min.js')` yields onnxruntime-node
 * instead of the WASM build, because a browser WASM runtime under node buys
 * nothing but grief. Same graph, same weights, same input names.
 *
 * Everything runs on ONE thread. Stockfish blocks it while it searches, which
 * is fine: the gauntlet is strictly sequential and nothing else is waiting.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// chess.js 0.10.3 is a global in the browser and a module here.
const chessMod = require('chess.js');
const Chess = chessMod.Chess || chessMod;

// ---------- url -> file ----------
// Workers address their assets as relative paths or file: URLs; both land
// inside the repo. The ?v= cache-buster the page appends is meaningless here.
function toPath(url) {
  let u = String(url).split('?')[0].split('#')[0];
  // A file: URL is already absolute — the net workers build theirs off
  // location.href — so it must not be re-rooted under the repo.
  if (u.startsWith('file://')) return { remote: false, file: decodeURIComponent(u.slice('file://'.length)) };
  if (/^https?:/.test(u)) return { remote: true, url: u };
  // Likewise the engine's .wasm, which it reads back out of location.hash.
  if (path.isAbsolute(u)) return { remote: false, file: u };
  return { remote: false, file: path.resolve(ROOT, u.replace(/^\.?\//, '')) };
}

// ---------- fetch (engine flavour) ----------
// A real Response over the file bytes, typed as wasm so instantiateStreaming
// accepts it. Only the engine worker gets this; see the sandbox below.
function makeStreamingFetch() {
  return function (url) {
    const t = toPath(url);
    if (t.remote) return Promise.reject(new Error('headless: refusing network fetch ' + t.url));
    return new Promise((resolve) => {
      fs.readFile(t.file, (err, buf) => {
        if (err) { resolve(new Response(null, { status: 404, statusText: 'not found' })); return; }
        resolve(new Response(buf, { status: 200, headers: { 'content-type': 'application/wasm', 'content-length': String(buf.length) } }));
      });
    });
  };
}

// ---------- fetch ----------
// No .body: both net workers check for a streaming reader and fall back to
// arrayBuffer() when it is absent, which is the path we want — the model is
// a local read, and a progress bar with nobody watching is wasted work.
function makeFetch() {
  return function (url) {
    const t = toPath(url);
    if (t.remote) return Promise.reject(new Error('headless: refusing network fetch ' + t.url));
    return new Promise((resolve) => {
      fs.readFile(t.file, (err, buf) => {
        if (err) { resolve({ ok: false, status: 404, statusText: 'not found', headers: { get: () => null } }); return; }
        resolve({
          ok: true,
          status: 200,
          headers: { get: (h) => (/content-length/i.test(h) ? String(buf.length)
                                : /content-type/i.test(h) ? 'application/octet-stream' : null) },
          arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
          json: () => Promise.resolve(JSON.parse(buf.toString('utf8'))),
          text: () => Promise.resolve(buf.toString('utf8'))
        });
      });
    });
  };
}

// ---------- indexedDB ----------
// A cache that always misses. The workers then report 'no-cache', engines.js
// asks them to download, and the download is a local read. Puts are accepted
// and dropped: re-reading 46MB per process is cheaper than persisting it.
function makeIndexedDB() {
  const fire = (req, prop, value) => setImmediate(() => {
    if (prop === 'onsuccess') { req.result = value; if (req.onsuccess) req.onsuccess({ target: req }); }
    else if (req.onerror) req.onerror({ target: req });
  });
  const store = {
    get: (key) => { const r = {}; fire(r, 'onsuccess', undefined); return r; },
    put: (val) => { const r = {}; fire(r, 'onsuccess', undefined); return r; },
    delete: (key) => { const r = {}; fire(r, 'onsuccess', undefined); return r; }
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => ({ objectStore: () => store })
  };
  return {
    open() {
      const req = {};
      setImmediate(() => { req.result = db; if (req.onsuccess) req.onsuccess({ target: req }); });
      return req;
    }
  };
}

// ---------- the worker environment ----------
// One vm context per worker file, wired to its parent by postMessage. The
// engine build (engine/stockfish-*.js) is loaded through the same door: in a
// context with no `require` and no `global` it takes its own worker branch,
// reads the .wasm from location.hash, and talks UCI over postMessage —
// exactly what stockfish.worker.js expects of the worker it spawns.
function makeWorkerClass(onWorkerError) {
  return class Worker {
    constructor(url) {
      const t = toPath(url);
      if (t.remote) throw new Error('headless: refusing remote worker ' + t.url);
      const file = t.file;
      const src = fs.readFileSync(file, 'utf8');
      const dir = path.dirname(file);
      const isEngine = /[\\/]engine[\\/]/.test(file);

      this.onmessage = null;
      this.onerror = null;
      this._dead = false;

      const parent = this;
      const sandbox = {
        // The engine locates its .wasm as location.hash, the same trick the
        // page's worker branch uses; the rest resolve assets off location.href.
        location: {
          href: 'file://' + dir + '/',
          origin: 'file://' + dir,
          pathname: file,
          hash: isEngine ? '#' + file.replace(/\.js$/i, '.wasm') : ''
        },
        navigator: { userAgent: 'node', hardwareConcurrency: 1 },
        crossOriginIsolated: false,
        console, URL, URLSearchParams, TextDecoder, TextEncoder, Blob,
        Uint8Array, Float32Array, Int32Array, Int8Array, Uint16Array, Uint32Array,
        Float64Array, ArrayBuffer, DataView, Math, Date, JSON, Promise, Error,
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
        performance, crypto, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        // The Stockfish.js worker branch brings its own instantiateWasm: it
        // streams the .wasm through fetch().body.getReader(), rewraps it in a
        // Response and hands that to instantiateStreaming (so it can report
        // download progress). Node 20 has all of those, so the engine gets the
        // real ones and a fetch that answers with a real Response; the net
        // workers keep the minimal fetch, whose missing .body sends them down
        // their arrayBuffer path.
        WebAssembly: isEngine ? WebAssembly : {
          Module: WebAssembly.Module, Instance: WebAssembly.Instance,
          Memory: WebAssembly.Memory, Table: WebAssembly.Table,
          compile: WebAssembly.compile, instantiate: WebAssembly.instantiate,
          validate: WebAssembly.validate, RuntimeError: WebAssembly.RuntimeError
        },
        Response, Headers, ReadableStream,
        fetch: isEngine ? makeStreamingFetch() : makeFetch(),
        indexedDB: makeIndexedDB(),
        onmessage: null,
        onerror: null,
        Worker: null,          // filled below, so a worker can spawn one
        postMessage(msg) {     // worker -> parent
          if (parent._dead) return;
          setImmediate(() => { if (parent.onmessage) parent.onmessage({ data: msg }); });
        },
        close() { parent.terminate(); },
        importScripts(...urls) {
          for (const u of urls) {
            // The two library loads the workers do, served locally.
            if (/chess(\.min)?\.js/i.test(u)) { sandbox.Chess = Chess; continue; }
            if (/ort[.\-]/i.test(u)) { sandbox.ort = require('onnxruntime-node'); continue; }
            const p = toPath(u);
            if (p.remote) throw new Error('headless: refusing importScripts ' + p.url);
            vm.runInContext(fs.readFileSync(p.file, 'utf8'), context, { filename: p.file });
          }
        }
      };
      sandbox.self = sandbox;
      sandbox.globalThis = sandbox;
      sandbox.Worker = makeWorkerClass(onWorkerError);

      const context = vm.createContext(sandbox);
      this._sandbox = sandbox;

      try {
        vm.runInContext(src, context, { filename: file });
      } catch (err) {
        setImmediate(() => {
          if (this.onerror) this.onerror({ message: err.message });
          else if (onWorkerError) onWorkerError(file, err);
        });
      }
    }

    postMessage(msg) {         // parent -> worker
      if (this._dead) return;
      setImmediate(() => {
        const h = this._sandbox.onmessage;
        if (!h) return;
        try { h({ data: msg }); }
        catch (err) { if (this.onerror) this.onerror({ message: err.message }); }
      });
    }

    terminate() { this._dead = true; }
  };
}

// ---------- a DOM the calibrator can drive ----------
// Only the handful of nodes calibrate.html touches. The log element streams
// to stdout as it is appended to, so a long run says what it is doing.
function makeDocument(onLog) {
  const mk = (id) => {
    const el = {
      id, value: '', innerHTML: '', disabled: false,
      scrollTop: 0, scrollHeight: 0, children: [],
      _text: '',
      appendChild(c) { el.children.push(c); return c; },
      querySelector() { return el._tbody || (el._tbody = mk(id + ':tbody')); },
      addEventListener(ev, fn) { el['on' + ev] = fn; },
      onclick: null
    };
    Object.defineProperty(el, 'textContent', {
      get() { return el._text; },
      set(v) {
        const next = String(v);
        if (id === 'log' && onLog && next.length > el._text.length && next.startsWith(el._text)) {
          onLog(next.slice(el._text.length));
        }
        el._text = next;
      }
    });
    return el;
  };
  const byId = {};
  return {
    _byId: byId,
    getElementById(id) { return byId[id] || (byId[id] = mk(id)); },
    createElement(tag) { return mk(tag); }
  };
}

// ---------- the page ----------
// chess.js, engines.js, bot.js and the calibrator's inline <script>, in the
// order the page loads them, in one context — as close to being the page as
// this gets without a browser.
function makePageContext({ onLog }) {
  const document = makeDocument(onLog);
  const sandbox = {
    console, document, URL, URLSearchParams, Math, Date, JSON, Promise, Error,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    performance, Blob, TextDecoder, TextEncoder,
    Float32Array, Uint8Array, ArrayBuffer,
    navigator: { userAgent: 'node', hardwareConcurrency: 1 },
    crossOriginIsolated: false,
    location: { href: 'file://' + ROOT + '/', origin: 'file://' + ROOT, pathname: ROOT + '/' },
    fetch: makeFetch(),
    indexedDB: makeIndexedDB(),
    Chess,
    Worker: makeWorkerClass((file, err) => onLog('worker ' + path.basename(file) + ' failed: ' + err.message + '\n'))
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const load = (file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'),
                                         context, { filename: file });

  vm.runInContext("var BUILD = 'calibrate-headless';", context, { filename: 'build' });
  load('engines.js');
  load('bot.js');

  // The calibrator's logic lives inline in its page. Take the last <script>
  // that has no src — that is the gauntlet, and it is run unmodified.
  const html = fs.readFileSync(path.join(ROOT, 'calibrate.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!blocks.length) throw new Error('calibrate.html: no inline <script> found');
  const script = blocks[blocks.length - 1][1];
  if (!/function runOne/.test(script)) throw new Error('calibrate.html: inline script is not the gauntlet');
  vm.runInContext(script, context, { filename: 'calibrate.html<script>' });

  return { context, sandbox, document };
}

module.exports = { makePageContext, ROOT };
