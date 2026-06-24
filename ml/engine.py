"""
SALI E SCENDI — MOTORE DI GIOCO (porta Python di supabase/functions/_shared/engine.ts)

Reimplementazione FEDELE delle stesse regole della Edge Function, così il
self-play in Python genera partite identiche a quelle "vere". Se cambi le regole
in engine.ts, aggiorna anche qui (e viceversa).

Convenzioni identiche al TS:
- seed in {cups, gold, swords, sticks}; rank in {Ace,2..7,Jack,Horse,King}
- nelle gerarchie: indice 0 = carta PIU' FORTE (strength bassa = forte)
"""
from __future__ import annotations
from dataclasses import dataclass
import random
from typing import Optional

SEEDS = ["cups", "gold", "swords", "sticks"]
RANKS = ["Ace", "2", "3", "4", "5", "6", "7", "Jack", "Horse", "King"]

# indice 0 = carta piu' FORTE
HIER_BRISCOLA = ["Ace", "3", "King", "Horse", "Jack", "7", "6", "5", "4", "2"]
HIER_TRESETTE = ["3", "2", "Ace", "King", "Horse", "Jack", "7", "6", "5", "4"]


@dataclass(frozen=True)
class Card:
    seed: str
    rank: str

    def __repr__(self) -> str:
        return f"{self.rank}-{self.seed}"


@dataclass
class Play:
    seat: int
    card: Card


def create_deck() -> list[Card]:
    return [Card(s, r) for s in SEEDS for r in RANKS]


def shuffle(arr: list, rng: random.Random) -> list:
    d = list(arr)
    rng.shuffle(d)
    return d


def max_cards_for(num_players: int) -> int:
    return 40 // num_players  # 4->10, 5->8


def rounds_sequence(max_cards: int) -> list[int]:
    seq = list(range(1, max_cards + 1))
    seq += list(range(max_cards, 0, -1))
    return seq


def card_strength(rank: str, hierarchy: list[str]) -> int:
    i = hierarchy.index(rank) if rank in hierarchy else -1
    return len(hierarchy) if i == -1 else i


def seat_order(num_players: int, first_seat: int) -> list[int]:
    return [(first_seat + i) % num_players for i in range(num_players)]


def dealer_for(num_players: int, round_index: int) -> int:
    return round_index % num_players


def first_seat_for(num_players: int, round_index: int) -> int:
    return (dealer_for(num_players, round_index) + 1) % num_players


def sort_hand(hand: list[Card], hierarchy: list[str]) -> list[Card]:
    return sorted(
        hand,
        key=lambda c: (SEEDS.index(c.seed), card_strength(c.rank, hierarchy)),
    )


@dataclass
class DealResult:
    hands: list[list[Card]]          # indicizzate per seat
    briscola: Optional[Card]
    hierarchy: list[str]
    is_no_trump: bool
    order: list[int]


def deal_round(num_players: int, n_cards: int, first_seat: int, rng: random.Random) -> DealResult:
    is_no_trump = n_cards >= max_cards_for(num_players)
    deck = shuffle(create_deck(), rng)
    hierarchy = HIER_TRESETTE if is_no_trump else HIER_BRISCOLA
    briscola: Optional[Card] = None
    if not is_no_trump:
        briscola = deck.pop()
    order = seat_order(num_players, first_seat)
    hands: list[list[Card]] = [[] for _ in range(num_players)]
    for _ in range(n_cards):
        for s in order:
            hands[s].append(deck.pop())
    for s in order:
        hands[s] = sort_hand(hands[s], hierarchy)
    return DealResult(hands, briscola, hierarchy, is_no_trump, order)


def legal_cards(hand: list[Card], lead_seed: Optional[str]) -> list[Card]:
    if not lead_seed:
        return list(hand)
    same = [c for c in hand if c.seed == lead_seed]
    return same if same else list(hand)


def is_legal_play(hand: list[Card], lead_seed: Optional[str], card: Card) -> bool:
    legal = legal_cards(hand, lead_seed)
    return any(c.seed == card.seed and c.rank == card.rank for c in legal)


def resolve_trick(plays: list[Play], briscola_seed: Optional[str], hierarchy: list[str]) -> int:
    """Ritorna il SEAT vincitore. plays nell'ordine di gioco (il primo e' l'uscita)."""
    lead_seed = plays[0].card.seed
    best = None  # (seat, is_b, strength)
    for p in plays:
        seed, rank = p.card.seed, p.card.rank
        is_b = briscola_seed is not None and seed == briscola_seed
        is_l = seed == lead_seed
        if not is_b and not is_l:
            continue
        st = card_strength(rank, hierarchy)
        if best is None:
            best = (p.seat, is_b, st)
            continue
        if is_b and not best[1]:
            best = (p.seat, is_b, st)
            continue
        if is_b == best[1] and st < best[2]:
            best = (p.seat, is_b, st)
    return best[0]


def score_round(declared: int, taken: int) -> int:
    return 1 + taken if declared == taken else -abs(declared - taken)


def forbidden_last_declare(other_declares: list[int], n_cards: int) -> Optional[int]:
    s = sum(other_declares)
    f = n_cards - s
    return f if 0 <= f <= n_cards else None


def auto_pick_card(hand: list[Card], lead_seed: Optional[str], hierarchy: list[str]) -> Card:
    legal = legal_cards(hand, lead_seed)
    worst = legal[0]
    for c in legal:
        if card_strength(c.rank, hierarchy) > card_strength(worst.rank, hierarchy):
            worst = c
    return worst


def auto_pick_declare(other_declares: list[int], n_cards: int, is_last: bool) -> int:
    if not is_last:
        return 0
    forb = forbidden_last_declare(other_declares, n_cards)
    if forb == 0:
        return min(1, n_cards)
    return 0


# ---------- "TUTTO MIO": verifica di una pretesa (claim) ----------
def verify_claim_all(hands, claimant, table, turn_seat, num_players,
                     briscola_seed, hierarchy, node_budget: int = 300_000) -> str:
    H = {s: list(cs) for s, cs in hands.items()}
    state = {"budget": node_budget, "exceeded": False}

    def by_strength(cards):
        return sorted(cards, key=lambda c: card_strength(c.rank, hierarchy))

    def solve(cur_table, turn) -> bool:
        state["budget"] -= 1
        if state["budget"] < 0:
            state["exceeded"] = True
            return False
        lead_seed = cur_table[0].card.seed if cur_table else None
        legal = by_strength(legal_cards(H[turn], lead_seed))
        is_claimant = (turn == claimant)
        for card in legal:
            H[turn].remove(card)
            new_table = cur_table + [Play(turn, card)]
            if len(new_table) == num_players:
                winner = resolve_trick(new_table, briscola_seed, hierarchy)
                if winner != claimant:
                    res = False
                elif len(H[claimant]) == 0:
                    res = True
                else:
                    res = solve([], claimant)
            else:
                res = solve(new_table, (turn + 1) % num_players)
            H[turn].append(card)
            if state["exceeded"]:
                return False
            if is_claimant:
                if res:
                    return True
            else:
                if not res:
                    return False
        return not is_claimant

    ok = solve(list(table), turn_seat)
    if state["exceeded"]:
        return "too_complex"
    return "proven" if ok else "refuted"
          return False
            if is_claimant:
                if res:
                    return True
            else:
                if not res:
                    return False
        return not is_claimant

    ok = solve(list(table), turn_seat)
    if state["exceeded"]:
        return "too_complex"
    return "proven" if ok else "refuted"
