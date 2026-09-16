/*
 * bookcheck.js — play every line of the Old Man's book and report.
 *
 *   node headless/bookcheck.js          # errors + a summary
 *   node headless/bookcheck.js -v       # every position he has an answer for
 *
 * The book is SAN typed by hand, so a single wrong token silently truncates a
 * line and takes every position after it with it. This loads bot.js VERBATIM
 * (compileBook warns on an illegal move) and then replays each line itself so
 * the failure is loud and named.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const chessMod = require('chess.js');
const Chess = chessMod.Chess || chessMod;

const ROOT = path.resolve(__dirname, '..');
const verbose = process.argv.includes('-v');

let bad = 0;
const sandbox = { Chess, Math, console: { warn: (m) => { bad++; console.error('  ' + m); }, log: console.log } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'bot.js'), 'utf8'), sandbox, { filename: 'bot.js' });

const lines = sandbox.SAC_BOOK_LINES;
console.log(lines.length + ' lines');

// Replay each line ourselves, so an illegal token names its line and ply.
let plies = 0;
for (const e of lines) {
  const g = new Chess();
  const sans = e.line.trim().split(/\s+/);
  if (!/^[wb]+$/.test(e.side)) { console.error('BAD side "' + e.side + '" in ' + e.name); bad++; }
  for (let i = 0; i < sans.length; i++) {
    const mv = g.move(sans[i]);
    if (!mv) {
      console.error('ILLEGAL ' + sans[i] + ' at ply ' + (i + 1) + ' of "' + e.name + '"');
      console.error('   after: ' + g.history().join(' '));
      bad++;
      break;
    }
    plies++;
  }
}

const book = sandbox.compileBook(lines);
const keys = Object.keys(book);
let moves = 0, forks = 0;
for (const k of keys) { moves += book[k].length; if (book[k].length > 1) forks++; }
console.log(plies + ' plies played, ' + keys.length + ' positions he answers, ' +
            moves + ' replies, ' + forks + ' positions where he chooses');

// His first move on each side, and the shape of the tree from the start.
const start = new Chess();
const opening = book[sandbox.bookKey(start.fen())];
console.log('as White: ' + (opening || []).map((m) => m.uci + '(' + m.w + ')').join(' '));
for (const first of ['e4', 'd4', 'c4', 'Nf3', 'f4', 'b4', 'b3', 'g3', 'e3', 'd3', 'c3', 'Nc3', 'g4', 'h4']) {
  const g = new Chess();
  g.move(first);
  const slot = book[sandbox.bookKey(g.fen())];
  console.log('  vs 1.' + first + ': ' + (slot ? slot.map((m) => m.uci + '(' + m.w + ')').join(' ') : '— out of book'));
}

if (verbose) {
  for (const k of keys) console.log(k + '  ->  ' + book[k].map((m) => m.uci + '(' + m.w + ',' + m.name + ')').join(' '));
}
console.log(bad ? '\nFAILED: ' + bad + ' problem(s)' : '\nbook is clean');
process.exit(bad ? 1 : 0);
