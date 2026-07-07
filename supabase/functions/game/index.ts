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
//   - send_message{ gameId, body }            (membro: invia un messaggio di chat)
//   - set_bots    { gameId, count }            (host/lobby: imposta quanti bot)
//   - toggle_autoplay { gameId, on? }          (AUTOGAME: delega/riprendi il posto a un bot ML)
//   - claim_all   { gameId }                   (TUTTO MIO: pretende tutte le prese restanti)
//   - advance_bot { gameId }                   (host: fa fare UNA mossa al bot/autoplay di turno)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as E from "../_shared/engine.ts";
import * as H from "../_shared/history.ts";
import * as M from "../_shared/mlbot.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Secondi a disposizione di ogni giocatore per ogni mossa (dichiarazione o carta).
const TURN_SECONDS = 30;

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
      case "send_message":  return await sendMessage(db, user.id, body);
      case "set_bots":      return await setBots(db, user.id, body);
      case "toggle_autoplay": return await toggleAutoplay(db, user.id, body);
      case "claim_all":     return await claimAll(db, user.id, body);
      case "advance_bot":   return await advanceBot(db, user.id, body);
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

  await dealRoundDB(db, game.id, n, rounds, 0);  return json({ ok: true });
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

  await applyDeclare(db, game, me.seat, value, isLast, n);  return json({ ok: true });
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
      // CAS: vince solo la prima `continue` (phase ancora trick_done) → niente
      // doppio avanzamento di presa se due richieste arrivano insieme.
      const { data: adv } = await db.from("games").update({
        phase: "playing", trick_index: nextTrick,
        trick_lead_seat: game.last_trick_winner,
        current_turn_seat: game.last_trick_winner, trick_plays: [],
        turn_deadline: nextDeadline(),
      }).eq("id", game.id).eq("phase", "trick_done").select("id");
      return json({ ok: true, advanced: !!(adv && adv.length) });
    }
    // fine round: prima CLAIM (trick_done → round_end), poi calcola i punti.
    // Così i punteggi non vengono applicati due volte da `continue` concorrenti.
    const { data: claimed } = await db.from("games")
      .update({ phase: "round_end", turn_deadline: null })
      .eq("id", game.id).eq("phase", "trick_done").select("id");
    if (claimed && claimed.length) await scoreRoundDB(db, game);
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

      // --- HISTORY: finalizza partita (games + players) — best-effort ---
      await H.logGameFinished(db, game.id, winnerSeat, (players ?? []).map((p: any) => ({
        seat: p.seat, user_id: p.user_id, display_name: p.display_name, score: p.score,
      })));

      // i bot sfottono l'ultimo / esultano se vincono
      await trashAtGameEnd(db, game, players ?? []);
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

// Invia un messaggio di chat nella stanza. Solo i membri possono scrivere.
// Validazioni: non vuoto, max 300 caratteri, anti-spam (>=1s dall'ultimo proprio msg).
async function sendMessage(db: any, userId: string, body: any) {
  const { game, me } = await loadGameAndPlayer(db, body.gameId, userId);
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (!me) return json({ error: "Non sei in questa partita" }, 403);

  let text = String(body.body ?? "").trim();
  if (!text) return json({ error: "Messaggio vuoto" }, 400);
  if (text.length > 300) text = text.slice(0, 300);

  // anti-spam: rifiuta se l'ultimo messaggio di questo utente e' < 1000ms fa
  const { data: last } = await db.from("chat_messages")
    .select("created_at").eq("game_id", game.id).eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - new Date(last.created_at).getTime() < 1000)
    return json({ error: "Aspetta un attimo prima di riscrivere" }, 400);

  const { error } = await db.from("chat_messages").insert({
    game_id: game.id,
    user_id: userId,
    seat: me.seat,
    display_name: me.display_name,
    body: text,
  });
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}

