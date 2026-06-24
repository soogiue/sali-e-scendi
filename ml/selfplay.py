"""
Self-play: fa giocare i bot tra loro col motore Python e produce i dataset di
training, EVENT-LEVEL, con gli stessi segnali della tabella history:

  - dataset DICHIARAZIONE: (stato a inizio round) -> prese effettive del round
  - dataset GIOCO:         (stato + carta scelta) -> punti round finali del seat

Questi due segnali sono "auto-etichettanti": il risultato lo conosciamo a fine
round, quindi non serve nessuna annotazione manuale.
"""
from __future__ import annotations
import random
import numpy as np
from engine import (
    Card, Play, deal_round, seat_order, first_seat_for, dealer_for,
    max_cards_for, rounds_sequence, resolve_trick, score_round,
    HIER_BRISCOLA, HIER_TRESETTE,
)
import features as F


def play_round(n, round_index, n_cards, bots, rng, decl_rows, play_rows):
    first_seat = first_seat_for(n, round_index)
    deal = deal_round(n, n_cards, first_seat, rng)
    hands = [list(h) for h in deal.hands]
    hier = HIER_TRESETTE if deal.is_no_trump else HIER_BRISCOLA
    bseed = deal.briscola.seed if deal.briscola else None
    order = seat_order(n, first_seat)

    # --- DICHIARAZIONI ---
    declared = [None] * n
    decl_sample = {}  # seat -> feature vec
    for idx, seat in enumerate(order):
        prior = [declared[s] for s in order[:idx]]
        ctx = {
            "hand": hands[seat], "briscola": deal.briscola,
            "is_no_trump": deal.is_no_trump, "n_cards": n_cards,
            "num_players": n, "declaration_order": idx,
            "is_last": idx == n - 1, "prior_declares": prior,
        }
        decl_sample[seat] = F.encode_declaration(ctx)
        declared[seat] = bots[seat].declare(ctx)

    # --- GIOCO ---
    taken = [0] * n
    play_sample = {seat: [] for seat in range(n)}  # seat -> list[feature vec]
    lead_seat = first_seat
    for trick_index in range(n_cards):
        table: list[Play] = []
        for seat in seat_order(n, lead_seat):
            lead_seed = table[0].card.seed if table else None
            ctx = {
                "hand": hands[seat], "table": table, "lead_seed": lead_seed,
                "briscola_seed": bseed, "is_no_trump": deal.is_no_trump,
                "n_cards": n_cards, "num_players": n, "trick_index": trick_index,
                "declared": declared[seat], "taken_so_far": taken[seat],
                "my_seat": seat,
            }
            card = bots[seat].play(ctx)
            play_sample[seat].append(F.encode_play(ctx, card))
            # rimuovi la carta dalla mano
            hands[seat] = [c for c in hands[seat]
                           if not (c.seed == card.seed and c.rank == card.rank)]
            table.append(Play(seat, card))
        lead_seat = resolve_trick(table, bseed, hier)
        taken[lead_seat] += 1

    # --- ETICHETTE (note solo a fine round) ---
    points = [score_round(declared[s], taken[s]) for s in range(n)]
    for seat in range(n):
        decl_rows[0].append(decl_sample[seat])
        decl_rows[1].append(taken[seat])               # target dichiarazione
        for vec in play_sample[seat]:
            play_rows[0].append(vec)
            play_rows[1].append(points[seat])          # target gioco
    return points


def play_game(make_bots, rng, num_players=None):
    n = num_players or rng.choice([4, 5])
    bots = make_bots(rng, n)
    max_cards = max_cards_for(n)
    rounds = rounds_sequence(max_cards)
    scores = [0] * n
    decl_rows = ([], [])
    play_rows = ([], [])
    for ri, n_cards in enumerate(rounds):
        pts = play_round(n, ri, n_cards, bots, rng, decl_rows, play_rows)
        for s in range(n):
            scores[s] += pts[s]
    return scores, decl_rows, play_rows


def generate_dataset(n_games, make_bots, seed=0, num_players=None, verbose=True):
    rng = random.Random(seed)
    DX, Dy, PX, Py = [], [], [], []
    for g in range(n_games):
        _, decl_rows, play_rows = play_game(make_bots, rng, num_players)
        DX += decl_rows[0]; Dy += decl_rows[1]
        PX += play_rows[0]; Py += play_rows[1]
        if verbose and (g + 1) % max(1, n_games // 10) == 0:
            print(f"  self-play: {g + 1}/{n_games} partite", flush=True)
    return (np.array(DX, dtype=np.float32), np.array(Dy, dtype=np.float32),
            np.array(PX, dtype=np.float32), np.array(Py, dtype=np.float32))


def evaluate_vs(make_test_bot, make_baseline_bot, n_games=300, seed=999, num_players=4):
    """Mette il bot di test al seat 0 contro baseline negli altri posti.
    Ritorna il punteggio medio per partita del seat 0 vs media baseline."""
    rng = random.Random(seed)

    def make_bots(r, n):
        bots = [make_baseline_bot(r) for _ in range(n)]
        bots[0] = make_test_bot(r)
        return bots

    test_score = 0.0
    base_score = 0.0
    for _ in range(n_games):
        scores, _, _ = play_game(make_bots, rng, num_players)
        test_score += scores[0]
        base_score += sum(scores[1:]) / (len(scores) - 1)
    return test_score / n_games, base_score / n_games
