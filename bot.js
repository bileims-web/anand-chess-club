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


// ---------- The club ----------
// Ten members, and every one of them would rather attack than be correct.
// `aggression` is a tilt applied to the net's policy before it is sampled
// (see chooseBotMove); `lines` is what they say while doing it.
//
// The tilt does NOT get weaker as the ladder gets harder — the veto above
// does the sorting instead. So the same personality axis reads as "wild" at
// 700, where nothing is screened and the sacrifices are real gifts, and as
// "brilliant attacker" at 1900, where a 50cp leash means only the sound ones
// survive. One knob, two very different opponents.
var LEVELS = [
  { name: 'Mad Dog', rating: 700, aggression: 1.0, lines: {
      hello:   ['New meat. I bite first.', 'No plan. Never needed one.'],
      capture: ['That was free!', 'Mine now.'],
      check:   ['RUN!', 'Chase chase chase!'],
      gloat:   ['I smell blood.', "You're leaking pieces."],
      rattled: ['…that was my piece?', 'Wait. Wait wait wait.'],
      won:     ['Told you. Bite first.'],
      lost:    ['Fine. Rematch. Now.'] } },

  { name: 'Coffee-House Carl', rating: 800, aggression: 0.85, lines: {
      hello:   ['Two rupees says I mate you in four.', 'Sit. Watch the trap.'],
      capture: ['Old trick. Still works.', 'You walked right in.'],
      check:   ["Scholar's special!", "Knew you'd block wrong."],
      gloat:   ["Table's mine. Always was.", 'Someone get the tea.'],
      rattled: ['Who taught you that?', "That's not in my book."],
      won:     ['Four moves. Ish.'],
      lost:    ['Lucky. Set them up again.'] } },

  { name: 'Gambit Gita', rating: 900, aggression: 0.9, lines: {
      hello:   ['Take the pawn. I insist.', 'Material is a loan.'],
      capture: ['Interest payment.', 'Collecting.'],
      check:   ["That's the pawn talking.", 'Told you it was a loan.'],
      gloat:   ['Best pawn I ever spent.', 'Down a pawn, up a game.'],
      rattled: ['You actually kept it?', 'Hm. Unusual.'],
      won:     ['Cheap at the price.'],
      lost:    ['Kept the pawn AND the game. Rude.'] } },

  { name: 'Two-Move Tony', rating: 1000, aggression: 0.8, lines: {
      hello:   ["I only know one move. It's check.", "Where's your king? There it is."],
      capture: ['Was it in the way? It was in the way.', 'Cleared.'],
      check:   ['Check.', 'Check again.'],
      gloat:   ['Running out of squares.', "King's doing all the work."],
      rattled: ['No checks. I hate this.', 'Give me a check. One.'],
      won:     ['Check, check, mate.'],
      lost:    ['Ran out of checks.'] } },

  { name: 'The Sacker', rating: 1100, aggression: 0.95, lines: {
      hello:   ["Guard h7. You won't.", "Something's getting sacrificed today."],
      capture: ['Down payment.', 'One less defender.'],
      check:   ['Here it comes.', 'Open up.'],
      gloat:   ["Your king's in the open. My favourite weather.", 'Count the attackers. Now the defenders.'],
      rattled: ['It was sound. Probably.', "I'd do it again."],
      won:     ['Worth every piece.'],
      lost:    ['Unsound. Beautiful. Again?'] } },

  { name: 'Blitz Bala', rating: 1200, aggression: 0.8, lines: {
      hello:   ['Move fast. I already have.', "Clock's the real opponent."],
      capture: ['Faster than you.', 'Snap.'],
      check:   ['Tick.', "Don't think. Move."],
      gloat:   ["You're spending time you don't have.", "I'm three moves ahead and two of them are bad."],
      rattled: ['Slow down, slow down—', 'Too fast. That one was too fast.'],
      won:     ['Told you. Speed.'],
      lost:    ["Should've thought. Never again."] } },

  { name: 'The Butcher', rating: 1300, aggression: 0.75, lines: {
      hello:   ['I trade. Everything.', "Let's keep this simple. And bloody."],
      capture: ['Next.', 'On the block.'],
      check:   ['Come here.', 'Nowhere to sit.'],
      gloat:   ["Board's getting empty. Mine isn't.", 'Just us and your king now.'],
      rattled: ['Bad trade. Bad trade.', 'That one cost me.'],
      won:     ['Clean cuts.'],
      lost:    ['You traded better. Noted.'] } },

  { name: 'The Ringer', rating: 1400, aggression: 0.55, lines: {
      hello:   ['I barely play, honestly.', "Beginner's luck, I'm sure."],
      capture: ['Oh! Is that allowed?', 'Sorry, sorry.'],
      check:   ['Oh dear, is that check?', "Didn't see that. Obviously."],
      gloat:   ["Beginner's luck holding up nicely.", 'Still learning the pieces, me.'],
      rattled: ["Now you've made me try.", 'Alright. Gloves off.'],
      won:     ['Lucky again. What are the odds.'],
      lost:    ["…I'll be honest, I've played before."] } },

  { name: 'The Sniper', rating: 1600, aggression: 0.6, lines: {
      hello:   ["I'll take one weakness. You'll give me two.", "Play on. I'm patient."],
      capture: ['Noted, and taken.', 'That square was mine an hour ago.'],
      check:   ['There it is.', "One shot's enough."],
      gloat:   ["You've been lost since move nine.", "It's already over. Play it out."],
      rattled: ['Hm. Re-aiming.', 'You found the one square.'],
      won:     ['One shot.'],
      lost:    ['Missed. Happens once a year.'] } },

  { name: 'The Champion', rating: 1900, aggression: 0.7, lines: {
      hello:   ["I attack because it's quicker.", 'Ten minutes. Then I have a lesson to teach.'],
      capture: ['Thank you.', 'That was load-bearing.'],
      check:   ['Your king. Now.', "Forced, I'm afraid."],
      gloat:   ['Resign and we both save time.', "There's no defence. I checked."],
      rattled: ['Interesting. Genuinely.', 'Right. Properly, then.'],
      won:     ['As expected. Well played, though.'],
      lost:    ['That was excellent. Truly.'] } }
];

