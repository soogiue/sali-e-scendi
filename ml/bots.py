"""
Politiche di gioco (bot). Tre livelli:
  - RandomBot     : sceglie a caso tra le mosse legali (baseline minima)
  - HeuristicBot  : regole sensate scritte a mano (per partire / confronto)
  - ModelBot      : usa i modelli ML allenati (dichiarazione + gioco)

Interfaccia comune:
  declare(ctx_decl) -> int
  play(ctx_play)    -> Card
dove ctx_* sono i dict descritti in features.py.
"""
from __future__ import annotations
import random
import numpy as np
from engine import (
    Card, Play, HIER_BRISCOLA, HIER_TRESETTE,
    card_strength, legal_cards, forbidden_last_declare, resolve_trick,
)
import features as F


def _hier(is_no_trump: bool):
    return HIER_TRESETTE if is_no_trump else HIER_BRISCOLA


def _fix_last_declare(value: int, ctx: dict) -> int:
    """Se sono l'ultimo e `value` è vietato, sposto al valore valido più vicino."""
    if not ctx["is_last"]:
        return max(0, min(value, ctx["n_cards"]))
    forb = forbidden_last_declare(ctx["prior_declares"], ctx["n_cards"])
    value = max(0, min(value, ctx["n_cards"]))
    if forb is None or value != forb:
        return value
    # prova value-1 poi value+1 nel range
    for cand in (value - 1, value + 1):
        if 0 <= cand <= ctx["n_cards"]:
            return cand
    return value


class RandomBot:
    name = "random"

    def __init__(self, rng: random.Random):
        self.rng = rng

    def declare(self, ctx: dict) -> int:
        v = self.rng.randint(0, ctx["n_cards"])
        return _fix_last_declare(v, ctx)

    def play(self, ctx: dict) -> Card:
        legal = legal_cards(ctx["hand"], ctx["lead_seed"])
        return self.rng.choice(legal)


class HeuristicBot:
    name = "heuristic"

    def __init__(self, rng: random.Random):
        self.rng = rng

    def declare(self, ctx: dict) -> int:
        hier = _hier(ctx["is_no_trump"])
        bseed = ctx["briscola"].seed if ctx["briscola"] else None
        est = 0.0
        for c in ctx["hand"]:
            s = card_strength(c.rank, hier)
            if bseed and c.seed == bseed:
                est += 0.85 if s <= 4 else 0.5      # briscola: spesso prende
            elif s <= 1:
                est += 0.55                          # carta top (Asso/3...)
            elif s == 2:
                est += 0.3
            else:
                est += 0.05
        return _fix_last_declare(int(round(est)), ctx)

    def play(self, ctx: dict) -> Card:
        hier = _hier(ctx["is_no_trump"])
        bseed = ctx["briscola_seed"]
        legal = legal_cards(ctx["hand"], ctx["lead_seed"])
        need = ctx["declared"] - ctx["taken_so_far"]
        tricks_remaining = ctx["n_cards"] - ctx["trick_index"]

        def weakest(cards):
            return max(cards, key=lambda c: card_strength(c.rank, hier))

        def strongest(cards):
            return min(cards, key=lambda c: card_strength(c.rank, hier))

        # Vorrei ancora prese? (sì se need>0 e ci sono ancora prese)
        want = need > 0 and tricks_remaining > 0

        if not ctx["table"]:
            # sono di mano: se voglio prese esco forte, altrimenti scarico debole
            return strongest(legal) if want else weakest(legal)

        # sto rispondendo: carte che mi farebbero vincere ORA
        winners = [c for c in legal
                   if F.candidate_provisional_winner(ctx["table"], c, ctx["my_seat"], bseed, hier)]
        if want and winners:
            return weakest(winners)      # vinco nel modo più economico
        return weakest(legal)            # non voglio/non posso: scarto la più debole


class ModelBot:
    name = "model"

    def __init__(self, decl_model, play_model, rng: random.Random, epsilon: float = 0.0):
        self.decl_model = decl_model
        self.play_model = play_model
        self.rng = rng
        self.epsilon = epsilon            # esplorazione per la generazione dati

    def declare(self, ctx: dict) -> int:
        if self.decl_model is None:
            return HeuristicBot(self.rng).declare(ctx)
        x = F.encode_declaration(ctx).reshape(1, -1)
        pred = float(self.decl_model.predict(x)[0])
        return _fix_last_declare(int(round(pred)), ctx)

    def play(self, ctx: dict) -> Card:
        legal = legal_cards(ctx["hand"], ctx["lead_seed"])
        if self.play_model is None or (self.epsilon and self.rng.random() < self.epsilon):
            return self.rng.choice(legal)
        X = np.stack([F.encode_play(ctx, c) for c in legal])
        vals = self.play_model.predict(X)
        return legal[int(np.argmax(vals))]
