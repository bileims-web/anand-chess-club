/*
 * patricia.worker.js — the Patricia engine lives entirely inside this worker.
 *
 * Patricia (github.com/Adam-Kulju/Patricia, MIT) is the most aggressive
 * engine there is, and it has its own way of being weak: `Skill_Level` 1-20
 * maps to an Elo table (4 = 1200, 10 = 1800, 17 = 2500; 21 is full
 * strength), and at any level below 21 it runs a five-line search, then
 * spends an accumulating centipawn budget on deliberately worse moves —
 * preferring a sacrifice whenever one is within reach. So, unlike Stockfish's
 * UCI_Elo, the weakened `bestmove` IS the thing we want, and this worker
 * hands it back as the move. No net, no candidate list, no margins.
 *
 * The build is engine/patricia.js + engine/patricia.wasm, made by
 * patricia/build.sh: single-threaded, so a search runs to its node limit
 * inside pat_cmd() and blocks this worker until it is done. Every search is
 * bounded by nodes, never by time, so a phone and the calibrator play the
 * same strength.
 *
 * Protocol (page -> worker):
 *   { cmd: 'init', id }
 *   { cmd: 'play', id, fen, skill, nodes }
 *       skill: Skill_Level 1-21; nodes: the search budget.
 *   { cmd: 'abort', id }   // page-side timeout fired; nothing to stop, the
 *                          // search is synchronous — the result is dropped
 *
 * Protocol (worker -> page), always tagged with the request id:
 *   { id, ok: true,  engine: 'patricia' }              // init done
 *   { id, ok: true,  bestmove, timeMs }                // play done
 *   { id, ok: false, error }
 *
 * The human mode keeps its mistake budget across a game and resets it on
 * `ucinewgame`. The page sends fens only, so a new game is inferred: the
 * move number went backwards, or there are more pieces than last time.
 */
'use strict';

var ENGINE_DIR = 'engine/';

var M = null;            // the Emscripten module
var lines = [];          // engine stdout since the last drain
var initInFlight = null;
var initDone = false;
var lastFull = 0, lastPieces = 0;
var aborted = {};

function reply(msg) { self.postMessage(msg); }

function cmd(s) { M.ccall('pat_cmd', null, ['string'], [s]); }
function drain() { var out = lines; lines = []; return out; }

function doInit() {
  if (initInFlight) return initInFlight;
  initInFlight = new Promise(function (resolve, reject) {
    try {
      importScripts(ENGINE_DIR + 'patricia.js');
    } catch (err) { reject(new Error('patricia.js failed to load: ' + (err.message || err))); return; }
    if (typeof Patricia !== 'function') { reject(new Error('patricia.js defined no factory')); return; }
    // The .wasm is fetched here and handed over as bytes, so the loader never
    // has to work out where it lives — the same path serves the page and the
    // headless harness, whose fetch is a local file read.
    resolve(fetch(ENGINE_DIR + 'patricia.wasm').then(function (r) {
      if (!r.ok) throw new Error('patricia.wasm: HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      return Patricia({
        wasmBinary: new Uint8Array(buf),
        print: function (l) { lines.push('' + l); },
        printErr: function (l) { lines.push('' + l); }
      });
    }).then(function (mod) {
      M = mod;
      M._pat_init();
      cmd('uci');
      var out = drain();
      if (out.indexOf('uciok') === -1) throw new Error('no uciok from Patricia');
      // 16MB is plenty for searches this small, and it is memset on every new game.
      cmd('setoption name Hash value 16');
      cmd('isready');
      if (drain().indexOf('readyok') === -1) throw new Error('no readyok from Patricia');
      initDone = true;
      return { engine: 'patricia' };
    }));
  }).catch(function (err) { initInFlight = null; throw err; });
  return initInFlight;
}

function pieceCount(fen) {
  var board = fen.split(' ')[0];
  return board.replace(/[^a-zA-Z]/g, '').length;
}

function play(m) {
  var fen = '' + m.fen;
  var parts = fen.split(' ');
  var full = parseInt(parts[5], 10) || 1;
  var pieces = pieceCount(fen);
  if (full < lastFull || pieces > lastPieces) cmd('ucinewgame');
  lastFull = full; lastPieces = pieces;

  var skill = Math.max(1, Math.min(21, parseInt(m.skill, 10) || 21));
  cmd('setoption name Skill_Level value ' + skill);
  cmd('position fen ' + fen);
  drain();
  var t0 = Date.now();
  cmd('go nodes ' + Math.max(1, parseInt(m.nodes, 10) || 10000));
  var out = drain();
  for (var i = out.length - 1; i >= 0; i--) {
    var bm = /^bestmove (\S+)/.exec(out[i]);
    if (bm) return { bestmove: bm[1], timeMs: Date.now() - t0 };
  }
  throw new Error('no bestmove from Patricia');
}

self.onmessage = function (e) {
  var m = e.data || {};

  if (m.cmd === 'init') {
    doInit().then(
      function (info) { reply({ id: m.id, ok: true, engine: info.engine }); },
      function (err) { reply({ id: m.id, ok: false, error: err.message || 'init failed' }); }
    );
    return;
  }

  if (m.cmd === 'play') {
    if (!initDone) { reply({ id: m.id, ok: false, error: 'engine not initialised' }); return; }
    var res;
    try { res = play(m); }
    catch (err) { reply({ id: m.id, ok: false, error: err.message || 'search failed' }); return; }
    if (aborted[m.id]) { delete aborted[m.id]; return; }
    reply({ id: m.id, ok: true, bestmove: res.bestmove, timeMs: res.timeMs });
    return;
  }

  if (m.cmd === 'abort') {
    // The search cannot be interrupted; if it is still queued behind another,
    // its result is dropped when it arrives.
    aborted[m.id] = true;
  }
};