// Anand gets the lines but no tilt: his screen takes his own top-ranked
// survivor, so a tilt on the sampled move would be theatre. His personality
// is that he is better than you, and he is nice about it.
var MEAN_GIRL = { name: 'Anand', rating: 2700, offLadder: true, avatarKind: 'disguise',
  aggression: 0, engineFirst: true, lines: {
    hello:   ['Shall we?', 'Take your time. I have some.'],
    capture: ['Necessary.', 'Thank you.'],
    check:   ['Check.', 'Your king, please.'],
    gloat:   ["It's a technique now.", 'The rest plays itself.'],
    rattled: ['Ah. Good move.', "You've made me think."],
    won:     ['Good game. Really.'],
    lost:    ["You beat me. That's rare — well done."] } };

// The Old School Master plays the way the club WISHES it played: every line
// opened, every piece thrown at the king, soundness a matter for the
// post-mortem. Same machinery as Anand — the engine proposes, a net picks —
// but with the dials set the other way: a wide field (eight lines, anything
// within 150cp of best survives), a small budget so the engine cannot see
// far enough to disapprove, an aggression tilt over the survivors past the
// ladder's full scale (1.6: at 1.0 the net's own ranking still out-voted a
// sacrifice it gave 4%), the net's ranking at T=1 so the tilt gets its say,
// the pick SAMPLED from the tilted weights rather than taken, so the same
// opening does not produce the same game, and — the part that makes him old
// school rather than merely greedy — a `sacrifice` bonus per pawn of material
// a move puts on offer (materialOffered), because the aggression score alone
// rewards taking, and his first measured game was a queen grabbing b7 and
// getting mated for it.
//
// A sacrifice must have a plan behind it, and 4000 nodes over eight lines
// cannot see one. But "sound" here means sound AGAINST THE OPPONENT HE
// FACES, not against a 3000-rated engine: a sacrifice that a grandmaster
// refutes and a 2000 does not is exactly the old school's stock in trade,
// and what makes it so is that the defence takes accuracy — one exact reply,
// where the natural ones lose. So whatever he picks is VERIFIED in two
// stages (verifyPick). First the engine, on `verifyNodes`, looks at the
// opponent's best `defences` replies and counts how many leave him more
// than `verifyMargin` behind its own best from before his move. None: the
// move is simply sound and stands. Two or more: the defence is easy, and
// the move is dropped. Exactly one — an only-move defence — goes to the
// second stage: Stockfish plays the reply at UCI_Elo equal to his own
// rating (the Elo limiter does apply to bestmove, which is what this reads),
// `refuterTries` times since that pick is noisy, and the move stands if his
// equal misses the refutation more often than not. A dropped move sends him
// back to pick again from what is left, and if none of his choices survive
// he plays the engine's move. The shallow margin is how wide his imagination
// runs; the verify margin is how much an accurate defence may take back.
// Rated 2000 on the card until the gauntlet says otherwise; below Anand, off
// the ladder, never locked.
var OLD_SCHOOL = { name: 'Old School Master', rating: 2000, offLadder: true,
  avatarKind: 'initials', aggression: 1.6, sacrifice: 0.6, temp: 1.0, engineFirst: true,
  proposal: { nodes: 4000, margin: 150, multipv: 8,
              verifyNodes: 20000, verifyMargin: 100, defences: 4,
              refuterMs: 60, refuterTries: 3 },
  lines: {
    hello:   ["Material is for the endgame. We shan't reach one.", 'Castle quickly. I am coming either way.'],
    capture: ['Take it. It was in the way.', 'A piece for the initiative. The old exchange rate.'],
    check:   ['The king walks. They always walk.', 'Check. And again, if you like.'],
    gloat:   ['Morphy would have played it faster.', 'Open lines, open king. The rest is bookkeeping.'],
    rattled: ['You declined? Nobody declines.', 'Hm. The romantics never planned for that.'],
    won:     ['Beauty before correctness. Mostly beauty.'],
    lost:    ['Unsound. Gloriously unsound. Again.'] } };

