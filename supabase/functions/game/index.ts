// ============================================================
//  SALI E SCENDI — EDGE FUNCTION "game" (server autoritativo)
//  Deno. Valida OGNI mossa col motore e scrive lo stato nel DB
//  con la service_role (bypassa la RLS). I client non scrivono mai.
//
//  Azioni (POST JSON { action, ... }):
//   - create_game { displayName }            -> { gameId, code, seat }
//   - join_game   { code, displayName }       -> { gameId, code, seat }
//   - start_game  { gameId }                  (solo host)
//   - declare     { gameId, value }
//   - play_card   { gameId, card:{seed,rank} }
//   - continue    { gameId }   (avanza dopo presa conclusa / fine round)
//   - timeout     { gameId }   (chiunque: se il timer del turno e' scaduto,
//                               il server gioca/dichiara in automatico)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as E from "../_shared/engine.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Secondi a disposizione di ogni giocatore per ogni mossa (dichiarazione o carta).
const TURN_SECONDS = 15;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Scadenza del prossimo turno (ISO string), TURN_SECONDS nel futuro.
function nextDeadline(): string {
  return new Date(Date.now() + TURN_SECONDS * 1000).toISOString();
}

function genCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente caratteri ambigui
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const db = createClient(SUPABASE_URL, SERVICE_ROLE);

    // identità utente dal JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: { user }, error: uErr } = await db.auth.getUser(jwt);
    if (uErr || !user) return json({ error: "Non autenticato" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    switch (action) {
      case "create_game":   return await createGame(db, user.id, body);
      case "join_game":     return await joinGame(db, user.id, body);
      case "start_game":    return await startGame(db, user.id, body);
      case "declare":       return await declare(db, user.id, body);
      case "play_card":     return await playCard(db, user.id, body);
      case "continue":      return await continueAfter(db, user.id, body);
      case "timeout":       return await timeoutAction(db, user.id, body);
      default:              return json({ error: "Azione sconosciuta: " + action }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

// ---------------- AZIONI ----------------

async function createGame(db: any, userId: string, body: any) {
  const displayName = cleanName(body.displayName);
  if (!displayName) return json({ error: "Inserisci il tuo nome" }, 400);
  // codice unico
  let code = genCode();
  for (let i = 0; i < 6; i++) {
    const { data } = await db.from("games").select("id").eq("code", code).maybeSingle();
    if (!data) break;
    code = genCode();
  }
  const { data: game, error } = await db.from("games")
    .insert({ code, host_user: userId, status: "lobby", phase: "lobby" })
    .select().single();
  if (error) return json({ error: error.message }, 400);

  const { error: pErr } = await db.from("game_players")
    .insert({ game_id: game.id, user_id: userId, seat: 0, display_name: displayName });
  if (pErr) return json({ error: pErr.message }, 400);

  return json({ gameId: game.id, code, seat: 0 });
}

async function joinGame(db: any, userId: string, body: any) {
  const code = String(body.code ?? "").toUpperCase().trim();
  const displayName = cleanName(body.displayName);
  if (!displayName) return json({ error: "Inserisci il tuo nome" }, 400);

  const { data: game } = await db.from("games").select("*").eq("code", code).maybeSingle();
  if (!game) return json({ error: "Stanza non trovata" }, 404);
  if (game.status !== "lobby") return json({ error: "La partita è già iniziata" }, 400);

  const { data: players } = await db.from("game_players")
    .select("*").eq("game_id", game.id).order("seat");
  // già dentro? (aggiorna comunque il nome scelto)
  const mine = (players ?? []).find((p: any) => p.user_id === userId);
  if (mine) {
    await db.from("game_players").update({ display_name: displayName })
      .eq("game_id", game.id).eq("user_id", userId);
    return json({ gameId: game.id, code, seat: mine.seat });
  }

  if ((players?.length ?? 0) >= 5) return json({ error: "Stanza piena (max 5)" }, 400);
  const seat = players?.length ?? 0;
  const { error } = await db.from("game_players")
    .insert({ game_id: game.id, user_id: userId, seat, display_name: displayName });
  if (error) return json({ error: error.message }, 400);

  return json({ gameId: game.id, code, seat });
}

async function startGame(db: any, userId: string, body: any) {
  const { data: game } = await db.from("games").select("*").eq("id", body.gameId).single();
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (game.host_user !== userId) return json({ error: "Solo l'host può iniziare" }, 403);
  if (game.status !== "lobby") return json({ error: "Già iniziata" }, 400);

  const { data: players } = await db.from("game_players")
    .select("*").eq("game_id", game.id).order("seat");
  const n = players?.length ?? 0;
  if (n < 4 || n > 5) return json({ error: "Servono 4 o 5 giocatori (ora: " + n + ")" }, 400);

  const maxCards = E.maxCardsFor(n);
  const rounds = E.roundsSequence(maxCards);
  await db.from("games").update({
    status: "playing", num_players: n, max_cards: maxCards, rounds, round_index: 0,
  }).eq("id", game.id);

  await dealRoundDB(db, game.id, n, rounds, 0);
  return json({ ok: true });
}

async function declare(db: any, userId: string, body: any) {
  const { game, me } = await loadGameAndPlayer(db, body.gameId, userId);
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (game.phase !== "declaring") return json({ error: "Non è la fase di dichiarazione" }, 400);
  if (me.seat !== game.current_turn_seat) return json({ error: "Non è il tuo turno" }, 400);

  const value = Number(body.value);
  if (!Number.isInteger(value) || value < 0 || value > game.n_cards)
    return json({ error: "Dichiarazione fuori range" }, 400);

  const { data: players } = await db.from("game_players")
    .select("*").eq("game_id", game.id).order("seat");
  const n = game.num_players;
  const declaredCount = players.filter((p: any) => p.declared !== null).length;
  const isLast = declaredCount === n - 1;
  if (isLast) {
    const others = players.filter((p: any) => p.declared !== null).map((p: any) => p.declared);
    const forb = E.forbiddenLastDeclare(others, game.n_cards);
    if (forb !== null && value === forb)
      return json({ error: "Non puoi dichiarare " + forb + " (la somma non può fare " + game.n_cards + ")" }, 400);
  }

  await applyDeclare(db, game, me.seat, value, isLast, n);
  return json({ ok: true });
}

async function playCard(db: any, userId: string, body: any) {
  const { game, me } = await loadGameAndPlayer(db, body.gameId, userId);
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (game.phase !== "playing") return json({ error: "Non è la fase di gioco" }, 400);
  if (me.seat !== game.current_turn_seat) return json({ error: "Non è il tuo turno" }, 400);

  const card = body.card as E.Card;
  if (!card || !card.seed || !card.rank) return json({ error: "Carta mancante" }, 400);

  const hand = await loadHand(db, game, me.seat);
  if (!hand) return json({ error: "Mano non trovata" }, 400);

  const plays = (game.trick_plays ?? []) as E.Play[];
  const leadSeed: E.Seed | null = plays.length ? plays[0].card.seed : null;
  if (!E.isLegalPlay(hand, leadSeed, card))
    return json({ error: "Mossa non valida: devi rispondere al seme se puoi" }, 400);

  const res = await applyPlay(db, game, me.seat, card, hand);
  return json({ ok: true, ...res });
}

async function continueAfter(db: any, userId: string, body: any) {
  const { game } = await loadGameAndPlayer(db, body.gameId, userId);
  if (!game) return json({ error: "Partita non trovata" }, 404);
  const n = game.num_players;

  if (game.phase === "trick_done") {
    const nextTrick = game.trick_index + 1;
    if (nextTrick < game.n_cards) {
      await db.from("games").update({
        phase: "playing", trick_index: nextTrick,
        trick_lead_seat: game.last_trick_winner,
        current_turn_seat: game.last_trick_winner, trick_plays: [],
        turn_deadline: nextDeadline(),
      }).eq("id", game.id);
      return json({ ok: true });
    }
    // fine round -> punteggi
    await scoreRoundDB(db, game);
    await db.from("games").update({ phase: "round_end", turn_deadline: null }).eq("id", game.id);
    return json({ ok: true });
  }

  if (game.phase === "round_end") {
    const nextRound = game.round_index + 1;
    if (nextRound < game.rounds.length) {
      await dealRoundDB(db, game.id, n, game.rounds, nextRound);
    } else {
      // fine partita
      const { data: players } = await db.from("game_players")
        .select("*").eq("game_id", game.id).order("score", { ascending: false });
      const winnerSeat = players?.[0]?.seat ?? null;
      await db.from("games").update({
        phase: "finished", status: "finished", winner_seat: winnerSeat, turn_deadline: null,
      }).eq("id", game.id);
    }
    return json({ ok: true });
  }

  return json({ error: "Niente da continuare in questa fase" }, 400);
}

// Timeout: chiunque puo' chiamarla. Se il turno corrente e' scaduto, il server
// esegue una mossa automatica per il giocatore di turno. Idempotente: se il
// tempo non e' scaduto, non fa nulla (cosi' le chiamate "anticipate" non barano).
async function timeoutAction(db: any, userId: string, body: any) {
  const { game, me } = await loadGameAndPlayer(db, body.gameId, userId);
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (!me) return json({ error: "Non sei in questa partita" }, 403);
  if (game.phase !== "declaring" && game.phase !== "playing")
    return json({ ok: true, skipped: "phase" });
  if (!game.turn_deadline) return json({ ok: true, skipped: "no-deadline" });

  // 1s di tolleranza per il disallineamento di orologio tra client e server.
  const deadlineMs = new Date(game.turn_deadline).getTime();
  if (Date.now() < deadlineMs - 1000) return json({ ok: true, skipped: "not-expired" });

  const n = game.num_players;
  const seat = game.current_turn_seat;

  if (game.phase === "declaring") {
    const { data: players } = await db.from("game_players")
      .select("*").eq("game_id", game.id).order("seat");
    const declaredCount = players.filter((p: any) => p.declared !== null).length;
    const isLast = declaredCount === n - 1;
    const others = players.filter((p: any) => p.declared !== null).map((p: any) => p.declared);
    const value = E.autoPickDeclare(others, game.n_cards, isLast);
    await applyDeclare(db, game, seat, value, isLast, n);
    return json({ ok: true, auto: "declare", seat, value });
  }

  // playing
  const hand = await loadHand(db, game, seat);
  if (!hand || hand.length === 0) return json({ ok: true, skipped: "no-hand" });
  const plays = (game.trick_plays ?? []) as E.Play[];
  const leadSeed: E.Seed | null = plays.length ? plays[0].card.seed : null;
  const hierarchy = game.is_no_trump ? E.HIER_TRESETTE : E.HIER_BRISCOLA;
  const card = E.autoPickCard(hand, leadSeed, hierarchy);
  const res = await applyPlay(db, game, seat, card, hand);
  return json({ ok: true, auto: "play", seat, card, ...res });
}

// ---------------- HELPERS DI MUTAZIONE ----------------

// Registra la dichiarazione di `seat`, poi avanza il turno o apre il gioco.
async function applyDeclare(db: any, game: any, seat: number, value: number, isLast: boolean, n: number) {
  await db.from("game_players").update({ declared: value })
    .eq("game_id", game.id).eq("seat", seat);

  if (isLast) {
    // tutte fatte -> si gioca; apre il primo (trick_lead_seat)
    await db.from("games").update({
      phase: "playing", current_turn_seat: game.trick_lead_seat,
      trick_index: 0, trick_plays: [], turn_deadline: nextDeadline(),
    }).eq("id", game.id);
  } else {
    const next = (game.current_turn_seat + 1) % n;
    await db.from("games").update({
      current_turn_seat: next, turn_deadline: nextDeadline(),
    }).eq("id", game.id);
  }
}

// Gioca `card` (gia' verificata legale) dalla mano `hand` di `seat`:
// toglie la carta, aggiorna il tavolo e, se la presa e' completa, risolve.
async function applyPlay(db: any, game: any, seat: number, card: E.Card, hand: E.Card[]) {
  const idx = hand.findIndex((c) => c.seed === card.seed && c.rank === card.rank);
  if (idx < 0) return { error: "carta-non-in-mano" };
  hand.splice(idx, 1);
  await db.from("hands").update({ cards: hand })
    .eq("game_id", game.id).eq("round_index", game.round_index).eq("seat", seat);

  const plays = (game.trick_plays ?? []) as E.Play[];
  const newPlays = [...plays, { seat, card }];
  const n = game.num_players;

  if (newPlays.length < n) {
    const next = (game.current_turn_seat + 1) % n;
    await db.from("games").update({
      trick_plays: newPlays, current_turn_seat: next, turn_deadline: nextDeadline(),
    }).eq("id", game.id);
    return {};
  }

  // presa completa -> vincitore
  const briscolaSeed: E.Seed | null = game.briscola ? game.briscola.seed : null;
  const hierarchy = game.is_no_trump ? E.HIER_TRESETTE : E.HIER_BRISCOLA;
  const winner = E.resolveTrick(newPlays, briscolaSeed, hierarchy);

  const winnerTaken = await taken(db, game.id, winner);
  await db.from("game_players").update({ taken: winnerTaken + 1 })
    .eq("game_id", game.id).eq("seat", winner);

  await db.from("games").update({
    trick_plays: newPlays, phase: "trick_done",
    last_trick_winner: winner, current_turn_seat: winner, turn_deadline: null,
  }).eq("id", game.id);
  return { trickWinner: winner };
}

// ---------------- HELPERS DI LETTURA ----------------

async function loadGameAndPlayer(db: any, gameId: string, userId: string) {
  const { data: game } = await db.from("games").select("*").eq("id", gameId).single();
  if (!game) return { game: null, me: null };
  const { data: me } = await db.from("game_players").select("*")
    .eq("game_id", gameId).eq("user_id", userId).maybeSingle();
  return { game, me };
}

async function loadHand(db: any, game: any, seat: number): Promise<E.Card[] | null> {
  const { data: handRow } = await db.from("hands").select("cards")
    .eq("game_id", game.id).eq("round_index", game.round_index).eq("seat", seat).maybeSingle();
  return handRow ? (handRow.cards as E.Card[]) : null;
}

async function taken(db: any, gameId: string, seat: number): Promise<number> {
  const { data } = await db.from("game_players").select("taken")
    .eq("game_id", gameId).eq("seat", seat).single();
  return data?.taken ?? 0;
}

function cleanName(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, 14);
}

// ---------------- DISTRIBUZIONE / PUNTEGGI ----------------

// Distribuisce un round e scrive tutto nel DB
async function dealRoundDB(db: any, gameId: string, n: number, rounds: number[], roundIndex: number) {
  const nCards = rounds[roundIndex];
  const firstSeat = E.firstSeatFor(n, roundIndex);
  const d = E.dealRound(n, nCards, firstSeat);

  // mani (private)
  const { data: players } = await db.from("game_players")
    .select("seat,user_id").eq("game_id", gameId).order("seat");
  const handRows = (players ?? []).map((p: any) => ({
    game_id: gameId, round_index: roundIndex, seat: p.seat,
    user_id: p.user_id, cards: d.hands[p.seat],
  }));
  await db.from("hands").upsert(handRows, { onConflict: "game_id,round_index,seat" });

  // reset dichiarazioni/prese
  await db.from("game_players").update({ declared: null, taken: 0 }).eq("game_id", gameId);

  await db.from("games").update({
    round_index: roundIndex, n_cards: nCards, dealer_seat: E.dealerFor(n, roundIndex),
    current_turn_seat: firstSeat, briscola: d.briscola, is_no_trump: d.isNoTrump,
    trick_index: 0, trick_lead_seat: firstSeat, trick_plays: [], last_trick_winner: null,
    phase: "declaring", status: "playing", turn_deadline: nextDeadline(),
  }).eq("id", gameId);
}

// Calcola e applica i punti di fine round
async function scoreRoundDB(db: any, game: any) {
  const { data: players } = await db.from("game_players")
    .select("*").eq("game_id", game.id).order("seat");
  for (const p of players) {
    const pts = E.scoreRound(p.declared ?? 0, p.taken);
    await db.from("game_players").update({ score: p.score + pts })
      .eq("game_id", game.id).eq("seat", p.seat);
    await db.from("round_results").insert({
      game_id: game.id, round_index: game.round_index, seat: p.seat,
      declared: p.declared ?? 0, taken: p.taken, points: pts,
    });
  }
}
