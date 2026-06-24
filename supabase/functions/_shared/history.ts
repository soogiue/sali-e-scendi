// ============================================================
//  SALI E SCENDI — LOGGER DELLA CRONOLOGIA (dataset ML)
//  Scrive lo storico EVENT-LEVEL di ogni partita nello schema `history`
//  (vedi migrations/001_v1_game_history). Usato dall'Edge Function "game".
//
//  PRINCIPI:
//   - BEST-EFFORT: ogni funzione è in try/catch e non lancia MAI. Un errore
//     di logging non deve mai rompere la partita (il gioco resta autoritativo).
//   - APPEND-ONLY: si inserisce, non si modifica lo stato di gioco.
//   - Accede allo schema `history` via db.schema("history") (service_role).
//     Richiede 'history' negli "Exposed schemas" del progetto Supabase.
// ============================================================

import * as E from "./engine.ts";

// Tipo minimale del client supabase-js che ci serve (evita dipendenze di tipo).
type DB = {
  schema: (s: string) => any;
  from: (t: string) => any;
};

const h = (db: DB) => db.schema("history");

function warn(where: string, e: unknown) {
  // Non rilanciare: logging best-effort.
  console.error(`[history.${where}]`, (e as Error)?.message ?? e);
}

// Ordine di dichiarazione/gioco dei posti a partire da firstSeat (orario).
function order(n: number, firstSeat: number): number[] {
  return E.seatOrder(n, firstSeat);
}

// ------------------------------------------------------------
// Recupera (o crea) la riga history.games per una partita pubblica.
// Ritorna il game_log_id (uuid) oppure null se non disponibile.
// ------------------------------------------------------------
async function ensureGameLog(db: DB, gameId: string): Promise<string | null> {
  try {
    const { data: existing } = await h(db).from("games")
      .select("id").eq("game_id", gameId).maybeSingle();
    if (existing?.id) return existing.id;

    // Config dalla partita pubblica.
    const { data: g } = await db.from("games")
      .select("code,host_user,num_players,max_cards,rounds,created_at")
      .eq("id", gameId).single();
    if (!g) return null;

    const { data: ins } = await h(db).from("games").insert({
      game_id: gameId,
      code: g.code,
      num_players: g.num_players,
      max_cards: g.max_cards,
      rounds: g.rounds,
      host_user: g.host_user,
      ruleset: "sali-e-scendi/v1",
      engine_version: "engine.ts@v1",
      status: "finished",            // valore finale aggiornato a fine partita
      started_at: g.created_at ?? new Date().toISOString(),
    }).select("id").single();
    return ins?.id ?? null;
  } catch (e) {
    warn("ensureGameLog", e);
    return null;
  }
}

async function getRoundLog(
  db: DB, gameId: string, roundIndex: number,
): Promise<string | null> {
  try {
    const { data } = await h(db).from("rounds")
      .select("id").eq("game_id", gameId).eq("round_index", roundIndex).maybeSingle();
    return data?.id ?? null;
  } catch (e) {
    warn("getRoundLog", e);
    return null;
  }
}

// ============================================================
// 1) INIZIO ROUND — crea history.rounds + history.deals (mani distribuite)
// ============================================================
export async function logRoundStart(
  db: DB,
  gameId: string,
  n: number,
  roundIndex: number,
  nCards: number,
  firstSeat: number,
  deal: E.DealResult,
  players: { seat: number; user_id: string }[],
): Promise<void> {
  try {
    const gameLogId = await ensureGameLog(db, gameId);
    if (!gameLogId) return;

    const ord = order(n, firstSeat);
    const dealerSeat = E.dealerFor(n, roundIndex);
    const isNoTrump = deal.isNoTrump;

    const { data: r } = await h(db).from("rounds").upsert({
      game_log_id: gameLogId,
      game_id: gameId,
      round_index: roundIndex,
      n_cards: nCards,
      dealer_seat: dealerSeat,
      first_seat: firstSeat,
      is_no_trump: isNoTrump,
      hierarchy: isNoTrump ? "tresette" : "briscola",
      briscola: deal.briscola,
    }, { onConflict: "game_log_id,round_index" }).select("id").single();

    const roundLogId = r?.id;
    if (!roundLogId) return;

    const userBySeat = new Map<number, string>();
    for (const p of players) userBySeat.set(p.seat, p.user_id);

    const dealRows = ord.map((seat) => ({
      round_log_id: roundLogId,
      game_id: gameId,
      round_index: roundIndex,
      seat,
      user_id: userBySeat.get(seat) ?? null,
      dealt_hand: deal.hands[seat] ?? [],
      declaration_order: ord.indexOf(seat),
      is_last_declarer: ord.indexOf(seat) === n - 1,
    }));
    await h(db).from("deals").upsert(dealRows, { onConflict: "round_log_id,seat" });
  } catch (e) {
    warn("logRoundStart", e);
  }
}

