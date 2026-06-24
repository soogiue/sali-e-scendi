"""Test del solver verify_claim_all su scenari costruiti a mano."""
from engine import Card, Play, verify_claim_all, HIER_BRISCOLA, HIER_TRESETTE

C = Card

def case(name, hands, claimant, table, turn, n, bseed, hier, expected):
    r = verify_claim_all(hands, claimant, table, turn, n, bseed, hier)
    ok = "OK" if r == expected else "FAIL"
    print(f"[{ok}] {name}: atteso={expected} ottenuto={r}")
    return r == expected

allok = True

# --- Caso 1: claimant ha i 2 trionfi più forti (Asso,3 di coppe = briscola),
# avversari con carte deboli. 4 giocatori, 2 prese rimaste, claimant di mano.
h1 = {
    0: [C("cups","Ace"), C("cups","3")],     # claimant: Asso+3 di briscola
    1: [C("gold","Ace"), C("gold","3")],     # forti ma fuori briscola
    2: [C("swords","Ace"), C("swords","3")],
    3: [C("cups","King"), C("sticks","2")],  # ha una briscola ma più debole (Re<3,Asso)
}
allok &= case("tutti i trionfi top", h1, 0, [], 0, 4, "cups", HIER_BRISCOLA, "proven")

# --- Caso 2: l'avversario ha la BOSS non catturabile (Asso di briscola) e il
# claimant ha solo Re+Cavallo: qualunque cosa esca, l'Asso prende -> refuted.
# (NB: se il claimant avesse l'Asso, basterebbe uscire d'Asso per "tirare" il 3,
#  quindi un trionfo avversario più basso NON basta a rifiutare la pretesa.)
h2 = {
    0: [C("cups","King"), C("cups","Horse")],
    1: [C("gold","Ace"), C("gold","3")],
    2: [C("swords","Ace"), C("swords","3")],
    3: [C("cups","Ace"), C("sticks","2")],   # ha l'Asso di briscola: imprendibile
}
allok &= case("avversario ha la boss imprendibile", h2, 0, [], 0, 4, "cups", HIER_BRISCOLA, "refuted")

# --- Caso 3: claimant esce con carta non-briscola altissima, ma avv void può tagliare.
h3 = {
    0: [C("gold","Ace"), C("gold","3")],     # Asso+3 di denari (non briscola)
    1: [C("gold","King"), C("gold","2")],
    2: [C("gold","Horse"), C("gold","Jack")],
    3: [C("cups","4"), C("cups","5")],       # void in denari: può tagliare con briscola
}
allok &= case("avversario può tagliare", h3, 0, [], 0, 4, "cups", HIER_BRISCOLA, "refuted")

# --- Caso 4: tresette (niente briscola), claimant ha 3 e 2 di denari (i due top).
h4 = {
    0: [C("gold","3"), C("gold","2")],       # 3,2 di denari = i più forti a tresette
    1: [C("gold","Ace"), C("gold","King")],
    2: [C("swords","3"), C("swords","2")],
    3: [C("cups","3"), C("cups","2")],
}
allok &= case("tresette, due top dello stesso seme", h4, 0, [], 0, 4, None, HIER_TRESETTE, "proven")

# --- Caso 5: presa IN CORSO (stato consistente: seat1 ha già giocato 1 carta,
# quindi ha 1 carta in mano; gli altri ne hanno 2). seat1 ha aperto col Re di
# coppe (briscola); tocca al claimant(0) con Asso+3 di coppe: vince questa presa
# e poi rilancia il 3 (trionfo top residuo). Gli avversari hanno solo denari.
h5 = {
    0: [C("cups","Ace"), C("cups","3")],     # claimant
    1: [C("gold","Ace")],                    # 1 carta: ha già messo il Re di coppe sul tavolo
    2: [C("gold","King"), C("gold","Horse")],
    3: [C("gold","Jack"), C("gold","7")],
}
allok &= case("presa in corso, claim valido", h5, 0, [Play(1, C("cups","King"))], 0, 4, "cups", HIER_BRISCOLA, "proven")

# --- Caso 6: presa in corso, seme di uscita = denari. Il claimant deve rispondere
# a denari ma seat2 ha l'Asso di denari (boss del seme): seat2 vince -> refuted.
h6 = {
    0: [C("gold","King"), C("gold","Horse")],
    1: [C("gold","Jack")],                   # ha già aperto col Fante di denari
    2: [C("gold","Ace"), C("gold","3")],     # Asso di denari: prende la presa
    3: [C("gold","7"), C("gold","2")],
}
allok &= case("presa in corso, avversario ha l'Asso del seme", h6, 0, [Play(1, C("gold","Jack"))], 0, 4, "cups", HIER_BRISCOLA, "refuted")

print("\nTUTTO OK" if allok else "\nCI SONO FALLIMENTI")