// Off the ladder, in display order. The app addresses them by negative index
// (-1 is Anand, -2 the Master) so a saved game or a past-games row can find
// its opponent again.
var BOSSES = [MEAN_GIRL, OLD_SCHOOL];
function bossAt(idx) { return idx < 0 ? BOSSES[-idx - 1] || null : null; }

// How sharply a member follows its net: the ladder is human-shaped, Anand is
// crushed to his top move, and a boss may say otherwise for itself.
function botTemp(o) {
  if (o && typeof o.temp === 'number') return o.temp;
  return (o && o.offLadder) ? ANAND_TEMPERATURE : MAIA_TEMPERATURE;
}

// A random line, or '' if this opponent has nothing to say about it.
function botLine(o, kind) {
  var pool = o && o.lines && o.lines[kind];
  if (!pool || !pool.length) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}


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
  'Anand': 2746,   // 2026-09-14, ANAND_NODES 8000, 16 games/anchor vs 2200-3100
  'Old School Master': 2176,   // 2026-09-14, 4000 nodes / 150cp / verified, 16 games/anchor vs 1320-2200
};

function ratingFor(o) { return (o && o.measured) || (o && o.rating) || 0; }

function applyMeasured() {
  LEVELS.concat(BOSSES).forEach(function (o) {
    if (typeof MEASURED[o.name] === 'number') o.measured = MEASURED[o.name];
  });
}

