/*
 * spar.js — watch a member play, from the starting position, and count what
 * they actually did.
 *
 *   node headless/spar.js "Old Man" --games 2 --elo 1500 --movetime 50
 *
 * On this host, always through the cap:
 *   RESEARCH_MEM=900M bash ~/trading/scripts/research.sh \
 *     node headless/spar.js "Old Man" --games 2
 *
 * gauntlet.js answers "how strong", and to do that it starts every game from
 * a few RANDOM plies — which is exactly the wrong thing for a member with an
 * opening book, and says nothing about style either way. This answers "how
 * does it play": real games from move one, every move annotated with what it
 * gave away (materialOffered), and a tally at the end.
 *
 * It drives the same decideMove the app and the calibrator use; the opponent
 * is Stockfish at a fixed UCI_Elo, like the gauntlet's anchors.
 */
'use strict';

const path = require('path');
const { makePageContext } = require('./browser');

const argv = process.argv.slice(2);
const names = [];
const opt = { games: 2, elo: 1500, movetime: 50, maxply: 200, seed: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--games') opt.games = parseInt(argv[++i], 10);
  else if (a === '--elo') opt.elo = parseInt(argv[++i], 10);
  else if (a === '--movetime') opt.movetime = parseInt(argv[++i], 10);
  else if (a === '--maxply') opt.maxply = parseInt(argv[++i], 10);
  else if (a === '--seed') opt.seed = parseInt(argv[++i], 10);
  else names.push(a);
}
if (!names.length) { console.error('usage: node headless/spar.js "Old Man" [--games 2] [--elo 1500]'); process.exit(2); }

const { sandbox } = makePageContext({ onLog: () => {} });
if (opt.seed !== null) {
  let s = opt.seed >>> 0;
  sandbox.Math = Object.create(Math);
  sandbox.Math.random = function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { Chess, SF, decideMove, ALL, bookMove, materialOffered, kingwardFactor, bookKey } = sandbox;
const bot = ALL.find((b) => b.name.toLowerCase() === names.join(' ').toLowerCase());
if (!bot) { console.error('unknown member: ' + names.join(' ') + '\nroster: ' + ALL.map((b) => b.name).join(', ')); process.exit(2); }
const engine = bot.offLadder ? sandbox.ANAND : sandbox.MAIA;

const tally = { plies: 0, book: 0, offered: 0, pawns: 0, checks: 0, captures: 0, kingward: 0, kpawns: 0, ms: 0 };

function playGame(botIsWhite) {
  const g = new Chess();
  const botColor = botIsWhite ? 'w' : 'b';
  const notes = [];

  function step() {
    if (g.game_over() || g.history().length >= opt.maxply) {
      const res = g.in_checkmate() ? (g.turn() === botColor ? 'lost' : 'WON') : 'drawn';
      return Promise.resolve({ res, notes, sans: g.history() });
    }
    return (g.turn() === botColor ? botMove() : sfMove()).then((ok) => (ok ? step() : { res: 'aborted', notes, sans: g.history() }));
  }

  function botMove() {
    const fen = g.fen();
    const inBook = !!bookMove(fen, bot);
    const t0 = Date.now();
    return engine.evaluate(fen, bot.rating, opt.elo).then((r) => {
      if (!r.moves || !r.moves.length) return false;
      return decideMove(fen, r.moves, bot).then((uci) => {
        const ms = Date.now() - t0;
        const mv = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci.slice(4) : undefined });
        if (!mv) return false;
        const offered = materialOffered(g, mv);
        // Material given away is not the same thing as a sacrifice: a piece
        // left hanging on the queenside is a blunder. Kingward is the half
        // that was aimed at something.
        const aimed = offered > 0 ? offered * kingwardFactor(g, mv, mv.color) : 0;
        tally.plies++; tally.ms += ms;
        if (inBook) tally.book++;
        if (offered > 0) { tally.offered++; tally.pawns += offered; }
        if (aimed >= 1) { tally.kingward++; tally.kpawns += offered; }
        if (g.in_check()) tally.checks++;
        if (mv.captured) tally.captures++;
        notes.push(Math.ceil(g.history().length / 2) + (botColor === 'w' ? '.' : '...') + mv.san +
                   (inBook ? ' [book]' : '') +
                   (offered > 0 ? (aimed >= 1 ? ' [SACRIFICES ' + offered + ' at the king]' : ' [drops ' + offered + ']') : '') +
                   (g.in_check() ? ' [check]' : ''));
        return true;
      });
    }, () => false);
  }

  function sfMove() {
    return SF.analyse(g.fen(), {
      movetime: opt.movetime, multipv: 1, timeout: Math.max(15000, opt.movetime * 40),
      options: { 'UCI_LimitStrength': 'true', 'UCI_Elo': opt.elo }
    }).then((res) => {
      if (!res.bestmove || res.bestmove === '(none)') return false;
      return !!g.move({ from: res.bestmove.slice(0, 2), to: res.bestmove.slice(2, 4),
                        promotion: res.bestmove.length > 4 ? res.bestmove.slice(4) : undefined });
    }, () => false);
  }

  return step();
}

(async () => {
  console.log(bot.name + ' (card ' + bot.rating + ') vs Stockfish ' + opt.elo + ', ' + opt.games + ' games from move one\n');
  await engine.init(() => {});
  await SF.init();
  for (let i = 0; i < opt.games; i++) {
    const white = i % 2 === 0;
    const out = await playGame(white);
    console.log('game ' + (i + 1) + ' — ' + bot.name + ' as ' + (white ? 'White' : 'Black') + ', ' + out.res + ' in ' + out.sans.length + ' plies');
    console.log('  ' + out.notes.join('  '));
    console.log('  moves: ' + out.sans.join(' ') + '\n');
  }
  const pct = (n) => (100 * n / (tally.plies || 1)).toFixed(0) + '%';
  console.log('over ' + tally.plies + ' of his moves: book ' + pct(tally.book) +
              ', offered material ' + pct(tally.offered) + ' (' + (tally.pawns / (tally.offered || 1)).toFixed(1) + ' pawns each)' +
              ', of which AT THE KING ' + pct(tally.kingward) + ' (' + (tally.kpawns / (tally.kingward || 1)).toFixed(1) + ' pawns each)' +
              ', check ' + pct(tally.checks) + ', captures ' + pct(tally.captures) +
              ', ' + Math.round(tally.ms / (tally.plies || 1)) + 'ms per move');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
