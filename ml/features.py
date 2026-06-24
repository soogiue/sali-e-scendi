"""
Feature encoding: trasforma lo stato di gioco in vettori numerici per i modelli.
Usato sia in training (train.py) sia a runtime dal ModelBot (bots.py), così la
rappresentazione è identica nelle due fasi (niente train/serve skew).
"""
from __future__ import annotations
import numpy as np
from engine import (
    Card, Play, SEEDS, RANKS, HIER_BRISCOLA, HIER_TRESETTE,
    card_strength, legal_cards,
)


def card_index(c: Card) -> int:
    return SEEDS.index(c.seed) * len(RANKS) + RANKS.index(c.rank)


def _multi_hot(cards, size: int = 40) -> np.ndarray:
    v = np.zeros(size, dtype=np.float32)
    for c in cards:
        v[card_index(c)] = 1.0
    return v


def _seed_one_hot(seed) -> np.ndarray:
    v = np.zeros(len(SEEDS), dtype=np.float32)
    if seed is not None and seed in SEEDS:
        v[SEEDS.index(seed)] = 1.0
    return v


# ---------------- DICHIARAZIONE ----------------
# Domanda: quante prese farò con questa mano? -> target = prese effettive.

DECL_FEATURE_NAMES = None  # solo vettori numerici


def encode_declaration(ctx: dict) -> np.ndarray:
    """ctx: hand, briscola(Card|None), is_no_trump, n_cards, num_players,
            declaration_order, is_last, prior_declares(list[int])."""
    hand = ctx["hand"]
    briscola = ctx["briscola"]
    is_no_trump = ctx["is_no_trump"]
    n_cards = ctx["n_cards"]
    hier = HIER_TRESETTE if is_no_trump else HIER_BRISCOLA
    bseed = briscola.seed if briscola else None

    n_brisc_in_hand = sum(1 for c in hand if bseed and c.seed == bseed)
    # "carte forti": tra le prime 3 della gerarchia per il proprio seme/briscola
    n_top = sum(1 for c in hand if card_strength(c.rank, hier) <= 2)

    extra = np.array([
        is_no_trump * 1.0,
        n_cards / 10.0,
        ctx["num_players"] / 5.0,
        ctx["declaration_order"] / 5.0,
        1.0 if ctx["is_last"] else 0.0,
        sum(ctx["prior_declares"]) / 10.0,
        len(ctx["prior_declares"]) / 5.0,
        n_brisc_in_hand / 10.0,
        n_top / 10.0,
    ], dtype=np.float32)

    return np.concatenate([
        _multi_hot(hand),          # 40
        _seed_one_hot(bseed),      # 4
        extra,                     # 9
    ])  # = 53


# ---------------- GIOCO ----------------
# Domanda: se gioco QUESTA carta in QUESTO stato, quanti punti round mi aspetto?
# -> target = punti round finali del seat. A runtime si sceglie l'argmax tra le legali.

def candidate_provisional_winner(table: list, candidate: Card, my_seat: int,
                                 briscola_seed, hier) -> bool:
    """Se gioco `candidate` ora, sto (provvisoriamente) vincendo la presa?"""
    from engine import resolve_trick
    plays = list(table) + [Play(my_seat, candidate)]
    return resolve_trick(plays, briscola_seed, hier) == my_seat


def encode_play(ctx: dict, candidate: Card) -> np.ndarray:
    """ctx: hand, table(list[Play]), lead_seed, briscola_seed, is_no_trump,
            n_cards, num_players, trick_index, declared, taken_so_far, my_seat."""
    hand = ctx["hand"]
    table_cards = [p.card for p in ctx["table"]]
    is_no_trump = ctx["is_no_trump"]
    hier = HIER_TRESETTE if is_no_trump else HIER_BRISCOLA
    bseed = ctx["briscola_seed"]
    lead_seed = ctx["lead_seed"]

    declared = ctx["declared"]
    taken = ctx["taken_so_far"]
    tricks_remaining = ctx["n_cards"] - ctx["trick_index"]
    need = declared - taken

    is_brisc = 1.0 if (bseed and candidate.seed == bseed) else 0.0
    follows = 1.0 if (lead_seed and candidate.seed == lead_seed) else 0.0
    strength = card_strength(candidate.rank, hier) / 10.0
    would_win = 1.0 if candidate_provisional_winner(
        ctx["table"], candidate, ctx["my_seat"], bseed, hier) else 0.0

    extra = np.array([
        ctx["is_no_trump"] * 1.0,
        ctx["n_cards"] / 10.0,
        ctx["num_players"] / 5.0,
        ctx["trick_index"] / 10.0,
        1.0 if not ctx["table"] else 0.0,   # is_lead
        declared / 10.0,
        taken / 10.0,
        tricks_remaining / 10.0,
        need / 10.0,
        is_brisc,
        follows,
        strength,
        would_win,
        len(ctx["table"]) / 5.0,
    ], dtype=np.float32)

    return np.concatenate([
        _multi_hot(hand),            # 40  mano residua
        _multi_hot([candidate]),     # 40  carta candidata
        _multi_hot(table_cards),     # 40  tavolo
        _seed_one_hot(lead_seed),    # 4
        _seed_one_hot(bseed),        # 4
        extra,                       # 14
    ])  # = 142
