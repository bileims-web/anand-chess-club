/*
 * maia.worker.js — Maia 3 neural-net opponent, running entirely in this worker.
 *
 * Ported from CSSLab/maia-platform-frontend (GPLv3):
 *   public/maia-worker.js, src/lib/engine/tensor.ts, src/lib/engine/maia.ts
 * Model: maia3_simplified.onnx (CSSLab), inference via onnxruntime-web 1.23 (WASM).
 *
 * The board-to-tensor encoding is kept byte-for-byte equivalent to theirs:
 * positions are always presented from White's perspective (the FEN is
 * mirrored when Black is to move, and the chosen move mirrored back),
 * tokens are (64, 12) square-major piece planes, Elo is a raw float
 * (Maia 3 interpolates the rating continuously), and the policy is a
 * softmax over the legal subset of a fixed 4352-move space.
 *
 * Messages from the page:
 *   { type: 'init', modelUrl, modelVersion }   -> status: 'ready' | 'no-cache'
 *   { type: 'download' }                        -> progress: 0..100, then 'ready'
 *   { type: 'eval', id, fen, eloSelf, eloOppo } -> eval-result
 *
 * Messages to the page:
 *   { type: 'status', status }        // 'loading' | 'no-cache' | 'downloading' | 'ready'
 *   { type: 'progress', progress }
 *   { type: 'error', message, id? }
 *   { type: 'eval-result', id, moves, value }   // moves: [[uci, prob], ...] sorted desc
 */
'use strict';

importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js');
importScripts('ort/ort.wasm.min.js');

ort.env.wasm.wasmPaths = new URL('ort/', self.location.href).href;
// WebKit (Safari, and every iPhone/iPad browser) deadlocks spawning the
// pthread pool from inside a worker: InferenceSession.create never returns
// and the opponent "thinks" forever. Single-thread there, like Anand's net.
var UA = (self.navigator && self.navigator.userAgent) || '';
var WEBKIT_ONLY = /iPhone|iPad|iPod|CriOS|FxiOS/.test(UA) ||
  (/AppleWebKit/.test(UA) && !/Chrome\/|Chromium\//.test(UA));
ort.env.wasm.numThreads =
  !WEBKIT_ONLY && typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true
    ? Math.max(1, Math.min(((self.navigator && navigator.hardwareConcurrency) || 2) - 1, 4))
    : 1;

// ---------- IndexedDB model cache ----------
var DB_NAME = 'MaiaModels';
var STORE_NAME = 'models';
var MODEL_KEY = 'maia3-model';

function openDB() {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open(DB_NAME, 1);
    request.onerror = function () { reject(request.error); };
    request.onsuccess = function () { resolve(request.result); };
    request.onupgradeneeded = function (event) {
      var db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

function getCachedModel(url, version) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction([STORE_NAME], 'readonly').objectStore(STORE_NAME).get(MODEL_KEY);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    }).then(function (data) {
      if (!data) return null;
      if (data.url !== url || data.version !== version) {
        db.transaction([STORE_NAME], 'readwrite').objectStore(STORE_NAME).delete(MODEL_KEY);
        return null;
      }
      return data.data.arrayBuffer();
    });
  });
}

function storeModel(url, version, buffer) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction([STORE_NAME], 'readwrite').objectStore(STORE_NAME).put({
        id: MODEL_KEY,
        url: url,
        version: version,
        data: new Blob([buffer]),
        timestamp: Date.now(),
        size: buffer.byteLength
      });
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

// ---------- Move space ----------
var allMoves = null;      // uci -> index (4352 entries)
var allMovesReversed = null; // index -> uci

function loadMoveMap() {
  if (allMoves) return Promise.resolve();
  return fetch(new URL('maia/all_moves_maia3.json', self.location.href).href)
    .then(function (r) {
      if (!r.ok) throw new Error('failed to load move map');
      return r.json();
    })
    .then(function (map) {
      allMoves = map;
      allMovesReversed = {};
      Object.keys(map).forEach(function (uci) { allMovesReversed[map[uci]] = uci; });
    });
}

// ---------- Board encoding (port of tensor.ts) ----------
function mirrorSquare(square) {
  return square.charAt(0) + (9 - parseInt(square.charAt(1), 10));
}