// Host: imposta QUANTI bot avere nella stanza (solo in lobby). I bot sono righe
// game_players con is_bot=true e user_id sintetico. Ricompatta i posti a 0..n-1.
async function setBots(db: any, userId: string, body: any) {
  const { data: game } = await db.from("games").select("*").eq("id", body.gameId).single();
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (game.host_user !== userId) return json({ error: "Solo l'host può gestire i bot" }, 403);
  if (game.status !== "lobby") return json({ error: "I bot si impostano solo prima dell'inizio" }, 400);

  let count = Number(body.count);
  if (!Number.isInteger(count) || count < 0) return json({ error: "Numero bot non valido" }, 400);

  const { data: players } = await db.from("game_players")
    .select("*").eq("game_id", game.id).order("seat");
  const humans = (players ?? []).filter((p: any) => !p.is_bot)
    .sort((a: any, b: any) => new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime());
  const H = humans.length;
  const maxBots = 5 - H;
  if (count > maxBots) count = maxBots;

  // 1) rimuovi i bot esistenti (libera i posti)
  await db.from("game_players").delete().eq("game_id", game.id).eq("is_bot", true);

  // 2) ricompatta gli umani su 0..H-1 (posti temporanei negativi per non violare unique)
  for (let i = 0; i < H; i++) {
    await db.from("game_players").update({ seat: -(i + 1) })
      .eq("game_id", game.id).eq("user_id", humans[i].user_id);
  }
  for (let i = 0; i < H; i++) {
    await db.from("game_players").update({ seat: i })
      .eq("game_id", game.id).eq("user_id", humans[i].user_id);
  }

  // 3) inserisci `count` bot ai posti H..H+count-1
  const botRows = [];
  for (let i = 0; i < count; i++) {
    botRows.push({
      game_id: game.id, user_id: crypto.randomUUID(), seat: H + i,
      display_name: "Bot " + (i + 1), is_bot: true,
    });
  }
  if (botRows.length) {
    const { error } = await db.from("game_players").insert(botRows);
    if (error) return json({ error: error.message }, 400);
  }
  return json({ ok: true, humans: H, bots: count });
}

// Inserisce un messaggio "di sistema" nella chat della stanza (notifiche di gioco).
async function systemChat(db: any, game: any, seat: number, name: string, text: string) {
  await db.from("chat_messages").insert({
    game_id: game.id, user_id: crypto.randomUUID(), seat, display_name: name, body: text,
  }).then(() => {}, () => {});  // best-effort: una notifica non deve mai bloccare l'azione
}

// ================= TRASHTALKING DEI BOT (sfottò tra amici) =================
// Interruttore: metti false per spegnere tutto.
const TRASH_TALK = true;

// Battute (italiano, tono pesante da amici). Placeholder: {name} {d} {t}.
const TRASH = {
  whiff: [
    "ahahah {name} sei un coglione, chiami {d} e ne fai {t} 😂",
    "{name} ma che cazzo chiami {d}?? ne fai {t}, una pippa",
    "bravo {name}: {d} dichiarate, {t} portate a casa. Fenomeno 💀",
    "{name} loool {d}?? ma giochi col culo?",
    "guardate {name}: {d} chiamate e {t} fatte 😂😂",
    "{name} che giocatore di merda, manco {d} prese sai fare",
    "{name} {d} chiamate ahahah ma sei negato proprio",
  ],
  zero: [
    "{name} ZERO prese ahahah ma vai a giocare a briscola va",
    "cappotto per {name} 💀 {d} chiamate e ZERO fatte, imbarazzante",
    "{name} ne hai fatte ZERO?? ma che ci sei venuto a fare 😂",
  ],
  over: [
    "{name} ne fai {t} e ne chiami {d}... impara a contare coglione 😂",
    "{name} {t} prese ma ne avevi dette {d}, ma che giochi a fare a caso?",
  ],
  loser: [
    "{name} ULTIMO. Come sempre del resto 💀",
    "complimenti {name}, ultimo posto, sei una pippa pazzesca 😂",
    "{name} hai perso pure stavolta, che tristezza ahahah",
    "{name} ultimo 🥱 ma lascia perdere ste carte va",
  ],
  gloat: [
    "ve l'avevo detto che vincevo io, umani scarsi 😎",
    "GG facile, tornate quando sapete giocare 😂",
    "vinco io come al solito, che noia battervi 🤖",
  ],
  claimFail: [
    "{name} TUTTO MIO un cazzo ahahah te le sei sognate le prese 💀",
    "ahahah {name} 'tutto mio' e non prende una sega, che figura",
    "{name} ma chi ti credi di essere, TUTTO MIO 😂 sei scarso",
  ],
  steal: [
    "{name} scemo coglione 💀",
    "{name} coglione 😂",
    "ahah {name} che scarso",
    "{name} pippa 💀",
    "{name} sei scarso coglione",
  ],
};