// ============================================================
// 2) DICHIARAZIONE — una riga history.declarations (azione + stato visto)
//    Da chiamare DOPO aver scritto game_players.declared per `seat`.
// ============================================================
export async function logDeclaration(
  db: DB,
  game: any,
  seat: number,
  declared: number,
  isLast: boolean,
  n: number,
): Promise<void> {
  try {
    const roundLogId = await getRoundLog(db, game.id, game.round_index);
    if (!roundLogId) return;

    const ord = order(n, game.trick_lead_seat);
    const myOrder = ord.indexOf(seat);

    // Dichiarazioni precedenti (per ordine), dallo stato attuale di game_players.
    const { data: gps } = await db.from("game_players")
      .select("seat,declared,user_id").eq("game_id", game.id);
    const declaredBySeat = new Map<number, number | null>();
    const userBySeat = new Map<number, string>();
    for (const p of gps ?? []) {
      declaredBySeat.set(p.seat, p.declared);
      userBySeat.set(p.seat, p.user_id);
    }

    const prior: { seat: number; declared: number }[] = [];
    for (let i = 0; i < myOrder; i++) {
      const s = ord[i];
      const d = declaredBySeat.get(s);
      if (d !== null && d !== undefined) prior.push({ seat: s, declared: d });
    }
    const sumPrior = prior.reduce((a, p) => a + p.declared, 0);
    const forbidden = isLast
      ? E.forbiddenLastDeclare(prior.map((p) => p.declared), game.n_cards)
      : null;

    // Mano vista al momento della dichiarazione (= mano corrente del round).
    const { data: handRow } = await db.from("hands").select("cards")
      .eq("game_id", game.id).eq("round_index", game.round_index)
      .eq("seat", seat).maybeSingle();

    await h(db).from("declarations").upsert({
      round_log_id: roundLogId,
      game_id: game.id,
      round_index: game.round_index,
      seat,
      user_id: userBySeat.get(seat) ?? null,
      declaration_order: myOrder,
      declared,
      hand_at_declaration: handRow?.cards ?? [],
      prior_declarations: prior,
      sum_prior: sumPrior,
      is_last_declarer: isLast,
      forbidden_value: forbidden,
    }, { onConflict: "round_log_id,seat" });
  } catch (e) {
    warn("logDeclaration", e);
  }
}

// ============================================================
// 3) CARTA GIOCATA — una riga history.plays (azione + stato + mosse legali)
//    Da chiamare con la mano PRIMA di rimuovere la carta (hand_before) e con
//    il tavolo PRIMA di aggiungere questa carta (tableBefore).
// ============================================================
export async function logPlay(
  db: DB,
  game: any,
  seat: number,
  card: E.Card,
  handBefore: E.Card[],
  tableBefore: E.Play[],
): Promise<void> {
  try {
    const roundLogId = await getRoundLog(db, game.id, game.round_index);
    if (!roundLogId) return;

    const leadSeed: E.Seed | null = tableBefore.length ? tableBefore[0].card.seed : null;
    const legalMoves = E.legalCards(handBefore, leadSeed);
    const isLead = tableBefore.length === 0;

    await h(db).from("plays").upsert({
      round_log_id: roundLogId,
      game_id: game.id,
      round_index: game.round_index,
      trick_index: game.trick_index,
      play_order: tableBefore.length,
      seat,
      card,
      hand_before: handBefore,
      legal_moves: legalMoves,
      table_before: tableBefore,
      lead_seat: game.trick_lead_seat,
      lead_suit: leadSeed ?? card.seed,
      is_lead: isLead,
    }, { onConflict: "round_log_id,trick_index,seat" });
  } catch (e) {
    warn("logPlay", e);
  }
}

