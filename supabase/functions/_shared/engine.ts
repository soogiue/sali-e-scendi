// ============================================================
//  SALI E SCENDI — MOTORE DI GIOCO (TypeScript)
//  Logica pura e tipizzata. Usata lato server (Edge Function)
//  come unica fonte di verità. Identica alla versione JS
//  verificata con 36 unit test + 600 partite simulate.
//
//  Regole:
//   - 4 giocatori -> max 10 carte, 5 -> 8  (= floor(40/n))
//   - round di picco: niente briscola, gerarchia "tresette"
//   - punteggio: indovini -> +1 + prese ; sbagli -> -|dichiarato-prese|
//   - devi rispondere al seme di uscita se ce l'hai (taglio NON obbligatorio)
//   - vincolo: la somma di TUTTE le dichiarazioni != n. prese del round
//   - primo a giocare = quello dopo il mazziere (che ruota ogni round)
// ============================================================

export type Seed = "cups" | "gold" | "swords" | "sticks";
export type Rank =
  | "Ace" | "2" | "3" | "4" | "5" | "6" | "7" | "Jack" | "Horse" | "King";

export interface Card { seed: Seed; rank: Rank; }
export type Hierarchy = readonly Rank[];
export interface Play { seat: number; card: Card; }

export const SEEDS: readonly Seed[] = ["cups", "gold", "swords", "sticks"];
export const RANKS: readonly Rank[] =
  ["Ace", "2", "3", "4", "5", "6", "7", "Jack", "Horse", "King"];

// indice 0 = carta piu' FORTE
export const HIER_BRISCOLA: Hierarchy =
  ["Ace", "3", "King", "Horse", "Jack", "7", "6", "5", "4", "2"];
export const HIER_TRESETTE: Hierarchy =
  ["3", "2", "Ace", "King", "Horse", "Jack", "7", "6", "5", "4"];

export type Rng = () => number;

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const seed of SEEDS) for (const rank of RANKS) deck.push({ seed, rank });
  return deck;
}

