from dataclasses import dataclass
from typing import Optional

HIER_BRISCOLA = ["Ace","3","King","Horse","Jack","7","6","5","4","2"]
HIER_TRESETTE = ["3","2","Ace","King","Horse","Jack","7","6","5","4"]

@dataclass(frozen=True)
class Card:
    seed: str; rank: str
@dataclass
class Play:
    seat: int; card: Card

def card_strength(rank, hier):
    return hier.index(rank) if rank in hier else len(hier)
def legal_cards(hand, lead_seed):
    if not lead_seed: return list(hand)
    same = [c for c in hand if c.seed==lead_seed]
    return same if same else list(hand)
def resolve_trick(plays, bseed, hier):
    lead = plays[0].card.seed; best=None
    for p in plays:
        isB = bseed is not None and p.card.seed==bseed
        isL = p.card.seed==lead
        if not isB and not isL: continue
        st = card_strength(p.card.rank, hier)
        if best is None: best=(p.seat,isB,st); continue
        if isB and not best[1]: best=(p.seat,isB,st); continue
        if isB==best[1] and st<best[2]: best=(p.seat,isB,st)
    return best[0]

def verify_claim_all(hands, claimant, table, turn_seat, n, bseed, hier, budget=300000):
    H={s:list(cs) for s,cs in hands.items()}
    st={"b":budget,"ex":False}
    def by(cards): return sorted(cards, key=lambda c: card_strength(c.rank,hier))
    def solve(cur, turn):
        st["b"]-=1
        if st["b"]<0: st["ex"]=True; return False
        lead = cur[0].card.seed if cur else None
        is_cl = turn==claimant
        for card in by(legal_cards(H[turn], lead)):
            H[turn].remove(card)
            nt = cur+[Play(turn,card)]
            if len(nt)==n:
                w = resolve_trick(nt,bseed,hier)
                res = False if w!=claimant else (True if len(H[claimant])==0 else solve([],claimant))
            else:
                res = solve(nt,(turn+1)%n)
            H[turn].append(card)
            if st["ex"]: return False
            if is_cl:
                if res: return True
            else:
                if not res: return False
        return not is_cl
    ok = solve(list(table), turn_seat)
    return "too_complex" if st["ex"] else ("proven" if ok else "refuted")

C=Card
def case(name,hands,cl,table,turn,n,bs,hier,exp):
    r=verify_claim_all(hands,cl,table,turn,n,bs,hier)
    print(("OK  " if r==exp else "FAIL")+f" {name}: atteso={exp} ott={r}")
    return r==exp

ok=True
ok&=case("tutti i trionfi top",{0:[C("cups","Ace"),C("cups","3")],1:[C("gold","Ace"),C("gold","3")],2:[C("swords","Ace"),C("swords","3")],3:[C("cups","King"),C("sticks","2")]},0,[],0,4,"cups",HIER_BRISCOLA,"proven")
ok&=case("avversario trionfo piu alto",{0:[C("cups","Ace"),C("cups","King")],1:[C("gold","Ace"),C("gold","3")],2:[C("swords","Ace"),C("swords","3")],3:[C("cups","3"),C("sticks","2")]},0,[],0,4,"cups",HIER_BRISCOLA,"refuted")
ok&=case("avversario puo tagliare",{0:[C("gold","Ace"),C("gold","3")],1:[C("gold","King"),C("gold","2")],2:[C("gold","Horse"),C("gold","Jack")],3:[C("cups","4"),C("cups","5")]},0,[],0,4,"cups",HIER_BRISCOLA,"refuted")
ok&=case("tresette due top",{0:[C("gold","3"),C("gold","2")],1:[C("gold","Ace"),C("gold","King")],2:[C("swords","3"),C("swords","2")],3:[C("cups","3"),C("cups","2")]},0,[],0,4,None,HIER_TRESETTE,"proven")
ok&=case("presa in corso valido",{0:[C("cups","Ace"),C("cups","3")],1:[C("gold","Ace")],2:[C("gold","King"),C("gold","Horse")],3:[C("gold","Jack"),C("gold","7")]},0,[Play(1,C("cups","King"))],0,4,"cups",HIER_BRISCOLA,"proven")
ok&=case("presa in corso avv col 3",{0:[C("cups","Ace"),C("cups","King")],1:[C("gold","Ace")],2:[C("gold","King"),C("gold","Horse")],3:[C("cups","3"),C("gold","7")]},0,[Play(1,C("cups","Jack"))],0,4,"cups",HIER_BRISCOLA,"refuted")
print("\nTUTTO OK" if ok else "\nFALLIMENTI")