// Nucleus: smallest prefix of the sorted policy with mass >= MAIA_TOP_P.
function nucleusOf(moves) {
  var pool = [], mass = 0;
  for (var i = 0; i < moves.length; i++) {
    pool.push(moves[i]);
    mass += moves[i][1];
    if (mass >= MAIA_TOP_P) break;
  }
  return pool;
}

function sampleWeighted(pool, weights) {
  var sum = 0;
  for (var i = 0; i < weights.length; i++) sum += weights[i];
  var r = Math.random() * sum;
  for (var j = 0; j < pool.length; j++) {
    r -= weights[j];
    if (r <= 0) return pool[j][0];
  }
  return pool[pool.length - 1][0];
}

// ---------- Style: how an opponent likes to win ----------
// The net says what a human of this rating would play. That is a distribution,
// and inside it there is nearly always both a quiet move and a sharp one. The
// tilt says which of those this member reaches for — it never adds a move the
// net didn't propose, and it works on the nucleus only, so the tail the last
// epoch cut out doesn't get a second chance at being fun.
//
// Scored in pawns, with chess.js alone: no engine, no search. Sharpness is
// cheap to recognise and expensive to verify, and verifying is the veto's job.
var PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
var AGGRESSION_K = 0.85;   // how hard a full-aggression member leans
var AGGRESSION_CLAMP = 3;  // no single move may dominate the sampling outright

function sqXY(sq) { return { x: sq.charCodeAt(0) - 97, y: parseInt(sq[1], 10) - 1 }; }

function kingXY(g, color) {
  var b = g.board();   // rank 8 first
  for (var r = 0; r < 8; r++) {
    for (var f = 0; f < 8; f++) {
      var p = b[r][f];
      if (p && p.type === 'k' && p.color === color) return { x: f, y: 7 - r };
    }
  }
  return null;
}

// `g` is the position the move CREATED; `mv` the chess.js move that made it.
function aggressionScore(g, mv, mover) {
  var s = 0;
  if (mv.captured) s += PIECE_VAL[mv.captured] * 0.35;
  if (mv.promotion) s += 1.5;
  if (g.in_check()) s += 1.2;
  var from = sqXY(mv.from), to = sqXY(mv.to);
  // Landing next to the enemy king beats landing three files away from it.
  var ek = kingXY(g, mover === 'w' ? 'b' : 'w');
  if (ek) {
    var d = Math.max(Math.abs(to.x - ek.x), Math.abs(to.y - ek.y));
    s += d <= 1 ? 0.9 : d === 2 ? 0.55 : d === 3 ? 0.25 : 0;
  }
  var fwd = mover === 'w' ? to.y - from.y : from.y - to.y;
  s += fwd * 0.12;              // forward is the direction of play
  if (fwd < 0) s -= 0.25;       // and a retreat is the opposite of the point
  return s;
}

// Material a move puts on offer: what the mover stands to lose if the piece
// it just moved is taken by the cheapest attacker and we recapture with what
// we have. Zero for a safe move; the value given away for a sacrifice. This
// is the romantic's yardstick — the aggression score above rewards TAKING
// material, and an old-school attack is about giving it. `g` is the position
// after the move, opponent to move.
function materialOffered(g, mv) {
  var moverVal = PIECE_VAL[mv.piece] || 0;
  if (!moverVal) return 0;
  var took = mv.captured ? PIECE_VAL[mv.captured] : 0;
  var replies = g.moves({ verbose: true }).filter(function (r) { return r.to === mv.to && r.captured; });
  if (!replies.length) return 0;
  var cheapest = replies.reduce(function (a, b) { return PIECE_VAL[b.piece] < PIECE_VAL[a.piece] ? b : a; });
  var g2 = new Chess(g.fen());
  g2.move(cheapest);
  var recapture = g2.moves({ verbose: true }).some(function (r) { return r.to === mv.to && r.captured; });
  return Math.max(0, moverVal - (recapture ? PIECE_VAL[cheapest.piece] : 0) - took);
}

