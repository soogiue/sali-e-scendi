"""
Esporta le partite UMANE raccolte in Supabase (schema history) in file CSV,
da usare per validare i bot o per imitation learning futura.

Legge dalle viste create dalla migration 001:
  - history.ml_play_samples
  - history.ml_declaration_samples

Richiede le variabili d'ambiente (NON mettere le chiavi nel codice):
  SUPABASE_URL=https://<ref>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=<service_role key>   # chiave SEGRETA, solo lato tuo PC

Uso:
  export SUPABASE_URL=...; export SUPABASE_SERVICE_ROLE_KEY=...
  python export_supabase.py
Output: ml/data/play_samples.csv, ml/data/declaration_samples.csv
"""
from __future__ import annotations
import os, sys, csv, json, urllib.request, urllib.parse

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def fetch_view(base_url: str, key: str, view: str, page=1000):
    """Scarica una vista dello schema history via PostREST, paginando."""
    rows = []
    offset = 0
    while True:
        url = f"{base_url}/rest/v1/{view}?select=*&limit={page}&offset={offset}"
        req = urllib.request.Request(url, headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept-Profile": "history",      # IMPORTANTISSIMO: schema history
        })
        with urllib.request.urlopen(req) as resp:
            batch = json.loads(resp.read().decode())
        rows += batch
        if len(batch) < page:
            break
        offset += page
    return rows


def write_csv(rows, path):
    if not rows:
        print(f"  (nessuna riga) {path}")
        return
    # raccoglie tutte le chiavi (le colonne jsonb diventano stringhe JSON)
    keys = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for r in rows:
            w.writerow({k: (json.dumps(v) if isinstance(v, (dict, list)) else v)
                        for k, v in r.items()})
    print(f"  scritte {len(rows)} righe -> {path}")


def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("ERRORE: imposta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        sys.exit(1)
    url = url.rstrip("/")
    os.makedirs(DATA_DIR, exist_ok=True)

    print("Scarico history.ml_play_samples ...")
    plays = fetch_view(url, key, "ml_play_samples")
    write_csv(plays, os.path.join(DATA_DIR, "play_samples.csv"))

    print("Scarico history.ml_declaration_samples ...")
    decls = fetch_view(url, key, "ml_declaration_samples")
    write_csv(decls, os.path.join(DATA_DIR, "declaration_samples.csv"))

    print("Fatto.")


if __name__ == "__main__":
    main()
