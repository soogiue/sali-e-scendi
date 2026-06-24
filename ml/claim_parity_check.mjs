import fs from "node:fs";
const HIER_BRISCOLA=["Ace","3","King","Horse","Jack","7","6","5","4","2"];
const HIER_TRESETTE=["3","2","Ace","King","Horse","Jack","7","6","5","4"];
const cardStrength=(r,h)=>{const i=h.indexOf(r);return i===-1?h.length:i;};
function legalCards(hand,lead){if(!lead)return hand.slice();const s=hand.filter(c=>c.seed===lead);return s.length?s:hand.slice();}
function resolveTrick(plays,bseed,h){const lead=plays[0].card.seed;let best=null;for(const p of plays){const{seed,rank}=p.card;const isB=bseed!=null&&seed===bseed;const isL=seed===lead;if(!isB&&!isL)continue;const st=cardStrength(rank,h);if(best===null){best={seat:p.seat,isB,st};continue;}if(isB&&!best.isB){best={seat:p.seat,isB,st};continue;}if(isB===best.isB&&st<best.st)best={seat:p.seat,isB,st};}return best.seat;}
function verifyClaimAll(hands,claimant,table,turnSeat,n,bseed,hier,nodeBudget=300000){
  let budget=nodeBudget,exceeded=false;
  const H={};for(const k of Object.keys(hands))H[+k]=hands[+k].slice();
  const remove=(s,c)=>{const a=H[s];const i=a.findIndex(x=>x.seed===c.seed&&x.rank===c.rank);if(i>=0)a.splice(i,1);};
  const restore=(s,c)=>{H[s].push(c);};
  const byStrength=(cs)=>cs.slice().sort((a,b)=>cardStrength(a.rank,hier)-cardStrength(b.rank,hier));
  function solve(curTable,turn){
    if(--budget<0){exceeded=true;return false;}
    const lead=curTable.length?curTable[0].card.seed:null;
    const legal=byStrength(legalCards(H[turn],lead));const isCl=turn===claimant;
    for(const card of legal){
      remove(turn,card);const nt=[...curTable,{seat:turn,card}];let res;
      if(nt.length===n){const w=resolveTrick(nt,bseed,hier);res=w!==claimant?false:(H[claimant].length===0?true:solve([],claimant));}
      else res=solve(nt,(turn+1)%n);
      restore(turn,card);if(exceeded)return false;
      if(isCl){if(res)return true;}else{if(!res)return false;}
    }
    return !isCl;
  }
  const ok=solve(table.slice(),turnSeat);
  return exceeded?"too_complex":(ok?"proven":"refuted");
}
const cases=JSON.parse(fs.readFileSync("claim_parity.json","utf8"));
let mism=0;
for(const c of cases){
  const hands={};for(const s of Object.keys(c.hands))hands[+s]=c.hands[s];
  const hier=c.noTrump?HIER_TRESETTE:HIER_BRISCOLA;
  const r=verifyClaimAll(hands,0,[],0,4,c.bseed,hier);
  if(r!==c.res){mism++;console.log("MISMATCH",r,"vs",c.res);}
}
console.log(`casi=${cases.length} mismatch=${mism}`);
console.log(mism===0?"PARITÀ CLAIM OK ✓":"PARITÀ CLAIM FALLITA ✗");
