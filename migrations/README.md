# Migrations — Sali e Scendi

Cartella delle migration del database (Supabase / PostgreSQL) di **Sali e Scendi**,
nello stesso stile delle migration di **jolo**.

## Come è organizzata

Ogni migration è una cartella numerata `NNN_v1_nome_breve/` che contiene:

```
NNN_v1_nome/
├─ up.sql         ← applica la modifica (da incollare nel SQL Editor di Supabase)
├─ down.sql       ← rollback (solo in emergenza)
├─ metadata.json  ← versione, autore, tabelle toccate, stato
└─ notes.md       ← cosa cambia, perché, compatibilità, checklist di test
```

A livello root:

```
migrations/
├─ README.md              ← questo file
├─ MIGRATION_LOG.md       ← storico cronologico di cosa è stato applicato
├─ DATABASE_STRUCTURE.md  ← struttura corrente del database (schema per schema)
└─ NNN_v1_*/              ← le singole migration
```

## Regole

1. **Numerazione progressiva.** Ogni nuova migration usa il numero successivo
   (`002_...`, `003_...`). Non riusare numeri.
2. **Sempre `up.sql` + `down.sql`.** Ogni migration deve essere reversibile.
3. **Idempotenza dove possibile.** Usare `create ... if not exists`,
   `create or replace`, `add column if not exists`.
4. **Backup prima di modifiche distruttive.** Per `ALTER`/`DROP` su tabelle con
   dati, fare prima una `tablename_backup_YYYYMMDD`.
5. **Log centralizzato.** Ogni `up.sql` scrive in `internal.schema_migrations`;
   ogni rollback scrive in `internal.schema_migrations_rollback`. Aggiornare
   anche `MIGRATION_LOG.md` a mano.

## Come applicare una migration

1. Apri il **SQL Editor** del progetto sali-e-scendi su Supabase.
2. Incolla ed esegui tutto il contenuto di `up.sql`.
3. Controlla le query di verifica in fondo al file.
4. Aggiorna `applied_at` e `status` in `metadata.json` e aggiungi la riga in
   `MIGRATION_LOG.md`.

## Contesto

Il database "live" del gioco è creato da `../db/setup.sql` (tabelle `public.games`,
`public.game_players`, `public.hands`, `public.round_results`). Le migration qui
**estendono** quello schema senza romperlo. Vedi `DATABASE_STRUCTURE.md` per la
mappa completa.
