/*
 * bot.js — how an opponent picks its move.
 *
 * Shared by the app (index.html) and the calibrator (calibrate.html) so that
 * the strength we measure is the strength that ships. Anything that touches
 * the DOM, the board, or persisted state stays in the page; only the decision
 * lives here.
 *
 * Expects two globals: Chess (chess.js) and SF (the Stockfish wrapper — any
 * object exposing init() and analyse(fen, opts)).
 */
'use strict';

function pvToCp(pv) {   // SF pv entry -> centipawns from the side to move
  if (!pv) return 0;
  if (pv.mate !== null && pv.mate !== undefined) return pv.mate > 0 ? 10000 : -10000;
  return pv.cp;
}


var LEVELS = [
  { name: 'The New Kid',     rating: 700 },
  { name: 'Coffee House',    rating: 800 },
  { name: 'Book Learner',    rating: 900 },
  { name: 'Tactics Grinder', rating: 1000 },
  { name: 'Weekend Warrior', rating: 1100 },
  { name: 'Club Regular',    rating: 1200 },
  { name: 'Board One',       rating: 1300 },
  { name: 'The Ringer',      rating: 1400 },
  { name: 'Prize Winner',    rating: 1600 },
  { name: 'The Champion',    rating: 1900 }
];
var MEAN_GIRL = { name: 'Anand', rating: 2700, offLadder: true, avatarKind: 'disguise' };


// ---------- Maia opponent ----------
// The net's policy is the move choice — no search (it would destroy the
// human-like play). Variety comes from temperature + nucleus (top-p)
// sampling over the policy, applied to the whole game, mirroring the
// Temperature/TopP controls of the Maia 3 UCI engine.
//
// Maia's rating calibration is a claim about its TOP move matching humans
// of that rating. Sampling the whole distribution at T=1 is a different
// thing: a move the net gave 1.5% gets played 1.5% of the time, and the
// tail is where the hung pieces live. That put the whole ladder below its
// own labels. T=0.7 with the tail cut at 0.92 keeps the human shape and
// the move-to-move variety while dropping the long tail — the same
// correction already applied to Anand, whose net is not a human model at
// all (sampling him at 1.0 produced 0.8%-probability h-pawn pushes).
var MAIA_TEMPERATURE = 0.7;   // ladder: human shape, tail damped
var ANAND_TEMPERATURE = 0.3;  // Anand: sharp; ~90% top move, tail crushed
var MAIA_TOP_P = 0.92;        // nucleus: drop the bottom 8% of policy mass

// ---------- Measured ratings ----------
// The number on a card was only ever a label typed into LEVELS — nothing
// verified that Anand plays at 2700, or that The Champion plays at 1900.
// calibrate.html plays each bot a gauntlet against Stockfish at known
// UCI_Elo and writes its findings here, keyed by name. Empty = uncalibrated,
// and every card falls back to its label.
//
// Note the asymmetry: a measured rating replaces the DISPLAYED rating and
// feeds the Elo maths, but never elo_self. elo_self is the control knob we
// ask Maia to play at — feeding a low measurement back into it would make
// the bot weaker still, one loop at a time.
var MEASURED = {
  // 'The Champion': 1642,
};

function ratingFor(o) { return (o && o.measured) || (o && o.rating) || 0; }

function applyMeasured() {
  LEVELS.concat([MEAN_GIRL]).forEach(function (o) {
    if (typeof MEASURED[o.name] === 'number') o.measured = MEASURED[o.name];
  });
}

function chooseMaiaMove(moves, temperature) {
  if (temperature <= 0) return moves[0][0];
  // Nucleus: smallest prefix of the sorted policy with mass >= MAIA_TOP_P.
  var nucleus = [];
  var mass = 0;
  for (var i = 0; i < moves.length; i++) {
    nucleus.push(moves[i]);
    mass += moves[i][1];
    if (mass >= MAIA_TOP_P) break;
  }
  // Temperature: p^(1/T), renormalised, then sample.
  var sum = 0;
  var weights = nucleus.map(function (m) {
    var w = Math.pow(m[1], 1 / temperature);
    sum += w;
    return w;
  });
  var r = Math.random() * sum;
  for (var j = 0; j < nucleus.length; j++) {
    r -= weights[j];
    if (r <= 0) return nucleus[j][0];
  }
  return nucleus[nucleus.length - 1][0];
}


// ---------- Anand's blunder filter ----------
// A policy net plays without looking at the position its move creates, so it
// cannot see that the piece it just moved is now hanging. That is fine for the
// ladder — a 1200 hangs pieces, that is what 1200 means — but it is what kept
// Anand short of the number on his card.
//
// So: take his top few policy moves, let the Stockfish already in the page
// look at each resulting position, and play the move HE liked most among those
// that don't drop material. Style survives (the ranking is still his), the
// gifts don't. A shallow depth is enough — hung pieces are a 2-ply problem.
var ANAND_FILTER_TOPK = 4;     // candidates screened, in policy order
var ANAND_FILTER_DEPTH = 10;   // plenty to see a piece hanging
var ANAND_FILTER_MARGIN = 90;  // cp worse than the best candidate, still played
var ANAND_FILTER_FLOOR = 0.02; // ignore candidates below 2% policy

// Resolves to a uci string: the filtered pick, or `fallback` if anything at
// all goes wrong. This must never be able to stop him moving.
function anandFilter(fen, moves, fallback) {
  var cands = moves.filter(function (m, i) {
    return i === 0 || m[1] >= ANAND_FILTER_FLOOR;
  }).slice(0, ANAND_FILTER_TOPK);
  if (cands.length < 2) return Promise.resolve(fallback);

  var scored = [];
  var chain = SF.init();

  cands.forEach(function (m) {
    chain = chain.then(function () {
      var g = new Chess(fen);
      var mv = g.move({
        from: m[0].slice(0, 2), to: m[0].slice(2, 4),
        promotion: m[0].length > 4 ? m[0].slice(4) : undefined
      });
      if (!mv) return;
      // Mate delivered by the candidate itself needs no engine opinion.
      if (g.in_checkmate()) { scored.push({ uci: m[0], cp: 100000, p: m[1] }); return; }
      if (g.in_draw() || g.in_stalemate()) { scored.push({ uci: m[0], cp: 0, p: m[1] }); return; }
      return SF.analyse(g.fen(), {
        depth: ANAND_FILTER_DEPTH, multipv: 1, timeout: 6000
      }).then(function (res) {
        // pvs scores are from the side to move — which, after his move, is
        // the player. Negate to get the position from Anand's side.
        scored.push({ uci: m[0], cp: -pvToCp(res.pvs[0]), p: m[1] });
      }, function () {});   // one failed probe just drops that candidate
    });
  });

  return chain.then(function () {
    if (!scored.length) return fallback;
    var best = scored.reduce(function (a, b) { return b.cp > a.cp ? b : a; });
    // Among the survivors, his own top-ranked move wins — the engine only
    // gets a veto, never the casting vote.
    var ok = scored.filter(function (s) { return s.cp >= best.cp - ANAND_FILTER_MARGIN; });
    return ok.reduce(function (a, b) { return b.p > a.p ? b : a; }).uci;
  }, function () { return fallback; });
}