const tpick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
const tfmt = (tpl: string, v: Record<string, any>) =>
  tpl.replace(/\{(\w+)\}/g, (_m, k) => String(v[k] ?? ""));

// Posta un messaggio di chat COME un bot specifico (col suo nome/posto reali).
async function botChat(db: any, game: any, bot: any, text: string) {
  await db.from("chat_messages").insert({
    game_id: game.id, user_id: bot.user_id, seat: bot.seat,
    display_name: bot.display_name, body: text,
  }).then(() => {}, () => {});
}

// Sceglie un bot a caso che faccia da "bocca" (diverso dal bersaglio).
function pickSpeakerBot(players: any[], excludeSeat: number) {
  const bots = (players ?? []).filter((p) => p.is_bot && p.seat !== excludeSeat);
  return bots.length ? bots[Math.floor(Math.random() * bots.length)] : null;
}

// Fine mano: un bot sfotte chi ha sbagliato di più la dichiarazione (preferendo gli umani).
async function trashAfterRound(db: any, game: any, players: any[], outcomeRows: any[]) {
  if (!TRASH_TALK) return;
  if (!players.some((p) => p.is_bot)) return;
  if (Math.random() > 0.65) return;                       // non a ogni mano
  const bySeat = new Map(players.map((p) => [p.seat, p]));
  const misses = outcomeRows.filter((o) => o.declared !== o.taken);
  if (!misses.length) return;
  const humanMisses = misses.filter((o) => !bySeat.get(o.seat)?.is_bot);
  const pool = humanMisses.length ? humanMisses : misses;
  pool.sort((a, b) => Math.abs(b.declared - b.taken) - Math.abs(a.declared - a.taken));
  const target = pool[0];
  const tp = bySeat.get(target.seat);
  const speaker = pickSpeakerBot(players, target.seat);
  if (!speaker || !tp) return;
  const vars = { name: tp.display_name, d: target.declared, t: target.taken };
  const line = (target.taken === 0 && target.declared > 0)
    ? tfmt(tpick(TRASH.zero), vars)
    : (target.taken > target.declared ? tfmt(tpick(TRASH.over), vars) : tfmt(tpick(TRASH.whiff), vars));
  await botChat(db, game, speaker, line);
}

// Fine partita: sfottò all'ultimo in classifica + gloat se vince un bot.
async function trashAtGameEnd(db: any, game: any, players: any[]) {
  if (!TRASH_TALK) return;
  if (!players.some((p) => p.is_bot)) return;
  const sorted = players.slice().sort((a, b) => a.score - b.score);
  const last = sorted[0];
  const winner = sorted[sorted.length - 1];
  const speaker = pickSpeakerBot(players, last.seat);
  if (speaker && !last.is_bot) {
    await botChat(db, game, speaker, tfmt(tpick(TRASH.loser), { name: last.display_name }));
  }
  if (winner.is_bot) await botChat(db, game, winner, tpick(TRASH.gloat));
}

// Presa rubata: ogni tanto, quando un bot vince una presa con un umano dentro.
async function trashStolenTrick(db: any, game: any, newPlays: E.Play[], winnerSeat: number) {
  if (!TRASH_TALK) return;
  if (Math.random() > 0.2) return;                        // raramente, niente spam
  const { data: players } = await db.from("game_players")
    .select("seat,user_id,display_name,is_bot").eq("game_id", game.id);
  const bySeat = new Map((players ?? []).map((p: any) => [p.seat, p]));
  const win = bySeat.get(winnerSeat) as any;
  if (!win || !win.is_bot) return;
  const humans = newPlays
    .map((pl) => bySeat.get(pl.seat) as any)
    .filter((p) => p && !p.is_bot && p.seat !== winnerSeat);
  if (!humans.length) return;
  const target = humans[Math.floor(Math.random() * humans.length)];
  await botChat(db, game, win, tfmt(tpick(TRASH.steal), { name: target.display_name }));
}