// ============================================================
// 4) PRESA CHIUSA — history.tricks + aggiorna plays.won_trick
// ============================================================
export async function logTrickResolved(
  db: DB,
  game: any,
  trickIndex: number,
  plays: E.Play[],
  winnerSeat: number,
): Promise<void> {
  try {
    const roundLogId = await getRoundLog(db, game.id, game.round_index);
    if (!roundLogId) return;

    const leadSuit = plays.length ? plays[0].card.seed : null;
    const leadSeat = plays.length ? plays[0].seat : game.trick_lead_seat;

    await h(db).from("tricks").upsert({
      round_log_id: roundLogId,
      game_id: game.id,
      round_index: game.round_index,
      trick_index: trickIndex,
      lead_seat: leadSeat,
      lead_suit: leadSuit,
      winner_seat: winnerSeat,
      plays: plays.map((p, i) => ({ seat: p.seat, card: p.card, play_order: i })),
    }, { onConflict: "round_log_id,trick_index" });

    // won_trick: false per tutti, true per il vincitore.
    await h(db).from("plays").update({ won_trick: false })
      .eq("round_log_id", roundLogId).eq("trick_index", trickIndex);
    await h(db).from("plays").update({ won_trick: true })
      .eq("round_log_id", roundLogId).eq("trick_index", trickIndex)
      .eq("seat", winnerSeat);
  } catch (e) {
    warn("logTrickResolved", e);
  }
}

// ============================================================
// 5) FINE ROUND — history.round_outcomes (dichiarato/preso/punti)
//    `rows` arriva già calcolato dall'index (declared, taken, points, scoreAfter).
// ============================================================
export async function logRoundOutcomes(
  db: DB,
  game: any,
  rows: { seat: number; user_id: string; declared: number; taken: number; points: number; scoreAfter: number }[],
): Promise<void> {
  try {
    const roundLogId = await getRoundLog(db, game.id, game.round_index);
    if (!roundLogId) return;

    const outRows = rows.map((r) => ({
      round_log_id: roundLogId,
      game_id: game.id,
      round_index: game.round_index,
      seat: r.seat,
      user_id: r.user_id,
      declared: r.declared,
      taken: r.taken,
      points: r.points,
      score_after: r.scoreAfter,
      guessed: r.declared === r.taken,
    }));
    await h(db).from("round_outcomes").upsert(outRows, { onConflict: "round_log_id,seat" });
  } catch (e) {
    warn("logRoundOutcomes", e);
  }
}

// ============================================================
// 6) FINE PARTITA — finalizza history.games + history.players
// ============================================================
export async function logGameFinished(
  db: DB,
  gameId: string,
  winnerSeat: number | null,
  playersByScoreDesc: { seat: number; user_id: string; display_name: string; score: number }[],
): Promise<void> {
  try {
    const gameLogId = await ensureGameLog(db, gameId);
    if (!gameLogId) return;

    const finalScores = playersByScoreDesc.map((p, i) => ({
      seat: p.seat, user_id: p.user_id, display_name: p.display_name,
      score: p.score, rank: i + 1,
    }));

    await h(db).from("games").update({
      status: "finished",
      winner_seat: winnerSeat,
      final_scores: finalScores,
      finished_at: new Date().toISOString(),
    }).eq("id", gameLogId);

    const playerRows = playersByScoreDesc.map((p, i) => ({
      game_log_id: gameLogId,
      game_id: gameId,
      seat: p.seat,
      user_id: p.user_id,
      display_name: p.display_name,
      final_score: p.score,
      final_rank: i + 1,
    }));
    await h(db).from("players").upsert(playerRows, { onConflict: "game_log_id,seat" });
  } catch (e) {
    warn("logGameFinished", e);
  }
}