function mirrorMove(moveUci) {
  var promotion = moveUci.length > 4 ? moveUci.substring(4) : '';
  return mirrorSquare(moveUci.substring(0, 2)) + mirrorSquare(moveUci.substring(2, 4)) + promotion;
}

function swapColorsInRank(rank) {
  var out = '';
  for (var i = 0; i < rank.length; i++) {
    var ch = rank.charAt(i);
    if (/[A-Z]/.test(ch)) out += ch.toLowerCase();
    else if (/[a-z]/.test(ch)) out += ch.toUpperCase();
    else out += ch;
  }
  return out;
}

function swapCastlingRights(castling) {
  if (castling === '-') return '-';
  var rights = {};
  castling.split('').forEach(function (c) { rights[c] = true; });
  var out = '';
  if (rights.k) out += 'K';
  if (rights.q) out += 'Q';
  if (rights.K) out += 'k';
  if (rights.Q) out += 'q';
  return out === '' ? '-' : out;
}

function mirrorFEN(fen) {
  var parts = fen.split(' ');
  var mirroredPosition = parts[0].split('/').slice().reverse().map(swapColorsInRank).join('/');
  var mirroredActiveColor = parts[1] === 'w' ? 'b' : 'w';
  var mirroredCastling = swapCastlingRights(parts[2]);
  var mirroredEnPassant = parts[3] !== '-' ? mirrorSquare(parts[3]) : '-';
  return mirroredPosition + ' ' + mirroredActiveColor + ' ' + mirroredCastling + ' ' +
    mirroredEnPassant + ' ' + parts[4] + ' ' + parts[5];
}

var PIECE_TYPES = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];

function boardToMaia3Tokens(fen) {
  var tensor = new Float32Array(64 * 12);
  var rows = fen.split(' ')[0].split('/');
  for (var rank = 0; rank < 8; rank++) {
    var row = 7 - rank;
    var file = 0;
    for (var i = 0; i < rows[rank].length; i++) {
      var ch = rows[rank].charAt(i);
      if (isNaN(parseInt(ch, 10))) {
        var pieceIdx = PIECE_TYPES.indexOf(ch);
        if (pieceIdx >= 0) tensor[(row * 8 + file) * 12 + pieceIdx] = 1.0;
        file += 1;
      } else {
        file += parseInt(ch, 10);
      }
    }
  }
  return tensor;
}

function preprocessMaia3(fen) {
  var board = new Chess(fen);
  if (fen.split(' ')[1] === 'b') {
    board = new Chess(mirrorFEN(board.fen()));
  } else if (fen.split(' ')[1] !== 'w') {
    throw new Error('Invalid FEN: ' + fen);
  }

  var boardTokens = boardToMaia3Tokens(board.fen());

  var legalMoves = new Float32Array(Object.keys(allMoves).length);
  board.moves({ verbose: true }).forEach(function (move) {
    var promotion = move.promotion ? move.promotion : '';
    var moveIndex = allMoves[move.from + move.to + promotion];
    if (moveIndex !== undefined) legalMoves[moveIndex] = 1.0;
  });

  return { boardTokens: boardTokens, legalMoves: legalMoves };
}

// ---------- Output processing (port of processOutputsMaia3) ----------
function processOutputs(fen, logitsMove, logitsValue, legalMoves) {
  // Value head: LDW logits for the side shown to the net (always "White").
  var maxWdl = Math.max(logitsValue[0], logitsValue[1], logitsValue[2]);
  var expL = Math.exp(logitsValue[0] - maxWdl);
  var expD = Math.exp(logitsValue[1] - maxWdl);
  var expW = Math.exp(logitsValue[2] - maxWdl);
  var winProb = (expW + 0.5 * expD) / (expL + expD + expW);

  var blackFlag = fen.split(' ')[1] === 'b';
  if (blackFlag) winProb = 1 - winProb;

  var indices = [];
  for (var i = 0; i < legalMoves.length; i++) if (legalMoves[i] > 0) indices.push(i);

  var maxLogit = -Infinity;
  indices.forEach(function (idx) { if (logitsMove[idx] > maxLogit) maxLogit = logitsMove[idx]; });
  var sum = 0;
  var exps = indices.map(function (idx) {
    var e = Math.exp(logitsMove[idx] - maxLogit);
    sum += e;
    return e;
  });

  var moves = indices.map(function (idx, k) {
    var uci = allMovesReversed[idx];
    if (blackFlag) uci = mirrorMove(uci);
    return [uci, exps[k] / sum];
  });
  moves.sort(function (a, b) { return b[1] - a[1]; });

  return { moves: moves, value: Math.round(winProb * 10000) / 10000 };
}

