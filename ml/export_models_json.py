"""
Esporta i modelli allenati (HistGradientBoostingRegressor) in JSON, così la Edge
Function in Deno/TypeScript può fare inferenza SENZA dipendenze (niente ONNX/WASM).

Per ogni modello salviamo:
  - baseline            : predizione di base (m._baseline_prediction)
  - n_features          : numero di feature attese
  - trees[]             : per ogni albero, l'array dei nodi
      nodi[i] = [feature_idx, threshold, left, right, value, is_leaf, missing_left]
      (per i nodi foglia feature_idx/threshold/left/right sono ignorati)

La traversata a runtime (identica a sklearn, niente categoriche/NaN qui):
  nodo = 0
  finché non foglia:
     se x[feature_idx] <= threshold:  nodo = left   (o missing_left se NaN)
     altrimenti:                      nodo = right
  ritorna baseline + somma dei value delle foglie di tutti gli alberi

Validazione: confronta la traversata manuale (qui in Python) con m.predict()
su input casuali. Se combaciano, la stessa traversata in TS darà gli stessi numeri.

Uso:
  cd ml && python export_models_json.py
Output:
  ../supabase/functions/_shared/models.json
"""
from __future__ import annotations
import os, json
import numpy as np
import joblib

HERE = os.path.dirname(__file__)
MODELS_DIR = os.path.join(HERE, "models")
OUT = os.path.join(HERE, "..", "supabase", "functions", "_shared", "models.json")


def serialize_model(m):
    nfeat = int(m.n_features_in_)
    # baseline può essere scalare o array (1,1)
    baseline = float(np.ravel(m._baseline_prediction)[0])
    trees = []
    for stage in m._predictors:           # 1 albero per iterazione (regressione)
        tp = stage[0]
        nodes = tp.nodes
        assert not nodes["is_categorical"].any(), "split categorici non supportati"
        arr = []
        for nd in nodes:
            arr.append([
                int(nd["feature_idx"]),
                float(nd["num_threshold"]),
                int(nd["left"]),
                int(nd["right"]),
                float(nd["value"]),
                int(nd["is_leaf"]),
                int(nd["missing_go_to_left"]),
            ])
        trees.append(arr)
    return {"baseline": baseline, "n_features": nfeat, "trees": trees}


def predict_manual(model_json, X):
    """Traversata pura: deve combaciare con m.predict()."""
    base = model_json["baseline"]
    trees = model_json["trees"]
    out = np.full(X.shape[0], base, dtype=np.float64)
    for i in range(X.shape[0]):
        x = X[i]
        acc = base
        for nodes in trees:
            j = 0
            while True:
                f, thr, left, right, val, is_leaf, miss_left = nodes[j]
                if is_leaf:
                    acc += val
                    break
                xv = x[int(f)]
                if np.isnan(xv):
                    j = int(left) if miss_left else int(right)
                else:
                    j = int(left) if xv <= thr else int(right)
        out[i] = acc
    return out


def main():
    out = {}
    rng = np.random.default_rng(0)
    for name, fname in [("decl", "decl_model.joblib"), ("play", "play_model.joblib")]:
        m = joblib.load(os.path.join(MODELS_DIR, fname))
        mj = serialize_model(m)
        out[name] = mj

        # --- validazione: manuale vs sklearn.predict ---
        nfeat = mj["n_features"]
        X = rng.standard_normal((200, nfeat)).astype(np.float32)
        # valori 0/1 plausibili per le feature binarie/multi-hot
        Xb = (rng.random((200, nfeat)) < 0.3).astype(np.float32)
        for Xtest in (X, Xb):
            ref = m.predict(Xtest)
            man = predict_manual(mj, Xtest.astype(np.float64))
            maxerr = float(np.max(np.abs(ref - man)))
            print(f"  [{name}] n_features={nfeat} trees={len(mj['trees'])} "
                  f"max|manuale-predict|={maxerr:.2e}")
            assert maxerr < 1e-4, f"MISMATCH per {name}: {maxerr}"

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    payload = json.dumps(out, separators=(",", ":"))
    # JSON (per i test in node) + modulo TS (importato dalla Edge Function: evita
    # i rischi dell'import-assertion JSON in Deno/bundler).
    with open(OUT, "w") as f:
        f.write(payload)
    OUT_TS = OUT[:-5] + ".ts"  # models.json -> models.ts
    with open(OUT_TS, "w") as f:
        f.write("// AUTO-GENERATO da ml/export_models_json.py — NON modificare a mano.\n")
        f.write("// Modelli ML (HistGradientBoostingRegressor) serializzati per inferenza in TS.\n")
        f.write("export default " + payload + ";\n")
    print(f"\nScritto {OUT}  ({os.path.getsize(OUT)/1024:.0f} KB)")
    print(f"Scritto {OUT_TS}  ({os.path.getsize(OUT_TS)/1024:.0f} KB)")
    print("Validazione OK: la traversata manuale combacia con model.predict().")


if __name__ == "__main__":
    main()
