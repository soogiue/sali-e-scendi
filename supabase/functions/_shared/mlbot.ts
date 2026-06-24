// ============================================================
//  SALI E SCENDI — BOT CON MODELLI ML (TypeScript)
//
//  Inferenza dei modelli allenati (HistGradientBoostingRegressor)
//  SENZA dipendenze esterne: gli alberi sono serializzati in
//  `models.json` (vedi ml/export_models_json.py) e qui li attraversiamo
//  in puro TS. La codifica delle feature è la PORTA FEDELE di
//  ml/features.py → niente train/serve skew.
//
//  Validato: la traversata Python (export_models_json.py) combacia con
//  sklearn .predict() con errore 0.0; questa traversata TS è identica.
// ============================================================
import {
  Card, Play, Seed,
  SEEDS, RANKS, HIER_BRISCOLA, HIER_TRESETTE,
  cardStrength, legalCards, resolveTrick, forbiddenLastDeclare,
} from "./engine.ts";

// modelli serializzati: { decl: TreeModel, play: TreeModel }
// Importati come modulo TS (models.ts) per evitare i rischi dell'import-assertion
// JSON in Deno/bundler. Rigenerare con: cd ml && python export_models_json.py
import modelsData from "./models.ts";

// nodo serializzato = [feature_idx, threshold, left, right, value, is_leaf, missing_left]
type Node = [number, number, number, number, number, number, number];
interface TreeModel { baseline: number; n_features: number; trees: Node[][]; }

const DECL = (modelsData as any)?.decl as TreeModel | undefined;
const PLAY = (modelsData as any)?.play as TreeModel | undefined;

/** true se entrambi i modelli sono presenti e usabili. */
export function modelsLoaded(): boolean {
  return !!(DECL?.trees?.length && PLAY?.trees?.length);
}

// ---------------- INFERENZA (traversata alberi) ----------------
function predict(model: TreeModel, x: number[]): number {
  let acc = model.baseline;
  for (const nodes of model.trees) {
    let j = 0;
    for (;;) {
      const nd = nodes[j];
      if (nd[5]) { acc += nd[4]; break; }      // foglia
      const xv = x[nd[0]];
      if (Number.isNaN(xv)) j = nd[6] ? nd[2] : nd[3];
      else j = xv <= nd[1] ? nd[2] : nd[3];
    }
  }
  return acc;
}

