/*
 * engines.js — the three engine workers, and nothing else.
 *
 * Stockfish (search, used for the coach, the review, Anand's blunder filter
 * and calibration) plus the two ONNX policy nets. Shared by index.html and
 * calibrate.html so both drive an identical stack.
 *
 * Expects a global BUILD (cache-busting build id) at call time.
 */
'use strict';

// ---------- Stockfish ----------
// Engine runs in stockfish.worker.js; nothing here blocks the main thread.
// Every request carries a timeout so a hung worker can never freeze the board.
var SF = (function () {
  var worker = null, nextId = 1, pending = {}, initPromise = null, queue = Promise.resolve();
  var info = { engine: null, threads: 0 };

  function ensureWorker() {
    if (worker) return;
    worker = new Worker('stockfish.worker.js?v=' + BUILD);
    worker.onmessage = function (e) {
      var m = e.data || {};
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m); else p.reject(new Error(m.error || 'engine error'));
    };
    worker.onerror = function (e) {
      var err = new Error(e.message || 'engine worker crashed');
      Object.keys(pending).forEach(function (id) {
        clearTimeout(pending[id].timer);
        pending[id].reject(err);
        delete pending[id];
      });
      try { worker.terminate(); } catch (ignore) {}
      worker = null;
      initPromise = null;
    };
  }

  function call(msg, timeoutMs) {
    ensureWorker();
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      msg.id = id;
      pending[id] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          delete pending[id];
          if (worker) worker.postMessage({ cmd: 'abort', id: id });
          reject(new Error(msg.cmd + ' timed out'));
        }, timeoutMs)
      };
      worker.postMessage(msg);
    });
  }

  // Resolves after the UCI handshake (uciok then readyok) completes in the worker.
  function init() {
    if (!initPromise) {
      initPromise = call({ cmd: 'init' }, 60000).then(function (m) {
        info.engine = m.engine;
        info.threads = m.threads;
        return info;
      }, function (err) {
        initPromise = null;
        throw err;
      });
    }
    return initPromise;
  }

  // analyse(fen, {depth | nodes | movetime, multipv, timeout, options})
  //   -> {bestmove, ponder, pvs, timeMs}
  // pvs: [{multipv, move, cp, mate, line, depth}], scores from the side to move.
  // Calls are serialised: the engine searches one position at a time.
  function analyse(fen, opts) {
    opts = opts || {};
    var job = queue.then(function () {
      return init().then(function () {
        return call({
          cmd: 'analyse',
          fen: fen,
          depth: opts.depth || 12,
          multipv: opts.multipv || 1,
          nodes: opts.nodes || 0,
          movetime: opts.movetime || 0,
          options: opts.options || null
        }, opts.timeout || 120000);
      });
    });
    queue = job.then(function () {}, function () {});
    return job;
  }

  return { init: init, analyse: analyse, info: info };
})();

// ---------- Neural-net engines ----------
// Each net runs in its own worker (ONNX, off the main thread) and is
// cached in IndexedDB after first download. Same worker protocol for both.
function makeNetEngine(workerFile, modelUrl, modelVersion) {
  var worker = null, nextId = 1, pending = {}, readyPromise = null;
  var statusCb = null, progressCb = null;

  function ensureWorker() {
    if (worker) return;
    // ?v= so a page update can never run last build's cached worker
    worker = new Worker(workerFile + '?v=' + BUILD);
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (readyPromise && (m.type === 'status' || m.type === 'progress')) {
        readyPromise.beat = Date.now();
      }
      if (m.type === 'status') {
        if (m.status === 'no-cache') worker.postMessage({ type: 'download' });
        if (m.status === 'ready' && readyPromise && readyPromise.resolve) readyPromise.resolve();
        if (statusCb) statusCb(m.status);
      }
      if (m.type === 'progress' && progressCb) progressCb(m.progress);
      if (m.type === 'eval-result' || (m.type === 'error' && m.id !== undefined)) {
        var p = pending[m.id];
        if (!p) return;
        delete pending[m.id];
        clearTimeout(p.timer);
        if (m.type === 'eval-result') p.resolve(m); else p.reject(new Error(m.message));
      } else if (m.type === 'error') {
        if (readyPromise && readyPromise.reject) readyPromise.reject(new Error(m.message));
      }
    };
    worker.onerror = function (e) {
      var err = new Error(e.message || 'maia worker crashed');
      if (readyPromise && readyPromise.reject) readyPromise.reject(err);
      Object.keys(pending).forEach(function (id) {
        clearTimeout(pending[id].timer);
        pending[id].reject(err);
        delete pending[id];
      });
      try { worker.terminate(); } catch (ignore) {}
      worker = null;
      readyPromise = null;
    };
  }

  // init(onStatus, onProgress) resolves when the model is loaded,
  // downloading it (with progress callbacks) if it isn't cached yet.
  // Later calls refresh the callbacks; a failed init can be retried.
  function init(onStatus, onProgress) {
    if (onStatus) statusCb = onStatus;
    if (onProgress) progressCb = onProgress;
    if (readyPromise) return readyPromise.promise;
    ensureWorker();
    var box = {};
    box.beat = Date.now();   // stamped again on every status/progress message
    box.promise = new Promise(function (resolve, reject) {
      box.resolve = resolve;
      box.reject = reject;
      worker.postMessage({
        type: 'init',
        modelUrl: modelUrl,
        modelVersion: modelVersion
      });
      // A healthy load reports in constantly. Prolonged silence means it
      // is wedged — say so quickly rather than spinning for five minutes.
      var watch = setInterval(function () {
        if (Date.now() - box.beat > 45000) {
          clearInterval(watch);
          reject(new Error('model load stalled'));
        }
      }, 5000);
      box.settle = function () { clearInterval(watch); };
    });
    box.promise = box.promise.then(function (v) {
      box.settle();
      return v;
    }, function (err) {
      box.settle();
      readyPromise = null;   // allow a retry
      if (worker && /stalled/.test(err.message)) {
        // a wedged worker never recovers; the retry gets a fresh one
        try { worker.terminate(); } catch (ignore) {}
        worker = null;
      }
      throw err;
    });
    readyPromise = box;
    return box.promise;
  }

  // evaluate(fen, eloSelf, eloOppo) -> {moves: [[uci, prob], ...] sorted, value}
  function evaluate(fen, eloSelf, eloOppo) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          delete pending[id];
          reject(new Error('maia eval timed out'));
        }, 30000)
      };
      worker.postMessage({ type: 'eval', id: id, fen: fen, eloSelf: eloSelf, eloOppo: eloOppo });
    });
  }

  return { init: init, evaluate: evaluate };
}

var MAIA = makeNetEngine('maia.worker.js', 'models/maia3_simplified.onnx', '3');
var ANAND = makeNetEngine('anand.worker.js', 'models/meangirl-8.onnx', '1');
