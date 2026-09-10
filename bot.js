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


// ---------- The engine's veto ----------
// A policy net plays without looking at the position its move creates, so it
// cannot see that the piece it just moved is now hanging.
//
// Left alone that caps the whole ladder. Measured by self-play, top move
// against top move, elo_self 1900 beats elo_self 700 by only 14/16 — about
// 340 Elo, against the 1200 points the cards claim. Maia 3 conditions on
// rating by interpolating two embedding vectors across a 0-5000 clip, so the
// whole ladder sits on 24% of that line. The knob cannot stretch further.
//
// So Stockfish holds a veto, and how tight the veto is IS the ladder. The net
// still chooses; the engine only refuses. The bottom rungs get no veto at all,
// because a 900 hangs pieces and that is what 900 means. The leash shortens as
// you climb.
//
// Depth, not movetime: a rung has to be worth the same on a slow phone as on a
// fast laptop. The time may vary, the strength may not.
var SCREENS = [
  { upTo: 1000,     spec: null },
  { upTo: 1300,     spec: { topK: 3, depth: 6,  margin: 250, floor: 0.02 } },
  { upTo: 1600,     spec: { topK: 4, depth: 8,  margin: 120, floor: 0.02 } },
  { upTo: Infinity, spec: { topK: 5, depth: 10, margin: 50,  floor: 0.01 } }
];

// Anand keeps the screen he shipped with, and keeps taking the move HE liked
// most among the survivors — he is a boss, not a rung, and his best is the
// point of him.
var ANAND_SCREEN = { topK: 4, depth: 10, margin: 90, floor: 0.02, preferSampled: false };

function screenFor(o) {
  if (!o) return null;
  if (o.offLadder) return ANAND_SCREEN;
  for (var i = 0; i < SCREENS.length; i++) {
    if (o.rating <= SCREENS[i].upTo) {
      var s = SCREENS[i].spec;
      if (!s) return null;
      // A rung is the same opponent every game, so it has to keep its variety:
      // the move it actually sampled stands whenever the engine can live with it.
      return { topK: s.topK, depth: s.depth, margin: s.margin, floor: s.floor,
               preferSampled: true };
    }
  }
  return null;
}

// Resolves to a uci string: the screened pick, or `sampled` if there is no
// screen at this level or anything at all goes wrong. This must never be able
// to stop an opponent moving.
function screenMove(fen, moves, sampled, spec) {
  if (!spec) return Promise.resolve(sampled);

  var cands = moves.filter(function (m, i) {
    return i === 0 || m[1] >= spec.floor;
  }).slice(0, spec.topK);

  // The sampled move has to be judged too. Screening only the top of the
  // policy would quietly replace it every time it fell outside topK, and the
  // rung would play the same handful of moves for ever.
  var have = false;
  for (var c = 0; c < cands.length; c++) if (cands[c][0] === sampled) { have = true; break; }
  if (!have) {
    for (var k = 0; k < moves.length; k++) {
      if (moves[k][0] === sampled) { cands = cands.concat([moves[k]]); break; }
    }
  }
  if (cands.length < 2) return Promise.resolve(sampled);

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
        depth: spec.depth, multipv: 1, timeout: 6000,
        // One Stockfish serves the whole page, and setoption is sticky. The
        // calibrator's anchor plays at a limited UCI_Elo, so a veto that said
        // nothing here would quietly inherit it and screen at 1200.
        options: { 'UCI_LimitStrength': 'false' }
      }).then(function (res) {
        // pvs scores are from the side to move — which, after this move, is
        // the player. Negate to get the position from the opponent's side.
        scored.push({ uci: m[0], cp: -pvToCp(res.pvs[0]), p: m[1] });
      }, function () {});   // one failed probe just drops that candidate
    });
  });

  return chain.then(function () {
    if (!scored.length) return sampled;
    var best = scored.reduce(function (a, b) { return b.cp > a.cp ? b : a; });
    var ok = scored.filter(function (s) { return s.cp >= best.cp - spec.margin; });
    if (!ok.length) return sampled;
    // The net's own choice stands unless it was a gift.
    if (spec.preferSampled) {
      for (var i = 0; i < ok.length; i++) if (ok[i].uci === sampled) return sampled;
    }
    // Otherwise the highest-ranked survivor: the engine refuses, never picks.
    return ok.reduce(function (a, b) { return b.p > a.p ? b : a; }).uci;
  }, function () { return sampled; });
}