// The move an opponent samples: policy, tail cut, then their own taste.
function chooseBotMove(fen, moves, o) {
  var temperature = botTemp(o);
  if (temperature <= 0) return moves[0][0];
  var pool = nucleusOf(moves);
  var aggression = (o && o.aggression) || 0;
  var base = pool.map(function (m) { return Math.pow(m[1], 1 / temperature); });
  if (aggression <= 0 || pool.length < 2) return sampleWeighted(pool, base);

  var g0;
  try { g0 = new Chess(fen); } catch (e) { return sampleWeighted(pool, base); }
  var mover = g0.turn();

  var scores = [], sum = 0, n = 0;
  for (var i = 0; i < pool.length; i++) {
    var uci = pool[i][0];
    var g = new Chess(fen);
    var mv = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4),
                      promotion: uci.length > 4 ? uci.slice(4) : undefined });
    if (!mv) { scores.push(null); continue; }   // shouldn't happen; no opinion
    if (g.in_checkmate()) return uci;           // nobody in this club declines mate
    var sc = aggressionScore(g, mv, mover);
    scores.push(sc); sum += sc; n++;
  }
  if (!n) return sampleWeighted(pool, base);

  // Centred, so the tilt decides between THESE moves rather than handing a
  // bonus to every move in a sharp position.
  var mean = sum / n;
  var weights = base.map(function (w, k) {
    if (scores[k] === null) return w;
    var d = Math.max(-AGGRESSION_CLAMP, Math.min(AGGRESSION_CLAMP, scores[k] - mean));
    return w * Math.exp(AGGRESSION_K * aggression * d);
  });
  return sampleWeighted(pool, weights);
}


// ---------- Anand: the engine proposes, his net picks ----------
// His net is 1.7MB and searches nothing, so asked for a move on its own it
// plays club chess with a 2700 on the card. Screening it harder cannot close
// that gap: a veto removes blunders, it does not find plans.
//
// So for him alone the arrangement is inverted. Stockfish, on a fixed node
// budget, proposes the moves, and everything within a margin of its best goes
// to his net, which plays the one HE ranks highest. The engine sets the
// standard, the net keeps the style.
//
// The budget is nodes, NOT UCI_Elo, and that is not a style choice. Stockfish's
// Elo limit weakens only the single `bestmove` it prints at the end of a
// search; the `info ... pv` lines it prints on the way are the honest,
// full-strength ranking, and those are what this reads. Asked for depth 12 at
// UCI_Elo 2700 he was getting a full-strength depth-12 list — the pv lines
// were byte-identical at UCI_Elo 1320 and 2700, only bestmove moved (found
// 2026-09-14) — and played engine chess with a 2700 on the card. A node cap
// weakens every line the same way, which is what a candidate list needs.
//
// Be careful what this claims. The pick among the candidates is his own, so
// his real strength sits a little under whatever the budget is worth. The
// margin is what that costs, which is why it is tight. What the budget IS
// worth is for calibrate.html to say. Measured 2026-09-14 (headless gauntlet,
// 16 games per anchor, anchors 2200-3100 at 50ms): 40000 nodes = 2894, 20000
// = 2894, 8000 = 2746 — so 8000, which reaches about depth 5-6 with six lines
// open. Halving from 40000 barely moved him; the last cut did.
var ANAND_NODES = 8000;   // MultiPV-6 search budget; calibrate, don't guess
var ANAND_MULTIPV = 6;
var ANAND_MARGIN = 40;    // cp behind the engine's best, still his to choose

// Anand's numbers are the default; another engine-first member brings its own.
function proposalFor(o) {
  return (o && o.proposal) ||
         { nodes: ANAND_NODES, margin: ANAND_MARGIN, multipv: ANAND_MULTIPV };
}

