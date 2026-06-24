# ML — Bot per Sali e Scendi (self-play)

Pipeline per addestrare dei **bot** che giocano a Sali e Scendi, imparando da
partite generate in **self-play** con il motore del gioco. Le partite umane
raccolte nello schema `history` servono per validare e (in futuro) per dare uno
stile più "umano".

## Idea in breve

Il gioco richiede **due decisioni**, quindi due modelli:

1. **Dichiarazione** — a inizio round, vista la mano: quante prese farò?
   → regressione `mano + contesto → prese attese`; il bot dichiara
   l'arrotondamento (rispettando il vincolo dell'ultimo dichiarante).
2. **Gioco** — a ogni turno: quale carta gioco?
   → regressione `(stato + carta candidata) → punti round attesi`; il bot sceglie
   la carta legale con punteggio previsto massimo (una "Q-function" leggera).

Entrambi i segnali sono **auto-etichettanti**: il risultato (prese fatte, punti
del round) si conosce a fine round, quindi non serve nessuna annotazione manuale.

## Perché self-play

Il motore (`engine.py`, porta fedele di `engine.ts`) permette di simulare
**partite illimitate**: non devi aspettare migliaia di partite umane. Si usa la
**policy iteration**:

```
iter 0 : i bot giocano con l'euristica   → dati → alleno i 2 modelli
iter 1 : i bot giocano con i MODELLI (+ esplorazione) → dati migliori → rialleno
iter k : ... il livello sale a ogni giro
```

## File

| File | Cosa fa |
|---|---|
| `engine.py` | Motore di gioco, identico a `engine.ts` (regole, deal, prese, punteggio). |
| `features.py` | Codifica stato → vettori numerici (mano, mosse legali, tavolo, briscola…). |
| `bots.py` | `RandomBot`, `HeuristicBot`, `ModelBot` (usa i modelli allenati). |
| `selfplay.py` | Simula partite e genera i dataset event-level con i target. |
| `train.py` | Training con policy iteration; salva i modelli in `models/`. |
| `export_supabase.py` | Esporta le partite **umane** da `history` in CSV (validazione). |

## Uso

```bash
cd ml
pip install -r requirements.txt

# allena (parti così, poi alza i numeri)
python train.py --iterations 3 --games 600

# output:
#   models/decl_model.joblib   (dichiarazione)
#   models/play_model.joblib   (gioco)
```

Parametri utili: `--games` (partite di self-play per iterazione, più = meglio ma
più lento), `--iterations`, `--epsilon` (esplorazione), `--eval-games`.

Per scaricare le partite umane raccolte (facoltativo):

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service_role key>   # chiave SEGRETA, solo sul tuo PC
python export_supabase.py        # -> data/play_samples.csv, data/declaration_samples.csv
```

## Risultati verificati (smoke test)

Con appena **40 partite** di training (un giro, modello leggero):

```
MODELLO  vs EURISTICA : modello=+11.65  euristica=+7.04   delta=+4.61 punti/partita
EURISTICA vs RANDOM   : euristica=+10.70 random=-32.31    delta=+43.0
```

Il bot allenato **batte già l'euristica** da cui ha imparato, e l'euristica
distrugge il random (conferma che il gioco premia le decisioni giuste). Con più
partite e più iterazioni il distacco cresce.

## Come è messo nel gioco (FATTO ✅)

Scelta: **inferenza integrata in Deno, senza dipendenze**. Gli alberi del
modello (`HistGradientBoostingRegressor`) vengono serializzati e attraversati
in puro TypeScript dentro la Edge Function. Niente ONNX/WASM, niente
microservizi, cold-start istantaneo sull'edge, e funziona dentro il flusso
autoritativo (così anche l'AUTOGAME usa i modelli).

Pipeline:

1. `python export_models_json.py` → genera
   `../supabase/functions/_shared/models.json` **e** `models.ts`
   (la function importa `models.ts`). Lo script **valida** che la traversata
   manuale degli alberi combaci con `model.predict()` (errore 0.0).
2. `../supabase/functions/_shared/mlbot.ts` riproduce `features.py` 1:1 e fa
   l'inferenza (`modelDeclare`, `modelPlay`). Parità verificata con
   `parity_dump.py` + `parity_check.mjs` (vettori e predizioni identici a Python).
3. In `game/index.ts`, `advanceBots` usa `mlbot.ts` per i posti `is_bot` **o**
   `autoplay` (fallback all'euristica di `engine.ts` se i modelli mancano).

> Per riallenare e riportare i modelli nel gioco: `python train.py …` →
> `python export_models_json.py` → `supabase functions deploy game`.

## Note tecniche

- Le feature di training e quelle usate dal `ModelBot` a runtime sono prodotte
  dalla **stessa** `features.py` → niente train/serve skew.
- La valutazione (`evaluate_vs`) è la parte lenta: il `ModelBot` fa una `predict`
  per ogni decisione. Per il training in sé non è un problema (è offline).
- Se cambi le regole in `engine.ts`, aggiorna **anche** `engine.py` (e viceversa):
  è l'unico punto da tenere in sincrono.