// arrotondamento "alla pari" come Python round() (banker's rounding)
function pyRound(v: number): number {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

// ---------------- ENCODING FEATURE (speculare a features.py) ----------------
function cardIndex(c: Card): number {
  return SEEDS.indexOf(c.seed) * RANKS.length + RANKS.indexOf(c.rank);
}
function multiHotInto(out: number[], offset: number, cards: readonly Card[]) {
  for (const c of cards) out[offset + cardIndex(c)] = 1;
}
function seedOneHotInto(out: number[], offset: number, seed: Seed | null) {
  const i = seed ? SEEDS.indexOf(seed) : -1;
  if (i >= 0) out[offset + i] = 1;
}

export interface DeclCtx {
  hand: Card[];
  briscola: Card | null;
  isNoTrump: boolean;
  nCards: number;
  numPlayers: number;
  declarationOrder: number;   // posizione nell'ordine di dichiarazione (0-based)
  isLast: boolean;
  priorDeclares: number[];
}

// 53 feature: multi_hot(mano 40) + seed_one_hot(briscola 4) + extra(9)
function encodeDeclaration(ctx: DeclCtx): number[] {
  const hier = ctx.isNoTrump ? HIER_TRESETTE : HIER_BRISCOLA;
  const bseed = ctx.briscola ? ctx.briscola.seed : null;
  const x = new Array(53).fill(0);
  multiHotInto(x, 0, ctx.hand);        // 0..39
  seedOneHotInto(x, 40, bseed);        // 40..43
  let nBrisc = 0, nTop = 0;
  for (const c of ctx.hand) {
    if (bseed && c.seed === bseed) nBrisc++;
    if (cardStrength(c.rank, hier) <= 2) nTop++;
  }
  const sumPrior = ctx.priorDeclares.reduce((a, b) => a + b, 0);
  const e = 44;
  x[e + 0] = ctx.isNoTrump ? 1 : 0;
  x[e + 1] = ctx.nCards / 10;
  x[e + 2] = ctx.numPlayers / 5;
  x[e + 3] = ctx.declarationOrder / 5;
  x[e + 4] = ctx.isLast ? 1 : 0;
  x[e + 5] = sumPrior / 10;
  x[e + 6] = ctx.priorDeclares.length / 5;
  x[e + 7] = nBrisc / 10;
  x[e + 8] = nTop / 10;
  return x;
}

export interface PlayCtx {
  hand: Card[];               // mano residua (include la candidata)
  table: Play[];
  leadSeed: Seed | null;
  briscolaSeed: Seed | null;
  isNoTrump: boolean;
  nCards: number;
  numPlayers: number;
  trickIndex: number;
  declared: number;
  takenSoFar: number;
  mySeat: number;
}

// 142 feature: mano(40)+candidata(40)+tavolo(40)+lead(4)+briscola(4)+extra(14)
function encodePlay(ctx: PlayCtx, candidate: Card): number[] {
  const hier = ctx.isNoTrump ? HIER_TRESETTE : HIER_BRISCOLA;
  const x = new Array(142).fill(0);
  multiHotInto(x, 0, ctx.hand);                          // 0..39
  multiHotInto(x, 40, [candidate]);                      // 40..79
  multiHotInto(x, 80, ctx.table.map((p) => p.card));     // 80..119
  seedOneHotInto(x, 120, ctx.leadSeed);                  // 120..123
  seedOneHotInto(x, 124, ctx.briscolaSeed);              // 124..127

  const declared = ctx.declared;
  const taken = ctx.takenSoFar;
  const tricksRemaining = ctx.nCards - ctx.trickIndex;
  const need = declared - taken;
  const isBrisc = ctx.briscolaSeed && candidate.seed === ctx.briscolaSeed ? 1 : 0;
  const follows = ctx.leadSeed && candidate.seed === ctx.leadSeed ? 1 : 0;
  const strength = cardStrength(candidate.rank, hier) / 10;
  const wouldWin = resolveTrick(
    [...ctx.table, { seat: ctx.mySeat, card: candidate }],
    ctx.briscolaSeed, hier,
  ) === ctx.mySeat ? 1 : 0;

  const e = 128;
  x[e + 0] = ctx.isNoTrump ? 1 : 0;
  x[e + 1] = ctx.nCards / 10;
  x[e + 2] = ctx.numPlayers / 5;
  x[e + 3] = ctx.trickIndex / 10;
  x[e + 4] = ctx.table.length === 0 ? 1 : 0;   // is_lead
  x[e + 5] = declared / 10;
  x[e + 6] = taken / 10;
  x[e + 7] = tricksRemaining / 10;
  x[e + 8] = need / 10;
  x[e + 9] = isBrisc;
  x[e + 10] = follows;
  x[e + 11] = strength;
  x[e + 12] = wouldWin;
  x[e + 13] = ctx.table.length / 5;
  return x;
}

// ---------------- POLITICHE (speculari a ml/bots.py::ModelBot) ----------------
function fixLastDeclare(
  value: number, nCards: number, isLast: boolean, prior: readonly number[],
): number {
  const v = Math.max(0, Math.min(value, nCards));
  if (!isLast) return v;
  const forb = forbiddenLastDeclare(prior, nCards);
  if (forb === null || v !== forb) return v;
  for (const cand of [v - 1, v + 1]) if (cand >= 0 && cand <= nCards) return cand;
  return v;
}

/** Quante prese dichiarare secondo il modello allenato. */
export function modelDeclare(ctx: DeclCtx): number {
  const pred = predict(DECL as TreeModel, encodeDeclaration(ctx));
  return fixLastDeclare(pyRound(pred), ctx.nCards, ctx.isLast, ctx.priorDeclares);
}

/** Quale carta giocare: argmax del valore previsto tra le legali. */
export function modelPlay(ctx: PlayCtx): Card {
  const legal = legalCards(ctx.hand, ctx.leadSeed);
  let best = legal[0];
  let bestVal = -Infinity;
  for (const c of legal) {
    const v = predict(PLAY as TreeModel, encodePlay(ctx, c));
    if (v > bestVal) { bestVal = v; best = c; }
  }
  return best;
}