// AUTOGAME: un giocatore delega (o riprende) il proprio posto al bot ML. Reversibile.
async function toggleAutoplay(db: any, userId: string, body: any) {
  const { game, me } = await loadGameAndPlayer(db, body.gameId, userId);
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (!me) return json({ error: "Non sei in questa partita" }, 403);
  if (me.is_bot) return json({ error: "Questo posto è già un bot" }, 400);

  const on = body.on === undefined ? !me.autoplay : !!body.on;
  await db.from("game_players").update({ autoplay: on })
    .eq("game_id", game.id).eq("seat", me.seat);

  await systemChat(db, game, me.seat, me.display_name,
    on ? "🤖 è passato in AUTOGAME (gioca il bot)" : "🙋 ha ripreso il controllo");

  // Se è già il suo turno, ci pensa il client host a far partire il bot (con il
  // ritardo di 2-3s, via azione advance_bot); il timeout resta come riserva.
  return json({ ok: true, autoplay: on });
}

// TUTTO MIO: il giocatore dichiara di prendere TUTTE le prese restanti. Verifichiamo
// (engine.verifyClaimAll, analisi doppio morto) se è dimostrabile contro qualsiasi
// difesa. Se sì, assegniamo le prese e chiudiamo il round; se è falsa, penalità e si
// continua; se non verificabile entro il budget, si continua senza penalità.
async function claimAll(db: any, userId: string, body: any) {
  const { game, me } = await loadGameAndPlayer(db, body.gameId, userId);
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (!me) return json({ error: "Non sei in questa partita" }, 403);
  if (game.phase !== "playing") return json({ error: "Puoi dichiarare TUTTO MIO solo mentre si gioca" }, 400);
  if (me.seat !== game.current_turn_seat) return json({ error: "Puoi dichiarare TUTTO MIO solo nel tuo turno" }, 400);

  // CLAIM del turno: impedisce che un timeout giochi una carta mentre verifichiamo.
  const { data: claimedTurn } = await db.from("games").update({ turn_deadline: null })
    .eq("id", game.id).eq("phase", "playing").eq("current_turn_seat", me.seat)
    .not("turn_deadline", "is", null).select("id");
  if (!claimedTurn || claimedTurn.length === 0)
    return json({ error: "Riprova: il turno è appena cambiato" }, 409);

  const n = game.num_players;
  const remaining = game.n_cards - game.trick_index;  // prese restanti (inclusa quella in corso)

  // carica tutte le mani residue del round
  const { data: handRows } = await db.from("hands").select("seat,cards")
    .eq("game_id", game.id).eq("round_index", game.round_index);
  const hands: Record<number, E.Card[]> = {};
  for (const r of handRows ?? []) hands[r.seat] = (r.cards as E.Card[]) ?? [];
  if (!hands[me.seat] || hands[me.seat].length === 0)
    return json({ error: "Non hai carte in mano" }, 400);

  const table = (game.trick_plays ?? []) as E.Play[];
  const briscolaSeed: E.Seed | null = game.briscola ? game.briscola.seed : null;
  const hierarchy = game.is_no_trump ? E.HIER_TRESETTE : E.HIER_BRISCOLA;

  await systemChat(db, game, me.seat, me.display_name,
    "🃏 TUTTO MIO! dichiara di prendere tutte le " + remaining + " prese restanti…");

  const verdict = E.verifyClaimAll(hands, me.seat, table, me.seat, n, briscolaSeed, hierarchy);

  if (verdict === "proven") {
    // assegna al claimant le prese restanti e chiudi il round
    const newTaken = (me.taken ?? 0) + remaining;
    await db.from("game_players").update({ taken: newTaken })
      .eq("game_id", game.id).eq("seat", me.seat);
    await scoreRoundDB(db, game);
    await db.from("games").update({ phase: "round_end", turn_deadline: null }).eq("id", game.id);
    await systemChat(db, game, me.seat, me.display_name,
      "✅ TUTTO MIO confermato: prende tutte le prese restanti. Round chiuso.");
    return json({ ok: true, verdict, awarded: remaining });
  }

  // Non confermato: si continua a giocare → ripristino il timer del turno (era
  // stato azzerato dal claim) così il giocatore può giocare normalmente.
  await db.from("games").update({ turn_deadline: nextDeadline() }).eq("id", game.id);

  if (verdict === "refuted") {
    // penalità proporzionale alla baldanza: -(prese che pretendeva)
    const penalty = remaining;
    await db.from("game_players").update({ score: (me.score ?? 0) - penalty })
      .eq("game_id", game.id).eq("seat", me.seat);
    await systemChat(db, game, me.seat, me.display_name,
      "❌ TUTTO MIO sbagliato! Non prenderebbe tutto: penalità −" + penalty + ". Si continua.");
    // un bot infierisce sul TUTTO MIO fallito
    if (TRASH_TALK) {
      const { data: pls } = await db.from("game_players")
        .select("seat,user_id,display_name,is_bot").eq("game_id", game.id);
      const speaker = pickSpeakerBot(pls ?? [], me.seat);
      if (speaker) await botChat(db, game, speaker, tfmt(tpick(TRASH.claimFail), { name: me.display_name }));
    }
    return json({ ok: true, verdict, penalty });
  }

  // too_complex
  await systemChat(db, game, me.seat, me.display_name,
    "⚠️ TUTTO MIO non verificabile in automatico: si continua a giocare.");
  return json({ ok: true, verdict });
}

