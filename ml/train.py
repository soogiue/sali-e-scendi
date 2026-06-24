"""
Training dei bot via SELF-PLAY con POLICY ITERATION.

Idea:
  iter 0 : i bot giocano con l'euristica -> raccolgo dati -> alleno 2 modelli
           (dichiarazione + gioco).
  iter k : i bot giocano con i MODELLI dell'iterazione precedente (+ un po' di
           esplorazione) -> nuovi dati (di qualità migliore) -> rialleno.
A ogni iterazione valuto il ModelBot contro l'euristica: il punteggio medio per
partita deve salire.

Due modelli:
  - DICHIARAZIONE: regressione  mano/contesto -> prese attese (poi arrotondo)
  - GIOCO:         regressione (stato + carta) -> punti round attesi; a runtime
                   scelgo la carta legale con punteggio previsto massimo.

Uso:
  python train.py --iterations 3 --games 400
Output: ml/models/decl_model.joblib, ml/models/play_model.joblib
"""
from __future__ import annotations
import argparse, os, random, time
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
import joblib

import selfplay as SP
from bots import HeuristicBot, ModelBot, RandomBot

MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")


def new_regressor():
    return HistGradientBoostingRegressor(
        max_depth=8, max_iter=300, learning_rate=0.08,
        l2_regularization=1.0, random_state=0,
    )


def fit_model(X, y, label):
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.15, random_state=0)
    m = new_regressor()
    m.fit(Xtr, ytr)
    mae = mean_absolute_error(yte, m.predict(Xte))
    print(f"    [{label}] n={len(X):>7d}  MAE(holdout)={mae:.3f}")
    return m


def make_heuristic_bots(rng, n):
    return [HeuristicBot(rng) for _ in range(n)]


def make_modelbot_factory(decl_model, play_model, epsilon):
    def make_bots(rng, n):
        return [ModelBot(decl_model, play_model, rng, epsilon=epsilon) for _ in range(n)]
    return make_bots


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iterations", type=int, default=3)
    ap.add_argument("--games", type=int, default=400, help="partite di self-play per iterazione")
    ap.add_argument("--eval-games", type=int, default=300)
    ap.add_argument("--epsilon", type=float, default=0.10, help="esplorazione nel self-play")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    os.makedirs(MODELS_DIR, exist_ok=True)
    decl_model = play_model = None
    t0 = time.time()

    for it in range(args.iterations):
        print(f"\n=== ITERAZIONE {it} ===")
        if it == 0:
            make_bots = make_heuristic_bots
            print("  comportamento: EURISTICO")
        else:
            make_bots = make_modelbot_factory(decl_model, play_model, args.epsilon)
            print(f"  comportamento: MODELLO (epsilon={args.epsilon})")

        print(f"  genero {args.games} partite di self-play...")
        DX, Dy, PX, Py = SP.generate_dataset(
            args.games, make_bots, seed=args.seed + it * 1000, verbose=True)

        print("  alleno i modelli...")
        decl_model = fit_model(DX, Dy, "dichiarazione")
        play_model = fit_model(PX, Py, "gioco")

        # valutazione: ModelBot (seat 0) vs euristica (altri seat)
        ms, bs = SP.evaluate_vs(
            make_test_bot=lambda r: ModelBot(decl_model, play_model, r, epsilon=0.0),
            make_baseline_bot=lambda r: HeuristicBot(r),
            n_games=args.eval_games, seed=10_000 + it, num_players=4)
        print(f"  VALUTAZIONE vs euristica: modello={ms:+.3f}  euristica={bs:+.3f}  "
              f"(delta={ms - bs:+.3f} punti/partita)")

    # baseline di riferimento: euristica vs random
    hs, rs = SP.evaluate_vs(
        make_test_bot=lambda r: HeuristicBot(r),
        make_baseline_bot=lambda r: RandomBot(r),
        n_games=args.eval_games, seed=77, num_players=4)
    print(f"\n  riferimento: euristica={hs:+.3f} vs random={rs:+.3f}")

    joblib.dump(decl_model, os.path.join(MODELS_DIR, "decl_model.joblib"))
    joblib.dump(play_model, os.path.join(MODELS_DIR, "play_model.joblib"))
    print(f"\nModelli salvati in {MODELS_DIR}/  (tempo totale {time.time() - t0:.1f}s)")


if __name__ == "__main__":
    main()
