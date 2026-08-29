/*
 * stockfish.worker.js — the Stockfish engine lives entirely inside this worker.
 * The page talks a small message protocol to us; all UCI stays in here.
 *
 * Protocol (page -> worker):
 *   { cmd: 'init',    id }
 *   { cmd: 'analyse', id, fen, depth, multipv }
 *   { cmd: 'abort',   id }   // page-side timeout fired; stop the current search
 *
 * Protocol (worker -> page), always tagged with the request id:
 *   { id, ok: true,  engine, threads }                          // init done
 *   { id, ok: true,  bestmove, ponder, pvs: [...], timeMs }     // analyse done
 *   { id, ok: false, error }
 *
 * Each pvs entry: { multipv, move, cp, mate, line, depth }.
 * cp/mate are from the side to move, as UCI reports them.
 */
'use strict';

var ENGINE_DIR = 'engine/';
var MULTI_BUILD = 'stockfish-18-lite.js';         // needs crossOriginIsolated (SharedArrayBuffer)
var SINGLE_BUILD = 'stockfish-18-lite-single.js'; // runs anywhere

var engine = null;      // nested Worker running the Stockfish build
var engineName = null;
var threads = 1;
var initDone = false;
var initInFlight = null;
var current = null;     // the one analyse in flight: { id, pvs, t0, aborted }

function reply(msg) { self.postMessage(msg); }
function send(cmd) { engine.postMessage(cmd); }

/* Spawn a build and complete the UCI handshake: uci -> uciok, isready -> readyok. */
function handshake(build, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var w, settled = false, sawUciok = false;
    var timer = setTimeout(function () { fail(new Error(build + ' load timed out')); }, timeoutMs);
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { w.terminate(); } catch (ignore) {}
      reject(err);
    }
    try {
      w = new Worker(ENGINE_DIR + build);
    } catch (err) { clearTimeout(timer); reject(err); return; }
    w.onerror = function (e) { fail(new Error(build + ': ' + (e.message || 'failed to load'))); };
    w.onmessage = function (e) {
      var line = '' + e.data;
      if (!sawUciok) {
        if (line === 'uciok') { sawUciok = true; w.postMessage('isready'); }
      } else if (line === 'readyok' && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(w);
      }
    };
    w.postMessage('uci');
  });
}

/* Wait for one readyok (used to sync after setoption). */
function waitReady(w, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('engine hung on isready')); }, timeoutMs);
    var prev = w.onmessage;
    w.onmessage = function (e) {
      if ('' + e.data === 'readyok') {
        clearTimeout(timer);
        w.onmessage = prev;
        resolve(w);
      }
    };
    w.postMessage('isready');
  });
}

function doInit() {
  if (initInFlight) return initInFlight;
  var canThread = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
  var attempt = canThread
    ? handshake(MULTI_BUILD, 60000).then(function (w) {
        engineName = MULTI_BUILD;
        var hc = (self.navigator && navigator.hardwareConcurrency) || 2;
        threads = Math.max(1, Math.min(hc - 1, 8));
        w.postMessage('setoption name Threads value ' + threads);
        return waitReady(w, 20000).catch(function (err) {
          try { w.terminate(); } catch (ignore) {}
          throw err;
        });
      }).catch(function () {
        // Threaded build failed on this browser — fall back to single-threaded.
        engineName = null;
        return handshake(SINGLE_BUILD, 60000);
      })
    : handshake(SINGLE_BUILD, 60000);

  initInFlight = attempt.then(function (w) {
    engine = w;
    if (!engineName) { engineName = SINGLE_BUILD; threads = 1; }
    engine.onmessage = function (e) { onEngineLine('' + e.data); };
    engine.onerror = function (e) {
      var err = e.message || 'engine crashed';
      if (current) { reply({ id: current.id, ok: false, error: err }); current = null; }
    };
    initDone = true;
    return { engine: engineName.replace(/\.js$/, ''), threads: threads };
  });
  return initInFlight;
}

/* ---------- UCI output parsing ---------- */
function onEngineLine(line) {
  if (!current) return;
  if (line.lastIndexOf('info ', 0) === 0) {
    // Skip bound reports; keep only real PV updates.
    if (line.indexOf(' pv ') === -1) return;
    if (line.indexOf('lowerbound') !== -1 || line.indexOf('upperbound') !== -1) return;
    var depth = /\bdepth (\d+)/.exec(line);
    var mpv = /\bmultipv (\d+)/.exec(line);
    var score = /\bscore (cp|mate) (-?\d+)/.exec(line);
    var pv = / pv (.+)$/.exec(line);
    if (!depth || !score || !pv) return;
    var slot = mpv ? parseInt(mpv[1], 10) : 1;
    current.pvs[slot - 1] = {
      multipv: slot,
      move: pv[1].split(' ')[0],
      cp: score[1] === 'cp' ? parseInt(score[2], 10) : null,
      mate: score[1] === 'mate' ? parseInt(score[2], 10) : null,
      line: pv[1],
      depth: parseInt(depth[1], 10)
    };
    return;
  }
  var bm = /^bestmove (\S+)(?: ponder (\S+))?/.exec(line);
  if (bm) {
    var job = current;
    current = null;
    if (job.aborted) return;
    reply({
      id: job.id,
      ok: true,
      bestmove: bm[1],
      ponder: bm[2] || null,
      pvs: job.pvs.filter(function (p) { return !!p; }),
      timeMs: Math.round(Date.now() - job.t0)
    });
  }
}

/* ---------- Requests from the page ---------- */
self.onmessage = function (e) {
  var m = e.data || {};

  if (m.cmd === 'init') {
    doInit().then(
      function (info) { reply({ id: m.id, ok: true, engine: info.engine, threads: info.threads }); },
      function (err) { initInFlight = null; reply({ id: m.id, ok: false, error: err.message || 'init failed' }); }
    );
    return;
  }

  if (m.cmd === 'analyse') {
    if (!initDone) { reply({ id: m.id, ok: false, error: 'engine not initialised' }); return; }
    if (current) { reply({ id: m.id, ok: false, error: 'analysis already running' }); return; }
    current = { id: m.id, pvs: [], t0: Date.now(), aborted: false };
    send('setoption name MultiPV value ' + (m.multipv || 1));
    send('position fen ' + m.fen);
    send('go depth ' + (m.depth || 12));
    return;
  }

  if (m.cmd === 'abort') {
    // The page already timed the request out; stop the search and drop its result.
    if (current && current.id === m.id) {
      current.aborted = true;
      send('stop');
    }
  }
};