// Azione: fa fare UNA mossa al bot/autoplay di turno. La chiama il client host
// dopo 2-3s quando tocca a un bot (vedi maybePumpBot nel frontend). Deve essere
// un membro della partita. Idempotente grazie ai claim in applyDeclare/applyPlay.
async function advanceBot(db: any, userId: string, body: any) {
  const { game, me } = await loadGameAndPlayer(db, body.gameId, userId);
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (!me) return json({ error: "Non sei in questa partita" }, 403);
  const acted = await botStepOnce(db, game.id);
  return json({ ok: true, acted });
}

// Esegue UNA mossa per il bot/autoplay di turno (dichiarazione o carta), con i
// modelli ML (fallback euristica). Ritorna true se ha agito. Il timing (attesa
// 2-3s tra una mossa e l'altra) è guidato dal client host, così le mosse non
// sono istantanee e si vedono "pensare" i bot. Le applyDeclare/applyPlay hanno
// un claim atomico, quindi chiamate doppie/concorrenti non rompono nulla.
async function botStepOnce(db: any, gameId: string): Promise<boolean> {
  const { data: game } = await db.from("games").select("*").eq("id", gameId).single();
  if (!game) return false;
  if (game.phase !== "declaring" && game.phase !== "playing") return false;
  const seat = game.current_turn_seat;
  const { data: me } = await db.from("game_players").select("*")
    .eq("game_id", gameId).eq("seat", seat).maybeSingle();
  // Gioca in automatico per: i bot della lobby (is_bot) e gli umani in AUTOGAME (autoplay).
  if (!me || !(me.is_bot || me.autoplay)) return false;  // turno di un umano attivo
  const n = game.num_players;
  const useModels = M.modelsLoaded();

  if (game.phase === "declaring") {
    const { data: players } = await db.from("game_players")
      .select("*").eq("game_id", gameId).order("seat");
    const declaredCount = players.filter((p: any) => p.declared !== null).length;
    const isLast = declaredCount === n - 1;
    const order = E.seatOrder(n, game.trick_lead_seat);
    const bySeat = new Map(players.map((p: any) => [p.seat, p]));
    const myOrder = order.indexOf(seat);
    const prior = order.slice(0, myOrder)
      .map((s) => (bySeat.get(s) as any)?.declared)
      .filter((v) => v !== null && v !== undefined) as number[];
    const hand = await loadHand(db, game, seat);
    const value = useModels
      ? M.modelDeclare({
          hand: hand ?? [], briscola: game.briscola, isNoTrump: game.is_no_trump,
          nCards: game.n_cards, numPlayers: n, declarationOrder: myOrder,
          isLast, priorDeclares: prior,
        })
      : E.botDeclare(hand ?? [], game.briscola, game.is_no_trump,
          game.n_cards, isLast, prior);
    await applyDeclare(db, game, seat, value, isLast, n);
  } else {
    const hand = await loadHand(db, game, seat);
    if (!hand || hand.length === 0) return false;
    const plays = (game.trick_plays ?? []) as E.Play[];
    const leadSeed: E.Seed | null = plays.length ? plays[0].card.seed : null;
    const briscolaSeed: E.Seed | null = game.briscola ? game.briscola.seed : null;
    const card = useModels
      ? M.modelPlay({
          hand, table: plays, leadSeed, briscolaSeed, isNoTrump: game.is_no_trump,
          nCards: game.n_cards, numPlayers: n, trickIndex: game.trick_index,
          declared: me.declared ?? 0, takenSoFar: me.taken ?? 0, mySeat: seat,
        })
      : E.botPlay(hand, plays, leadSeed, briscolaSeed, game.is_no_trump,
          game.n_cards, game.trick_index, me.declared ?? 0, me.taken ?? 0, seat);
    await applyPlay(db, game, seat, card, hand);
  }
  return true;
}