export function shuffle<T>(arr: readonly T[], rng: Rng = Math.random): T[] {
  const d = arr.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

export function maxCardsFor(numPlayers: number): number {
  return Math.floor(40 / numPlayers); // 4->10, 5->8
}

// Sequenza dei round: [1..max, max..1] (il picco compare due volte)
export function roundsSequence(maxCards: number): number[] {
  const seq: number[] = [];
  for (let i = 1; i <= maxCards; i++) seq.push(i);
  for (let i = maxCards; i >= 1; i--) seq.push(i);
  return seq;
}

// forza di una carta: piu' basso = piu' forte
export function cardStrength(rank: Rank, hierarchy: Hierarchy): number {
  const i = hierarchy.indexOf(rank);
  return i === -1 ? hierarchy.length : i;
}

// Ordine dei posti in senso orario a partire da `firstSeat`
export function seatOrder(numPlayers: number, firstSeat: number): number[] {
  const order: number[] = [];
  for (let i = 0; i < numPlayers; i++) order.push((firstSeat + i) % numPlayers);
  return order;
}

// Mazziere del round (ruota a ogni round) e primo a giocare (quello dopo)
export function dealerFor(numPlayers: number, roundIndex: number): number {
  return roundIndex % numPlayers;
}
export function firstSeatFor(numPlayers: number, roundIndex: number): number {
  return (dealerFor(numPlayers, roundIndex) + 1) % numPlayers;
}

export function sortHand(hand: readonly Card[], hierarchy: Hierarchy): Card[] {
  return hand.slice().sort((a, b) =>
    a.seed !== b.seed
      ? SEEDS.indexOf(a.seed) - SEEDS.indexOf(b.seed)
      : cardStrength(a.rank, hierarchy) - cardStrength(b.rank, hierarchy)
  );
}

export interface DealResult {
  hands: Card[][];        // indicizzate per posto (seat)
  briscola: Card | null;  // null nei round di picco (tresette)
  hierarchy: Hierarchy;
  isNoTrump: boolean;
  order: number[];        // ordine di gioco (seat)
}

export function dealRound(
  numPlayers: number,
  nCards: number,
  firstSeat: number,
  rng: Rng = Math.random,
): DealResult {
  const isNoTrump = nCards >= maxCardsFor(numPlayers);
  const deck = shuffle(createDeck(), rng);
  const hierarchy = isNoTrump ? HIER_TRESETTE : HIER_BRISCOLA;
  let briscola: Card | null = null;
  if (!isNoTrump) briscola = deck.pop() ?? null;

  const order = seatOrder(numPlayers, firstSeat);
  const hands: Card[][] = new Array(numPlayers);
  for (const s of order) hands[s] = [];
  for (let c = 0; c < nCards; c++) {
    for (const s of order) hands[s].push(deck.pop() as Card);
  }
  for (const s of order) hands[s] = sortHand(hands[s], hierarchy);
  return { hands, briscola, hierarchy, isNoTrump, order };
}

// Carte legali: rispondi al seme di uscita se ce l'hai, altrimenti gioca qualsiasi carta
export function legalCards(hand: readonly Card[], leadSeed: Seed | null): Card[] {
  if (!leadSeed) return hand.slice();
  const same = hand.filter((c) => c.seed === leadSeed);
  return same.length > 0 ? same : hand.slice();
}

export function isLegalPlay(
  hand: readonly Card[], leadSeed: Seed | null, card: Card,
): boolean {
  const legal = legalCards(hand, leadSeed);
  return legal.some((c) => c.seed === card.seed && c.rank === card.rank);
}

// Risolve la presa. plays nell'ordine di gioco (il primo e' l'uscita).
// Ritorna il SEAT vincitore.
export function resolveTrick(
  plays: readonly Play[], briscolaSeed: Seed | null, hierarchy: Hierarchy,
): number {
  const leadSeed = plays[0].card.seed;
  let best: { seat: number; isB: boolean; st: number } | null = null;
  for (const p of plays) {
    const { seed, rank } = p.card;
    const isB = briscolaSeed != null && seed === briscolaSeed;
    const isL = seed === leadSeed;
    if (!isB && !isL) continue; // fuori seme e non briscola: non puo' vincere
    const st = cardStrength(rank, hierarchy);
    if (best === null) { best = { seat: p.seat, isB, st }; continue; }
    if (isB && !best.isB) { best = { seat: p.seat, isB, st }; continue; }
    if (isB === best.isB && st < best.st) best = { seat: p.seat, isB, st };
  }
  return (best as { seat: number }).seat;
}

// Punteggio di un giocatore nel round
export function scoreRound(declared: number, taken: number): number {
  return declared === taken ? 1 + taken : -Math.abs(declared - taken);
}

// Valore VIETATO per l'ultimo dichiarante (somma di tutte le dichiarazioni != nCards).
// null se nessun valore in [0..nCards] e' vietato.
export function forbiddenLastDeclare(
  otherDeclares: readonly number[], nCards: number,
): number | null {
  const sum = otherDeclares.reduce((a, b) => a + b, 0);
  const f = nCards - sum;
  return f >= 0 && f <= nCards ? f : null;
}

// ---------- MOSSE AUTOMATICHE (allo scadere del timer di turno) ----------

// Carta da giocare in automatico: la piu' DEBOLE tra le legali
// (strength piu' alto = carta piu' debole). Cosi' il timeout non "spreca" carte forti.
export function autoPickCard(
  hand: readonly Card[], leadSeed: Seed | null, hierarchy: Hierarchy,
): Card {
  const legal = legalCards(hand, leadSeed);
  let worst = legal[0];
  for (const c of legal) {
    if (cardStrength(c.rank, hierarchy) > cardStrength(worst.rank, hierarchy)) worst = c;
  }
  return worst;
}

// Dichiarazione automatica valida: prova 0; se sei l'ultimo e 0 e' vietato, usa 1
// (nCards >= 1 sempre, quindi 1 e' un valore valido nel range).
export function autoPickDeclare(
  otherDeclares: readonly number[], nCards: number, isLast: boolean,
): number {
  if (!isLast) return 0;
  const forb = forbiddenLastDeclare(otherDeclares, nCards);
  if (forb === 0) return Math.min(1, nCards);
  return 0;
}

// ---------- BOT (euristica "vera": gioca per vincere) ----------
// Speculare a ml/bots.py::HeuristicBot. A differenza di autoPick* (pensata per i
// timeout, volutamente debole), questa stima le prese e cerca di indovinare.

// Sposta una dichiarazione lontano dal valore vietato (solo per l'ultimo).
function fixLastDeclare(
  value: number, nCards: number, isLast: boolean, priorDeclares: readonly number[],
): number {
  const v = Math.max(0, Math.min(value, nCards));
  if (!isLast) return v;
  const forb = forbiddenLastDeclare(priorDeclares, nCards);
  if (forb === null || v !== forb) return v;
  for (const cand of [v - 1, v + 1]) {
    if (cand >= 0 && cand <= nCards) return cand;
  }
  return v;
}

// Quante prese dichiarare, vista la mano.
export function botDeclare(
  hand: readonly Card[], briscola: Card | null, isNoTrump: boolean,
  nCards: number, isLast: boolean, priorDeclares: readonly number[],
): number {
  const hierarchy = isNoTrump ? HIER_TRESETTE : HIER_BRISCOLA;
  const bseed = briscola ? briscola.seed : null;
  let est = 0;
  for (const c of hand) {
    const s = cardStrength(c.rank, hierarchy);
    if (bseed && c.seed === bseed) est += s <= 4 ? 0.85 : 0.5;
    else if (s <= 1) est += 0.55;
    else if (s === 2) est += 0.3;
    else est += 0.05;
  }
  return fixLastDeclare(Math.round(est), nCards, isLast, priorDeclares);
}

// Quale carta giocare.
export function botPlay(
  hand: readonly Card[], table: readonly Play[], leadSeed: Seed | null,
  briscolaSeed: Seed | null, isNoTrump: boolean, nCards: number,
  trickIndex: number, declared: number, takenSoFar: number, mySeat: number,
): Card {
  const hierarchy = isNoTrump ? HIER_TRESETTE : HIER_BRISCOLA;
  const legal = legalCards(hand, leadSeed);
  const need = declared - takenSoFar;
  const tricksRemaining = nCards - trickIndex;
  const want = need > 0 && tricksRemaining > 0;

  const weakest = (cards: readonly Card[]) =>
    cards.reduce((w, c) =>
      cardStrength(c.rank, hierarchy) > cardStrength(w.rank, hierarchy) ? c : w, cards[0]);
  const strongest = (cards: readonly Card[]) =>
    cards.reduce((b, c) =>
      cardStrength(c.rank, hierarchy) < cardStrength(b.rank, hierarchy) ? c : b, cards[0]);

  // Sono di mano: se voglio prese esco forte, altrimenti scarico debole.
  if (table.length === 0) return want ? strongest(legal) : weakest(legal);

  // Sto rispondendo: carte che mi farebbero vincere ORA la presa.
  const winners = legal.filter((c) =>
    resolveTrick([...table, { seat: mySeat, card: c }], briscolaSeed, hierarchy) === mySeat);
  if (want && winners.length > 0) return weakest(winners); // vinco economico
  return weakest(legal);                                    // scarto la più debole
}

// ---------- "TUTTO MIO": verifica di una pretesa (claim) ----------
export type ClaimResult = "proven" | "refuted" | "too_complex";

export function verifyClaimAll(
  hands: Record<number, Card[]>,
  claimant: number,
  table: readonly Play[],
  turnSeat: number,
  numPlayers: number,
  briscolaSeed: Seed | null,
  hierarchy: Hierarchy,
  nodeBudget = 300_000,
): ClaimResult {
  let budget = nodeBudget;
  let exceeded = false;
  const H: Record<number, Card[]> = {};
  for (const k of Object.keys(hands)) H[+k] = hands[+k].slice();
  const remove = (seat: number, c: Card) => {
    const arr = H[seat];
    const i = arr.findIndex((x) => x.seed === c.seed && x.rank === c.rank);
    if (i >= 0) arr.splice(i, 1);
  };
  const restore = (seat: number, c: Card) => { H[seat].push(c); };
  const byStrength = (cards: Card[]) =>
    cards.slice().sort((a, b) => cardStrength(a.rank, hierarchy) - cardStrength(b.rank, hierarchy));
  function solve(curTable: Play[], turn: number): boolean {
    if (--budget < 0) { exceeded = true; return false; }
    const leadSeed: Seed | null = curTable.length ? curTable[0].card.seed : null;
    const legal = byStrength(legalCards(H[turn], leadSeed));
    const isClaimant = turn === claimant;
    for (const card of legal) {
      remove(turn, card);
      const newTable = [...curTable, { seat: turn, card }];
      let res: boolean;
      if (newTable.length === numPlayers) {
        const winner = resolveTrick(newTable, briscolaSeed, hierarchy);
        if (winner !== claimant) res = false;
        else if (H[claimant].length === 0) res = true;
        else res = solve([], claimant);
      } else {
        res = solve(newTable, (turn + 1) % numPlayers);
      }
      restore(turn, card);
      if (exceeded) return false;
      if (isClaimant) { if (res) return true; }
      else { if (!res) return false; }
    }
    return !isClaimant;
  }
  const ok = solve(table.slice(), turnSeat);
  if (exceeded) return "too_complex";
  return ok ? "proven" : "refuted";
}
