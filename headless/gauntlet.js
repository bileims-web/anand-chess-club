/*
 * gauntlet.js — run calibrate.html's gauntlet without a browser.
 *
 *   node headless/gauntlet.js "The Ringer" "The Sacker"
 *   node headless/gauntlet.js --games 10 --movetime 50 --maxply 200 "The Sniper"
 *
 * On this host, always through the cap:
 *   RESEARCH_MEM=900M bash ~/trading/scripts/research.sh \
 *     node headless/gauntlet.js "The Ringer" "The Sacker"
 *
 * It drives the calibrator's own code (see browser.js) — the bot picks its
 * move through decideMove exactly as the app does. Results are printed as the
 * paste-ready MEASURED block and written to headless/results/.
 *
 * Anand can be measured too: his gauntlet runs against calibrate.html's
 * ANAND_ANCHORS (2200-3100) rather than the ladder's.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { makePageContext } = require('./browser');

// ---------- arguments ----------
const argv = process.argv.slice(2);
const names = [];
const opt = { games: 10, movetime: 50, maxply: 200, seed: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--games') opt.games = parseInt(argv[++i], 10);
  else if (a === '--movetime') opt.movetime = parseInt(argv[++i], 10);
  else if (a === '--maxply') opt.maxply = parseInt(argv[++i], 10);
  else if (a === '--seed') opt.seed = parseInt(argv[++i], 10);
  else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
  else names.push(a);
}
if (!names.length) { console.error('usage: node headless/gauntlet.js "The Ringer" ["The Sacker" ...]'); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(__dirname, 'results');
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, stamp + '.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const say = (s) => { process.stdout.write(s); logStream.write(s); };

// ---------- the page ----------
const { context, sandbox } = makePageContext({ onLog: say });

// A seed makes a run repeatable — it fixes the random openings AND the bot's
// own sampling. Left off, each run is an independent sample, like the browser.
if (opt.seed !== null) {
  let s = opt.seed >>> 0;
  sandbox.Math = Object.create(Math);
  sandbox.Math.random = function () {   // mulberry32
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL = sandbox.ALL;
if (!ALL || !ALL.length) { console.error('calibrate.html did not expose its roster'); process.exit(1); }

const picks = names.map((n) => {
  const i = ALL.findIndex((b) => b.name.toLowerCase() === n.toLowerCase());
  if (i < 0) {
    console.error('unknown opponent: ' + n);
    console.error('roster: ' + ALL.map((b) => b.name).join(', '));
    process.exit(2);
  }
  return i;
});

// ---------- drive it ----------
const $ = (id) => sandbox.document.getElementById(id);

function runBot(index) {
  $('games').value = String(opt.games);
  $('movetime').value = String(opt.movetime);
  $('maxply').value = String(opt.maxply);
  $('who').value = String(index);
  $('run').onclick();
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!sandbox.running) { clearInterval(poll); resolve(); }
    }, 500);
  });
}

// Ctrl-C stops after the current game rather than losing the run.
process.on('SIGINT', () => {
  if (sandbox.running) { say('\nSIGINT — stopping after this game…\n'); sandbox.stopping = true; }
  else process.exit(130);
});

(async () => {
  const t0 = Date.now();
  say('headless gauntlet — games/anchor ' + opt.games + ', movetime ' + opt.movetime +
      'ms, maxply ' + opt.maxply + (opt.seed === null ? '' : ', seed ' + opt.seed) + '\n');

  for (const i of picks) await runBot(i);

  const measured = $('out').textContent;
  const results = sandbox.results || {};
  const mins = Math.round((Date.now() - t0) / 60000);

  say('\n' + measured + '\n');
  say('\nran ' + mins + ' min; log ' + logFile + '\n');

  fs.writeFileSync(path.join(outDir, stamp + '.json'), JSON.stringify({
    when: new Date().toISOString(),
    config: opt,
    bots: picks.map((i) => ALL[i].name),
    results,
    measured
  }, null, 2));
  say('wrote ' + path.join(outDir, stamp + '.json') + '\n');
  logStream.end();
  process.exit(0);
})().catch((err) => {
  say('\nFAILED: ' + (err && err.stack ? err.stack : err) + '\n');
  logStream.end();
  process.exit(1);
});
