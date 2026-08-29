/*
 * anand.worker.js — Anand's brain: dkappe's "Mean Girl 8" lc0 network
 * (leela-chess-weights, GPLv3), exported to ONNX from the badgyal
 * pytorch loader, running via onnxruntime-web entirely in this worker.
 *
 * Encoding is a faithful port of badgyal/board2planes.py:
 *   - board mirrored when Black is to move (moves mirrored back)
 *   - 112 input planes: the 13-plane piece block (12 piece planes +
 *     one zero plane) repeated 8x as "history", then castling rights
 *     (H1, A1, H8, A8 of the mirrored board), the ORIGINAL side to
 *     move, a zeroed halfmove-clock plane, a zero plane, a ones plane
 *   - policy over the classic 1858-entry lc0 move list; castling is
 *     looked up as e1h1/e1a1, knight promotions drop the 'n' suffix
 *   - value head: tanh scalar for the side to move
 *
 * Protocol identical to maia.worker.js (init / download / eval).
 */
'use strict';

importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js');
importScripts('ort/ort.wasm.min.js');

ort.env.wasm.wasmPaths = new URL('ort/', self.location.href).href;
ort.env.wasm.numThreads = 1; // 1.7MB net: single-thread inference is instant

// ---------- IndexedDB model cache (same DB as Maia, its own key) ----------
var DB_NAME = 'MaiaModels';
var STORE_NAME = 'models';
var MODEL_KEY = 'meangirl-8';

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

// ---------- Policy index ----------
var policyMap = null;   // uci -> index (1858 entries)

function loadPolicyIndex() {
  if (policyMap) return Promise.resolve();
  return fetch(new URL('anand/policy_index.json', self.location.href).href)
    .then(function (r) {
      if (!r.ok) throw new Error('failed to load policy index');
      return r.json();
    })
    .then(function (list) {
      policyMap = {};
      for (var i = 0; i < list.length; i++) policyMap[list[i]] = i;
    });
}

// ---------- FEN mirroring (same transforms as maia.worker.js) ----------
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

// ---------- 112-plane encoding (port of board2planes) ----------
var PIECE_TYPES = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];

function boardToPlanes(mirroredFen, originalBlackToMove) {
  var planes = new Float32Array(112 * 64);
  var parts = mirroredFen.split(' ');
  var rows = parts[0].split('/');
  var rank, row, file, i, ch;

  for (rank = 0; rank < 8; rank++) {
    row = 7 - rank;
    file = 0;
    for (i = 0; i < rows[rank].length; i++) {
      ch = rows[rank].charAt(i);
      if (isNaN(parseInt(ch, 10))) {
        var pieceIdx = PIECE_TYPES.indexOf(ch);
        if (pieceIdx >= 0) {
          // the 13-plane block is repeated 8 times as history
          for (var rep = 0; rep < 8; rep++) {
            planes[(rep * 13 + pieceIdx) * 64 + row * 8 + file] = 1.0;
          }
        }
        file += 1;
      } else {
        file += parseInt(ch, 10);
      }
    }
  }

  var castling = parts[2];
  function fill(planeIdx, on) {
    if (!on) return;
    var start = planeIdx * 64;
    for (var k = 0; k < 64; k++) planes[start + k] = 1.0;
  }
  fill(104, castling.indexOf('K') !== -1);  // H1 of the mirrored board
  fill(105, castling.indexOf('Q') !== -1);  // A1
  fill(106, castling.indexOf('k') !== -1);  // H8
  fill(107, castling.indexOf('q') !== -1);  // A8
  fill(108, originalBlackToMove);           // colour plane: original turn
  // 109: halfmove clock, zeroed by badgyal; 110: zeros; 111: ones
  fill(111, true);

  return planes;
}

function preprocess(fen) {
  var blackToMove = fen.split(' ')[1] === 'b';
  var board = new Chess(fen);
  if (blackToMove) board = new Chess(mirrorFEN(board.fen()));
  else if (fen.split(' ')[1] !== 'w') throw new Error('Invalid FEN: ' + fen);

  var planes = boardToPlanes(board.fen(), blackToMove);

  // Legal moves of the mirrored board, with badgyal's lookup quirks.
  var legal = [];
  board.moves({ verbose: true }).forEach(function (move) {
    var uci = move.from + move.to + (move.promotion || '');
    var fixed = uci;
    if (move.flags.indexOf('k') !== -1 && uci === 'e1g1') fixed = 'e1h1';
    else if (move.flags.indexOf('q') !== -1 && uci === 'e1c1') fixed = 'e1a1';
    if (fixed.charAt(fixed.length - 1) === 'n') fixed = fixed.slice(0, -1);
    var idx = policyMap[fixed];
    if (idx !== undefined) {
      legal.push([blackToMove ? mirrorMove(uci) : uci, idx]);
    }
  });

  return { planes: planes, legal: legal, blackToMove: blackToMove };
}

function processOutputs(pre, policyLogits, valueScalar) {
  var maxLogit = -Infinity;
  pre.legal.forEach(function (m) {
    if (policyLogits[m[1]] > maxLogit) maxLogit = policyLogits[m[1]];
  });
  var sum = 0;
  var exps = pre.legal.map(function (m) {
    var e = Math.exp(policyLogits[m[1]] - maxLogit);
    sum += e;
    return e;
  });
  var moves = pre.legal.map(function (m, k) { return [m[0], exps[k] / sum]; });
  moves.sort(function (a, b) { return b[1] - a[1]; });

  // tanh value is for the side to move; report White's win probability.
  var winProb = (valueScalar + 1) / 2;
  if (pre.blackToMove) winProb = 1 - winProb;

  return { moves: moves, value: Math.round(winProb * 10000) / 10000 };
}

// ---------- ONNX session ----------
var session = null;
var modelUrl = null;
var modelVersion = null;

function initSession(buffer) {
  return ort.InferenceSession.create(buffer).then(function (s) { session = s; });
}

function runEval(msg) {
  var pre = preprocess(msg.fen);
  var feeds = {
    planes: new ort.Tensor('float32', pre.planes, [1, 112, 8, 8])
  };
  return session.run(feeds).then(function (result) {
    var out = processOutputs(
      pre,
      new Float32Array(result.policy.data),
      Number(result.value.data[0])
    );
    postMessage({ type: 'eval-result', id: msg.id, moves: out.moves, value: out.value });
  });
}

// ---------- Message handler (same protocol as maia.worker.js) ----------
self.onmessage = function (e) {
  var msg = e.data;
  Promise.resolve().then(function () {
    if (msg.type === 'init') {
      modelUrl = msg.modelUrl;
      modelVersion = msg.modelVersion;
      postMessage({ type: 'status', status: 'loading' });
      return loadPolicyIndex().then(function () {
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
      postMessage({ type: 'status', status: 'downloading' });
      return fetch(modelUrl).then(function (response) {
        if (!response.ok) throw new Error('failed to fetch model (' + response.status + ')');
        return response.arrayBuffer();
      }).then(function (buffer) {
        return storeModel(modelUrl, modelVersion, buffer).catch(function () {
          // cache failure (private mode, quota) shouldn't block play
        }).then(function () {
          return initSession(buffer);
        });
      }).then(function () {
        postMessage({ type: 'progress', progress: 100 });
        postMessage({ type: 'status', status: 'ready' });
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