// Resolves to a uci string, or null if the engine could not answer — the
// caller then falls back to the net alone. Nothing may stop him moving.
// The pick among the survivors is the member's taste: policy at the member's
// temperature, tilted by its aggression — the same expression the veto's
// fallback uses (tiltWeight). With no aggression that is the policy ranking,
// which is what Anand has always taken.
function anandPick(fen, moves, o) {
  var spec = proposalFor(o);
  var taste = { aggression: (o && o.aggression) || 0, temp: botTemp(o) };
  var pOf = {};
  for (var i = 0; i < moves.length; i++) pOf[moves[i][0]] = moves[i][1];

  return SF.init().then(function () {
    return SF.analyse(fen, {
      nodes: spec.nodes, multipv: spec.multipv, timeout: 15000,
      // Explicit: the calibrator's anchor sets it true on this same engine and
      // setoption persists, so a proposal must never inherit a weakened pick.
      options: { 'UCI_LimitStrength': 'false' }
    });
  }).then(function (res) {
    // A node cap stops the search mid-iteration, so the six slots can hold
    // lines from different depths, and a move can sit in two of them (its old
    // slot from the last full iteration and its new one). Keep the deepest
    // report of each move.
    var pvs = ((res && res.pvs) || []).slice().sort(function (a, b) {
      return (b.depth || 0) - (a.depth || 0);
    });
    var cand = [], seen = {};
    for (var j = 0; j < pvs.length; j++) {
      if (!pvs[j] || !pvs[j].move || seen[pvs[j].move]) continue;
      seen[pvs[j].move] = true;
      // cp is from the side to move, which on his own move is his side —
      // no negation here, unlike the veto, which scores AFTER a move.
      cand.push({ uci: pvs[j].move, cp: pvToCp(pvs[j]) });
    }
    if (!cand.length) return null;
    var best = cand.reduce(function (a, b) { return b.cp > a.cp ? b : a; });
    var ok = cand.filter(function (c) { return c.cp >= best.cp - spec.margin; });
    if (!ok.length) return null;
    if (ok.length === 1 || !taste.aggression) {
      return ok.reduce(function (a, b) {
        return (pOf[b.uci] || 0) > (pOf[a.uci] || 0) ? b : a;
      }).uci;
    }
    // Score the survivors for sharpness and let the member's taste rank them.
    var g0;
    try { g0 = new Chess(fen); } catch (e) { g0 = null; }
    if (!g0) return ok[0].uci;
    var mover = g0.turn(), scored = [], sum = 0;
    for (var k = 0; k < ok.length; k++) {
      var g = new Chess(fen), u = ok[k].uci;
      var mv = g.move({ from: u.slice(0, 2), to: u.slice(2, 4),
                        promotion: u.length > 4 ? u.slice(4) : undefined });
      if (!mv) continue;
      if (g.in_checkmate()) return u;           // nobody in this club declines mate
      var ag = aggressionScore(g, mv, mover);
      if (o && o.sacrifice) ag += o.sacrifice * materialOffered(g, mv);
      scored.push({ uci: u, p: pOf[u] || 0, ag: ag }); sum += ag;
    }
    if (!scored.length) return ok[0].uci;
    var mean = sum / scored.length;
    // Sampled, not taken: a member with taste should not replay the same
    // game every time the opening repeats.
    var pick = function (pool) {
      return sampleWeighted(
        pool.map(function (s) { return [s.uci, s.p]; }),
        pool.map(function (s) { return tiltWeight(s, mean, taste); }));
    };
    if (!spec.verifyNodes) return pick(scored);
    return verifyPick(fen, scored, pick, spec, ratingFor(o));
  }, function () { return null; });
}

// The practical test. Resolves to a uci string: the first sampled pick whose
// defence is either unnecessary, or an only-move that an equal-rated
// opponent tends to miss (see OLD_SCHOOL); failing that, the engine's best.
// `rating` is the strength the refuter plays at.
function applyUci(g, u) {
  return g.move({ from: u.slice(0, 2), to: u.slice(2, 4),
                  promotion: u.length > 4 ? u.slice(4) : undefined });
}

