"""
Genera casi di test reali (stati di gioco) con i vettori-feature e le predizioni
dei modelli, per verificare la PARITÀ con la porta TypeScript (mlbot.ts).
Output: ml/parity_cases.json
"""
from __future__ import annotations
import os, json, random
import numpy as np
import joblib
from engine import (
    Card, Play, deal_round, seat_order, first_seat_for,
    max_cards_for, rounds_sequence, resolve_trick,
    HIER_BRISCOLA, HIER_TRESETTE,
)
import features as F

HERE = os.path.dirname(__file__)
decl_m = joblib.load(os.path.join(HERE, "models", "decl_model.joblib"))
play_m = joblib.load(os.path.join(HERE, "models", "play_model.joblib"))


def cardd(c):
    return {"seed": c.seed, "rank": c.rank}


def main():
    rng = random.Random(42)
    decl_cases, play_cases = [], []
    for _ in range(40):
        n = rng.choice([4, 5])
        rounds = rounds_sequence(max_cards_for(n))
        ri = rng.randrange(len(rounds))
        n_cards = rounds[ri]
        first_seat = first_seat_for(n, ri)
        deal = deal_round(n, n_cards, first_seat, rng)
        hands = [list(h) for h in deal.hands]
        bseed = deal.briscola.seed if deal.briscola else None
        hier = HIER_TRESETTE if deal.is_no_trump else HIER_BRISCOLA
        order = seat_order(n, first_seat)

        # --- dichiarazioni ---
        declared = [None] * n
        for idx, seat in enumerate(order):
            prior = [declared[s] for s in order[:idx]]
            ctx = {"hand": hands[seat], "briscola": deal.briscola,
                   "is_no_trump": deal.is_no_trump, "n_cards": n_cards,
                   "num_players": n, "declaration_order": idx,
                   "is_last": idx == n - 1, "prior_declares": prior}
            vec = F.encode_declaration(ctx)
            pred = float(decl_m.predict(vec.reshape(1, -1))[0])
            decl_cases.append({
                "hand": [cardd(c) for c in hands[seat]],
                "briscola": cardd(deal.briscola) if deal.briscola else None,
                "isNoTrump": bool(deal.is_no_trump), "nCards": n_cards,
                "numPlayers": n, "declarationOrder": idx,
                "isLast": idx == n - 1, "priorDeclares": [int(p) for p in prior],
                "vec": [float(v) for v in vec], "pred": pred,
            })
            # dichiarazione semplice per andare avanti
            declared[seat] = max(0, min(int(round(pred)), n_cards))

        # --- gioco: una presa, registra ogni decisione + ogni candidata ---
        taken = [0] * n
        lead_seat = first_seat
        for trick_index in range(min(2, n_cards)):
            table = []
            for seat in seat_order(n, lead_seat):
                lead_seed = table[0].card.seed if table else None
                ctx = {"hand": hands[seat], "table": list(table), "lead_seed": lead_seed,
                       "briscola_seed": bseed, "is_no_trump": deal.is_no_trump,
                       "n_cards": n_cards, "num_players": n, "trick_index": trick_index,
                       "declared": declared[seat], "taken_so_far": taken[seat], "my_seat": seat}
                from engine import legal_cards
                for cand in legal_cards(hands[seat], lead_seed):
                    vec = F.encode_play(ctx, cand)
                    pred = float(play_m.predict(vec.reshape(1, -1))[0])
                    play_cases.append({
                        "hand": [cardd(c) for c in hands[seat]],
                        "table": [{"seat": p.seat, "card": cardd(p.card)} for p in table],
                        "leadSeed": lead_seed, "briscolaSeed": bseed,
                        "isNoTrump": bool(deal.is_no_trump), "nCards": n_cards,
                        "numPlayers": n, "trickIndex": trick_index,
                        "declared": int(declared[seat]), "takenSoFar": taken[seat],
                        "mySeat": seat, "candidate": cardd(cand),
                        "vec": [float(v) for v in vec], "pred": pred,
                    })
                # scegli una carta legale a caso per proseguire
                lc = legal_cards(hands[seat], lead_seed)
                chosen = rng.choice(lc)
                hands[seat] = [c for c in hands[seat]
                               if not (c.seed == chosen.seed and c.rank == chosen.rank)]
                table.append(Play(seat, chosen))
            lead_seat = resolve_trick(table, bseed, hier)
            taken[lead_seat] += 1

    out = {"decl": decl_cases, "play": play_cases}
    with open(os.path.join(HERE, "parity_cases.json"), "w") as f:
        json.dump(out, f)
    print(f"decl_cases={len(decl_cases)} play_cases={len(play_cases)} -> parity_cases.json")


if __name__ == "__main__":
    main()