// ---------- ONNX session ----------
var session = null;
var modelUrl = null;
var modelVersion = null;
var downloading = false;

function initSession(buffer) {
  return ort.InferenceSession.create(buffer).then(function (s) { session = s; });
}

function runEval(msg) {
  var pre = preprocessMaia3(msg.fen);
  var feeds = {
    tokens: new ort.Tensor('float32', pre.boardTokens, [1, 64, 12]),
    elo_self: new ort.Tensor('float32', Float32Array.from([msg.eloSelf]), [1]),
    elo_oppo: new ort.Tensor('float32', Float32Array.from([msg.eloOppo]), [1])
  };
  return session.run(feeds).then(function (result) {
    var out = processOutputs(
      msg.fen,
      new Float32Array(result.logits_move.data),
      new Float32Array(result.logits_value.data),
      pre.legalMoves
    );
    postMessage({ type: 'eval-result', id: msg.id, moves: out.moves, value: out.value });
  });
}

// ---------- Message handler ----------
self.onmessage = function (e) {
  var msg = e.data;
  Promise.resolve().then(function () {
    if (msg.type === 'init') {
      modelUrl = msg.modelUrl;
      modelVersion = msg.modelVersion;
      postMessage({ type: 'status', status: 'loading' });
      return loadMoveMap().then(function () {
        return getCachedModel(modelUrl, modelVersion);
      }).then(function (buffer) {
        if (buffer) {
          return initSession(buffer).then(function () {
            postMessage({ type: 'status', status: 'ready' });
          });
        }
        postMessage({ type: 'status', status: 'no-cache' });
      });
    }

    if (msg.type === 'download') {
      if (downloading) return;   // a retry while one is in flight must not start a second fetch
      downloading = true;
      postMessage({ type: 'status', status: 'downloading' });
      postMessage({ type: 'progress', progress: 0 });
      return fetch(modelUrl).then(function (response) {
        if (!response.ok) throw new Error('failed to fetch model (' + response.status + ')');
        if (!response.body || typeof response.body.getReader !== 'function') {
          return response.arrayBuffer().then(function (b) { return new Uint8Array(b); });
        }
        var reader = response.body.getReader();
        var contentLength = +(response.headers.get('Content-Length') || 0);
        var chunks = [];
        var received = 0;
        var lastReported = 0;
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              var buffer = new Uint8Array(received);
              var pos = 0;
              chunks.forEach(function (c) { buffer.set(c, pos); pos += c.length; });
              return buffer;
            }
            chunks.push(r.value);
            received += r.value.length;
            if (contentLength > 0) {
              // the server reports the compressed size, so cap what we show
              var progress = Math.min(99, Math.floor((received / contentLength) * 100));
              if (progress >= lastReported + 1) {
                postMessage({ type: 'progress', progress: progress });
                lastReported = progress;
              }
            }
            return pump();
          });
        }
        return pump();
      }).then(function (buffer) {
        return storeModel(modelUrl, modelVersion, buffer.buffer).catch(function () {
          // Cache write failing (private mode, quota) shouldn't block play.
        }).then(function () {
          return initSession(buffer.buffer);
        });
      }).then(function () {
        postMessage({ type: 'progress', progress: 100 });
        postMessage({ type: 'status', status: 'ready' });
      }).catch(function (err) {
        downloading = false;   // a fresh 'download' may try again
        throw err;
      });
    }

    if (msg.type === 'eval') {
      if (!session) throw new Error('model not initialised');
      return runEval(msg);
    }
  }).catch(function (err) {
    postMessage({ type: 'error', message: err.message || 'worker error', id: msg.id });
  });
};