function verifyPick(fen, pool, pick, spec, rating) {
  var deep = { nodes: spec.verifyNodes, multipv: 1, timeout: 15000,
               options: { 'UCI_LimitStrength': 'false' } };
  var refuter = { movetime: spec.refuterMs || 60, multipv: 1, timeout: 15000,
                  options: { 'UCI_LimitStrength': 'true', 'UCI_Elo': String(rating) } };
  var tries = spec.refuterTries || 3;
  var need = Math.floor(tries / 2) + 1;    // a majority of the replies must fail to refute

  return SF.analyse(fen, deep).then(function (root) {
    var bestMove = root && root.pvs && root.pvs[0] && root.pvs[0].move;
    var bestCp = root && root.pvs && root.pvs[0] ? pvToCp(root.pvs[0]) : null;
    if (bestCp === null) return pick(pool);

    // Does `u` hold against one equal-rated reply? Resolves true/false.
    function holdsOnce(child) {
      return SF.analyse(child, refuter).then(function (rep) {
        var g = new Chess(child);
        if (!rep || !rep.bestmove || rep.bestmove === '(none)' || !applyUci(g, rep.bestmove)) {
          return true;                    // no reply at all: nothing to refute with
        }
        if (g.in_checkmate()) return false;   // his equal just mated him
        return SF.analyse(g.fen(), deep).then(function (res) {
          // his move again: the score is already from his side
          var cp = res && res.pvs && res.pvs[0] ? pvToCp(res.pvs[0]) : null;
          return cp === null || cp >= bestCp - spec.verifyMargin;
        });
      });
    }

    function holds(child) {
      var yes = 0, no = 0;
      function next() {
        if (yes >= need) return Promise.resolve(true);
        if (no > tries - need) return Promise.resolve(false);
        return holdsOnce(child).then(function (ok) { if (ok) yes++; else no++; return next(); });
      }
      return next();
    }

    // Stage one: how many of the opponent's best replies refute `u`?
    // Reply scores are the opponent's, negated back to his side.
    function refutations(child) {
      var wide = { nodes: spec.verifyNodes, multipv: spec.defences || 4, timeout: 15000,
                   options: { 'UCI_LimitStrength': 'false' } };
      return SF.analyse(child, wide).then(function (res) {
        var pvs = (res && res.pvs) || [], n = 0;
        for (var i = 0; i < pvs.length; i++) {
          if (pvs[i] && -pvToCp(pvs[i]) < bestCp - spec.verifyMargin) n++;
        }
        return n;
      });
    }

    var left = pool.slice();
    function attempt(n) {
      if (!left.length || n <= 0) return Promise.resolve(bestMove || pick(pool));
      var u = pick(left);
      if (u === bestMove) return Promise.resolve(u);   // the engine's own choice needs no check
      var g = new Chess(fen);
      if (!applyUci(g, u)) return Promise.resolve(bestMove || pick(pool));
      if (g.in_checkmate()) return Promise.resolve(u);
      var child = g.fen();
      return refutations(child).then(function (count) {
        if (count === 0) return true;            // sound outright
        if (count > 1) return false;             // easy to defend: no plan there
        return holds(child);                     // only-move defence: would his equal find it?
      }).then(function (ok) {
        if (ok) return u;
        left = left.filter(function (s) { return s.uci !== u; });
        return attempt(n - 1);
      }, function () { return u; });   // a failed probe lets the pick stand
    }
    return attempt(3);
  }, function () { return pick(pool); });
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

// A boss only reaches the screen when the engine could not propose. Anand
// keeps the screen he shipped with and takes the move HE liked most among the
// survivors; another boss brings its own taste to the same screen.
var BOSS_SCREEN = { topK: 4, depth: 10, margin: 90, floor: 0.02 };
function bossScreen(o) {
  return { topK: BOSS_SCREEN.topK, depth: BOSS_SCREEN.depth, margin: BOSS_SCREEN.margin,
           floor: BOSS_SCREEN.floor, aggression: (o && o.aggression) || 0,
           temp: botTemp(o), preferSampled: false };
}

// Keyed to o.rating, the label on the card, NOT ratingFor(o). A measured
// rating describes what a rung turned out to be worth; the label defines
// which rung it is, and the screen is part of that definition. Feeding a
// measurement back in here would move the rung every time we measured it.
function screenFor(o) {
  if (!o) return null;
  if (o.offLadder) return bossScreen(o);
  for (var i = 0; i < SCREENS.length; i++) {
    if (o.rating <= SCREENS[i].upTo) {
      var s = SCREENS[i].spec;
      if (!s) return null;
      // A rung is the same opponent every game, so it has to keep its variety:
      // the move it actually sampled stands whenever the engine can live with it.
      return { topK: s.topK, depth: s.depth, margin: s.margin, floor: s.floor,
               aggression: o.aggression || 0, temp: MAIA_TEMPERATURE,
               preferSampled: true };
    }
  }
  return null;
}

// One survivor's weight under this member's taste — the same expression
// chooseBotMove samples from, so the fallback and the sampler agree about
// what sharp means. With no aggression it is the policy ranking, which is
// what Anand has always taken.
function tiltWeight(s, mean, spec) {
  var w = Math.pow(s.p, 1 / spec.temp);
  if (!spec.aggression) return w;
  var d = Math.max(-AGGRESSION_CLAMP, Math.min(AGGRESSION_CLAMP, s.ag - mean));
  return w * Math.exp(AGGRESSION_K * spec.aggression * d);
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

  var mover = new Chess(fen).turn();
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
      // Scored for sharpness here, where the position it creates is already
      // built, so the fallback below can rank on the member's own taste.
      var ag = spec.aggression ? aggressionScore(g, mv, mover) : 0;
      // Mate delivered by the candidate itself needs no engine opinion.
      if (g.in_checkmate()) { scored.push({ uci: m[0], cp: 100000, p: m[1], ag: ag }); return; }
      if (g.in_draw() || g.in_stalemate()) { scored.push({ uci: m[0], cp: 0, p: m[1], ag: ag }); return; }
      return SF.analyse(g.fen(), {
        depth: spec.depth, multipv: 1, timeout: 6000,
        // One Stockfish serves the whole page, and setoption is sticky. The
        // calibrator's anchor plays at a limited UCI_Elo, so a veto that said
        // nothing here would quietly inherit it and screen at 1200.
        options: { 'UCI_LimitStrength': 'false' }
      }).then(function (res) {
        // pvs scores are from the side to move — which, after this move, is
        // the player. Negate to get the position from the opponent's side.
        scored.push({ uci: m[0], cp: -pvToCp(res.pvs[0]), p: m[1], ag: ag });
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
    // Otherwise the sharpest survivor this member would have wanted. Ranking
    // by policy alone would hand back the most HUMAN move every time the veto
    // fired — and the leash is tightest at the top, so the member's taste
    // would disappear exactly where it is most of the point. The engine still
    // only refuses: it chooses among moves the net proposed and it approved.
    var sum = 0;
    for (var j = 0; j < ok.length; j++) sum += ok[j].ag;
    var mean = sum / ok.length;
    return ok.reduce(function (a, b) {
      return tiltWeight(b, mean, spec) > tiltWeight(a, mean, spec) ? b : a;
    }).uci;
  }, function () { return sampled; });
}


// ---------- One way in ----------
// The app and the calibrator must choose moves through the same door, or the
// strength we measure stops being the strength that ships. They drifted once
// already: a rename left both pages calling a function that no longer existed.
// Resolves to a uci string, always.
function decideMove(fen, moves, o) {
  if (o && o.engineFirst) {
    return anandPick(fen, moves, o).then(function (uci) {
      if (uci) return uci;
      // the engine could not answer — his net alone, screened as before
      return screenMove(fen, moves, chooseBotMove(fen, moves, o), screenFor(o));
    });
  }
  return screenMove(fen, moves, chooseBotMove(fen, moves, o), screenFor(o));
}
