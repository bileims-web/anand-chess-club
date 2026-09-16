/*
 * bot.js — how an opponent picks its move.
 *
 * Shared by the app (index.html) and the calibrator (calibrate.html) so that
 * the strength we measure is the strength that ships. Anything that touches
 * the DOM, the board, or persisted state stays in the page; only the decision
 * lives here.
 *
 * Expects three globals: Chess (chess.js), SF (the Stockfish wrapper — any
 * object exposing init() and analyse(fen, opts)) and PAT (the Patricia
 * wrapper: init() and play(fen, opts)).
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

// The Old Man is what the Master would be if he had never learned to check
// his own work. Same machinery again, a third set of dials, and three things
// of his own.
//
// He is WEAK ON PURPOSE. The card says 1500 because a sacrifice you cannot
// refute is a lecture, not a game: the whole point of him is that the piece
// he throws at your king is usually one you may keep, if you find the moves.
// Measured 1560 (2026-09-15) — and what makes him that is NOT the node budget.
// Doubling it from 1200 to 2400 was worth 44 Elo, where the Master's rule of
// thumb says a doubling is worth a class; a member who deliberately plays a
// move the engine rates 250cp below best is not limited by how far the engine
// saw. The MARGIN is his strength knob: 250 to 150 moved him 121 points. So
// his ordinary moves are held to the Master's own 150cp, and everything he
// gets wrong, he gets wrong on purpose, below.
//
// 1. TWO margins. Anything within `margin` of the engine's best is his to
//    choose, as for the Master. But a move that offers material AT THE KING
//    survives out to `kingMargin`, nearly four times as far — the engine may
//    disapprove all it likes of Bxh7+, and he plays it anyway. That second
//    margin IS the madness, and it is bounded: beyond it even he can see it.
//    Widening the FIRST margin looks like more of the same and is not: at 250
//    he threw material 15% of the time instead of 11%, but in smaller pieces,
//    checked half as often (10% against 17%) and lost 121 Elo. Ordinary error
//    is not style. Leave `margin` alone and move `kingMargin` if he ever needs
//    to be madder.
// 2. The sacrifice bonus is KINGWARD (sacKingward). materialOffered alone
//    rewards giving a piece away anywhere on the board, which is not romance,
//    it is a blunder with a story attached; multiplied by kingwardFactor it
//    rewards giving it away on the king's doorstep and nowhere else.
// 3. A BOOK. He opens the way he plays: gambits, both colours, the engine
//    never consulted while a line of it lasts (see SAC_BOOK_LINES).
//
// No verification. The Master's two-stage test asks whether a sacrifice is
// sound against an equal, and every answer it gives makes him stronger and
// tamer — 2000 to 2176 when it landed. The Old Man is the other end of that
// trade: nothing of his is checked, so about half of what he plays should not
// work, and finding out which half is the game. Never locked, never on the
// ladder, and he does not resign or take a draw — at his age the swindle is
// the last thing to go.
var OLD_MAN = { name: 'Old Man', rating: 1500, offLadder: true,
  avatarKind: 'initials', aggression: 1.6, sacrifice: 1.6, sacKingward: true,
  temp: 1.0, engineFirst: true, book: true, neverResigns: true, neverDraws: true,
  proposal: { nodes: 2400, margin: 150, kingMargin: 550, multipv: 10 },
  lines: {
    hello:   ['Sit, child. Sixty years of bad ideas, and I remember every one.',
              'I stopped counting material in 1971. Never missed it.',
              'Castle if you like. I am coming to that side anyway.'],
    capture: ['Take it. Take the other one as well.',
              'It was standing in front of my attack.',
              'Pieces are for giving. The endgame is for accountants.'],
    check:   ['Out of the house, little king. Walk.',
              'Check. There is more of this.',
              'Your king has seen the board. Now he sees the middle of it.'],
    gloat:   ['I have nothing left but the attack. It has always been enough.',
              'Count my pieces. Now count your king\u2019s squares.',
              'Morphy did this to a Duke. At the opera. Between arias.'],
    rattled: ['You gave it back? Nobody gives it back.',
              'Defended. How very modern of you.',
              'My hands shake. My sacrifices do not.'],
    won:     ['Mate. Now let us set it up again and look at the pretty part.',
              'Unsound, probably. Beautiful, certainly.'],
    lost:    ['Bah. One piece too many. Set them up.',
              'I would play it again tomorrow. And the day after that.'] } };

// ---------- The Patricia three ----------
// Three members who are not a net and a screen at all, but a second engine.
// Patricia (github.com/Adam-Kulju/Patricia, MIT) is built to attack — its
// evaluation is trained to prefer the sacrifice, and at full strength it is
// a 3500 that plays like Tal — and it carries its own way of being weaker:
// `Skill_Level` 1-20 maps to an Elo table (4 = 1200, 10 = 1800, 17 = 2500,
// 21 = full strength). Below 21 it runs a five-line search and then spends an
// accumulating centipawn budget on deliberately worse moves, reaching for a
// sacrifice whenever one is within reach. So for these three the weakened
// `bestmove` is exactly the move we want, and `patriciaMove` plays it as it
// comes. No net, no candidate list, no margins, no book: the whole
// personality is in the engine, and the dial is the level.
//
// The budget is NODES, not time, for the same reason the ladder's screens are
// depth and Anand's proposal is nodes: a member has to be worth the same on a
// phone as on the calibrator. The levels were calibrated by Patricia's author
// at real time controls, so with a node cap under them the card is a label
// until the gauntlet says otherwise — move `nodes` first if one lands far
// off, then the level.
//
// The mistake budget accrues across a game and resets on a new one; the
// worker infers a new game from the fen (see patricia.worker.js).
var CHESS_PRODIGY = { name: 'Chess Prodigy', rating: 1200, offLadder: true,
  avatarKind: 'initials', aggression: 0, engineFirst: false,
  patricia: { skill: 4, nodes: 8000 },
  lines: {
    hello:   ["I'm nine. I've beaten my dad, my coach, and my coach's dad.",
              'Mum says I have to be done by bedtime. That is plenty.',
              'Do you know the Fried Liver? You will.'],
    capture: ['Free piece! Coach says never say no.',
              'Mine. Was that yours? Mine now.'],
    check:   ['Check! I love saying it.',
              'Check. Again. This never gets old.'],
    gloat:   ['I saw this in a puzzle book. Page forty.',
              "You're doing the face grown-ups do."],
    rattled: ["That's not what the book said you'd play.",
              'Wait. Wait. Let me think. Don\u2019t look.'],
    won:     ['Told you. Nine years old.'],
    lost:    ['I let you win. Also: rematch. Now.'] } };

var GRAND_OLD_MAN = { name: 'Grand Old Man', rating: 1800, offLadder: true,
  avatarKind: 'initials', aggression: 0, engineFirst: false,
  patricia: { skill: 10, nodes: 20000 },
  lines: {
    hello:   ['I have played this game since before your grandfather was born, and I have never once defended.',
              'Sit. The pieces go forward. Everything else is commentary.',
              'They call me the Grand Old Man. The grand part is the chess.'],
    capture: ['Taken. It was offered, and I am not a man to refuse a gift.',
              'One less thing between me and your king.'],
    check:   ['Check. Your king and I are about to become well acquainted.',
              'Check. Do not run. It is undignified, and it will not help.'],
    gloat:   ['This is how the game was played when it was still a game.',
              'Anderssen would have found it faster. Anderssen was a better man.'],
    rattled: ['Hm. That is the modern way, I suppose.',
              'You defend well. Nobody defended in my day. It was considered rude.'],
    won:     ['The attack was always sound. It merely took a hundred years to prove.'],
    lost:    ['Unsound, then. I shall play it again tomorrow, correctly.'] } };

var MR_X = { name: 'Mr.X', rating: 2500, offLadder: true,
  avatarKind: 'initials', aggression: 0, engineFirst: false,
  patricia: { skill: 17, nodes: 60000 },
  lines: {
    hello:   ['No name. No rating. No mercy.',
              'You will not find my games anywhere. You will remember this one.'],
    capture: ['Taken.', 'You did not need that.'],
    check:   ['Check.', 'Check. Keep walking.'],
    gloat:   ['Some in the club say I am a grandmaster in disguise. Some say worse.',
              'This position has one exit. I am standing in it.'],
    rattled: ['Interesting. Nobody told you to play that.', '\u2026Noted.'],
    won:     ['Nobody saw that coming. Nobody ever does.'],
    lost:    ['This game never happened. Understood?'] } };

// Off the ladder, in display order. The app addresses them by negative index
// (-1 is Anand, -2 the Master, -3 the Old Man, -4 the Prodigy, -5 the Grand
// Old Man, -6 Mr.X) so a saved game or a past-games row can find its opponent
// again. Append only: those indices are stored.
var BOSSES = [MEAN_GIRL, OLD_SCHOOL, OLD_MAN, CHESS_PRODIGY, GRAND_OLD_MAN, MR_X];
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
  'Old Man': 1560,   // 2026-09-15, 2400 nodes / 150cp + 550cp kingward, 16 games/anchor vs 1320-2200
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

// How much of a sacrifice is aimed at the king. materialOffered says what a
// move gives away; this says whether it gives it away anywhere that matters.
// A bishop thrown at h7 and a bishop left hanging on b5 cost the same and are
// not the same move: the first is the old school, the second is a blunder with
// a story attached. Chebyshev distance from the square the piece lands on to
// the enemy king, and a check counts as having landed on him.
//
// Only members with `sacKingward` are scored this way. The Master is not: he
// has a verification stage to throw out the pointless ones, and this would be
// a second opinion on the same question.
function kingwardFactor(g, mv, mover) {
  if (g.in_check()) return 1;
  var ek = kingXY(g, mover === 'w' ? 'b' : 'w');
  if (!ek) return 0;
  var to = sqXY(mv.to);
  var d = Math.max(Math.abs(to.x - ek.x), Math.abs(to.y - ek.y));
  return d <= 1 ? 1 : d === 2 ? 0.7 : d === 3 ? 0.3 : 0;
}

// What a member's taste makes of one move: the aggression score, plus the
// material it puts on offer if giving material is part of who they are.
function tasteScore(g, mv, mover, o) {
  var s = aggressionScore(g, mv, mover);
  if (o && o.sacrifice) {
    var off = materialOffered(g, mv);
    if (off && o.sacKingward) off *= kingwardFactor(g, mv, mover);
    s += o.sacrifice * off;
  }
  return s;
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
    // A second, wider margin for one kind of move only: the piece thrown at
    // the king. The engine will not propose Bxh7+ inside a normal margin —
    // it can count, and it has just counted a bishop — so a member who is
    // meant to play it anyway needs the candidate kept alive past the point
    // where the engine has written it off. `kingMargin` is how far past, and
    // it is still a bound: beyond it the move is losing by an amount even he
    // can see. Members without one (Anand, the Master) never reach this.
    if (spec.kingMargin > spec.margin) {
      var m0 = new Chess(fen).turn();
      for (var w = 0; w < cand.length; w++) {
        var c = cand[w];
        if (c.cp >= best.cp - spec.margin) continue;       // already his
        if (c.cp < best.cp - spec.kingMargin) continue;    // past even his imagination
        var gw = new Chess(fen), mw = applyUci(gw, c.uci);
        if (!mw) continue;
        // At least a pawn's worth of material, discounted by how far from the
        // king it lands: a rook dropped on a1 does not qualify, a pawn on g6
        // next to the king does.
        if (materialOffered(gw, mw) * kingwardFactor(gw, mw, m0) >= 1) ok.push(c);
      }
    }
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
      var ag = tasteScore(g, mv, mover, o);
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


// ---------- Patricia: the engine is the member ----------
// Resolves to a uci string, or null if Patricia could not answer — the caller
// then falls back to the net and the boss screen, so nothing can stop a
// member moving. The move is checked for legality here because it is going
// straight onto the board: a second engine is a second parser.
function patriciaMove(fen, o) {
  var spec = (o && o.patricia) || {};
  return PAT.init().then(function () {
    return PAT.play(fen, { skill: spec.skill, nodes: spec.nodes, timeout: 30000 });
  }).then(function (res) {
    var u = res && res.bestmove;
    if (!u || u === '(none)' || u === '0000') return null;
    try { return applyUci(new Chess(fen), u) ? u : null; } catch (e) { return null; }
  }, function (err) {
    // Say so: the fallback plays a perfectly reasonable game, which is how a
    // dead engine measured 2010 on the gauntlet before anyone noticed.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('patricia: ' + (err && err.message || err) + ' — falling back to the net');
    }
    return null;
  });
}


// ---------- The Old Man's book ----------
// Every other member of the club starts thinking on move one, and it shows:
// a net asked for an opening plays whatever club players play, and an engine
// on a small budget plays whatever is safe. Neither of them will ever, on its
// own, play 2.f4. So the one member whose whole character is the gambit gets
// told the gambits.
//
// Written as lines of SAN, the way they are written in a book, and compiled
// on first use into a map from position to move (compileBook). Keying on the
// POSITION rather than the move order means transpositions come free: 1.Nf3
// d5 2.d4 and 1.d4 d5 2.Nf3 are the same key, and the book answers both.
//
// `side` says which half of the line is his. Many of these are 'wb' on
// purpose — he plays the Muzio, and he also ACCEPTS the Muzio; a gambit
// declined is an insult on both sides of the board. Where the defence is
// merely correct rather than fun, the line is 'w' or 'b' alone.
//
// `weight` is how often he reaches for it when several lines leave the same
// position, sampled, so the same opening does not give the same game. Weights
// are combined as a MAXIMUM, never a sum: three separate King's Gambit lines
// must not out-vote the Danish at move two just because they were written out
// in more detail.
//
// The book is his ONLY exemption from the engine. While a line lasts he plays
// it whatever Stockfish thinks, which is the point — the engine does not
// approve of the Latvian either.
var SAC_BOOK_LINES = [
  // --- White: 1.e4, and a pawn at the first opportunity ---
  { name: 'Muzio Gambit',            side: 'wb', weight: 3,
    line: 'e4 e5 f4 exf4 Nf3 g5 Bc4 g4 O-O gxf3 Qxf3 Qf6 e5 Qxe5 Bxf7+ Kxf7 d4 Qxd4+ Be3 Qf6 Bxf4' },
  { name: 'Allgaier Gambit',         side: 'w',  weight: 1,
    line: 'e4 e5 f4 exf4 Nf3 g5 h4 g4 Ng5 h6 Nxf7 Kxf7 d4' },
  { name: 'Kieseritzky, accepted',   side: 'b',  weight: 3,
    line: 'e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5 Nf6 Bc4 d5 exd5 Bd6' },
  { name: "King's Gambit, modern defence", side: 'w', weight: 1,
    line: 'e4 e5 f4 exf4 Nf3 d5 exd5 Nf6 Bb5+ c6 dxc6 Nxc6 d4' },
  { name: "King's Gambit declined",  side: 'w',  weight: 1,
    line: 'e4 e5 f4 Bc5 Nf3 d6 Nc3 Nf6 Bc4 Nc6 d3' },
  { name: 'Falkbeer Counter-Gambit', side: 'w',  weight: 1,
    line: 'e4 e5 f4 d5 exd5 e4 d3 Nf6 dxe4 Nxe4 Nf3 Bc5 Qe2' },
  { name: 'Danish Gambit',           side: 'wb', weight: 2,
    line: 'e4 e5 d4 exd4 c3 dxc3 Bc4 cxb2 Bxb2' },
  { name: 'Goring Gambit',           side: 'wb', weight: 2,
    line: 'e4 e5 Nf3 Nc6 d4 exd4 c3 dxc3 Bc4 cxb2 Bxb2' },
  { name: 'Scotch Gambit',           side: 'wb', weight: 1,
    line: 'e4 e5 Nf3 Nc6 d4 exd4 Bc4 Bc5 c3 dxc3 Nxc3' },
  { name: 'Evans Gambit',            side: 'wb', weight: 3,
    line: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O d6 cxd4 Bb6 Nc3' },
  { name: 'Evans Gambit, 5...Bc5',   side: 'w',  weight: 1,
    line: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Bc5 d4 exd4 O-O' },
  { name: 'Evans Gambit declined',   side: 'w',  weight: 1,
    line: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bb6 b5 Na5 Nxe5' },
  { name: 'Fried Liver Attack',      side: 'w',  weight: 3,
    line: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5 Nxf7 Kxf7 Qf3+ Ke6 Nc3' },
  { name: 'Two Knights, 5...Na5',    side: 'w',  weight: 3,
    line: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6 Qf3' },
  { name: 'Traxler Counter-Attack',  side: 'wb', weight: 3,
    line: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 Bc5 Nxf7 Bxf2+ Kxf2 Nxe4+ Kg1 Qh4 g3 Nxg3 hxg3 Qxg3+ Kf1 Rf8' },
  { name: 'Schliemann Defence',      side: 'b',  weight: 3,
    line: 'e4 e5 Nf3 Nc6 Bb5 f5 Nc3 fxe4 Nxe4 d5 Nxe5 dxe4 Nxc6 Qg5' },
  { name: 'Schliemann, 4.d3',        side: 'b',  weight: 2,
    line: 'e4 e5 Nf3 Nc6 Bb5 f5 d3 fxe4 dxe4 Nf6' },
  { name: 'Schliemann, 4.Bxc6',      side: 'b',  weight: 2,
    line: 'e4 e5 Nf3 Nc6 Bb5 f5 Bxc6 dxc6 Nxe5 Qd4' },
  { name: 'Rubinstein Counter-Gambit', side: 'b', weight: 2,
    line: 'e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Nd4 Nxe5 Qe7 Nf3 Nxb5 Nxb5 Qxe4+' },
  { name: 'Wayward Queen, punished', side: 'b',  weight: 2,
    line: 'e4 e5 Qh5 Nc6 Bc4 g6 Qf3 Nf6' },
  { name: 'Traxler, 5.Bxf7+',        side: 'b',  weight: 2,
    line: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 Bc5 Bxf7+ Ke7 Bb3 Rf8 O-O d6' },
  { name: "King's Gambit, 2...Nc6",  side: 'w',  weight: 1,
    line: 'e4 e5 f4 Nc6 Nf3 exf4 d4 g5 h4' },
  { name: "King's Gambit, 2...d6",   side: 'w',  weight: 1,
    line: 'e4 e5 f4 d6 Nf3 exf4 d4 g5 h4' },
  { name: "King's Gambit, 2...Nf6",  side: 'w',  weight: 1,
    line: 'e4 e5 f4 Nf6 fxe5 Nxe4 Nf3 d5 d3' },
  { name: 'Smith-Morra Gambit',      side: 'w',  weight: 3,
    line: 'e4 c5 d4 cxd4 c3 dxc3 Nxc3 Nc6 Nf3 d6 Bc4 e6 O-O Nf6 Qe2 Be7 Rd1' },
  { name: 'Morra, 3...Nf6',          side: 'w',  weight: 1,
    line: 'e4 c5 d4 cxd4 c3 Nf6 e5 Nd5 cxd4 d6 Nf3' },
  { name: 'Morra declined, 3...d3',  side: 'w',  weight: 1,
    line: 'e4 c5 d4 cxd4 c3 d3 Bxd3 Nc6 Nf3 d6 O-O' },
  { name: 'Morra declined, 3...d5',  side: 'w',  weight: 1,
    line: 'e4 c5 d4 cxd4 c3 d5 exd5 Qxd5 cxd4 Nc6 Nf3' },
  { name: 'Milner-Barry Gambit',     side: 'w',  weight: 3,
    line: 'e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 Bd3 cxd4 cxd4 Bd7 O-O Nxd4 Nxd4 Qxd4 Nc3' },
  { name: 'French Advance, 3...Nc6', side: 'w',  weight: 2,
    line: 'e4 e6 d4 d5 e5 Nc6 Nf3 Nge7 c3 Nf5 Bd3' },
  { name: 'French Advance, 3...b6',  side: 'w',  weight: 2,
    line: 'e4 e6 d4 d5 e5 b6 c3 Qd7 Nf3 Ba6 Bxa6 Nxa6' },
  { name: 'Caro-Kann, Fantasy',      side: 'w',  weight: 3,
    line: 'e4 c6 d4 d5 f3 dxe4 fxe4 e5 Nf3 exd4 Bc4 Bb4+ c3 dxc3 O-O' },
  { name: 'Pirc, Austrian Attack',   side: 'w',  weight: 2,
    line: 'e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3 O-O Bd3 Nc6 e5' },
  { name: 'Modern, Austrian Attack', side: 'w',  weight: 2,
    line: 'e4 g6 d4 Bg7 Nc3 d6 f4 Nf6 Nf3 O-O Bd3' },
  { name: 'Alekhine, Four Pawns',    side: 'w',  weight: 2,
    line: 'e4 Nf6 e5 Nd5 d4 d6 c4 Nb6 f4 dxe5 fxe5 Nc6 Be3 Bf5 Nc3' },
  { name: 'Scandinavian, 7.g4',      side: 'w',  weight: 2,
    line: 'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 Bg4 h3 Bh5 g4 Bg6 Ne5' },
  { name: 'Scandinavian, transposed', side: 'w', weight: 2,
    line: 'e4 d5 exd5 Nf6 d4 Qxd5 Nc3' },
  { name: 'Scandinavian, 2...Nf6',   side: 'w',  weight: 1,
    line: 'e4 d5 exd5 Nf6 d4 Nxd5 c4 Nb6 Nc3 g6 Be3' },
  { name: 'Nimzowitsch Defence',     side: 'w',  weight: 1,
    line: 'e4 Nc6 d4 d5 Nc3 dxe4 d5' },

  // --- Black: 1...e5 against everything, and a counter-gambit if allowed ---
  { name: 'Latvian Gambit',          side: 'b',  weight: 3,
    line: 'e4 e5 Nf3 f5 Nxe5 Qf6 d4 d6 Nc4 fxe4 Nc3 Qg6' },
  { name: 'Latvian, 3.Bc4',          side: 'b',  weight: 2,
    line: 'e4 e5 Nf3 f5 Bc4 fxe4 Nxe5 Qg5 Nf7 Qxg2 Rf1 d5 Nxh8 Nf6' },
  { name: 'Latvian, 3.exf5',         side: 'b',  weight: 2,
    line: 'e4 e5 Nf3 f5 exf5 e4 Ne5 Nf6' },
  { name: 'Elephant Gambit',         side: 'b',  weight: 1,
    line: 'e4 e5 Nf3 d5 exd5 e4 Qe2 Nf6' },
  { name: 'Scotch, 4...Qh4',         side: 'b',  weight: 2,
    line: 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Qh4' },
  { name: 'Vienna Gambit, accepted', side: 'b',  weight: 2,
    line: 'e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Nf3 Bg4' },
  { name: "Bishop's Opening, 3...Nxe4", side: 'b', weight: 2,
    line: 'e4 e5 Bc4 Nf6 Nf3 Nxe4' },
  { name: 'Centre Game',             side: 'b',  weight: 2,
    line: 'e4 e5 d4 exd4 Qxd4 Nc6 Qe3 Nf6 Nc3 Bb4' },
  { name: 'Budapest Gambit',         side: 'b',  weight: 3,
    line: 'd4 Nf6 c4 e5 dxe5 Ng4 Bf4 Nc6 Nf3 Bb4+ Nbd2 Qe7 a3 Ngxe5' },
  { name: 'Budapest, 4.Nf3',         side: 'b',  weight: 2,
    line: 'd4 Nf6 c4 e5 dxe5 Ng4 Nf3 Bc5 e3 Nc6 Be2 Ngxe5' },
  { name: 'Fajarowicz Gambit',       side: 'b',  weight: 1,
    line: 'd4 Nf6 c4 e5 dxe5 Ne4' },
  { name: 'Benko Gambit',            side: 'b',  weight: 2,
    line: 'd4 Nf6 c4 c5 d5 b5 cxb5 a6 bxa6 Bxa6 Nc3 d6 e4 Bxf1 Kxf1 g6' },
  { name: 'Blumenfeld Gambit',       side: 'b',  weight: 1,
    line: 'd4 Nf6 c4 e6 Nf3 c5 d5 b5' },
  { name: 'Albin Counter-Gambit',    side: 'b',  weight: 2,
    line: 'd4 d5 c4 e5 dxe5 d4 Nf3 Nc6 g3 Be6 Bg2 Qd7' },
  { name: 'Lasker Trap',             side: 'b',  weight: 2,
    line: 'd4 d5 c4 e5 dxe5 d4 e3 Bb4+ Bd2 dxe3 Bxb4 exf2+ Ke2 fxg1=N+' },
  { name: 'Benko without c4',        side: 'b',  weight: 1,
    line: 'd4 Nf6 Nf3 c5 d5 b5' },
  { name: 'Trompowsky, 2...Ne4',     side: 'b',  weight: 1,
    line: 'd4 Nf6 Bg5 Ne4 Bf4 c5' },
  { name: 'Bellon Gambit',           side: 'b',  weight: 2,
    line: 'c4 e5 Nc3 Nf6 Nf3 e4 Ng5 b5' },
  { name: 'English, 1...e5',         side: 'b',  weight: 1,
    line: 'c4 e5 Nc3 Nf6 g3 Bb4' },
  { name: "From's Gambit",           side: 'b',  weight: 3,
    line: 'f4 e5 fxe5 d6 exd6 Bxd6 Nf3 g5 d4 g4 Ne5 Bxe5 dxe5 Qxd1+ Kxd1 Nc6' },
  { name: "From's Gambit, 5.g3",     side: 'b',  weight: 2,
    line: 'f4 e5 fxe5 d6 exd6 Bxd6 Nf3 g5 g3 g4 Nh4 Ne7' },
  { name: 'Sokolsky, 1...e5',        side: 'b',  weight: 2,
    line: 'b4 e5 Bb2 Bxb4' },
  { name: 'Reti, 2...d4',            side: 'b',  weight: 1,
    line: 'Nf3 d5 c4 d4 e3 Nc6 exd4 Nxd4' },
  { name: 'Anything else, 1...e5',   side: 'b',  weight: 1, line: 'b3 e5' },
  { name: 'Anything else, 1...e5',   side: 'b',  weight: 1, line: 'g3 e5' },
  { name: 'Anything else, 1...e5',   side: 'b',  weight: 1, line: 'e3 e5' },
  { name: 'Anything else, 1...e5',   side: 'b',  weight: 1, line: 'd3 e5' },
  { name: 'Anything else, 1...e5',   side: 'b',  weight: 1, line: 'c3 e5' },
  { name: 'Anything else, 1...e5',   side: 'b',  weight: 1, line: 'Nc3 e5' },
  { name: 'Anything else, 1...e5',   side: 'b',  weight: 1, line: 'a3 e5' },
  { name: 'Anything else, 1...e5',   side: 'b',  weight: 1, line: 'h3 e5' },
  { name: 'Grob, 1...e5',            side: 'b',  weight: 1, line: 'g4 e5' },
  { name: 'Desprez, 1...e5',         side: 'b',  weight: 1, line: 'h4 e5' },
  // He has waited his whole life for someone to play 1.f3 and 2.g4.
  { name: "Fool's Mate",             side: 'b',  weight: 3, line: 'f3 e5 g4 Qh4#' }
];

var SAC_BOOK = null;   // compiled on first use: position -> [{ uci, w, name }]

// Castling rights and the en-passant square are part of the position; the
// clocks are not. Two games that reach this board by different routes get the
// same book move.
function bookKey(fen) { return fen.split(' ').slice(0, 4).join(' '); }

// Walk each line, recording the moves that belong to him. An illegal token is
// a typo in the book: say so and drop the rest of that line, because every
// position after it is fiction. Nothing here may throw — a broken book must
// cost him his opening, not his move.
function compileBook(lines) {
  var map = {};
  for (var i = 0; i < lines.length; i++) {
    var e = lines[i], sans = e.line.split(/\s+/), g;
    try { g = new Chess(); } catch (err) { return map; }
    for (var p = 0; p < sans.length; p++) {
      var mine = e.side.indexOf(g.turn()) >= 0;
      var key = mine ? bookKey(g.fen()) : null;
      var mv = null;
      try { mv = g.move(sans[p]); } catch (err2) { mv = null; }
      if (!mv) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('book: illegal move ' + sans[p] + ' at ply ' + (p + 1) + ' of ' + e.name);
        }
        break;
      }
      if (!mine) continue;
      var uci = mv.from + mv.to + (mv.promotion || '');
      var slot = map[key] || (map[key] = []);
      var found = null;
      for (var k = 0; k < slot.length; k++) if (slot[k].uci === uci) { found = slot[k]; break; }
      if (found) { if (e.weight > found.w) found.w = e.weight; }
      else slot.push({ uci: uci, w: e.weight, name: e.name });
    }
  }
  return map;
}

// His move if this position is still in his book, else null. Sampled by
// weight, and every candidate is played on a copy first: the book is data,
// and data can be wrong, but an opponent that cannot move is unforgivable.
function bookMove(fen, o) {
  if (!o || !o.book) return null;
  if (!SAC_BOOK) SAC_BOOK = compileBook(SAC_BOOK_LINES);
  var slot = SAC_BOOK[bookKey(fen)];
  if (!slot || !slot.length) return null;
  var ok = slot.filter(function (s) {
    try { return !!applyUci(new Chess(fen), s.uci); } catch (e) { return false; }
  });
  if (!ok.length) return null;
  return sampleWeighted(
    ok.map(function (s) { return [s.uci, s.w]; }),
    ok.map(function (s) { return s.w; }));
}


// ---------- One way in ----------
// The app and the calibrator must choose moves through the same door, or the
// strength we measure stops being the strength that ships. They drifted once
// already: a rename left both pages calling a function that no longer existed.
// Resolves to a uci string, always.
function decideMove(fen, moves, o) {
  // A member with a book plays it while it lasts, engine and net both silent.
  var booked = bookMove(fen, o);
  if (booked) return Promise.resolve(booked);
  if (o && o.patricia) {
    return patriciaMove(fen, o).then(function (uci) {
      if (uci) return uci;
      // Patricia could not answer — his net alone, screened as a boss is
      return screenMove(fen, moves, chooseBotMove(fen, moves, o), screenFor(o));
    });
  }
  if (o && o.engineFirst) {
    return anandPick(fen, moves, o).then(function (uci) {
      if (uci) return uci;
      // the engine could not answer — his net alone, screened as before
      return screenMove(fen, moves, chooseBotMove(fen, moves, o), screenFor(o));
    });
  }
  return screenMove(fen, moves, chooseBotMove(fen, moves, o), screenFor(o));
}