// ---------------- HELPERS DI MUTAZIONE (bot + umani) ----------------

// Registra la dichiarazione di `seat`, poi avanza il turno o apre il gioco.
// CLAIM ATOMICO: la update vale solo se `declared` è ancora NULL per quel posto.
// Così, se `declare` (umano) e `timeout` (auto) arrivano insieme, una sola vince
// e il turno avanza UNA volta sola (niente giocatori saltati). Il valore umano
// è preservato perché chi scrive per primo "blocca" la cella.
async function applyDeclare(db: any, game: any, seat: number, value: number, isLast: boolean, n: number) {
  const { data: claimed } = await db.from("game_players").update({ declared: value })
    .eq("game_id", game.id).eq("seat", seat).is("declared", null).select("seat");
  if (!claimed || claimed.length === 0) return;  // qualcun altro ha già dichiarato per questo posto

  await H.logDeclaration(db, game, seat, value, isLast, n);

  if (isLast) {
    await db.from("games").update({
      phase: "playing",
      current_turn_seat: game.trick_lead_seat,
      trick_index: 0,
      trick_plays: [],
      turn_deadline: nextDeadline(),
    }).eq("id", game.id);
  } else {
    const next = (game.current_turn_seat + 1) % n;
    await db.from("games").update({
      current_turn_seat: next,
      turn_deadline: nextDeadline(),
    }).eq("id", game.id);
  }
}

