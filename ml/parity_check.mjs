// Verifica parità tra features.py (Python) e mlbot.ts (TS), replicando qui la
// stessa logica di encoding/inferenza usata nella Edge Function e confrontandola
// con i casi generati da parity_dump.py.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const models = JSON.parse(fs.readFileSync(
  path.join(HERE, "..", "supabase", "functions", "_shared", "models.json"), "utf8"));
const cases = JSON.parse(fs.readFileSync(path.join(HERE, "parity_cases.json"), "utf8"));
const DECL = models.decl, PLAY = models.play;

// ---- engine constants (porta da engine.ts) ----
const SEEDS = ["cups", "gold", "swords", "sticks"];
const RANKS = ["Ace", "2", "3", "4", "5", "6", "7", "Jack", "Horse", "King"];
const HIER_BRISCOLA = ["Ace", "3", "King", "Horse", "Jack", "7", "6", "5", "4", "2"];
const HIER_TRESETTE = ["3", "2", "Ace", "King", "Horse", "Jack", "7", "6", "5", "4"];
const cardStrength = (rank, hier) => { const i = hier.indexOf(rank); return i === -1 ? hier.length : i; };
function legalCards(hand, leadSeed) {
  if (!leadSeed) return hand.slice();
  const same = hand.filter((c) => c.seed === leadSeed);
  return same.length ? same : hand.slice();
}
function resolveTrick(plays, briscolaSeed, hier) {
  const leadSeed = plays[0].card.seed;
  let best = null;
  for (const p of plays) {
    const { seed, rank } = p.card;
    const isB = briscolaSeed != null && seed === briscolaSeed;
    const isL = seed === leadSeed;
    if (!isB && !isL) continue;
    const st = cardStrength(rank, hier);
    if (best === null) { best = { seat: p.seat, isB, st }; continue; }
    if (isB && !best.isB) { best = { seat: p.seat, isB, st }; continue; }
    if (isB === best.isB && st < best.st) best = { seat: p.seat, isB, st };
  }
  return best.seat;
}
const forbiddenLastDeclare = (others, nCards) => {
  const f = nCards - others.reduce((a, b) => a + b, 0);
  return f >= 0 && f <= nCards ? f : null;
};

// ---- mlbot.ts (replicato 1:1) ----
function predict(model, x) {
  let acc = model.baseline;
  for (const nodes of model.trees) {
    let j = 0;
    for (;;) {
      const nd = nodes[j];
      if (nd[5]) { acc += nd[4]; break; }
      const xv = x[nd[0]];
      if (Number.isNaN(xv)) j = nd[6] ? nd[2] : nd[3];
      else j = xv <= nd[1] ? nd[2] : nd[3];
    }
  }
  return acc;
}
const cardIndex = (c) => SEEDS.indexOf(c.seed) * RANKS.length + RANKS.indexOf(c.rank);
function multiHotInto(out, off, cards) { for (const c of cards) out[off + cardIndex(c)] = 1; }
function seedOneHotInto(out, off, seed) { const i = seed ? SEEDS.indexOf(seed) : -1; if (i >= 0) out[off + i] = 1; }

function encodeDeclaration(ctx) {
  const hier = ctx.isNoTrump ? HIER_TRESETTE : HIER_BRISCOLA;
  const bseed = ctx.briscola ? ctx.briscola.seed : null;
  const x = new Array(53).fill(0);
  multiHotInto(x, 0, ctx.hand);
  seedOneHotInto(x, 40, bseed);
  let nBrisc = 0, nTop = 0;
  for (const c of ctx.hand) { if (bseed && c.seed === bseed) nBrisc++; if (cardStrength(c.rank, hier) <= 2) nTop++; }
  const sumPrior = ctx.priorDeclares.reduce((a, b) => a + b, 0);
  const e = 44;
  x[e + 0] = ctx.isNoTrump ? 1 : 0; x[e + 1] = ctx.nCards / 10; x[e + 2] = ctx.numPlayers / 5;
  x[e + 3] = ctx.declarationOrder / 5; x[e + 4] = ctx.isLast ? 1 : 0; x[e + 5] = sumPrior / 10;
  x[e + 6] = ctx.priorDeclares.length / 5; x[e + 7] = nBrisc / 10; x[e + 8] = nTop / 10;
  return x;
}
function encodePlay(ctx, candidate) {
  const hier = ctx.isNoTrump ? HIER_TRESETTE : HIER_BRISCOLA;
  const x = new Array(142).fill(0);
  multiHotInto(x, 0, ctx.hand);
  multiHotInto(x, 40, [candidate]);
  multiHotInto(x, 80, ctx.table.map((p) => p.card));
  seedOneHotInto(x, 120, ctx.leadSeed);
  seedOneHotInto(x, 124, ctx.briscolaSeed);
  const tricksRemaining = ctx.nCards - ctx.trickIndex;
  const need = ctx.declared - ctx.takenSoFar;
  const isBrisc = ctx.briscolaSeed && candidate.seed === ctx.briscolaSeed ? 1 : 0;
  const follows = ctx.leadSeed && candidate.seed === ctx.leadSeed ? 1 : 0;
  const strength = cardStrength(candidate.rank, hier) / 10;
  const wouldWin = resolveTrick([...ctx.table, { seat: ctx.mySeat, card: candidate }], ctx.briscolaSeed, hier) === ctx.mySeat ? 1 : 0;
  const e = 128;
  x[e + 0] = ctx.isNoTrump ? 1 : 0; x[e + 1] = ctx.nCards / 10; x[e + 2] = ctx.numPlayers / 5;
  x[e + 3] = ctx.trickIndex / 10; x[e + 4] = ctx.table.length === 0 ? 1 : 0; x[e + 5] = ctx.declared / 10;
  x[e + 6] = ctx.takenSoFar / 10; x[e + 7] = tricksRemaining / 10; x[e + 8] = need / 10;
  x[e + 9] = isBrisc; x[e + 10] = follows; x[e + 11] = strength; x[e + 12] = wouldWin; x[e + 13] = ctx.table.length / 5;
  return x;
}

let maxVecErr = 0, maxPredErr = 0;
for (const c of cases.decl) {
  const x = encodeDeclaration(c);
  for (let i = 0; i < x.length; i++) maxVecErr = Math.max(maxVecErr, Math.abs(x[i] - c.vec[i]));
  maxPredErr = Math.max(maxPredErr, Math.abs(predict(DECL, x) - c.pred));
}
for (const c of cases.play) {
  const x = encodePlay(c, c.candidate);
  for (let i = 0; i < x.length; i++) maxVecErr = Math.max(maxVecErr, Math.abs(x[i] - c.vec[i]));
  maxPredErr = Math.max(maxPredErr, Math.abs(predict(PLAY, x) - c.pred));
}
console.log(`decl=${cases.decl.length} play=${cases.play.length}`);
console.log(`max|vec_TS - vec_PY|   = ${maxVecErr.toExponential(2)}`);
console.log(`max|pred_TS - pred_PY| = ${maxPredErr.toExponential(2)}`);
if (maxVecErr < 1e-5 && maxPredErr < 1e-4) console.log("PARITÀ OK ✓");
else { console.log("PARITÀ FALLITA ✗"); process.exit(1); }