// Gioca `card` (gia' verificata legale) dalla mano `hand` di `seat`:
// toglie la carta, aggiorna il tavolo e, se la presa e' completa, risolve.
// CLAIM ATOMICO: azzera `turn_deadline` solo se è ancora il turno di `seat` in
// fase playing (e il deadline non è già null). Una sola richiesta vince, quindi
// `play_card` e `timeout` concorrenti non giocano due carte / non saltano turni.
async function applyPlay(db: any, gameSnap: any, seat: number, card: E.Card, hand: E.Card[]) {
  const { data: claimed } = await db.from("games").update({ turn_deadline: null })
    .eq("id", gameSnap.id).eq("phase", "playing").eq("current_turn_seat", seat)
    .not("turn_deadline", "is", null).select("id");
  if (!claimed || claimed.length === 0) return { lost: true };  // turno già gestito da un'altra richiesta

  // stato autorevole DOPO il claim (evita snapshot stantii del tavolo)
  const { data: game } = await db.from("games").select("*").eq("id", gameSnap.id).single();

  const idx = hand.findIndex((c) => c.seed === card.seed && c.rank === card.rank);
  if (idx < 0) return { error: "carta-non-in-mano" };

  const handBefore = hand.slice();
  hand.splice(idx, 1);

  await db.from("hands").update({ cards: hand })
    .eq("game_id", game.id)
    .eq("round_index", game.round_index)
    .eq("seat", seat);

  const plays = (game.trick_plays ?? []) as E.Play[];

  await H.logPlay(db, game, seat, card, handBefore, plays);

  const newPlays = [...plays, { seat, card }];
  const n = game.num_players;

  if (newPlays.length < n) {
    const next = (game.current_turn_seat + 1) % n;
    await db.from("games").update({
      trick_plays: newPlays,
      current_turn_seat: next,
      turn_deadline: nextDeadline(),
    }).eq("id", game.id);
    return {};
  }

  const briscolaSeed: E.Seed | null = game.briscola ? game.briscola.seed : null;
  const hierarchy = game.is_no_trump ? E.HIER_TRESETTE : E.HIER_BRISCOLA;
  const winner = E.resolveTrick(newPlays, briscolaSeed, hierarchy);

  const winnerTaken = await taken(db, game.id, winner);
  await db.from("game_players").update({ taken: winnerTaken + 1 })
    .eq("game_id", game.id).eq("seat", winner);

  await H.logTrickResolved(db, game, game.trick_index, newPlays, winner);

  await db.from("games").update({
    trick_plays: newPlays,
    phase: "trick_done",
    last_trick_winner: winner,
    current_turn_seat: winner,
    turn_deadline: null,
  }).eq("id", game.id);

  // ogni tanto un bot punzecchia l'umano a cui ha rubato la presa
  await trashStolenTrick(db, game, newPlays, winner);

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
    .eq("game_id", game.id)
    .eq("round_index", game.round_index)
    .eq("seat", seat)
    .maybeSingle();

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

  const { data: players } = await db.from("game_players")
    .select("seat,user_id").eq("game_id", gameId).order("seat");

  const handRows = (players ?? []).map((p: any) => ({
    game_id: gameId,
    round_index: roundIndex,
    seat: p.seat,
    user_id: p.user_id,
    cards: d.hands[p.seat],
  }));

  await db.from("hands").upsert(handRows, { onConflict: "game_id,round_index,seat" });

  await H.logRoundStart(db, gameId, n, roundIndex, nCards, firstSeat, d, players ?? []);

  await db.from("game_players").update({ declared: null, taken: 0 }).eq("game_id", gameId);

  await db.from("games").update({
    round_index: roundIndex,
    n_cards: nCards,
    dealer_seat: E.dealerFor(n, roundIndex),
    current_turn_seat: firstSeat,
    briscola: d.briscola,
    is_no_trump: d.isNoTrump,
    trick_index: 0,
    trick_lead_seat: firstSeat,
    trick_plays: [],
    last_trick_winner: null,
    phase: "declaring",
    status: "playing",
    turn_deadline: nextDeadline(),
  }).eq("id", gameId);
}

// Calcola e applica i punti di fine round
async function scoreRoundDB(db: any, game: any) {
  const { data: players } = await db.from("game_players")
    .select("*").eq("game_id", game.id).order("seat");

  const outcomeRows: any[] = [];

  for (const p of players ?? []) {
    const pts = E.scoreRound(p.declared ?? 0, p.taken);
    const scoreAfter = p.score + pts;

    await db.from("game_players").update({ score: scoreAfter })
      .eq("game_id", game.id).eq("seat", p.seat);

    await db.from("round_results").insert({
      game_id: game.id,
      round_index: game.round_index,
      seat: p.seat,
      declared: p.declared ?? 0,
      taken: p.taken,
      points: pts,
    });

    outcomeRows.push({
      seat: p.seat,
      user_id: p.user_id,
      declared: p.declared ?? 0,
      taken: p.taken,
      points: pts,
      scoreAfter,
    });
  }

  await H.logRoundOutcomes(db, game, outcomeRows);

  // i bot sfottono chi ha sbagliato la dichiarazione
  await trashAfterRound(db, game, players ?? [], outcomeRows);
}