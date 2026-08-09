// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hiva Nasiri. Commercial licensing: see LICENSING.md
// Headless smoke test: run the demo circuit through the real solver code.
const els_stubs = {stat:{textContent:''},phmode:{value:'3'},pv:{},pi:{},pvleg:{},pileg:{},props:{},cnv:{}};
global.document={getElementById:id=>els_stubs[id]||{},querySelector:()=>({}),};
global.getComputedStyle=()=>({getPropertyValue:()=>''});
global.matchMedia=()=>({matches:false});
let plotArgs=null;
global.drawPlots=(...a)=>{plotArgs=a;};

// ---- Validation-suite harness (SPEC §5 item 9). Per-block PASS/FAIL
// registry with hard/soft gating and an end-of-run summary. The existing
// per-block tolerance gates call record() instead of process.exit(1), so one
// regression no longer masks the rest of the suite: every block still runs
// and the summary shows them all. Catastrophic solver errors (the braced
// `if(r.err){...process.exit(1)}` guards) still bail immediately: there is
// nothing left to validate once the solver itself has crashed, and letting
// the script continue would crash on undefined metadata. `soft` is reserved
// for future tolerance-drift checks (numerical/measurement noise rather than
// wrong physics); every current gate is hard, preserving the old CI contract
// that any gate failure is exit 1. ----
const SUITE={byBlock:{},hard:0,soft:0,total:0};
function record(block,name,ok,opts){
  const soft=opts&&opts.soft;
  SUITE.total++;
  (SUITE.byBlock[block]=SUITE.byBlock[block]||[]).push({name,ok,soft:!!soft});
  if(!ok){if(soft)SUITE.soft++;else SUITE.hard++;}
  return ok;
}
function summary(){
  const names=Object.keys(SUITE.byBlock).sort();
  console.log('\n==== validation suite summary ====');
  for(const b of names){
    const rs=SUITE.byBlock[b], pass=rs.filter(r=>r.ok).length;
    const hard=rs.filter(r=>!r.ok&&!r.soft).length, soft=rs.filter(r=>!r.ok&&r.soft).length;
    const tag=hard?'FAIL':(soft?'WARN':'PASS');
    console.log('  '+tag+' '+b+': '+pass+'/'+rs.length+(soft?(' ('+soft+' soft)'):''));
  }
  const head=SUITE.hard?(SUITE.hard+' HARD FAIL'):'all green';
  console.log('==== '+head+(SUITE.soft?(', '+SUITE.soft+' soft'):'')+', '+SUITE.total+' checks ====');
  process.exit(SUITE.hard?1:0);
}

const fs=require('fs');
const blocks=fs.readFileSync('src/blocks.js','utf8');
const solver=fs.readFileSync('src/solver.js','utf8');
// S normally lives in ui.js; provide it plus the demo circuit directly
const pre=`
var S={blocks:[
 {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
 {id:2,type:'brk',x:0,y:0,params:{tclose:30,topen:-1,init:0}},
 {id:3,type:'line',x:0,y:0,params:{R:0.3,L:2}},
 {id:4,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
 {id:5,type:'gnd',x:0,y:0,params:{}},
 {id:6,type:'gnd',x:0,y:0,params:{}},
 {id:7,type:'probe',x:0,y:0,params:{}}
],wires:[
 {a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},
 {a:[1,0],b:[5,0]},{a:[4,1],b:[6,0]},{a:[7,0],b:[3,1]}
]};
`;
eval(pre+blocks+solver);
runEMT();
console.log('status:', els_stubs.stat.textContent);
const [t,probes,vp,els,ie,nph]=plotArgs;
const v=vp[0][0]; // probe, phase A
const preClose=v.filter((_,i)=>t[i]<28);
const postClose=v.filter((_,i)=>t[i]>60);
const vmaxPre=Math.max(...preClose.map(Math.abs));
const vmaxPost=Math.max(...postClose.map(Math.abs));
console.log('probe |V| before close (<28ms):', vmaxPre.toFixed(3), 'V (expect ~0)');
console.log('probe |V| after close (>60ms):', vmaxPost.toFixed(1), 'V');
// analytical check: Vload_peak = Vs_peak * R/(Rs+R+jwL) magnitude
const Vs=277*Math.SQRT2, w=2*Math.PI*60, R=12, Rs=0.5, Rl=0.3, L=2e-3;
const Zmag=Math.hypot(Rs+Rl+R, w*L);
const expected=Vs*R/Zmag;
console.log('analytical steady-state peak:', expected.toFixed(1), 'V');
const err=Math.abs(vmaxPost-expected)/expected*100;
console.log('error:', err.toFixed(2)+'%', err<2?'PASS':'FAIL');

// ---- RMS + power (P,Q) check, reusing the demo-circuit run above: load is
// pure R (Q~0), line is R+L (P,Q both nonzero) — validates the derived-signal
// math (rms/active/reactive power) against the same analytical steady state.
{
  const bv0 = plotArgs[9], freqHz0 = plotArgs[10];
  const dtOut = t[1]-t[0];
  const win = Math.max(1, Math.round(1000/freqHz0/dtOut));
  const shift = Math.max(1, Math.round(win/4));
  const movAvgLocal = s => { let sum=0; const out=new Array(s.length);
    for(let i=0;i<s.length;i++){ sum+=s[i]||0; if(i>=win) sum-=(s[i-win]||0); out[i]=sum/Math.min(i+1,win); } return out; };
  const rmsLocal = s => { let sumsq=0; const out=new Array(s.length);
    for(let i=0;i<s.length;i++){ const v=s[i]||0; sumsq+=v*v; if(i>=win){const o=s[i-win]||0; sumsq-=o*o;} out[i]=Math.sqrt(Math.max(0,sumsq)/Math.min(i+1,win)); } return out; };
  const pSeries = (v,i) => { const n=Math.min(v.length,i.length); const p=new Array(n); for(let k=0;k<n;k++) p[k]=(v[k]||0)*(i[k]||0); return movAvgLocal(p); };
  const qSeries = (v,i) => { const n=Math.min(v.length,i.length); const prod=new Array(n);
    for(let k=0;k<n;k++){ const j=Math.min(n-1,k+shift); prod[k]=(v[k]||0)*(i[j]||0); } return movAvgLocal(prod); };
  const avgAfter = (arr, lo) => { const s=arr.filter((_,i)=>t[i]>lo); return s.reduce((a,b)=>a+b,0)/s.length; };

  const loadIdx = els.findIndex(e=>e.kind==='rlc'), lineIdx = els.findIndex(e=>e.kind==='line');
  const pLoadSS = avgAfter(pSeries(bv0[loadIdx][0], ie[loadIdx][0]), 90);
  const qLoadSS = avgAfter(qSeries(bv0[loadIdx][0], ie[loadIdx][0]), 90);
  const pLineSS = avgAfter(pSeries(bv0[lineIdx][0], ie[lineIdx][0]), 90);
  const qLineSS = avgAfter(qSeries(bv0[lineIdx][0], ie[lineIdx][0]), 90);
  const vRmsSS = avgAfter(rmsLocal(v), 90);

  // ---- energy balance (Tellegen): sum of P across every branch must be ~0.
  // This is what caught (and now guards against regressing) the src/gfm sign
  // convention fix — see SPEC §3. src/gfm inject their current at terminal 0
  // (opposite of the passive elements), so their raw v·i must be negated.
  const srcIdx = els.findIndex(e=>e.kind==='src'), brkIdx = els.findIndex(e=>e.kind==='brk');
  const signFor = k => (k==='src'||k==='gfm') ? -1 : 1;
  const pOf = idx => avgAfter(pSeries(bv0[idx][0], ie[idx][0]).map(x=>x*signFor(els[idx].kind)), 90);
  const pSrcSS = pOf(srcIdx), pBrkSS = pOf(brkIdx);
  const totalP = pSrcSS + pBrkSS + pLineSS + pLoadSS;
  console.log('energy balance: src',pSrcSS.toFixed(1),'+ brk',pBrkSS.toFixed(2),'+ line',pLineSS.toFixed(1),'+ load',pLoadSS.toFixed(1),'= total',totalP.toFixed(2),'W (expect ~0)', Math.abs(totalP)<pLoadSS*0.01?'PASS':'FAIL');

  const Ipeak = Vs/Zmag, Irms = Ipeak/Math.SQRT2;
  const pLoadExp = Irms*Irms*R, pLineExp = Irms*Irms*Rl, qLineExp = Irms*Irms*(w*L), vRmsExp = expected/Math.SQRT2;
  const pctErr=(sim,exp)=>Math.abs(sim-exp)/Math.abs(exp)*100;

  console.log('probe RMS(V) sim:',vRmsSS.toFixed(1),'V, analytical Vpeak/sqrt2:',vRmsExp.toFixed(1),'V, error:',pctErr(vRmsSS,vRmsExp).toFixed(2)+'%', pctErr(vRmsSS,vRmsExp)<2?'PASS':'FAIL');
  console.log('load P sim:',pLoadSS.toFixed(1),'W, analytical Irms^2*R:',pLoadExp.toFixed(1),'W, error:',pctErr(pLoadSS,pLoadExp).toFixed(2)+'%', pctErr(pLoadSS,pLoadExp)<2?'PASS':'FAIL');
  console.log('load Q sim:',qLoadSS.toFixed(3),'VAR (pure R, expect ~0)', Math.abs(qLoadSS)<pLoadExp*0.02?'PASS':'FAIL');
  console.log('line P sim:',pLineSS.toFixed(2),'W, analytical Irms^2*Rl:',pLineExp.toFixed(2),'W, error:',pctErr(pLineSS,pLineExp).toFixed(2)+'%', pctErr(pLineSS,pLineExp)<3?'PASS':'FAIL');
  console.log('line Q sim:',qLineSS.toFixed(2),'VAR, analytical Irms^2*wL:',qLineExp.toFixed(2),'VAR, error:',pctErr(qLineSS,qLineExp).toFixed(2)+'%', pctErr(qLineSS,qLineExp)<3?'PASS':'FAIL');
  record('solver','demo derived P/Q/RMS + energy balance', !(pctErr(vRmsSS,vRmsExp)>=2 || pctErr(pLoadSS,pLoadExp)>=2 || Math.abs(qLoadSS)>=pLoadExp*0.02 || pctErr(pLineSS,pLineExp)>=3 || pctErr(qLineSS,qLineExp)>=3 || Math.abs(totalP)>=pLoadSS*0.01));
}

// ---- capacitor check: series RC divider, steady-state peak across C ----
S.blocks.length=0; S.wires.length=0; S.vconv='ph';
S.blocks.push(
 {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:10}},
 {id:2,type:'cap',x:0,y:0,params:{C:100}},
 {id:3,type:'gnd',x:0,y:0,params:{}},
 {id:4,type:'gnd',x:0,y:0,params:{}},
 {id:5,type:'probe',x:0,y:0,params:{}}
);
S.wires.push(
 {a:[1,1],b:[2,0]},{a:[2,1],b:[4,0]},{a:[1,0],b:[3,0]},{a:[5,0],b:[2,0]}
);
runEMT();
console.log('cap status:', els_stubs.stat.textContent);
{
 const [t2,,vp2]=plotArgs;
 const vc=vp2[0][0];
 const vmax=Math.max(...vc.filter((_,i)=>t2[i]>60).map(Math.abs));
 const w2=2*Math.PI*60, Zc=1/(w2*100e-6);
 const exp2=277*Math.SQRT2*Zc/Math.hypot(10,Zc);
 const err2=Math.abs(vmax-exp2)/exp2*100;
 console.log('cap |V| sim:',vmax.toFixed(1),'V, analytical:',exp2.toFixed(1),'V');
 console.log('cap error:', err2.toFixed(2)+'%', err2<2?'PASS':'FAIL');
 record('src','demo |V| steady divider', err<2);
 record('cap','series-RC divider steady peak', err2<2);
}

// ---- current-zero breaker check: demo circuit, opening armed at 60 ms ----
S.blocks.length=0; S.wires.length=0; S.vconv='ph';
S.blocks.push(
 {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
 {id:2,type:'brk',x:0,y:0,params:{tclose:30,topen:60,init:0}},
 {id:3,type:'line',x:0,y:0,params:{R:0.3,L:2}},
 {id:4,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
 {id:5,type:'gnd',x:0,y:0,params:{}},
 {id:6,type:'gnd',x:0,y:0,params:{}},
 {id:7,type:'probe',x:0,y:0,params:{}}
);
S.wires.push(
 {a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},
 {a:[1,0],b:[5,0]},{a:[4,1],b:[6,0]},{a:[7,0],b:[3,1]}
);
runEMT();
console.log('brk status:', els_stubs.stat.textContent);
{
 const [t3,,vp3,els3,ie3]=plotArgs;
 const ibrk=ie3[els3.findIndex(e=>e.kind==='brk')][0]; // phase A breaker current
 const ipeak=Math.max(...ibrk.map(Math.abs));
 // last conducting sample: must be near a current zero, not the commanded time
 let last=-1; for(let i=0;i<ibrk.length;i++) if(Math.abs(ibrk[i])>1e-3) last=i;
 const iclear=Math.abs(ibrk[last])/ipeak*100;
 console.log('brk A clears at',t3[last].toFixed(2),'ms, |i| at clearing:',iclear.toFixed(2)+'% of peak',
  (t3[last]>=60&&iclear<5)?'PASS':'FAIL');
 // after clearing, breaker current ~0
 const iresid=Math.max(...ibrk.slice(last+2).map(Math.abs));
 console.log('brk A residual current:',iresid.toExponential(2),'A',iresid<1e-3?'PASS':'FAIL');
 // per-pole clearing: load voltage collapses at a different instant per phase
 const clearT=vp3[0].map(vph=>{let l=-1;for(let i=0;i<vph.length;i++)if(Math.abs(vph[i])>1)l=i;return t3[l];});
 console.log('pole clearing times (ms):',clearT.map(x=>x.toFixed(2)).join(', '));
 const distinct=new Set(clearT.map(x=>x.toFixed(2))).size===3;
 console.log('poles clear at distinct instants:',distinct?'PASS':'FAIL');
 record('brk','per-pole current-zero clearing', !(!(t3[last]>=60&&iclear<5)||iresid>=1e-3||!distinct));
}

// ---- multi-operation breaker: reclose sequence (nOps=3, SPEC section 2) ----
// op1 close@30/open@60, op2 close@100/open@130, op3 close@170/stays closed (topen3=-1)
S.blocks.length=0; S.wires.length=0; S.vconv='ph';
S.blocks.push(
 {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
 {id:2,type:'brk',x:0,y:0,params:{tclose:30,topen:60,init:0,nOps:3,tclose2:100,topen2:130,tclose3:170,topen3:-1}},
 {id:3,type:'line',x:0,y:0,params:{R:0.3,L:2}},
 {id:4,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
 {id:5,type:'gnd',x:0,y:0,params:{}},
 {id:6,type:'gnd',x:0,y:0,params:{}}
);
S.wires.push(
 {a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},
 {a:[1,0],b:[5,0]},{a:[4,1],b:[6,0]}
);
{
 const r=simulate(3,220,null,50,0);
 if(r.err){console.log('brk multi-op: solver error:',r.err,'FAIL');process.exit(1);}
 const bi=r.curMeta.findIndex(m=>m.kind==='brk');
 const ibrk=r.ic[bi][0]; // phase A
 const maxAbsInWindow=(t0,t1)=>{let m=0; r.t.forEach((tv,k)=>{if(tv>=t0&&tv<=t1)m=Math.max(m,Math.abs(ibrk[k]));}); return m;};
 // gap windows start well after the arming instant (60/130ms) since per-pole
 // clearing waits for phase A's own next current zero, up to ~8.3ms later
 const gap1=maxAbsInWindow(70,95), gap2=maxAbsInWindow(140,165);
 const on1=maxAbsInWindow(35,55), on2=maxAbsInWindow(105,125), on3=maxAbsInWindow(175,215);
 console.log('brk multi-op: op1 conducting peak',on1.toFixed(1),'A, gap1 (70-95ms) residual',gap1.toExponential(2),'A');
 console.log('brk multi-op: op2 conducting peak',on2.toFixed(1),'A, gap2 (140-165ms) residual',gap2.toExponential(2),'A');
 console.log('brk multi-op: op3 conducting peak (topen3=-1, stays closed through end)',on3.toFixed(1),'A');
 const okShape=on1>5&&gap1<0.5&&on2>5&&gap2<0.5&&on3>5;
 console.log('brk multi-op: close/open/reclose/open/reclose-and-stay-closed shape',okShape?'PASS':'FAIL');
 // each opening must still clear at a true current zero, not the raw commanded topen instant
 const clearNear=(topenMs)=>{ let last=-1; r.t.forEach((tv,k)=>{ if(tv<topenMs+20&&Math.abs(ibrk[k])>1e-3) last=k; }); return last<0?null:{t:r.t[last],i:Math.abs(ibrk[last])}; };
 const c1=clearNear(60), c2=clearNear(130), ipeak=Math.max(on1,on2,on3);
 const clearOk=c1&&c1.t>=60&&(c1.i/ipeak*100)<5&&c2&&c2.t>=130&&(c2.i/ipeak*100)<5;
 console.log('brk multi-op: op1 clears at',c1?c1.t.toFixed(2):'?','ms, op2 clears at',c2?c2.t.toFixed(2):'?',
  'ms (both must be >= commanded time, near a current zero)',clearOk?'PASS':'FAIL');
 record('brk','multi-op close/open/reclose sequence', okShape&&clearOk);
}

// ---- transformer check: src -> 2:1 xfmr -> load, vs reflected-impedance phasor ----
S.blocks.length=0; S.wires.length=0; S.vconv='ph';
S.blocks.push(
 {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
 {id:2,type:'xfmr',x:0,y:0,params:{V1:240,V2:120,R:0.1,L:0.5}},
 {id:3,type:'rlc',x:0,y:0,params:{R:5,L:-1,C:-1}},
 {id:4,type:'gnd',x:0,y:0,params:{}},
 {id:5,type:'gnd',x:0,y:0,params:{}},
 {id:6,type:'probe',x:0,y:0,params:{}}
);
S.wires.push(
 {a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},
 {a:[3,1],b:[5,0]},{a:[6,0],b:[2,1]}
);
runEMT();
console.log('xfmr status:', els_stubs.stat.textContent);
{
 const [t4,,vp4]=plotArgs;
 const v2=vp4[0][0]; // secondary bus voltage, phase A
 const vmax=Math.max(...v2.filter((_,i)=>t4[i]>60).map(Math.abs));
 // reflect load to primary: i1 = Vs/(Rs+Rl+jwL+a^2*R), v2 = a*i1*R
 const a=2,R=5,Rs=0.5,Rl=0.1,L=0.5e-3,w4=2*Math.PI*60;
 const Zmag=Math.hypot(Rs+Rl+a*a*R, w4*L);
 const exp4=277*Math.SQRT2/Zmag*a*R;
 const err4=Math.abs(vmax-exp4)/exp4*100;
 console.log('xfmr secondary |V| sim:',vmax.toFixed(1),'V, analytical:',exp4.toFixed(1),'V');
 console.log('xfmr error:', err4.toFixed(2)+'%', err4<2?'PASS':'FAIL');
 record('xfmr','reflected-impedance secondary V', err4<2);
}

// ---- fault check: bolted-ish fault on load bus at 60 ms, clears at 90 ms ----
S.blocks.length=0; S.wires.length=0; S.vconv='ph';
S.blocks.push(
 {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
 {id:2,type:'line',x:0,y:0,params:{R:0.3,L:2}},
 {id:3,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
 {id:4,type:'fault',x:0,y:0,params:{Rf:0.05,ton:60,toff:90}},
 {id:5,type:'gnd',x:0,y:0,params:{}},
 {id:6,type:'gnd',x:0,y:0,params:{}},
 {id:7,type:'probe',x:0,y:0,params:{}}
);
S.wires.push(
 {a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[5,0]},
 {a:[3,1],b:[6,0]},{a:[4,0],b:[2,1]},{a:[7,0],b:[2,1]}
);
runEMT();
console.log('fault status:', els_stubs.stat.textContent);
{
 const [t5,,vp5]=plotArgs;
 const v=vp5[0][0];
 const inWin=(lo,hi)=>v.filter((_,i)=>t5[i]>lo&&t5[i]<hi);
 const vPre=Math.max(...inWin(40,59).map(Math.abs));
 const vFlt=Math.max(...inWin(70,89).map(Math.abs));
 const vRec=Math.max(...inWin(105,120).map(Math.abs));
 // analytical fault-on divider: Zsh = Rf||R (real), |V| = Vs*Zsh/|Rs+Rl+Zsh+jwL|
 const Rf=0.05,R=12,Rs=0.5,Rl=0.3,L5=2e-3,w5=2*Math.PI*60;
 const Zsh=Rf*R/(Rf+R);
 const exp5=277*Math.SQRT2*Zsh/Math.hypot(Rs+Rl+Zsh,w5*L5);
 const errF=Math.abs(vFlt-exp5)/exp5*100;
 console.log('fault-on |V| sim:',vFlt.toFixed(2),'V, analytical:',exp5.toFixed(2),'V, error:',errF.toFixed(2)+'%',errF<2?'PASS':'FAIL');
 const errR=Math.abs(vRec-vPre)/vPre*100;
 console.log('recovery |V|:',vRec.toFixed(1),'V vs pre-fault',vPre.toFixed(1),'V, diff:',errR.toFixed(2)+'%',errR<5?'PASS':'FAIL');
 record('fault','fault-on divider + recovery', !(errF>=2||errR>=5));
}

// ---- coupled line check: balanced load -> positive-sequence impedance Z1 = (Zs-Zm) ----
S.blocks.length=0; S.wires.length=0; S.vconv='ph';
S.blocks.push(
 {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
 {id:2,type:'line',x:0,y:0,params:{R:0.3,L:2,Rm:0.1,Lm:0.8}},
 {id:3,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
 {id:4,type:'gnd',x:0,y:0,params:{}},
 {id:5,type:'gnd',x:0,y:0,params:{}},
 {id:6,type:'probe',x:0,y:0,params:{}}
);
S.wires.push(
 {a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},
 {a:[3,1],b:[5,0]},{a:[6,0],b:[2,1]}
);
runEMT();
console.log('coupled status:', els_stubs.stat.textContent);
{
 const [t6,,vp6]=plotArgs;
 const v=vp6[0][0];
 const vmax=Math.max(...v.filter((_,i)=>t6[i]>60).map(Math.abs));
 // balanced currents see Z1 = (Rs_line-Rm) + jw(Ls-Lm)
 const w6=2*Math.PI*60;
 const Zmag=Math.hypot(0.5+(0.3-0.1)+12, w6*(2-0.8)*1e-3);
 const exp6=277*Math.SQRT2*12/Zmag;
 const err6=Math.abs(vmax-exp6)/exp6*100;
 console.log('coupled balanced |V| sim:',vmax.toFixed(1),'V, analytical (Z1):',exp6.toFixed(1),'V, error:',err6.toFixed(2)+'%',err6<2?'PASS':'FAIL');
 record('line','coupled balanced Z1 = Zs-Zm', err6<2);
}

// ---- unbalanced SLG fault: phase A fault through coupled line, B and C ride through ----
S.blocks.push({id:7,type:'fault',x:0,y:0,params:{Rf:0.05,ton:60,toff:-1,ph:1}});
S.wires.push({a:[7,0],b:[2,1]});
runEMT();
console.log('SLG status:', els_stubs.stat.textContent);
{
 const [t7,,vp7]=plotArgs;
 const post=p=>Math.max(...vp7[0][p].filter((_,i)=>t7[i]>75).map(Math.abs));
 const [vA,vB,vC]=[post(0),post(1),post(2)];
 console.log('post-fault |V| A/B/C:',vA.toFixed(1),'/',vB.toFixed(1),'/',vC.toFixed(1),'V');
 const okA=vA<30, okBC=vB>250&&vC>250;
 console.log('phase A collapsed:',okA?'PASS':'FAIL','; B,C ride through:',okBC?'PASS':'FAIL');
 // coupling makes the healthy phases respond differently: peak |V| of B vs C
 const dpk=Math.abs(vB-vC);
 console.log('B/C peak asymmetry (coupled, unbalanced):',dpk.toFixed(1),'V',dpk>5?'PASS':'FAIL');
 record('line','SLG: faulted phase collapses, healthy ride through + asymmetry', okA&&okBC&&dpk>5);
}

// ---- showcase example: all blocks at once (also a pivoting-LU regression test) ----
{
 const ex=JSON.parse(fs.readFileSync('examples/showcase.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 runEMT();
 console.log('showcase status:', els_stubs.stat.textContent);
 const [t8,,vp8]=plotArgs;
 const win=(pi,p,lo,hi)=>Math.max(...vp8[pi][p].filter((_,i)=>t8[i]>lo&&t8[i]<hi).map(Math.abs));
 // analytical pre-fault secondary voltage: complex phasor through the chain
 const C={mul:(a,b)=>[a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]],
          div:(a,b)=>{const d=b[0]*b[0]+b[1]*b[1];return[(a[0]*b[0]+a[1]*b[1])/d,(a[1]*b[0]-a[0]*b[1])/d];},
          add:(a,b)=>[a[0]+b[0],a[1]+b[1]], abs:a=>Math.hypot(a[0],a[1])};
 const w=2*Math.PI*60, a=2;
 const Zsec=C.div(C.mul([5,0],[0,-1/(w*200e-6)]), C.add([5,0],[0,-1/(w*200e-6)])); // R || C
 const Ztot=C.add(C.add([0.5+(0.3-0.1)+0.1, w*((2-0.8)+0.5)*1e-3],[0,0]), C.mul([a*a,0],Zsec));
 const exp8=277*Math.SQRT2*a*C.abs(Zsec)/C.abs(Ztot);
 const v2pre=win(1,0,35,54);
 // GFM injects ~5 kW at the secondary bus, so the passive-chain value is a
 // reference, not an exact target: bus must sit at or slightly above it
 const err8=Math.abs(v2pre-exp8)/exp8*100;
 console.log('showcase secondary pre-fault |V| sim:',v2pre.toFixed(1),'V, passive-chain ref:',exp8.toFixed(1),'V, deviation:',err8.toFixed(2)+'%',(err8<10&&v2pre>exp8-2)?'PASS':'FAIL');
 // grid-tied droop equilibrium: grid holds 60.000 Hz = gfm f0, so Pf -> P0 (5 kW)
 const [,,,els8,ie8]=plotArgs;
 const gi=els8.findIndex(e=>e.kind==='gfm');
 const igfm=Math.max(...ie8[gi][0].filter((_,i)=>t8[i]>40&&t8[i]<54).map(Math.abs));
 const iexp=2*5000/(3*v2pre); // i_peak = 2P/(3 v_peak) at unity pf
 const errI=Math.abs(igfm-iexp)/iexp*100;
 console.log('showcase GFM pre-fault current:',igfm.toFixed(1),'A peak, P0-equilibrium estimate:',iexp.toFixed(1),'A, deviation:',errI.toFixed(0)+'%',errI<40?'PASS':'FAIL');
 // SLG fault on primary at 55 ms: phase A primary collapses, clears by 85 ms + zero-crossing
 const vApri_flt=win(0,0,65,84), vApri_rec=win(0,0,100,120), vApri_pre=win(0,0,35,54);
 const okFlt=vApri_flt<0.15*vApri_pre, okRec=Math.abs(vApri_rec-vApri_pre)/vApri_pre<0.05;
 console.log('showcase primary A fault-on:',vApri_flt.toFixed(1),'V (pre',vApri_pre.toFixed(1),'V)',okFlt?'PASS':'FAIL',
  '; recovered:',vApri_rec.toFixed(1),'V',okRec?'PASS':'FAIL');
 // stability guard: nothing exploded anywhere
 let vmax=0; vp8.forEach(pr=>pr.forEach(ph=>ph.forEach(v=>{if(Math.abs(v)>vmax)vmax=Math.abs(v);})));
 console.log('showcase max |V| anywhere:',vmax.toFixed(1),'V',vmax<2000?'PASS':'FAIL');
 record('fixture:showcase','all-blocks integration + pivoting-LU regression', !(err8>=10||v2pre<=exp8-2||errI>=40||!okFlt||!okRec||vmax>=2000));
}

// ---- GFM inverter island: droop fixed point (|V| and drooped frequency) ----
S.blocks.length=0; S.wires.length=0; S.vconv='ph';
S.blocks.push(
 {id:1,type:'gfm',x:0,y:0,params:{E0:277,f0:60,mp:0.05,mq:0.5,P0:0,Q0:0,Rf:0.1,Lf:1,Tf:20}},
 {id:2,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
 {id:3,type:'gnd',x:0,y:0,params:{}},
 {id:4,type:'gnd',x:0,y:0,params:{}},
 {id:5,type:'probe',x:0,y:0,params:{}}
);
S.wires.push(
 {a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[2,1],b:[4,0]},{a:[5,0],b:[2,0]}
);
runEMT();
console.log('gfm status:', els_stubs.stat.textContent);
{
 const [t9,,vp9]=plotArgs;
 const v=vp9[0][0];
 // analytical droop fixed point: f = f0 - mp*P/1000, P = 3*(E0/|Zf+R|)^2*R
 const E0=277,R=12,Rf=0.1,Lf=1e-3,mp=0.05;
 let f=60,Zm=0,P=0;
 for(let it=0;it<6;it++){
  const w=2*Math.PI*f; Zm=Math.hypot(Rf+R,w*Lf);
  P=3*(E0/Zm)**2*R; f=60-mp*P/1000;
 }
 const expV=E0*Math.SQRT2*R/Zm;
 const vmax=Math.max(...v.filter((_,i)=>t9[i]>100).map(Math.abs));
 const errV=Math.abs(vmax-expV)/expV*100;
 console.log('gfm |V| sim:',vmax.toFixed(1),'V, analytical:',expV.toFixed(1),'V, error:',errV.toFixed(2)+'%',errV<2?'PASS':'FAIL');
 // measure frequency from interpolated zero upcrossings in 85-120 ms
 const xs=[];
 for(let i=1;i<v.length;i++){
  if(t9[i]>85&&t9[i]<=120&&v[i-1]<0&&v[i]>=0)
   xs.push(t9[i-1]+(t9[i]-t9[i-1])*(-v[i-1])/(v[i]-v[i-1]));
 }
 let fmeas=0; if(xs.length>=2) fmeas=1000*(xs.length-1)/(xs[xs.length-1]-xs[0]);
 const errF=Math.abs(fmeas-f);
 console.log('gfm frequency sim:',fmeas.toFixed(3),'Hz, droop prediction:',f.toFixed(3),'Hz, |diff|:',errF.toFixed(3),'Hz',errF<0.1?'PASS':'FAIL');
 console.log('gfm delivered P (analytical fixed point):',(P/1000).toFixed(2),'kW');
 record('gfm','island droop fixed point |V| + frequency', !(errV>=2||errF>=0.1));
}

// ---- GFM AC current limiter (SPEC §2): EMF-backoff holds a 3-ph terminal
// fault at Iacmax; prefault droop fixed point undisturbed (limit not reached);
// voltage recovers after clearing (mu released); Iacmax=0 reproduces the
// unlimited current (backward compatibility for pre-feature files). ----
{
 const mk=iac=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'gfm',x:0,y:0,params:{E0:277,f0:60,mp:0.05,mq:0.5,P0:0,Q0:0,Rf:0.1,Lf:1,Tf:20,Iacmax:iac}},
   {id:2,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'fault',x:0,y:0,params:{Rf:0.05,ton:100,toff:200,ph:0}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[2,1],b:[4,0]},{a:[5,0],b:[2,0]});
  return simulate(3,600,null);
 };
 // balanced 3-ph RMS over a window: sqrt(mean of (ia²+ib²+ic²)/3) — for a
 // balanced set this is the instantaneous phase RMS, no cycle-window needed
 const irms=(r,gi,lo,hi)=>{
  let s=0,n=0;
  for(let i=0;i<r.t.length;i++){
   if(r.t[i]<=lo||r.t[i]>=hi) continue;
   s+=(r.ic[gi][0][i]**2+r.ic[gi][1][i]**2+r.ic[gi][2][i]**2)/3; n++;
  }
  return Math.sqrt(s/n);
 };
 const rL=mk(40);
 console.log('gfm limiter status:', rL.err||rL.stat);
 if(rL.err) process.exit(1);
 const gi=rL.curEls.findIndex(e=>e.kind==='gfm');
 // prefault: droop fixed point (same iteration as the island test above)
 const E0=277,R=12,Rf=0.1,Lf=1e-3,mp=0.05;
 let f=60;
 for(let it=0;it<6;it++){
  const Zm=Math.hypot(Rf+R,2*Math.PI*f*Lf);
  f=60-mp*3*(E0/Zm)**2*R/1000;
 }
 const Zm=Math.hypot(Rf+R,2*Math.PI*f*Lf), iPre=E0/Zm;
 const iPreSim=irms(rL,gi,60,95);
 const ePre=Math.abs(iPreSim-iPre)/iPre*100;
 console.log('gfm limiter prefault I:',iPreSim.toFixed(1),'A rms, analytical:',iPre.toFixed(1),'A, error:',ePre.toFixed(2)+'%',ePre<3?'PASS':'FAIL');
 // during fault: held at Iacmax (~2% high by design, SPEC §2), vs 683 A unlimited
 const iFlt=irms(rL,gi,150,195);
 const eFlt=Math.abs(iFlt-40)/40*100;
 console.log('gfm limiter fault I:',iFlt.toFixed(1),'A rms, limit 40 A, deviation:',eFlt.toFixed(1)+'%',eFlt<10?'PASS':'FAIL');
 // recovery: mu released (100 ms tau), current back at the droop fixed point
 const iRec=irms(rL,gi,550,595);
 const eRec=Math.abs(iRec-iPre)/iPre*100;
 console.log('gfm limiter recovery I:',iRec.toFixed(1),'A rms, prefault:',iPre.toFixed(1),'A, error:',eRec.toFixed(2)+'%',eRec<5?'PASS':'FAIL');
 // Iacmax=0: limiter off, fault current is the raw E/|Z| (backward compat)
 const rU=mk(0);
 const gU=rU.curEls.findIndex(e=>e.kind==='gfm');
 const iUnl=irms(rU,gU,150,195);
 console.log('gfm no-limit fault I:',iUnl.toFixed(0),'A rms (unlimited, expect ~683):',iUnl>400?'PASS':'FAIL');
 record('gfm','AC current limiter (island): prefault/limit/recovery/no-limit', !(ePre>=3||eFlt>=10||eRec>=5||iUnl<=400));
}

// ---- GFM AC current limiter, GRID-TIED (SPEC §2): the case the proportional
// mu·Iacmax/If law latched on (current is NOT ∝ mu against a grid: it follows
// the mu·E − Vgrid phasor difference, so that law drove mu to the floor after
// clearing and held 5x over-limit while absorbing power). The affine phasor
// solve must hold the limit during the fault, then RELEASE fully (mu back to
// exactly 1) in both modes; in GFL mode the PI trims must re-engage after the
// anti-windup freeze and re-settle on the P0 setpoint. ----
{
 const mk=(mode,P0,Q0)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'gfm',x:0,y:0,params:{mode,E0:277,f0:60,mp:0.05,mq:0.5,P0,Q0,kiP:0.15,kiQ:25,Rf:0.1,Lf:3,Tf:20,Idcmax:100,Iacmax:40}},
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'fault',x:0,y:0,params:{Rf:0.05,ton:100,toff:200,ph:0}}
  );
  S.wires.push({a:[1,1],b:[2,1]},{a:[1,0],b:[3,0]},{a:[2,0],b:[4,0]},{a:[5,0],b:[2,1]});
  return simulate(3,1500,null);
 };
 const irms=(r,gi,lo,hi)=>{
  let s=0,n=0;
  for(let i=0;i<r.t.length;i++){
   if(r.t[i]<=lo||r.t[i]>=hi) continue;
   s+=(r.ic[gi][0][i]**2+r.ic[gi][1][i]**2+r.ic[gi][2][i]**2)/3; n++;
  }
  return Math.sqrt(s/n);
 };
 // droop mode at zero setpoint: E0 matches the grid, so prefault AND
 // recovered exchange is ~0 A (the latched failure held ~214 A here)
 const rD=mk(0,0,0);
 console.log('gfm grid-tied limiter status:', rD.err||rD.stat);
 if(rD.err) process.exit(1);
 const gD=rD.curEls.findIndex(e=>e.kind==='gfm');
 const eD=rD.curEls[gD];
 const iDf=irms(rD,gD,150,195), iDe=irms(rD,gD,1400,1495);
 const eDf=Math.abs(iDf-40)/40*100;
 console.log('gfm grid droop fault I:',iDf.toFixed(1),'A rms, limit 40 A, deviation:',eDf.toFixed(1)+'%',eDf<10?'PASS':'FAIL');
 console.log('gfm grid droop release: end I',iDe.toFixed(2),'A rms (expect ~0, latch was ~214), mu',eD.mu,(iDe<2&&eD.mu===1)?'PASS':'FAIL');
 // GFL mode: PI must re-settle on P0=5 kW after the fault (integrators unfrozen)
 const rG=mk(1,5,1);
 if(rG.err) process.exit(1);
 const gG=rG.curEls.findIndex(e=>e.kind==='gfm');
 const eG=rG.curEls[gG];
 const iGf=irms(rG,gG,150,195);
 const eGf=Math.abs(iGf-40)/40*100;
 const ePset=Math.abs(eG.Pf/1000-5)/5*100;
 console.log('gfm grid GFL fault I:',iGf.toFixed(1),'A rms, limit 40 A, deviation:',eGf.toFixed(1)+'%',eGf<10?'PASS':'FAIL');
 console.log('gfm grid GFL re-trim: P end',(eG.Pf/1000).toFixed(3),'kW, setpoint 5 kW, error:',ePset.toFixed(1)+'%, mu',eG.mu,(ePset<5&&eG.mu===1)?'PASS':'FAIL');
 record('gfm','AC current limiter (grid-tied): limit + full release + GFL re-trim', !(eDf>=10||iDe>=2||eD.mu!==1||eGf>=10||ePset>=5||eG.mu!==1));
}

// ---- GFM DC port (SPEC §2): droop mode, DC+ wired to a battery+cap so the
// inverter actually draws the power it delivers to its AC island load from a
// real DC source. Battery holds the DC bus at its Vref; Idc must match the
// AC-side delivered power (lossless AVM) divided by that bus voltage ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'gfm',x:0,y:0,params:{mode:0,E0:277,f0:60,mp:0.05,mq:0.5,P0:0,Q0:0,kiP:0.02,kiQ:0.2,Rf:0.1,Lf:1,Tf:20,Idcmax:100}},
  {id:2,type:'rlc',x:0,y:0,params:{R:200,L:-1,C:-1}},
  {id:3,type:'gnd',x:0,y:0,params:{}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'batt',x:0,y:0,params:{Vref:360,Imax:50,kp:2,ki:2000,Ah:0.02,soc0:100,Ichg:10}},
  {id:6,type:'cap',x:0,y:0,params:{C:1000}},
  {id:7,type:'gnd',x:0,y:0,params:{}},
  {id:8,type:'gnd',x:0,y:0,params:{}},
  {id:9,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[2,1],b:[4,0]},
  {a:[1,2],b:[6,0]},{a:[6,1],b:[8,0]},
  {a:[5,1],b:[1,2]},{a:[5,0],b:[7,0]},
  {a:[9,0],b:[1,2]}
 );
 els_stubs.phmode.value='3';
 runEMT();
 console.log('gfm dc-port status:', els_stubs.stat.textContent);
 const [tD,,vpD,elsD,,,,,,,,auxD]=plotArgs;
 const gi=elsD.findIndex(e=>e.kind==='gfm');
 const idc=auxD[gi], vdc=vpD[0][0];
 const avg=(a,lo)=>{ const s=a.filter((_,i)=>tD[i]>lo); return s.reduce((x,y)=>x+y,0)/s.length; };
 const vdcSS=avg(vdc,90), idcSS=avg(idc,90);
 // analytical droop fixed point (same formula as the standalone gfm test above)
 const E0=277,R=200,Rf=0.1,Lf=1e-3,mp=0.05;
 let f=60,Zm=0,P=0;
 for(let it=0;it<6;it++){ const w=2*Math.PI*f; Zm=Math.hypot(Rf+R,w*Lf); P=3*(E0/Zm)**2*R; f=60-mp*P/1000; }
 const idcExp=P/vdcSS;
 const errIdc=Math.abs(idcSS-idcExp)/idcExp*100;
 console.log('gfm dc-port: bus |V|',vdcSS.toFixed(1),'V (battery Vref 360)',Math.abs(vdcSS-360)<3.6?'PASS':'FAIL');
 console.log('gfm dc-port: Idc sim',idcSS.toFixed(2),'A, analytical Pac/Vdc:',idcExp.toFixed(2),'A, error:',errIdc.toFixed(2)+'%',errIdc<3?'PASS':'FAIL');
 console.log('gfm dc-port: discharging into the AC load (Idc>0):',idcSS>0?'PASS':'FAIL');
 record('gfm','DC port: bus hold + Idc = Pac/Vdc', !(Math.abs(vdcSS-360)>=3.6||errIdc>=3||idcSS<=0));
}

// ---- GFM grid-following (GFL) mode: PI-dispatches P0/Q0 into a stiff grid
// instead of drooping away from it. The decoupled P->frequency/Q->voltage PI
// (SPEC §2) assumes a predominantly inductive tie, same as droop control
// always does — found by direct experimentation (see PR discussion): with
// the default Lf=1mH the tie here (Rf+Rs=0.6Ω vs Xf=0.377Ω) is resistance-
// dominated and Q tracking is either very slow or poorly damped, so this test
// uses a taller Lf (a well-filtered inverter, X/R~3) to check the CONTROL LAW
// itself converges correctly; defaults stay gentle/conservative (kiP/kiQ)
// so mode=1 doesn't oscillate out of the box on a less-inductive tie. Runs
// simulate() directly (not through runEMT()) for a longer settling window
// than the default 120 ms UI duration. ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'gfm',x:0,y:0,params:{mode:1,E0:277,f0:60,mp:0.05,mq:0.5,P0:5,Q0:1,kiP:0.15,kiQ:25,Rf:0.1,Lf:3,Tf:20,Idcmax:100}},
  {id:3,type:'gnd',x:0,y:0,params:{}},
  {id:4,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,1]},{a:[1,0],b:[3,0]},{a:[2,0],b:[4,0]}
 );
 const r=simulate(3,600,null);
 console.log('gfl status:', r.err||r.stat);
 if(r.err) process.exit(1);
 const gi=r.curEls.findIndex(e=>e.kind==='gfm');
 const bv=r.bv[gi], ic=r.ic[gi], tL=r.t;
 let sp=0,sq=0,n=0;
 for(let i=0;i<tL.length;i++){
  if(tL[i]<=500) continue; // steady-state window after PI settling
  const v0=bv[0][i],v1=bv[1][i],v2=bv[2][i],i0=ic[0][i],i1=ic[1][i],i2=ic[2][i];
  sp += v0*i0+v1*i1+v2*i2;
  sq += ((v1-v2)*i0+(v2-v0)*i1+(v0-v1)*i2)/Math.sqrt(3);
  n++;
 }
 const Pss=sp/n, Qss=sq/n;
 const errP=Math.abs(Pss-5000)/5000*100, errQ=Math.abs(Qss-1000)/1000*100;
 console.log('gfl: P sim',(Pss/1000).toFixed(2),'kW, setpoint 5.00 kW, error:',errP.toFixed(1)+'%',errP<5?'PASS':'FAIL');
 console.log('gfl: Q sim',(Qss/1000).toFixed(2),'kvar, setpoint 1.00 kvar, error:',errQ.toFixed(1)+'%',errQ<5?'PASS':'FAIL');
 record('gfm','GFL mode: PI P0/Q0 setpoint into stiff grid', !(errP>=5||errQ>=5));
}

// ---- DC bus (tests/fixtures/dcbus.json): PFC holds 380 V, grid lost at 60 ms, battery catches at 360 V ----
{
 const ex=JSON.parse(fs.readFileSync('tests/fixtures/dcbus.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 els_stubs.phmode.value='1';
 runEMT();
 els_stubs.phmode.value='3';
 console.log('dcbus status:', els_stubs.stat.textContent);
 const [tA,,vpA,elsA,ieA]=plotArgs;
 const v=vpA[0][0];
 const win=(lo,hi)=>v.filter((_,i)=>tA[i]>lo&&tA[i]<hi);
 const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
 const vGrid=avg(win(40,58)), vBatt=avg(win(90,120));
 const okG=Math.abs(vGrid-380)<380*0.01, okB=Math.abs(vBatt-360)<360*0.01;
 console.log('dcbus |V| grid-up:',vGrid.toFixed(1),'V (PI target 380)',okG?'PASS':'FAIL',
  '; on battery:',vBatt.toFixed(1),'V (target 360)',okB?'PASS':'FAIL');
 const vSagMin=Math.min(...win(58,75));
 console.log('dcbus ride-through minimum:',vSagMin.toFixed(1),'V (must stay above UVLO 300)',vSagMin>300?'PASS':'FAIL');
 const iOf=k=>ieA[elsA.findIndex(e=>e.kind===k)][0];
 const iBattIdle=Math.max(...iOf('batt').filter((_,i)=>tA[i]>40&&tA[i]<58).map(Math.abs));
 const iBattOn=avg(iOf('batt').filter((_,i)=>tA[i]>90));
 const iCplOn=avg(iOf('cpl').filter((_,i)=>tA[i]>90));
 const expBatt=10000/360;
 const errB=Math.abs(iBattOn-expBatt)/expBatt*100;
 console.log('dcbus battery idle current:',iBattIdle.toFixed(2),'A (expect ~0)',iBattIdle<0.5?'PASS':'FAIL');
 console.log('dcbus battery on-load:',iBattOn.toFixed(1),'A, analytical P/V:',expBatt.toFixed(1),'A, error:',errB.toFixed(1)+'%',errB<3?'PASS':'FAIL');
 const iPfcMax=Math.max(...iOf('pfc').map(Math.abs));
 console.log('dcbus PFC current limit respected: max',iPfcMax.toFixed(1),'A ≤ 40 A',iPfcMax<=40.01?'PASS':'FAIL');
 record('fixture:dcbus','PFC hold + battery catch + CPL + PFC limit', !(!okG||!okB||vSagMin<=300||iBattIdle>=0.5||errB>=3||iPfcMax>40.01));
 void iCplOn;
}

// ---- hybrid AC/DC (tests/fixtures/hybrid.json): grid -> breaker -> PFC bridge -> DC bus ----
// breaker opens at 60 ms (current zero, per pole) -> PFC UV shutdown -> battery catches
{
 const ex=JSON.parse(fs.readFileSync('tests/fixtures/hybrid.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 runEMT();
 console.log('hybrid status:', els_stubs.stat.textContent);
 const [tH,,vpH,elsH,ieH]=plotArgs;
 const vac=vpH[0][0], vdc=vpH[1][0]; // probe 12 = AC bus, probe 13 = DC bus
 const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
 const winA=(arr,lo,hi)=>arr.filter((_,i)=>tH[i]>lo&&tH[i]<hi);
 // DC side: 380 V on grid, battery catches 360 V after breaker opens
 const vG=avg(winA(vdc,40,58)), vB=avg(winA(vdc,95,120));
 const okG=Math.abs(vG-380)<3.8, okB=Math.abs(vB-360)<3.6;
 console.log('hybrid DC bus on grid:',vG.toFixed(1),'V (380)',okG?'PASS':'FAIL',
  '; on battery:',vB.toFixed(1),'V (360)',okB?'PASS':'FAIL');
 // cross-domain power balance: line carries AC load + PFC draw at unity pf.
 // ipk_line = sqrt2*(3*Vrms^2/12 + 10000)/(3*Vrms), Vrms from the AC probe
 const vpkAC=Math.max(...winA(vac,40,58).map(Math.abs));
 const Vrms=vpkAC/Math.SQRT2;
 const iLine=Math.max(...winA(ieH[elsH.findIndex(e=>e.kind==='line')][0],40,58).map(Math.abs));
 const iExp=Math.SQRT2*(3*Vrms*Vrms/12+10000)/(3*Vrms);
 const errL=Math.abs(iLine-iExp)/iExp*100;
 console.log('hybrid line current:',iLine.toFixed(1),'A peak, power-balance prediction:',iExp.toFixed(1),'A, error:',errL.toFixed(1)+'%',errL<5?'PASS':'FAIL');
 // after the poles clear, the AC bus is dead and the PFC has shut down on UV
 const vacPost=Math.max(...winA(vac,90,120).map(Math.abs));
 const iPfcPost=Math.max(...winA(ieH[elsH.findIndex(e=>e.kind==='pfc')][0],90,120).map(Math.abs));
 console.log('hybrid AC bus post-trip:',vacPost.toFixed(2),'V (expect ~0)',vacPost<20?'PASS':'FAIL',
  '; PFC output post-trip:',iPfcPost.toFixed(2),'A',iPfcPost<0.1?'PASS':'FAIL');
 // DC ride-through
 const vMin=Math.min(...winA(vdc,58,90));
 console.log('hybrid DC ride-through min:',vMin.toFixed(1),'V (> UVLO 300)',vMin>300?'PASS':'FAIL');
 const battOn=avg(winA(ieH[elsH.findIndex(e=>e.kind==='batt')][0],95,120));
 const errBt=Math.abs(battOn-10000/360)/(10000/360)*100;
 console.log('hybrid battery on-load:',battOn.toFixed(1),'A (P/V = 27.8), error:',errBt.toFixed(1)+'%',errBt<3?'PASS':'FAIL');
 record('fixture:hybrid','AC/DC bridge: breaker trip -> UV shutdown -> battery catch', !(!okG||!okB||errL>=5||vacPost>=20||iPfcPost>=0.1||vMin<=300||errBt>=3));
}

// ---- bus check: a bus ties every wired tap to ONE node; must be electrically
// identical to wiring the same components directly to a shared point, and
// must support more than two connections cleanly (the whole point of it) ----
{
 // reference: two 24Ω loads wired directly to the same source terminal (no bus)
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'rlc',x:0,y:0,params:{R:24,L:-1,C:-1}},
  {id:3,type:'rlc',x:0,y:0,params:{R:24,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'gnd',x:0,y:0,params:{}},
  {id:7,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,0]},{a:[1,1],b:[3,0]},
  {a:[2,1],b:[5,0]},{a:[3,1],b:[6,0]},
  {a:[1,0],b:[4,0]},{a:[7,0],b:[1,1]}
 );
 runEMT();
 const [tRef,,vpRef]=plotArgs;
 const vRef=Math.max(...vpRef[0][0].filter((_,i)=>tRef[i]>60).map(Math.abs));

 // same circuit via a bus: src + 2 loads + probe on 4 of its 6 taps
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:8,type:'bus',x:0,y:0,params:{name:'Feeder',taps:6,len:160}},
  {id:2,type:'rlc',x:0,y:0,params:{R:24,L:-1,C:-1}},
  {id:3,type:'rlc',x:0,y:0,params:{R:24,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'gnd',x:0,y:0,params:{}},
  {id:7,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[8,0]}, {a:[8,1],b:[2,0]}, {a:[8,2],b:[3,0]}, {a:[7,0],b:[8,3]},
  {a:[2,1],b:[5,0]},{a:[3,1],b:[6,0]},
  {a:[1,0],b:[4,0]}
 );
 runEMT();
 console.log('bus status:', els_stubs.stat.textContent);
 const [tBus,,vpBus]=plotArgs;
 const vBus=Math.max(...vpBus[0][0].filter((_,i)=>tBus[i]>60).map(Math.abs));
 const err=Math.abs(vBus-vRef)/vRef*100;
 console.log('bus vs direct multi-wire junction |V| — reference:',vRef.toFixed(3),'V, via bus:',vBus.toFixed(3),'V, diff:',err.toFixed(4)+'%',err<0.01?'PASS':'FAIL');
 record('bus','multi-wire junction == direct wiring', err<0.01);

 // buses are monitored automatically: the run above must expose the bus as a
 // voltage signal (probeMeta entry with its name, AC auto-detected) alongside
 // the explicit probe, and both must read the same node voltage.
 const pm=plotArgs[6]; // probeMeta
 const busMeta=pm.find(m=>m.type==='bus');
 const okMeta=!!busMeta&&busMeta.id===8&&busMeta.name==='Feeder'&&busMeta.dc===false;
 console.log('bus auto-monitor meta:',JSON.stringify(busMeta),okMeta?'PASS':'FAIL');
 const busIdx=pm.indexOf(busMeta), prbIdx=pm.findIndex(m=>m.type==='probe');
 const dmax=Math.max(...vpBus[busIdx][0].map((v,i)=>Math.abs(v-vpBus[prbIdx][0][i])));
 console.log('bus signal == probe signal (same node), max |diff|:',dmax.toExponential(2),'V',dmax<1e-9?'PASS':'FAIL');
 record('bus','auto-monitor meta + signal == probe', okMeta&&dmax<1e-9);
}

// ---- single-tap bus: 1 tap is legal (named node anchor); several wires may
// share the one tap; circuit must solve identically to the 6-tap version ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:8,type:'bus',x:0,y:0,params:{name:'Node',taps:1,len:40}},
  {id:2,type:'rlc',x:0,y:0,params:{R:24,L:-1,C:-1}},
  {id:3,type:'rlc',x:0,y:0,params:{R:24,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[8,0]},{a:[8,0],b:[2,0]},{a:[8,0],b:[3,0]},
  {a:[2,1],b:[5,0]},{a:[3,1],b:[6,0]},{a:[1,0],b:[4,0]}
 );
 runEMT();
 console.log('1-tap bus status:', els_stubs.stat.textContent);
 const [t1t,,vp1t]=plotArgs;
 const v1t=Math.max(...vp1t[0][0].filter((_,i)=>t1t[i]>60).map(Math.abs));
 // analytical: 24||24 = 12 Ω divider against Rs = 0.5
 const exp1t=277*Math.SQRT2*12/12.5;
 const err1t=Math.abs(v1t-exp1t)/exp1t*100;
 console.log('1-tap bus |V| sim:',v1t.toFixed(1),'V, analytical:',exp1t.toFixed(1),'V, error:',err1t.toFixed(2)+'%',err1t<2?'PASS':'FAIL');
 record('bus','single-tap named node anchor', err1t<2);
}

// ---- bus Vhi/Vlo band (PSS/E NVHI/NVLO): solvePowerFlow must carry each bus's
// own limits on busBlocks, falling back to 0.95/1.05 when 0 so every existing
// circuit colors identically to the old hardcoded band. ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:8,type:'bus',x:0,y:0,params:{name:'Custom',taps:2,len:40,Vhi:1.2,Vlo:0.8}},
  {id:9,type:'bus',x:0,y:0,params:{name:'Default',taps:2,len:40}},
  {id:2,type:'rlc',x:0,y:0,params:{R:24,L:-1,C:-1}},
  {id:3,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[8,0]},{a:[8,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[3,0]});
 S.wires.push({a:[1,1],b:[9,0]});
 const pfr=solvePowerFlow();
 const bm=new Map((pfr.busBlocks||[]).map(b=>[b.name,b]));
 const cu=bm.get('Custom'), df=bm.get('Default');
 const okCu=!!cu&&Math.abs(cu.Vhi-1.2)<1e-9&&Math.abs(cu.Vlo-0.8)<1e-9;
 const okDf=!!df&&Math.abs(df.Vhi-1.05)<1e-9&&Math.abs(df.Vlo-0.95)<1e-9;
 console.log('bus Vhi/Vlo custom:',cu&&cu.Vhi+'/'+cu.Vlo,'(expect 1.2/0.8)',okCu?'PASS':'FAIL');
 console.log('bus Vhi/Vlo default:',df&&df.Vhi+'/'+df.Vlo,'(expect 1.05/0.95)',okDf?'PASS':'FAIL');
 record('bus','per-bus Vhi/Vlo band on busBlocks (custom + default fallback)', okCu&&okDf);
}

// ---- DC/DC converter, CV mode (SPEC §2): a battery at its own native 48 V
// feeds the converter's IN port; the converter PI-regulates OUT to 380 V
// against a resistive load. Verify OUT holds Vref, the output current
// matches the load's own draw, and the input current matches the lossless
// power-balance prediction (and equals the battery's own reported current,
// since they're literally the same node) ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'batt',x:0,y:0,params:{Vref:48,Imax:100,kp:2,ki:2000,Ah:0.02,soc0:100,Ichg:10}},
  {id:2,type:'dcdc',x:0,y:0,params:{mode:0,Vref:380,Imax:100,kp:2,ki:2000,I0:0}},
  {id:3,type:'cap',x:0,y:0,params:{C:1000}},
  {id:4,type:'rlc',x:0,y:0,params:{R:50,L:-1,C:-1}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'gnd',x:0,y:0,params:{}},
  {id:7,type:'gnd',x:0,y:0,params:{}},
  {id:8,type:'probe',x:0,y:0,params:{}},
  {id:9,type:'probe',x:0,y:0,params:{}},
  {id:10,type:'cap',x:0,y:0,params:{C:1000}}, // IN-side node: battery + dcdc.IN are both G=0 — needs a cap too
  {id:11,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,0]},{a:[1,0],b:[5,0]},
  {a:[2,1],b:[3,0]},{a:[3,1],b:[6,0]},
  {a:[2,1],b:[4,0]},{a:[4,1],b:[7,0]},
  {a:[8,0],b:[2,0]},{a:[9,0],b:[2,1]},
  {a:[10,0],b:[2,0]},{a:[10,1],b:[11,0]}
 );
 els_stubs.phmode.value='1';
 runEMT();
 els_stubs.phmode.value='3';
 console.log('dcdc CV status:', els_stubs.stat.textContent);
 const [tC,,vpC,elsC,ieC]=plotArgs;
 const avg=(a,lo)=>{ const s=a.filter((_,i)=>tC[i]>lo); return s.reduce((x,y)=>x+y,0)/s.length; };
 const vIn=avg(vpC[0][0],90), vOut=avg(vpC[1][0],90);
 const di=elsC.findIndex(e=>e.kind==='dcdc'), bi=elsC.findIndex(e=>e.kind==='batt');
 const iOut=avg(ieC[di][0],90), iBatt=avg(ieC[bi][0],90);
 console.log('dcdc CV: OUT |V|',vOut.toFixed(1),'V (Vref 380)',Math.abs(vOut-380)<3.8?'PASS':'FAIL');
 const iOutExp=380/50; // load draw at Vref
 const errIOut=Math.abs(iOut-iOutExp)/iOutExp*100;
 console.log('dcdc CV: OUT current',iOut.toFixed(2),'A, analytical Vref/R:',iOutExp.toFixed(2),'A, error:',errIOut.toFixed(2)+'%',errIOut<2?'PASS':'FAIL');
 const iInExp=(iOut*vOut)/vIn; // lossless power balance
 const errIIn=Math.abs(iBatt-iInExp)/iInExp*100;
 console.log('dcdc CV: IN current (=battery)',iBatt.toFixed(2),'A, analytical Pout/Vin:',iInExp.toFixed(2),'A, error:',errIIn.toFixed(2)+'%',errIIn<2?'PASS':'FAIL');
 record('dcdc','CV mode: Vref hold + out/in current power balance', !(Math.abs(vOut-380)>=3.8||errIOut>=2||errIIn>=2));
}

// ---- DC/DC converter, CC mode: dispatches a fixed output current directly
// (no PI) into a resistive load; input current must still satisfy lossless
// power balance against the battery's own (different, stepped-down) voltage ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'batt',x:0,y:0,params:{Vref:48,Imax:50,kp:2,ki:2000,Ah:0.02,soc0:100,Ichg:10}},
  {id:2,type:'dcdc',x:0,y:0,params:{mode:1,Vref:380,Imax:50,kp:2,ki:2000,I0:10}},
  {id:3,type:'cap',x:0,y:0,params:{C:1000}},
  {id:4,type:'rlc',x:0,y:0,params:{R:20,L:-1,C:-1}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'gnd',x:0,y:0,params:{}},
  {id:7,type:'gnd',x:0,y:0,params:{}},
  {id:8,type:'probe',x:0,y:0,params:{}},
  {id:9,type:'probe',x:0,y:0,params:{}},
  {id:10,type:'cap',x:0,y:0,params:{C:1000}}, // IN-side node: battery + dcdc.IN are both G=0 — needs a cap too
  {id:11,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,0]},{a:[1,0],b:[5,0]},
  {a:[2,1],b:[3,0]},{a:[3,1],b:[6,0]},
  {a:[2,1],b:[4,0]},{a:[4,1],b:[7,0]},
  {a:[8,0],b:[2,0]},{a:[9,0],b:[2,1]},
  {a:[10,0],b:[2,0]},{a:[10,1],b:[11,0]}
 );
 els_stubs.phmode.value='1';
 runEMT();
 els_stubs.phmode.value='3';
 console.log('dcdc CC status:', els_stubs.stat.textContent);
 const [tD,,vpD,elsD,ieD]=plotArgs;
 const avg=(a,lo)=>{ const s=a.filter((_,i)=>tD[i]>90); return s.reduce((x,y)=>x+y,0)/s.length; };
 const vIn=avg(vpD[0][0],90), vOut=avg(vpD[1][0],90);
 const di=elsD.findIndex(e=>e.kind==='dcdc'), bi=elsD.findIndex(e=>e.kind==='batt');
 const iOut=avg(ieD[di][0],90), iBatt=avg(ieD[bi][0],90);
 const errIOut=Math.abs(iOut-10)/10*100;
 console.log('dcdc CC: OUT current',iOut.toFixed(2),'A, setpoint I0=10 A, error:',errIOut.toFixed(2)+'%',errIOut<1?'PASS':'FAIL');
 const vOutExp=10*20; // I0 * R
 console.log('dcdc CC: OUT |V|',vOut.toFixed(1),'V, analytical I0*R:',vOutExp.toFixed(1),'V',Math.abs(vOut-vOutExp)<2?'PASS':'FAIL');
 const iInExp=(iOut*vOut)/vIn;
 const errIIn=Math.abs(iBatt-iInExp)/iInExp*100;
 console.log('dcdc CC: IN current (=battery)',iBatt.toFixed(2),'A, analytical Pout/Vin:',iInExp.toFixed(2),'A, error:',errIIn.toFixed(2)+'%',errIIn<2?'PASS':'FAIL');
 record('dcdc','CC mode: I0 setpoint + V=I0*R + power balance', !(errIOut>=1||Math.abs(vOut-vOutExp)>=2||errIIn>=2));
}

// ---- battery charging + SOC: grid up, battery below Vref bus -> CC charge at
// Ichg; SOC ramps at exactly Ichg/(36·Ah) %/s (1-ph DC study) ----
{
 const ex=JSON.parse(fs.readFileSync('tests/fixtures/dcbus.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 const bt=S.blocks.find(b=>b.type==='batt');
 bt.params={...bt.params, Ah:0.02, soc0:50, Ichg:10};
 S.blocks.find(b=>b.type==='pfc').params.tgrid=-1; // grid never lost
 els_stubs.phmode.value='1';
 runEMT();
 els_stubs.phmode.value='3';
 console.log('charge status:', els_stubs.stat.textContent);
 const [tC,,vpC,elsC,ieC,,,,,,,auxC]=plotArgs;
 const bi=elsC.findIndex(e=>e.kind==='batt');
 const soc=auxC[bi];
 const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
 const win=(arr,lo,hi)=>arr.filter((_,i)=>tC[i]>lo&&tC[i]<hi);
 // bus must still hold 380 (PFC covers CPL + charge, 26.3+10 < Imax 40)
 const vBus=avg(win(vpC[0][0],40,120));
 console.log('charge: bus |V|',vBus.toFixed(1),'V (380)',Math.abs(vBus-380)<3.8?'PASS':'FAIL');
 // battery current == -Ichg (charging), steady after PI settles
 const iBatt=avg(win(ieC[bi][0],40,120));
 console.log('charge: battery current',iBatt.toFixed(2),'A (expect -10)',Math.abs(iBatt+10)<0.3?'PASS':'FAIL');
 // SOC slope: Ichg/(36·Ah) = 10/0.72 = 13.89 %/s
 const i40=tC.findIndex(t=>t>40), i110=tC.findIndex(t=>t>110);
 const slope=(soc[i110]-soc[i40])/((tC[i110]-tC[i40])/1000);
 const slopeExp=10/(36*0.02);
 const errS=Math.abs(slope-slopeExp)/slopeExp*100;
 console.log('charge: SOC slope',slope.toFixed(2),'%/s, analytical Ichg/(36·Ah):',slopeExp.toFixed(2),'%/s, error:',errS.toFixed(2)+'%',errS<2?'PASS':'FAIL');
 console.log('charge: SOC',soc[0].toFixed(2),'% ->',soc[soc.length-1].toFixed(2),'%',(soc[soc.length-1]>soc[0])?'PASS':'FAIL');
 record('batt','CC charge: bus hold + Ichg + SOC slope', !(Math.abs(vBus-380)>=3.8||Math.abs(iBatt+10)>=0.3||errS>=2||soc[soc.length-1]<=soc[0]));
}

// ---- battery depletion: grid lost, tiny capacity -> SOC hits 0, bus collapses;
// total discharged charge must equal the stored soc0·Ah·36 A·s ----
{
 const ex=JSON.parse(fs.readFileSync('tests/fixtures/dcbus.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 const bt=S.blocks.find(b=>b.type==='batt');
 // Ichg:0 is set EXPLICITLY, not left absent. This check needs a battery that
 // only discharges, and it used to get one because the fixture happened to omit
 // Ichg. Saving a circuit from the app materialises every DEFS default, so the
 // key came back as its default 10 A, the battery charged before the grid was
 // lost, and the discharged charge no longer matched soc0*Ah*36. A test must
 // state the condition it depends on rather than rely on a missing key.
 bt.params={...bt.params, Ah:0.002, soc0:20, Ichg:0};
 S.blocks.find(b=>b.type==='pfc').params.tgrid=20; // grid lost at 20 ms
 els_stubs.phmode.value='1';
 runEMT();
 els_stubs.phmode.value='3';
 console.log('deplete status:', els_stubs.stat.textContent);
 const [tD,,vpD,elsD,ieD,,,,,,,auxD]=plotArgs;
 const bi=elsD.findIndex(e=>e.kind==='batt');
 const soc=auxD[bi], v=vpD[0][0], ib=ieD[bi][0];
 const socEnd=soc[soc.length-1];
 console.log('deplete: SOC end',socEnd.toFixed(3),'% (expect 0)',socEnd<0.01?'PASS':'FAIL');
 // after the battery dies the bus can't hold 360: CPL rides the cap down to
 // UVLO and sheds; final bus voltage far below the 360 setpoint
 const vEnd=v[v.length-1];
 console.log('deplete: bus end',vEnd.toFixed(1),'V (< 330, collapsed)',vEnd<330?'PASS':'FAIL');
 // charge balance: ∫ i_batt dt == soc0/100 · Ah · 3600 A·s
 let q=0; for(let i=1;i<ib.length;i++) q+=Math.max(0,ib[i])*(tD[i]-tD[i-1])/1000;
 const qExp=0.20*0.002*3600;
 const errQ=Math.abs(q-qExp)/qExp*100;
 console.log('deplete: discharged',q.toFixed(3),'A·s, stored soc0·Ah·36:',qExp.toFixed(3),'A·s, error:',errQ.toFixed(2)+'%',errQ<3?'PASS':'FAIL');
 record('batt','depletion: SOC->0, bus collapse, charge balance', !(socEnd>=0.01||vEnd>=330||errQ>=3));
}

// ---- reverse PFC (rev=1): battery holds the DC bus ABOVE the PFC's Vref, so
// the PFC pins at -Imax and exports P = vdc·Imax into the AC grid at unity pf.
// AC node phasor: v = [E + sqrt(E² + 4·Rs·P_ph)]/2 (power INTO the source EMF) ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'pfc',x:0,y:0,params:{Vref:360,Imax:40,kp:2,ki:2000,Vac:277,tgrid:-1,rev:1}},
  {id:3,type:'cap',x:0,y:0,params:{C:1000}},
  {id:4,type:'batt',x:0,y:0,params:{Vref:380,Imax:50,kp:2,ki:2000,Ah:0.02,soc0:80,Ichg:10}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'gnd',x:0,y:0,params:{}},
  {id:7,type:'gnd',x:0,y:0,params:{}},
  {id:8,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,0]},{a:[1,0],b:[5,0]},          // grid -> PFC AC side
  {a:[2,1],b:[3,0]},{a:[3,1],b:[6,0]},          // DC bus + cap
  {a:[4,1],b:[2,1]},{a:[4,0],b:[7,0]},          // battery on DC bus
  {a:[8,0],b:[2,1]}
 );
 runEMT();
 console.log('revpfc status:', els_stubs.stat.textContent);
 const [tR,,vpR,elsR,ieR,,,,,,,auxR]=plotArgs;
 const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
 const win=(arr,lo,hi)=>arr.filter((_,i)=>tR[i]>lo&&tR[i]<hi);
 const pi=elsR.findIndex(e=>e.kind==='pfc'), bi=elsR.findIndex(e=>e.kind==='batt'), si=elsR.findIndex(e=>e.kind==='src');
 const vBus=avg(win(vpR[0][0],60,120));
 console.log('revpfc: DC bus',vBus.toFixed(1),'V (battery holds 380)',Math.abs(vBus-380)<3.8?'PASS':'FAIL');
 const iPfc=avg(win(ieR[pi][0],60,120));
 console.log('revpfc: PFC DC current',iPfc.toFixed(1),'A (pinned at -Imax = -40)',Math.abs(iPfc+40)<0.5?'PASS':'FAIL');
 const iBatt=avg(win(ieR[bi][0],60,120));
 console.log('revpfc: battery discharge',iBatt.toFixed(1),'A (covers the export)',Math.abs(iBatt-40)<1?'PASS':'FAIL');
 // AC side: P = 380·40 = 15.2 kW into the grid; per-phase phasor at the node
 const P1=vBus*40/3, E=277, Rs=0.5;
 const vNode=(E+Math.sqrt(E*E+4*Rs*P1))/2, iExp=Math.SQRT2*P1/vNode;
 const iSrc=Math.max(...win(ieR[si][0],60,120).map(Math.abs));
 const errI=Math.abs(iSrc-iExp)/iExp*100;
 console.log('revpfc: AC current',iSrc.toFixed(1),'A peak, phasor prediction:',iExp.toFixed(1),'A, error:',errI.toFixed(1)+'%',errI<3?'PASS':'FAIL');
 const soc=auxR[bi];
 console.log('revpfc: SOC',soc[0].toFixed(1),'% ->',soc[soc.length-1].toFixed(1),'% (draining)',soc[soc.length-1]<soc[0]?'PASS':'FAIL');
 record('pfc','reverse mode: -Imax export + AC phasor + SOC drain', !(Math.abs(vBus-380)>=3.8||Math.abs(iPfc+40)>=0.5||Math.abs(iBatt-40)>=1||errI>=3||soc[soc.length-1]>=soc[0]));
}

// ---- tests/fixtures/bess_soc.json: exercises the actual saved file (catches wiring
// typos the inline tests above can't), 1-ph BESS demo — PFC charges the
// battery for 50 ms, then grid is lost and the battery discharges into the CPL ----
{
 const ex=JSON.parse(fs.readFileSync('tests/fixtures/bess_soc.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 els_stubs.phmode.value='1';
 runEMT();
 els_stubs.phmode.value='3';
 console.log('bess_soc status:', els_stubs.stat.textContent);
 const [tS,,vpS,elsS,,,,,,,,auxS]=plotArgs;
 const bi=elsS.findIndex(e=>e.kind==='batt');
 const soc=auxS[bi];
 const i50=tS.findIndex(t=>t>50);
 const chargedUp=soc[i50]>soc[0], drainedAfter=soc[soc.length-1]<soc[i50];
 console.log('bess_soc: SOC',soc[0].toFixed(1),'% -> (charge, t=50ms)',soc[i50].toFixed(1),'% -> (discharge, end)',soc[soc.length-1].toFixed(1),'%',
  (chargedUp&&drainedAfter)?'PASS':'FAIL');
 const vEnd=vpS[0][0][vpS[0][0].length-1];
 console.log('bess_soc: bus holds up on battery after grid loss:',vEnd.toFixed(1),'V (> UVLO 300)',vEnd>300?'PASS':'FAIL');
 record('fixture:bess_soc','saved file: charge then discharge ride-through', chargedUp&&drainedAfter&&vEnd>300);
}

// ---- tests/fixtures/grid_export.json: exercises the actual saved file — battery
// (higher Vref) holds a DC bus (a named Bus block, auto-monitored) and a
// reverse-mode PFC exports that power to the AC grid ----
{
 const ex=JSON.parse(fs.readFileSync('tests/fixtures/grid_export.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 runEMT();
 console.log('grid_export status:', els_stubs.stat.textContent);
 const [tG,,vpG,elsG,ieG,,pmG,,,,,auxG]=plotArgs;
 const busMeta=pmG.find(m=>m.type==='bus');
 const busIdx=pmG.indexOf(busMeta);
 const vBus=vpG[busIdx][0].slice(-200).reduce((s,v)=>s+v,0)/200;
 console.log('grid_export: named DC bus auto-monitored, |V|~',vBus.toFixed(1),'V (battery holds ~380)',Math.abs(vBus-380)<10?'PASS':'FAIL');
 const bi=elsG.findIndex(e=>e.kind==='batt'), pi=elsG.findIndex(e=>e.kind==='pfc');
 const iPfcEnd=ieG[pi][0][ieG[pi][0].length-1];
 console.log('grid_export: PFC DC current at end',iPfcEnd.toFixed(1),'A (negative = exporting)',iPfcEnd<-1?'PASS':'FAIL');
 const soc=auxG[bi];
 console.log('grid_export: SOC',soc[0].toFixed(1),'% ->',soc[soc.length-1].toFixed(1),'% (draining)',soc[soc.length-1]<soc[0]?'PASS':'FAIL');
 record('fixture:grid_export','saved file: named DC bus + reverse PFC export', !(Math.abs(vBus-380)>=10||iPfcEnd>=-1||soc[soc.length-1]>=soc[0]));
}

// ---- tests/fixtures/gfm_bess.json: exercises the actual saved file — GFM in GFL
// mode dispatches P0/Q0 into the grid while drawing that power from a
// battery on its new DC port, through a named (auto-monitored) Bus ----
{
 const ex=JSON.parse(fs.readFileSync('tests/fixtures/gfm_bess.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 runEMT();
 console.log('gfm_bess status:', els_stubs.stat.textContent);
 const [tB,,vpB,elsB,,,pmB,,,,,auxB]=plotArgs;
 const busMeta=pmB.find(m=>m.type==='bus');
 const busIdx=pmB.indexOf(busMeta);
 const vBus=vpB[busIdx][0][vpB[busIdx][0].length-1];
 console.log('gfm_bess: named DC bus auto-monitored, |V| end',vBus.toFixed(1),'V (battery holds ~380)',Math.abs(vBus-380)<15?'PASS':'FAIL');
 const gi=elsB.findIndex(e=>e.kind==='gfm'), bi=elsB.findIndex(e=>e.kind==='batt');
 const idc=auxB[gi], soc=auxB[bi];
 const idcEnd=idc[idc.length-1];
 console.log('gfm_bess: GFM Idc end',idcEnd.toFixed(2),'A (discharging the battery, >0)',idcEnd>0?'PASS':'FAIL');
 console.log('gfm_bess: SOC',soc[0].toFixed(1),'% ->',soc[soc.length-1].toFixed(1),'% (draining)',soc[soc.length-1]<soc[0]?'PASS':'FAIL');
 record('fixture:gfm_bess','saved file: GFM GFL DC port + named bus + SOC', !(Math.abs(vBus-380)>=15||idcEnd<=0||soc[soc.length-1]>=soc[0]));
}

// ---- tests/fixtures/dcdc_charger.json: exercises the actual saved file — a
// dedicated DC/DC converter (CC mode) discharges a battery at its own
// native 48 V onto a 380 V DC bus held by a reversible PFC/grid tie ----
{
 const ex=JSON.parse(fs.readFileSync('tests/fixtures/dcdc_charger.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 runEMT();
 console.log('dcdc_charger status:', els_stubs.stat.textContent);
 const [tE,,vpE,elsE,ieE,,pmE,,,,,auxE]=plotArgs;
 const busMeta=pmE.find(m=>m.type==='bus');
 const busIdx=pmE.indexOf(busMeta);
 const vBus=vpE[busIdx][0][vpE[busIdx][0].length-1];
 console.log('dcdc_charger: named DC bus |V| end',vBus.toFixed(1),'V (PFC holds 380)',Math.abs(vBus-380)<10?'PASS':'FAIL');
 const di=elsE.findIndex(e=>e.kind==='dcdc'), bi=elsE.findIndex(e=>e.kind==='batt');
 const iOutEnd=ieE[di][0][ieE[di][0].length-1];
 console.log('dcdc_charger: dcdc OUT current end',iOutEnd.toFixed(2),'A (setpoint I0=2)',Math.abs(iOutEnd-2)<0.1?'PASS':'FAIL');
 const iBattEnd=ieE[bi][0][ieE[bi][0].length-1];
 const iBattExp=iOutEnd*vBus/48;
 const errIBatt=Math.abs(iBattEnd-iBattExp)/iBattExp*100;
 console.log('dcdc_charger: battery current end',iBattEnd.toFixed(2),'A, lossless power-balance prediction:',iBattExp.toFixed(2),'A, error:',errIBatt.toFixed(1)+'%',errIBatt<3?'PASS':'FAIL');
 const soc=auxE[bi];
 console.log('dcdc_charger: SOC',soc[0].toFixed(1),'% ->',soc[soc.length-1].toFixed(1),'% (draining)',soc[soc.length-1]<soc[0]?'PASS':'FAIL');
 record('fixture:dcdc_charger','saved file: DC/DC CC onto PFC-held 380V bus', !(Math.abs(vBus-380)>=10||Math.abs(iOutEnd-2)>=0.1||errIBatt>=3||soc[soc.length-1]>=soc[0]));
}

// ---- PV array I-V curve sanity (SPEC §2): the single-exponential
// "engineering equation" fit must pass through the three datasheet points
// it's built from, and the true peak must sit close to the nominal Vmpp ----
{
 const P={Voc:45,Isc:10,Vmpp:36,Impp:9.3,G:1000};
 const curveI=V=>{
  const IscG=P.Isc*(P.G/1000);
  const ratio=Math.min(0.999,P.Impp/P.Isc);
  const C2=(P.Vmpp/P.Voc-1)/Math.log(Math.max(1e-9,1-ratio));
  const C1=(1-ratio)*Math.exp(-P.Vmpp/(C2*P.Voc));
  const I=IscG*(1-C1*(Math.exp(V/(C2*P.Voc))-1));
  return Math.max(0,Math.min(IscG,I));
 };
 const i0=curveI(0), iVoc=curveI(P.Voc), iVmpp=curveI(P.Vmpp);
 console.log('pv curve: I(0)=',i0.toFixed(3),'(Isc=10)',Math.abs(i0-10)<0.01?'PASS':'FAIL');
 console.log('pv curve: I(Voc)=',iVoc.toFixed(4),'(expect ~0)',iVoc<0.01?'PASS':'FAIL');
 console.log('pv curve: I(Vmpp)=',iVmpp.toFixed(3),'(Impp=9.3)',Math.abs(iVmpp-9.3)<0.01?'PASS':'FAIL');
 let bestV=0,bestP=0;
 for(let v=0;v<=P.Voc;v+=0.1){ const p=v*curveI(v); if(p>bestP){bestP=p;bestV=v;} }
 const errPeak=Math.abs(bestV-P.Vmpp);
 console.log('pv curve: true peak at V=',bestV.toFixed(1),'(nominal Vmpp=36), |diff|:',errPeak.toFixed(1),'V',errPeak<1?'PASS':'FAIL');
 record('pv','I-V curve passes datasheet points + peak near Vmpp', !(Math.abs(i0-10)>=0.01||iVoc>=0.01||Math.abs(iVmpp-9.3)>=0.01||errPeak>=1));
}

// ---- PV array MPPT convergence: panel charges a battery-held DC bus.
// Vop must hunt near Vmpp (decoupled from the bus voltage, which the
// battery holds at its own, different, Vref), delivered power must match
// Vmpp*Impp*(G/1000) ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'pv',x:0,y:0,params:{Voc:45,Isc:10,Vmpp:36,Impp:9.3,G:1000,Imax:15,Tmppt:1,dV:0.5}},
  {id:2,type:'batt',x:0,y:0,params:{Vref:40,Imax:50,kp:2,ki:2000,Ah:0.02,soc0:50,Ichg:20}},
  {id:3,type:'cap',x:0,y:0,params:{C:1000}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,1]},{a:[1,0],b:[4,0]},{a:[2,0],b:[5,0]},
  {a:[3,0],b:[2,1]},{a:[3,1],b:[5,0]},{a:[6,0],b:[2,1]}
 );
 els_stubs.phmode.value='1';
 runEMT();
 els_stubs.phmode.value='3';
 console.log('pv mppt status:', els_stubs.stat.textContent);
 const [tP,,vpP,elsP,ieP,,,,,,,auxP]=plotArgs;
 const avg=(a,lo)=>{ const s=a.filter((_,i)=>tP[i]>lo); return s.reduce((x,y)=>x+y,0)/s.length; };
 const vBus=avg(vpP[0][0],90);
 const pi=elsP.findIndex(e=>e.kind==='pv');
 const vop=avg(auxP[pi],90), iPv=avg(ieP[pi][0],90);
 console.log('pv mppt: bus |V|',vBus.toFixed(1),'V (battery Vref 40)',Math.abs(vBus-40)<0.5?'PASS':'FAIL');
 const errVop=Math.abs(vop-36);
 console.log('pv mppt: Vop avg',vop.toFixed(2),'V (hunting near Vmpp=36)',errVop<1.5?'PASS':'FAIL');
 const pDelivered=vBus*iPv, pExp=36*9.3;
 const errP=Math.abs(pDelivered-pExp)/pExp*100;
 console.log('pv mppt: delivered power',pDelivered.toFixed(1),'W, analytical Vmpp*Impp:',pExp.toFixed(1),'W, error:',errP.toFixed(1)+'%',errP<3?'PASS':'FAIL');
 record('pv','MPPT convergence: Vop near Vmpp + delivered power', !(Math.abs(vBus-40)>=0.5||errVop>=1.5||errP>=3));
}

// ---- PV array irradiance scaling: half sun (G=500) should roughly halve
// delivered power, with Vop still hunting near the same Vmpp (Voc/Vmpp are
// held fixed with irradiance in this lightweight AVM — SPEC §2/§7) ----
{
 S.blocks.find(b=>b.type==='pv').params.G=500;
 runEMT();
 console.log('pv half-sun status:', els_stubs.stat.textContent);
 const [tH,,vpH,elsH,ieH]=plotArgs;
 const avg=(a,lo)=>{ const s=a.filter((_,i)=>tH[i]>lo); return s.reduce((x,y)=>x+y,0)/s.length; };
 const pi=elsH.findIndex(e=>e.kind==='pv');
 const pDelivered=avg(vpH[0][0],90)*avg(ieH[pi][0],90);
 const pExp=36*9.3*0.5;
 const errP=Math.abs(pDelivered-pExp)/pExp*100;
 console.log('pv half-sun: delivered power',pDelivered.toFixed(1),'W, analytical (half of full-sun):',pExp.toFixed(1),'W, error:',errP.toFixed(1)+'%',errP<3?'PASS':'FAIL');
 record('pv','irradiance scaling: half-sun halves power', errP<3);
}

// ---- tests/fixtures/pv_mppt.json: exercises the actual saved file — a PV panel
// under partial cloud (G=800) charges a battery on a small DC bus ----
{
 const ex=JSON.parse(fs.readFileSync('tests/fixtures/pv_mppt.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 els_stubs.phmode.value='1';
 runEMT();
 els_stubs.phmode.value='3';
 console.log('pv_mppt status:', els_stubs.stat.textContent);
 const [tM,,vpM,elsM,,,,,,,,auxM]=plotArgs;
 const pvB=ex.blocks.find(b=>b.type==='pv'), battB=ex.blocks.find(b=>b.type==='batt');
 const pi=elsM.findIndex(e=>e.kind==='pv'), bi=elsM.findIndex(e=>e.kind==='batt');
 const vop=auxM[pi], soc=auxM[bi];
 const vopEnd=vop[vop.length-1];
 console.log('pv_mppt: Vop end',vopEnd.toFixed(1),'V (within panel range 0-'+pvB.params.Voc+')',(vopEnd>0&&vopEnd<pvB.params.Voc)?'PASS':'FAIL');
 console.log('pv_mppt: battery SOC',soc[0].toFixed(1),'% ->',soc[soc.length-1].toFixed(1),'% (charging)',soc[soc.length-1]>soc[0]?'PASS':'FAIL');
 record('fixture:pv_mppt','saved file: PV under cloud charges battery', (vopEnd>0&&vopEnd<pvB.params.Voc)&&soc[soc.length-1]>soc[0]);
}

// ---- PI (RLC) line (SPEC §2): src -> line(R=1,L=5mH,C=20µF) -> load(100Ω).
// Verified against an INDEPENDENT complex nodal analysis (not the same
// formula the implementation uses) — a 2-node, 2-unknown linear system for
// the pi-line's series impedance + shunt admittance at each end + load ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'line',x:0,y:0,params:{R:1,L:5,Rm:0,Lm:0,C:20}},
  {id:3,type:'rlc',x:0,y:0,params:{R:100,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]},{a:[6,0],b:[2,1]}
 );
 runEMT();
 console.log('pi-line status:', els_stubs.stat.textContent);
 const [tPi,,vpPi]=plotArgs;
 const vmax=Math.max(...vpPi[0][0].filter((_,i)=>tPi[i]>90).map(Math.abs));
 // independent 2-node complex nodal analysis via tests/reference/phasor.js
 // (NOT the implementation's own companion-model formula). The same 2-node
 // system the inline version solved by hand, now routed through a reusable
 // independent solver so other blocks can cross-check against it too.
 const PH=require('./tests/reference/phasor.js');
 const w=2*Math.PI*60, R=1,Lh=5e-3,Ctot=20e-6,Rload=100,Rs=0.5,Vs=277*Math.SQRT2;
 const Zs=PH.c(R,w*Lh), Ysh=PH.c(0,w*Ctot/2), invZs=PH.cinv(Zs);
 const Vp=PH.nodalSolve(2, PH.c(0,0),
  { 0: PH.c(Vs/Rs, 0) }, // Norton injection Vs/Rs into node A (after the source)
  [ {from:-1,to:0,y:PH.c(1/Rs,0)},      // source Rs to ground at node A
    {from:-1,to:0,y:Ysh},               // A-end shunt C/2 to ground
    {from:0,to:1,y:invZs},              // series R+jwL between A and B
    {from:-1,to:1,y:PH.cadd(Ysh,PH.c(1/Rload,0))} ]); // B-end C/2 + load to ground
 const VBmag=PH.cabs(Vp[1]);
 const errPi=Math.abs(vmax-VBmag)/VBmag*100;
 console.log('pi-line |V| at load sim:',vmax.toFixed(2),'V, independent nodal analysis:',VBmag.toFixed(2),'V, error:',errPi.toFixed(2)+'%',errPi<1?'PASS':'FAIL');
 record('line','pi-line: independent 2-node nodal cross-check', errPi<1);
}

// ---- PI line + mutual coupling together must be rejected with a clear error ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'line',x:0,y:0,params:{R:1,L:5,Rm:0.1,Lm:0.8,C:20}},
  {id:3,type:'rlc',x:0,y:0,params:{R:100,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]});
 runEMT();
 const gotErr=els_stubs.stat.textContent.includes('mutual coupling') && els_stubs.stat.textContent.includes('shunt C');
 console.log('coupled+C validation:', els_stubs.stat.textContent, gotErr?'PASS':'FAIL');
 record('line','pi-line + mutual coupling rejected with clear error', gotErr);
}

// ---- PQ load (SPEC §2): src -> PQ load (P=8kW, Q=3kvar lagging). Verify
// delivered P and Q both match setpoint (the actual test of the whole
// design — does it deliver what you asked for), and that Q flips sign
// correctly for a leading (capacitive, Q<0) setpoint too ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.05}},
  {id:2,type:'pq',x:0,y:0,params:{P:8,Q:3,f:60,Tf:20,vmin:50}},
  {id:3,type:'gnd',x:0,y:0,params:{}},
  {id:4,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[2,1],b:[4,0]});
 // called directly (not through runEMT()) for a longer settling window than
 // the default 120 ms UI duration — the RMS/quarter-cycle tracking (Tf) needs
 // several time constants to settle, same reasoning as the GFL mode test.
 // Explicit plotUs=250 (dec=5): the Q estimate below is a forward quarter-period
 // shift product v[k]*i[k+shift], and a PQ load's current carries Tf-tracker +
 // quarter-period-buffer dynamics that make that estimator's bias dec-dependent
 // (dec=1 lands +8%, dec=5 cancels to ~1.6%). Same decimation-skews-Q issue the
 // wt4 test calls out; pinning the spacing makes the test deterministic
 // instead of coupled to the auto-cap policy. The solver's injected Q is
 // unchanged by dec — only the test's estimate of it moves.
 const rQ=simulate(3,400,null,50,250);
 console.log('pq load status:', rQ.err||rQ.stat);
 if(rQ.err) process.exit(1);
 const tQ=rQ.t, elsQ=rQ.curEls, ieQ=rQ.ic, bvQ=rQ.bv;
 const pi=elsQ.findIndex(e=>e.kind==='pq');
 const bv=bvQ[pi][0], ic=ieQ[pi][0];
 let sp=0,n=0; for(let i=0;i<tQ.length;i++){ if(tQ[i]<=350) continue; sp+=bv[i]*ic[i]; n++; }
 const Pavg=sp/n;
 const dtOut=tQ[1]-tQ[0], win=Math.round(1000/60/dtOut), shift=Math.round(win/4);
 let sq=0,n2=0; for(let i=0;i<tQ.length-shift;i++){ if(tQ[i]<=350) continue; sq+=bv[i]*ic[i+shift]; n2++; }
 const Qavg=sq/n2;
 // P/Q are the block's THREE-PHASE TOTAL (SPEC §2 "Power convention"), so ONE
 // phase carries a third. This is measured on phase 0 rather than summed
 // because the forward-shift Q estimator is phase-sensitive (shift=17 of a
 // 67-sample cycle is not exactly T/4, and the residual differs per phase:
 // 984/808/707 var), and the dec=5 bias calibration above is phase-0 specific.
 // It still guards the convention: injecting the full P per phase would read 3x.
 const Pset3=8000/3, Qset3=3000/3;
 const errP=Math.abs(Pavg-Pset3)/Pset3*100, errQ=Math.abs(Qavg-Qset3)/Qset3*100;
 console.log('pq load: P sim',(Pavg/1000).toFixed(2),'kW/ph, setpoint 8.00 kW 3-ph =',(Pset3/1000).toFixed(2),'kW/ph, error:',errP.toFixed(1)+'%',errP<5?'PASS':'FAIL');
 console.log('pq load: Q sim',(Qavg/1000).toFixed(2),'kvar/ph, setpoint 3.00 kvar 3-ph =',(Qset3/1000).toFixed(2),'kvar/ph, error:',errQ.toFixed(1)+'%',errQ<8?'PASS':'FAIL');
 record('pq','PQ load: P + Q setpoint (lag and lead)', !(errP>=5||errQ>=8));
}

// ---- tests/fixtures/pq_piline.json: exercises the actual saved file — a PI
// (RLC) line feeds a PQ load, tying both new features together ----
{
 const ex=JSON.parse(fs.readFileSync('tests/fixtures/pq_piline.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 const rC=simulate(3,400,null);
 console.log('pq_piline status:', rC.err||rC.stat);
 if(rC.err) process.exit(1);
 const tC=rC.t, v=rC.vp[0][0];
 const pi=rC.curEls.findIndex(e=>e.kind==='pq');
 const bv=rC.bv[pi][0], ic=rC.ic[pi][0];
 let sp=0,n=0; for(let i=0;i<tC.length;i++){ if(tC[i]<=350) continue; sp+=bv[i]*ic[i]; n++; }
 const Pavg=sp/n, errP2=Math.abs(Pavg-8000)/8000*100;
 console.log('pq_piline: P delivered',(Pavg/1000).toFixed(2),'kW, setpoint 8.00 kW, error:',errP2.toFixed(1)+'%',errP2<5?'PASS':'FAIL');
 const vmax=Math.max(...v.filter((_,i)=>tC[i]>350).map(Math.abs));
 console.log('pq_piline: bus |V| peak',vmax.toFixed(1),'V (sagged from ~392V nominal under load, reasonable)',vmax>150&&vmax<392?'PASS':'FAIL');
 record('fixture:pq_piline','saved file: PI line into PQ load sag', !(errP2>=5||!(vmax>150&&vmax<392)));
}

// ---- solver timestep (dt) and plot-step controls: previously hardcoded
// (50µs solver step, auto-capped-at-~1400-points plotting), now user-facing
// PSCAD-style knobs. Verify (1) a finer dt still converges to the same
// analytical steady state — proves dtUs actually reaches the solver rather
// than being accepted and ignored — and (2) an explicit plotUs controls the
// output sample spacing exactly.
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'line',x:0,y:0,params:{R:0.3,L:2}},
  {id:3,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]},{a:[6,0],b:[2,1]});
 const Vs=277*Math.SQRT2, w=2*Math.PI*60, R=12, Rs=0.5, Rl=0.3, L=2e-3;
 const Zmag=Math.hypot(Rs+Rl+R, w*L);
 const expected=Vs*R/Zmag;

 [['default (dt=50µs, plot=auto)', simulate(3,60,null)],
  ['dt=10µs explicit', simulate(3,60,null,10,0)]].forEach(([label,r])=>{
   if(r.err){ console.log('dt test ('+label+') error:', r.err); process.exit(1); }
   const v=r.vp[0][0], t=r.t;
   const post=v.filter((_,i)=>t[i]>40);
   const vmax=Math.max(...post.map(Math.abs));
   const err=Math.abs(vmax-expected)/expected*100;
   console.log('dt test '+label+': probe |V| steady',vmax.toFixed(1),'V vs analytical',expected.toFixed(1),'V, error:',err.toFixed(2)+'%',err<2?'PASS':'FAIL');
   record('solver','dt '+label+' converges to analytical steady state', err<2);
 });

 // requested 500µs plot step at a 50µs solver step -> dec=10 -> 0.5ms spacing
 const rPlot=simulate(3,60,null,50,500);
 const dtOutMs=rPlot.t[1]-rPlot.t[0];
 const okPlot=Math.abs(dtOutMs-0.5)<1e-9;
 console.log('plot step: requested 500µs, actual output spacing',(dtOutMs*1000).toFixed(0)+'µs',okPlot?'PASS':'FAIL');
 record('solver','plot-step (plotUs) controls output spacing', okPlot);
}

// ---- synchronous generator (SPEC §2): classical swing model. SMIB (single
// machine, infinite bus) — a syncgen tied through its own Ra/Ld plus an
// external line to a stiff src. At any true steady state an infinite bus
// forces frequency to lock to EXACTLY f0 regardless of Pm0/Kgov (Kgov=0
// here specifically to isolate that this is the infinite bus doing it, not
// a governor), and energy balance requires Pe_ss = Pm0. Needs several
// seconds — the natural swing period at these H/Sbase/X defaults is ~0.5s —
// to actually settle, unlike every other test in this file. ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 const Pm0=20;
 S.blocks.push(
  {id:1,type:'syncgen',x:0,y:0,params:{H:4,Sbase:50,Ra:0.05,Ld:2,f0:60,E0:277,Pm0,Kgov:0,D:25,Q0:0,mq:0.5,Tf:20}},
  {id:2,type:'line',x:0,y:0,params:{R:0.1,L:2,Rm:0,Lm:0,C:0}},
  {id:3,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.01}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,1]},{a:[1,0],b:[4,0]},{a:[3,0],b:[5,0]});
 const r=simulate(3,6000,null,50,0);
 if(r.err){ console.log('syncgen error:', r.err); process.exit(1); }
 console.log('syncgen status:', r.stat);

 const gi=r.curMeta.findIndex(m=>m.kind==='syncgen');
 const fEnd=r.aux[gi][r.aux[gi].length-1];
 const errF=Math.abs(fEnd-60);
 console.log('syncgen SMIB: frequency lock (internal state, final)',fEnd.toFixed(6),'Hz (expect exactly 60), error:',errF.toFixed(6),errF<0.001?'PASS':'FAIL');

 const tailIdx=r.t.map((_,i)=>i).filter(i=>r.t[i]>5000);
 const PeSS=tailIdx.reduce((s,i)=>s+r.bv[gi][0][i]*r.ic[gi][0][i]+r.bv[gi][1][i]*r.ic[gi][1][i]+r.bv[gi][2][i]*r.ic[gi][2][i],0)/tailIdx.length/1000;
 const errP=Math.abs(PeSS-Pm0)/Pm0*100;
 console.log('syncgen SMIB: Pe steady-state',PeSS.toFixed(3),'kW vs Pm0',Pm0,'kW, error:',errP.toFixed(2)+'%',errP<2?'PASS':'FAIL');

 record('syncgen','SMIB: frequency lock + Pe=Pm0 steady state', !(errF>=0.001||errP>=2));
}

// ---- synchronous generator: damping self-consistency sweep. Same SMIB rig
// as above, but D is swept instead of held fixed, and instead of waiting for
// steady state we measure the natural, undriven swing transient that a flat
// start (theta=0, f=f0) already produces (Pm0=20kW doesn't match the initial
// electrical operating point, so the machine swings on its own — no extra
// disturbance mechanism needed). Linearizing the swing equation gives a
// standard 2nd-order system: zeta = f0*D/(4*H*Sbase*wn), wn = sqrt(pi*f0*Ks/
// (H*Sbase)) (SPEC §2) — critically, D sets damping but NOT natural
// frequency, so if the log-decrement-derived zeta and wn are computed
// independently at each D, wn must come out the same every time. That
// self-consistency, not a match to a hand-picked reference number, is what
// this test actually checks — it fails if the swing-equation implementation
// has the wrong structure even if any single D happened to look plausible. ----
{
 function findPeaks(t,df){
  const peaks=[]; const minSpacingMs=100;
  for(let i=2;i<df.length-2;i++){
   const a=Math.abs(df[i]);
   if(a>Math.abs(df[i-1])&&a>=Math.abs(df[i+1])&&a>0.002){
    if(!peaks.length||t[i]-peaks[peaks.length-1].t>minSpacingMs) peaks.push({t:t[i],v:df[i]});
   }
  }
  return peaks;
 }
 const Ds=[5,15,25,40,60];
 const results=[];
 Ds.forEach(D=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'syncgen',x:0,y:0,params:{H:4,Sbase:50,Ra:0.05,Ld:2,f0:60,E0:277,Pm0:20,Kgov:0,D,Q0:0,mq:0.5,Tf:20}},
   {id:2,type:'line',x:0,y:0,params:{R:0.1,L:2,Rm:0,Lm:0,C:0}},
   {id:3,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.01}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,1]},{a:[1,0],b:[4,0]},{a:[3,0],b:[5,0]});
  const r=simulate(3,4000,null,50,2000);
  if(r.err){ console.log('syncgen damping sweep error:', r.err); process.exit(1); }
  const gi=r.curMeta.findIndex(m=>m.kind==='syncgen');
  const df=r.aux[gi].map(v=>v-60);
  const peaks=findPeaks(r.t,df);
  if(peaks.length<3){ console.log('syncgen damping D='+D+': not enough peaks to measure — FAIL'); process.exit(1); }
  const p0=peaks[0], p2=peaks[2]; // one full damped period apart (two half-swings)
  const decrement=Math.log(Math.abs(p0.v)/Math.abs(p2.v));
  const zeta=decrement/Math.sqrt((2*Math.PI)**2+decrement**2);
  const Td=p2.t-p0.t;
  const wd=2*Math.PI/(Td/1000);
  const wn=wd/Math.sqrt(1-zeta*zeta);
  results.push({D,zeta,wn});
  console.log('syncgen damping D='+D+': zeta='+zeta.toFixed(4),'wn='+wn.toFixed(3)+' rad/s');
 });

 const monotonic=results.every((r,i)=>i===0||r.zeta>results[i-1].zeta);
 console.log('syncgen damping: zeta strictly increasing with D across sweep',monotonic?'PASS':'FAIL');

 const wns=results.map(r=>r.wn);
 const wnAvg=wns.reduce((a,b)=>a+b,0)/wns.length;
 const wnSpreadPct=(Math.max(...wns)-Math.min(...wns))/wnAvg*100;
 console.log('syncgen damping: natural frequency wn self-consistent across D sweep, spread',wnSpreadPct.toFixed(2)+'%','(must stay <3%, since D should not move wn)',wnSpreadPct<3?'PASS':'FAIL');

 record('syncgen','damping sweep: zeta monotonic + wn self-consistent', monotonic&&wnSpreadPct<3);
}

// ---- synchronous generators: two-machine governor load-sharing (examples/
// syncgen_droop.json) — two machines with DIFFERENT Pm0/Kgov/Sbase feed one
// common bus through a Bus block; a breaker adds a second load at 2000ms.
// Standard textbook governor droop: at any new steady state, each machine's
// picked-up power satisfies Pe_i = Pm0_i - (Kgov_i+D_i)*df, where df is the
// SAME frequency deviation for every machine on the bus (they're
// electrically synchronized). This test independently backs out the implied
// df from each machine's own power/params and checks both machines (a) land
// on the same measured df, and (b) each implied df matches the measured one
// — i.e. actual load-sharing proportion matches the droop-formula
// prediction, not just "the frequency dropped and it didn't blow up". ----
{
 const ex=JSON.parse(fs.readFileSync('examples/syncgen_droop.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 const params=ex.blocks.filter(b=>b.type==='syncgen').map(b=>b.params);
 const r=simulate(3,6000,null,50,0);
 if(r.err){ console.log('syncgen load-sharing error:', r.err); process.exit(1); }
 console.log('syncgen load-sharing status:', r.stat);

 const gis=r.curMeta.map((m,i)=>m.kind==='syncgen'?i:-1).filter(i=>i>=0);
 const t=r.t, tailIdx=t.map((_,i)=>i).filter(i=>t[i]>5000);
 const fEnds=gis.map(gi=>r.aux[gi][r.aux[gi].length-1]);
 const fSpread=Math.max(...fEnds)-Math.min(...fEnds);
 console.log('syncgen load-sharing: both machines end at the same bus frequency, spread',fSpread.toFixed(5),'Hz (must be <0.001)',fSpread<0.001?'PASS':'FAIL');

 let worstErr=0;
 gis.forEach((gi,k)=>{
  const fEnd=fEnds[k];
  const PeSS=tailIdx.reduce((s,i)=>s+r.bv[gi][0][i]*r.ic[gi][0][i]+r.bv[gi][1][i]*r.ic[gi][1][i]+r.bv[gi][2][i]*r.ic[gi][2][i],0)/tailIdx.length/1000;
  const p=params[k];
  const df=fEnd-p.f0;
  const impliedDf=(p.Pm0-PeSS)/(p.Kgov+p.D);
  const err=Math.abs(impliedDf-df);
  worstErr=Math.max(worstErr,err);
  console.log('syncgen load-sharing: gen'+(k+1)+' Pe_ss='+PeSS.toFixed(2)+'kW, measured df='+df.toFixed(5)+', droop-formula-implied df='+impliedDf.toFixed(5)+', error='+err.toFixed(5)+' Hz',err<0.002?'PASS':'FAIL');
 });

 record('syncgen','two-machine governor load-sharing (droop formula)', !(fSpread>=0.001||worstErr>=0.002));
}

// ---- centralized-UPS data center (examples/central_ups.json, after PNNL's
// DML_DC2_Central_UPS): utility -> breaker -> 8.66:1 xfmr -> 480 V bus with
// cooling/support loads + double-conversion UPS (PFC -> 380 V DC link with
// battery -> GFM -> IT load). Utility trips at 150 ms and the rectifier's
// grid-lost protection drops with it: the bus must black out, the battery
// must catch the DC link at 360 V, and the IT load must NOT see the event.
// Guards against the regression class that killed the two earlier UPS
// examples (removed): AC/DC domain errors and dead-bus CPL oscillation. ----
{
 const ex=JSON.parse(fs.readFileSync('examples/central_ups.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 const r=simulate(3,500,null,50,100);
 if(r.err){ console.log('central_ups error:', r.err); process.exit(1); }
 console.log('central_ups status:', r.stat);
 // probe order = blocks order filtered to probe|bus: bus#4, probe#14 (DC), probe#15 (ITE)
 const t=r.t, vBus=r.vp[0][0], vDC=r.vp[1][0], vITE=r.vp[2][0];
 const rms=(v,lo,hi)=>{let s=0,n=0;for(let i=0;i<t.length;i++)if(t[i]>lo&&t[i]<hi){s+=v[i]*v[i];n++;}return Math.sqrt(s/Math.max(1,n));};
 const avg=(v,lo,hi)=>{let s=0,n=0;for(let i=0;i<t.length;i++)if(t[i]>lo&&t[i]<hi){s+=v[i];n++;}return s/Math.max(1,n);};
 const busPre=rms(vBus,100,145), dcPre=avg(vDC,100,145);
 const okBusPre=Math.abs(busPre-277)<277*0.03, okDcPre=Math.abs(dcPre-380)<3.8;
 console.log('central_ups 480V bus pre-trip:',busPre.toFixed(1),'V rms (277 nominal)',okBusPre?'PASS':'FAIL',
  '; DC link:',dcPre.toFixed(1),'V (PI target 380)',okDcPre?'PASS':'FAIL');
 const busPost=rms(vBus,300,490), dcPost=avg(vDC,300,490);
 const okBusPost=busPost<5, okDcPost=Math.abs(dcPost-360)<3.6;
 console.log('central_ups bus post-trip:',busPost.toFixed(2),'V rms (expect ~0, no dead-bus oscillation)',okBusPost?'PASS':'FAIL',
  '; DC on battery:',dcPost.toFixed(1),'V (360)',okDcPost?'PASS':'FAIL');
 // IT ride-through: worst 2-cycle RMS window across the whole event
 let worst=1e9;
 for(let lo=100;lo<=466;lo+=5)worst=Math.min(worst,rms(vITE,lo,lo+100/3));
 console.log('central_ups IT load worst 2-cycle RMS across trip:',worst.toFixed(1),'V (must hold >265)',worst>265?'PASS':'FAIL');
 // battery: trickle-charging before the trip, discharging (SOC falling) after
 const bi=r.curMeta.findIndex(m=>m.kind==='batt');
 const soc=r.aux[bi];
 const socAt=ms=>soc[Math.min(soc.length-1,Math.round(ms/500*(soc.length-1)))];
 const dSocPre=socAt(145)-socAt(50), dSocPost=socAt(490)-socAt(200);
 console.log('central_ups battery SOC: pre-trip drift',dSocPre.toFixed(2),'% (charging, >=0)',dSocPre>=0?'PASS':'FAIL',
  '; post-trip',dSocPost.toFixed(2),'% (discharging, <-3)',dSocPost<-3?'PASS':'FAIL');
 record('fixture:central_ups','UPS trip: blackout + 360V battery catch + IT ride-through', !(!okBusPre||!okDcPre||!okBusPost||!okDcPost||worst<=265||dSocPre<0||dSocPost>=-3));
}

// ---- centralized-UPS voltage-sag disturbance (examples/central_ups_sag.json)
// — same facility as central_ups.json, but instead of a scripted full
// outage, a 0.3Ω 3-phase FAULT is applied directly on the 2.4kV utility
// feeder for 100ms (200-300ms). This is a physics-driven disturbance, not a
// scripted event: the resulting sag trips the PFC rectifier's own
// undervoltage protection (grid voltage crosses its UV threshold), exactly
// like a real double-conversion UPS. This case is cited elsewhere with
// specific figures (~24% retained bus voltage, ~99.7% IT-load immunity,
// 380->360V DC handoff), so those exact numbers are asserted here and cannot
// silently drift away from what has been published about them. ----
{
 const ex=JSON.parse(fs.readFileSync('examples/central_ups_sag.json','utf8'));
 S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 const r=simulate(3,500,null,20,100);
 if(r.err){ console.log('central_ups_sag error:', r.err); process.exit(1); }
 console.log('central_ups_sag status:', r.stat);
 // probe order = blocks-array order filtered to probe|bus: bus#4, probe#13 (feeder),
 // probe#14 (DC), probe#15 (ITE) — 4 entries (this file has an extra feeder
 // probe central_ups.json doesn't), so look up by id rather than assume position.
 const probeIds=ex.blocks.filter(b=>b.type==='probe'||b.type==='bus').map(b=>b.id);
 const t=r.t, vBus=r.vp[probeIds.indexOf(4)][0], vDC=r.vp[probeIds.indexOf(14)][0], vITE=r.vp[probeIds.indexOf(15)][0];
 const rms=(v,lo,hi)=>{let s=0,n=0;for(let i=0;i<t.length;i++)if(t[i]>lo&&t[i]<hi){s+=v[i]*v[i];n++;}return Math.sqrt(s/Math.max(1,n));};
 const avg=(v,lo,hi)=>{let s=0,n=0;for(let i=0;i<t.length;i++)if(t[i]>lo&&t[i]<hi){s+=v[i];n++;}return s/Math.max(1,n);};
 const busPre=rms(vBus,150,195), busSag=rms(vBus,220,280);
 const retainedPct=100*busSag/busPre;
 const okRetained=Math.abs(retainedPct-24)<4; // report cites ~24%
 console.log('central_ups_sag: 480V bus retained during fault',retainedPct.toFixed(1)+'%','(report cites ~24%)',okRetained?'PASS':'FAIL');
 const dcPre=avg(vDC,150,195), dcSag=avg(vDC,220,280), dcPost=avg(vDC,400,490);
 const okDcPre=Math.abs(dcPre-380)<3.8, okDcSag=Math.abs(dcSag-360)<3.6, okDcPost=Math.abs(dcPost-380)<3.8;
 console.log('central_ups_sag: DC link',dcPre.toFixed(1),'V pre ->',dcSag.toFixed(1),'V during sag (360 target) ->',dcPost.toFixed(1),'V recovered (380)',
  (okDcPre&&okDcSag&&okDcPost)?'PASS':'FAIL');
 let worst=1e9;
 for(let lo=150;lo<=460;lo+=5)worst=Math.min(worst,rms(vITE,lo,lo+100/3));
 const worstPct=100*worst/277;
 console.log('central_ups_sag: IT load worst 2-cycle RMS across event',worst.toFixed(1),'V ('+worstPct.toFixed(1)+'% of nominal, report cites ~99.7%, must hold >95%)',worstPct>95?'PASS':'FAIL');
 record('fixture:central_ups_sag','sag: ~24% retained + DC handoff + IT >95% (case-study numbers)', !(!okRetained||!okDcPre||!okDcSag||!okDcPost||worstPct<=95));
}

// ---- closed breakers must be sized against their OWN neighbours, not against
// an absolute constant. buildYbus() used to stamp every closed breaker at a
// fixed 1e4 S. At 400 V that is a fine short; at 400 kV, where a feeder is
// ~0.003 S, it makes the breaker node's self-admittance millions of times its
// links and Newton diverges on a case that has a perfectly good solution.
// The check: a transmission-voltage bus with several breakered feeders must
// converge AND must land on the same answer as the identical network with the
// breakers replaced by plain wire, which is what a closed ideal breaker means.
// A radial of passive feeders is too easy to show it — Newton solves that in
// three iterations either way. What exposes the scaling is a MESHED
// transmission network whose feeders are PV machines, because a PV bus's
// Jacobian row is written at the machine node, right behind the breaker.
{
 const VLL=400e3, W=2*Math.PI*50, NB=3, NF=2, NPV=3;
 const build=(withBrk)=>{ S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  let id=10; const B=[]; const nid=()=>++id;
  const gnd=()=>{ const g=nid(); S.blocks.push({id:g,type:'gnd',x:0,y:0,rot:90,params:{}}); return g; };
  for(let k=0;k<NB;k++){ const b=nid();
   S.blocks.push({id:b,type:'bus',x:100*k,y:0,params:{name:'B'+k,taps:20,len:200,Vbase:VLL}});
   B.push({id:b,n:0}); }
  const tap=b=>b.n++;
  const src=nid(); S.blocks.push({id:src,type:'src',x:-200,y:0,params:{Vrms:VLL,f:50,Rs:1}});
  S.wires.push({a:[src,0],b:[gnd(),0]},{a:[src,1],b:[B[0].id,tap(B[0])]});
  for(let k=0;k<NB;k++){ const j=(k+1)%NB, l=nid();   // ring
   S.blocks.push({id:l,type:'line',x:0,y:0,params:{R:3,L:32,Rm:0,Lm:0,C:2.4}});
   S.wires.push({a:[B[k].id,tap(B[k])],b:[l,0]},{a:[l,1],b:[B[j].id,tap(B[j])]}); }
  const Sk=2e6, Zb=VLL*VLL/(Sk*1e3), X=0.15*Zb, Zm=Zb;
  let made=0;
  for(let k=0;k<NB;k++) for(let f=0;f<NF;f++){
   const tx=nid();   // GSU: a real machine never bolts onto a 400 kV bus
   S.blocks.push({id:tx,type:'line',x:0,y:0,params:{R:X/50,L:X/W*1e3,Rm:0,Lm:0,C:0}});
   S.wires.push({a:[B[k].id,tap(B[k])],b:[tx,0]});
   let feed=[tx,1];
   if(withBrk){ const br=nid();
    S.blocks.push({id:br,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:1,nOps:1}});
    S.wires.push({a:[tx,1],b:[br,0]}); feed=[br,1]; }
   const d=nid();
   if(made<NPV){ made++;
    S.blocks.push({id:d,type:'syncgen',x:0,y:0,params:{H:5,Sbase:Sk,Ra:0.005*Zm,Ld:0.25*Zm/W*1e3,
     f0:50,E0:VLL,Pm0:4e5,Kgov:Sk/2.5,D:Sk/50,Q0:0,mq:0,Tf:20,Tg:250,Pmax:0,
     Te:0.05,Ka:50,Vref:VLL,Emax:1.6*VLL/Math.sqrt(3),pfType:'PV',Vset:VLL,Qmax:0,Qmin:0}});
    S.wires.push({a:feed,b:[d,1]},{a:[d,0],b:[gnd(),0]});
   } else {
    S.blocks.push({id:d,type:'zip',x:0,y:0,params:{P:3e5,Q:7.5e4,V0:VLL,
     az:0.4,ai:0.3,ap:0.3,bz:0.4,bi:0.3,bp:0.3,f:50,Tf:20,vmin:0.5*VLL}});
    S.wires.push({a:feed,b:[d,0]},{a:[d,1],b:[gnd(),0]}); }
  }
 };
 const vbus=()=>{ const pf=solvePowerFlow();
  const b=(pf.busBlocks||[]).find(x=>x.name==='B1');
  return {conv:!!pf.converged, it:pf.iters, mis:pf.maxMismatch, v:b?b.Vpu:NaN}; };
 build(true); const wb=vbus();
 build(false); const nb=vbus();
 const dev=Math.abs(wb.v-nb.v)/nb.v*100;
 // The residual FLOOR is the part that regresses if the scaling is lost. Newton's
 // injection sum carries rounding of order eps times the row sum, so a breaker
 // stamped far above its neighbours raises the floor for the whole matrix: the
 // fixed 1e4 S bottoms this case out around 1e-8 pu, while a locally scaled
 // stamp reaches ~1e-11. Assert a level the unscaled stamp cannot reach.
 const okFloor=wb.conv&&wb.mis<1e-9;
 console.log('brk PF scale: with breakers converged',wb.conv,'in',wb.it,'iters, V',wb.v.toFixed(5),
  'residual',wb.mis!=null?wb.mis.toExponential(1):'?','(must be <1e-9)',
  '| spliced V',nb.v.toFixed(5),'| deviation',dev.toFixed(4),'% (<0.5%)',
  (wb.conv&&nb.conv&&dev<0.5&&okFloor)?'PASS':'FAIL');
 record('brk','closed-breaker PF stamp scales to its own node: HV breakered feeders keep the residual floor low and match the spliced network',
  wb.conv&&nb.conv&&dev<0.5&&okFloor);
}

// ---- power flow (positive-sequence steady-state solve + machine init).
// A slack syncgen feeds a load through a line. solvePowerFlow() must converge
// and write pfInit onto the machine; a run started from it must be FLAT (no
// electromechanical swing), whereas the same circuit cold-started swings as it
// hunts for its load angle. This is the acceptance test for the initializer:
// initialize, run undisturbed, confirm nothing moves. ----
{
 const build=()=>{ S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'syncgen',x:0,y:0,params:{H:4,Sbase:200,Ra:0.05,Ld:5,f0:60,E0:277,Pm0:0,Kgov:15,D:25,Q0:0,mq:0.5,Tf:20,pfType:'slack',Vset:0}},
   {id:2,type:'line',x:0,y:0,params:{R:0.2,L:3,Rm:0,Lm:0,C:0}},
   {id:3,type:'rlc',x:0,y:0,params:{R:8,L:-1,C:-1}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]});
 };
 const fSwing=(withPF)=>{ build();
  let pf=null; if(withPF){ pf=solvePowerFlow(); }
  const r=simulate(3,4000,null,200,2000);
  const gi=r.curMeta.findIndex(m=>m.kind==='syncgen');
  const idx=r.t.map((_,i)=>i).filter(i=>r.t[i]>100); // skip electrical inrush
  const f=idx.map(i=>r.aux[gi][i]);
  return {pf, swing:(Math.max(...f)-Math.min(...f))*1000, fend:r.aux[gi][r.aux[gi].length-1]};
 };
 const cold=fSwing(false), warm=fSwing(true);
 const conv=warm.pf&&warm.pf.converged;
 console.log('power flow: converged',conv,'in',warm.pf?warm.pf.iters:'-','iters, mismatch',warm.pf?warm.pf.maxMismatch.toExponential(1):'-','V',conv?'PASS':'FAIL');
 const th0=Math.abs((S.blocks.find(b=>b.id===1).pfInit||{}).th||0);
 console.log('power flow: machine initialized at nonzero load angle',(th0*180/Math.PI).toFixed(1),'deg',th0>0.01?'PASS':'FAIL');
 console.log('power flow flat-start swing',warm.swing.toFixed(0),'mHz vs cold-start',cold.swing.toFixed(0),'mHz (init must be flatter, <30 mHz)',
  (warm.swing<30&&warm.swing<cold.swing)?'PASS':'FAIL');
 const errFend=Math.abs(warm.fend-60);
 console.log('power flow flat-start final frequency',warm.fend.toFixed(4),'Hz (expect ~60)',errFend<0.05?'PASS':'FAIL');
 record('powerflow','converge + machine init + flat-start swing < cold', !(!conv||th0<=0.01||warm.swing>=30||warm.swing>=cold.swing||errFend>=0.05));
}

// ---- the two solvers must agree about how big a load IS (SPEC §2 "Power
// convention"). Until July 2026 they did not: pq/zip injected their full P into
// EVERY phase while solvePowerFlow() — a three-phase-total solve — read the same
// number at face value, so the power flow saw a third of the load the EMT run
// actually drew. Nothing caught it, because every load test measured one phase
// against a per-phase expectation and every PF test used constant-impedance rlc.
// The witness was examples/ieee9bus.json, whose PF returned a slack of -133 MW
// against the published +71.6 MW. Guard the agreement directly: solve the same
// circuit both ways and compare the slack's real power. ----
{
 // Bus voltage is the comparable both solvers report directly, and the load is
 // sized for a ~10% drop so a 3x disagreement is unmistakable: measured on the
 // pre-fix code this same case reads PF 7201 V against EMT 8643 V, a 20% error
 // versus 0.6% once they agree. The line carries shunt C on purpose — a
 // constant-power load behind a PURE series RL has no local voltage anchor and
 // runs away into phantom voltages (the standing trap in CLAUDE.md), which is a
 // property of the load model, not of this convention.
 const runBoth=(loadBlock)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:7967,f:60,Rs:0.5}},
   {id:2,type:'line',x:0,y:0,params:{R:1.5,L:20,Rm:0,Lm:0,C:4}},
   loadBlock,
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'gnd',x:0,y:0,params:{}},
   {id:6,type:'bus',x:0,y:0,params:{name:'LOAD',taps:3,len:50,Vbase:7967}},
   {id:7,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[6,0]},{a:[6,1],b:[3,0]},
   {a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]},{a:[7,0],b:[6,2]});
  const pf=solvePowerFlow();
  const Vpf=pf.converged?pf.busBlocks.find(b=>b.name==='LOAD').Vmag:NaN;
  // EMT steady-state rms at the same bus, over an integer number of cycles
  // (300->400 ms is exactly 6 cycles at 60 Hz).
  const r=simulate(3,400,null,50,250);
  const v=r.vp[0][0];
  let s=0,n=0; for(let k=0;k<r.t.length;k++){ if(r.t[k]<=300) continue; s+=v[k]*v[k]; n++; }
  return {Vpf, Vemt:Math.sqrt(s/n), conv:pf.converged};
 };
 const cases=[
  ['pq',  {id:3,type:'pq', x:0,y:0,params:{P:4000,Q:1200,f:60,Tf:20,vmin:50}}],
  ['zip', {id:3,type:'zip',x:0,y:0,params:{P:4000,Q:1200,V0:7967,az:0,ai:0,ap:1,bz:0,bi:0,bp:1,f:60,Tf:20,vmin:50}}]
 ];
 let bad=false;
 cases.forEach(([label,lb])=>{
  const m=runBoth(lb);
  const err=Math.abs(m.Vemt-m.Vpf)/m.Vpf*100;
  const ok=m.conv&&err<2;
  console.log('PF vs EMT load size ('+label+' 4000 kW 3-ph): PF bus',m.Vpf.toFixed(0),
   'V, EMT bus',m.Vemt.toFixed(0),'V, error',err.toFixed(2)+'%',ok?'PASS':'FAIL');
  if(!ok)bad=true;
 });
 record('powerflow','solvePowerFlow and the EMT run agree on a pq/zip load\'s size', !bad);
}

// ---- passive-history initialization from the power flow (SPEC §2, §5 item 32).
// Machine init alone (item 10) starts the MACHINES at the operating point but
// leaves every line current and cap voltage at zero, so the run still begins by
// energizing a dead network. This is the acceptance test for closing that gap:
// a 3-bus radial with long lines, line-charging caps and a light-inertia machine
// is run three ways and the FIRST CYCLE is compared against the power flow's own
// phasors, which is where an inrush lives.
//   cold   = no power flow at all
//   pfinit = power flow, machines initialized, histories zeroed  (pre-item-32;
//            produced by deleting the per-terminal phasors `pfV` the seeder reads)
//   seeded = power flow, machines AND passive histories initialized
// The seeded run must reproduce the PF waveform from the very first sample, and
// must do so by orders of magnitude, not by a tuned tolerance. ----
{
 const P={H:0.6,Sbase:60000,Ra:2,Ld:600,E0:231000,Pm0:40000,D:0,mq:0.001,R:8,L:600,Cs:2,RL:1800,LL:1500};
 const build=()=>{ S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'syncgen',x:0,y:0,params:{H:P.H,Sbase:P.Sbase,Ra:P.Ra,Ld:P.Ld,f0:50,E0:P.E0,Pm0:P.Pm0,Kgov:0,D:P.D,Q0:0,mq:P.mq,Tf:20,pfType:'slack',Vset:0,Tg:0,Te:0}},
   {id:2,type:'gnd',x:0,y:0,params:{}},
   {id:3,type:'bus',x:0,y:0,params:{name:'B1',Vbase:P.E0,taps:2}},
   {id:4,type:'line',x:0,y:0,params:{R:P.R,L:P.L,Rm:0,Lm:0,C:0}},
   {id:5,type:'bus',x:0,y:0,params:{name:'B2',Vbase:P.E0,taps:3}},
   {id:6,type:'cap',x:0,y:0,params:{C:P.Cs}},{id:7,type:'gnd',x:0,y:0,params:{}},
   {id:8,type:'line',x:0,y:0,params:{R:P.R,L:P.L,Rm:0,Lm:0,C:0}},
   {id:9,type:'bus',x:0,y:0,params:{name:'B3',Vbase:P.E0,taps:3}},
   {id:10,type:'cap',x:0,y:0,params:{C:P.Cs}},{id:11,type:'gnd',x:0,y:0,params:{}},
   {id:12,type:'rlc',x:0,y:0,params:{R:P.RL,L:P.LL,C:-1}},{id:13,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,0],b:[2,0]},{a:[1,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,0]},
   {a:[5,1],b:[6,0]},{a:[6,1],b:[7,0]},{a:[5,2],b:[8,0]},{a:[8,1],b:[9,0]},
   {a:[9,1],b:[10,0]},{a:[10,1],b:[11,0]},{a:[9,2],b:[12,0]},{a:[12,1],b:[13,0]});
 };
 const W=2*Math.PI*50;
 const go=mode=>{ build();
  const keep={};
  if(mode!=='cold'){ const pf=solvePowerFlow();
   if(pf.err||!pf.converged) return {err:pf.err||'not converged'};
   S.blocks.forEach(b=>{ if(b.pfV&&b.pfV[0]) keep[b.id]=b.pfV[0]; });
   if(mode==='pfinit') S.blocks.forEach(b=>{ delete b.pfV; }); }
  const r=simulate(3,400,null,50,50);
  if(r.err) return {err:r.err};
  const gi=r.curMeta.findIndex(m=>m.kind==='syncgen');
  const f=r.aux[gi].filter(Number.isFinite);
  // First-cycle deviation of every bus from the waveform its PF phasor implies,
  // as a % of that bus's own peak; plus the peak envelope over the whole run
  // relative to what the PF predicts (an inrush shows up in both).
  let res=0, over=0;
  r.probeMeta.forEach((pm,pi)=>{ const z=keep[pm.id]; if(!z) return;
   const ref=Math.SQRT2*Math.hypot(z.re,z.im); if(!(ref>0)) return;
   let pk=0; r.vp[pi][0].forEach(v=>{ if(Math.abs(v)>pk) pk=Math.abs(v); });
   over=Math.max(over,100*(pk-ref)/ref);
   for(let k=0;k<r.t.length;k++){ const t=r.t[k]/1000; if(t>1/50) break;
    const e=Math.SQRT2*(z.re*Math.sin(W*t)+z.im*Math.cos(W*t));
    res=Math.max(res,100*Math.abs(r.vp[pi][0][k]-e)/ref); } });
  return {res, over, swing:(Math.max(...f)-Math.min(...f))*1000, fend:f[f.length-1]};
 };
 const cold=go('cold'), pfi=go('pfinit'), sed=go('seeded');
 const bad=cold.err||pfi.err||sed.err;
 if(bad){ console.log('passive history: solver error',bad); record('powerflow','passive-history init (SPEC §5 item 32)',false); }
 else {
  console.log('passive history: machine swing cold',cold.swing.toFixed(0),'mHz / machines-only',pfi.swing.toFixed(0),
   'mHz / seeded',sed.swing.toFixed(0),'mHz (seeded must be <10 and 20x flatter)',
   (sed.swing<10&&sed.swing*20<pfi.swing)?'PASS':'FAIL');
  console.log('passive history: first-cycle bus deviation from PF, machines-only',pfi.res.toFixed(1),
   '% vs seeded',sed.res.toFixed(3),'% (seeded must be <0.5% and 100x smaller)',
   (sed.res<0.5&&sed.res*100<pfi.res)?'PASS':'FAIL');
  console.log('passive history: peak bus overvoltage vs PF, machines-only',pfi.over.toFixed(1),
   '% vs seeded',sed.over.toFixed(2),'% (no inrush spike: seeded must be <3%)',
   (sed.over<3&&sed.over<pfi.over)?'PASS':'FAIL');
  console.log('passive history: seeded final frequency',sed.fend.toFixed(5),'Hz (expect ~50)',
   Math.abs(sed.fend-50)<0.01?'PASS':'FAIL');
  record('powerflow','passive-history init: first cycle ON the PF solution, no inrush (§5 item 32)',
   !(sed.swing>=10||sed.swing*20>=pfi.swing||sed.res>=0.5||sed.res*100>=pfi.res||sed.over>=3||sed.over>=pfi.over||Math.abs(sed.fend-50)>=0.01));
 }
}

// ---- passive-history seeding, per element family (SPEC §5 item 32). The
// fixture above covers line/cap/rlc/syncgen; these cover the families whose
// history is NOT a plain two-terminal (v,i) pair, where the seed has to be
// built through the element's own internal structure:
//   cline    3x3 mutual coupling      -> sequence-decomposed complex inverse
//   xfmr3    winding incidence rows   -> vector group + clock shift + neutral
//   xfmr3w   star (T) equivalent      -> internal star point, not a network node
//   xfmrsat  nonlinear magnetizing    -> exact flux seed + correct LU segment
// A hook that does nothing also passes a test that doesn't contain its block,
// so each case asserts BOTH that the machines-only residual is large (the
// fixture really exercises the block) and that the seeded one is ~0. ----
{
 const F=50, W2=2*Math.PI*F;
 const meas=(build,mode)=>{ build();
  const keep={};
  if(mode!=='cold'){ const pf=solvePowerFlow();
   if(pf.err||!pf.converged) return {err:pf.err||'not converged'};
   S.blocks.forEach(b=>{ if(b.pfV&&b.pfV[0]) keep[b.id]=b.pfV[0]; });
   if(mode==='pfinit') S.blocks.forEach(b=>{ delete b.pfV; }); }
  const r=simulate(3,200,null,50,50);
  if(r.err) return {err:r.err};
  let res=0,over=0,nb=0;
  r.probeMeta.forEach((pm,pi)=>{ const z=keep[pm.id]; if(!z) return;
   const ref=Math.SQRT2*Math.hypot(z.re,z.im); if(!(ref>0)) return; nb++;
   let pk=0; r.vp[pi][0].forEach(v=>{ if(Math.abs(v)>pk) pk=Math.abs(v); });
   over=Math.max(over,100*(pk-ref)/ref);
   for(let k=0;k<r.t.length;k++){ const t=r.t[k]/1000; if(t>1/F) break;
    const e=Math.SQRT2*(z.re*Math.sin(W2*t)+z.im*Math.cos(W2*t));
    res=Math.max(res,100*Math.abs(r.vp[pi][0][k]-e)/ref); } });
  return {res,over,nb};
 };
 // src -> line -> DEVICE -> load, probes either side of the device
 const rig=(dev,extra)=>()=>{ S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push({id:1,type:'src',x:0,y:0,params:{Vrms:20000,f:F,Rs:0.5}},
   {id:2,type:'line',x:0,y:0,params:{R:0.6,L:12,Rm:0,Lm:0,C:0}},
   dev,
   {id:4,type:'rlc',x:0,y:0,params:{R:14,L:9,C:-1}},
   {id:5,type:'gnd',x:0,y:0,params:{}},{id:6,type:'gnd',x:0,y:0,params:{}},
   {id:7,type:'probe',x:0,y:0,params:{}},{id:8,type:'probe',x:0,y:0,params:{}});
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},
   {a:[1,0],b:[5,0]},{a:[4,1],b:[6,0]},{a:[7,0],b:[2,1]},{a:[8,0],b:[3,1]});
  if(extra) extra();
 };
 const CASES=[
  ['pline', rig({id:3,type:'line',x:0,y:0,params:{R:0.6,L:12,Rm:0,Lm:0,C:2}})],
  ['gfm', ()=>{ S.blocks.length=0;S.wires.length=0;S.vconv='ph';
    S.blocks.push({id:1,type:'gfm',x:0,y:0,params:{E0:277,f0:F,mp:0.05,mq:0.5,P0:0,Q0:0,Rf:0.1,Lf:1,Tf:20,pfType:'slack'}},
     {id:2,type:'gnd',x:0,y:0,params:{}},
     {id:3,type:'line',x:0,y:0,params:{R:0.3,L:2,Rm:0,Lm:0,C:0}},
     {id:4,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
     {id:5,type:'gnd',x:0,y:0,params:{}},
     {id:6,type:'probe',x:0,y:0,params:{}},{id:7,type:'probe',x:0,y:0,params:{}});
    S.wires.push({a:[1,0],b:[2,0]},{a:[1,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,0]},
     {a:[6,0],b:[1,1]},{a:[7,0],b:[3,1]}); }],
  ['cline', ()=>{ S.blocks.length=0;S.wires.length=0;S.vconv='ph';
    S.blocks.push({id:1,type:'src',x:0,y:0,params:{Vrms:20000,f:F,Rs:0.5}},
     {id:2,type:'line',x:0,y:0,params:{R:1.2,L:40,Rm:0.4,Lm:14,C:0}},
     {id:3,type:'rlc',x:0,y:0,params:{R:120,L:90,C:-1}},
     {id:4,type:'gnd',x:0,y:0,params:{}},{id:5,type:'gnd',x:0,y:0,params:{}},
     {id:6,type:'probe',x:0,y:0,params:{}},{id:7,type:'probe',x:0,y:0,params:{}});
    S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]},
     {a:[6,0],b:[2,0]},{a:[7,0],b:[2,1]}); }],
  ['xfmr3 Dy11+Lm', rig({id:3,type:'xfmr3',x:0,y:0,params:{conn:'Dy11',V1:34641,V2:4160,R:0.4,L:6,Rn1:0,Rn2:0,Lm:900}})],
  ['xfmr3 Yy0 Rn',  rig({id:3,type:'xfmr3',x:0,y:0,params:{conn:'Yy0',V1:34641,V2:4160,R:0.4,L:6,Rn1:5,Rn2:5,Lm:0}})],
  ['xfmrsat',       rig({id:3,type:'xfmr',x:0,y:0,params:{V1:20000,V2:4000,R:0.4,L:6,Lm:900,lknee:0,Lsat:20}})],
  ['xfmr3w', ()=>{ S.blocks.length=0;S.wires.length=0;S.vconv='ph';
    S.blocks.push({id:1,type:'src',x:0,y:0,params:{Vrms:20000,f:F,Rs:0.5}},
     {id:2,type:'line',x:0,y:0,params:{R:0.6,L:12,Rm:0,Lm:0,C:0}},
     {id:3,type:'xfmr3w',x:0,y:0,params:{conn:'Yy0d1',V1:34641,V2:4160,V3:6900,R1:0.3,L1:5,R2:0.3,L2:5,R3:0.3,L3:5,Rn1:0,Rn2:0,Rn3:0,Lm:800}},
     {id:4,type:'rlc',x:0,y:0,params:{R:16,L:10,C:-1}},{id:9,type:'rlc',x:0,y:0,params:{R:30,L:18,C:-1}},
     {id:5,type:'gnd',x:0,y:0,params:{}},{id:6,type:'gnd',x:0,y:0,params:{}},{id:10,type:'gnd',x:0,y:0,params:{}},
     {id:7,type:'probe',x:0,y:0,params:{}},{id:8,type:'probe',x:0,y:0,params:{}},{id:11,type:'probe',x:0,y:0,params:{}});
    S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[3,2],b:[9,0]},
     {a:[1,0],b:[5,0]},{a:[4,1],b:[6,0]},{a:[9,1],b:[10,0]},
     {a:[7,0],b:[2,1]},{a:[8,0],b:[3,1]},{a:[11,0],b:[3,2]}); }]
 ];
 let allOk=true;
 CASES.forEach(([name,build])=>{
  const p=meas(build,'pfinit'), s=meas(build,'seeded');
  if(p.err||s.err){ console.log('passive history ['+name+']: solver error',p.err||s.err); allOk=false; return; }
  // exercised: the block must MATTER in this fixture, or a no-op hook passes
  const exercised=p.res>0.25, clean=s.res<0.05&&s.over<0.5;
  console.log('passive history ['+name+']: machines-only',p.res.toFixed(3),'% dev / seeded',s.res.toFixed(4),
   '% dev,',s.over.toFixed(2),'% over,',s.nb,'buses (fixture must bite >0.25%, seeded <0.05%)',
   (exercised&&clean)?'PASS':'FAIL');
  if(!(exercised&&clean)) allOk=false;
 });
 // A saturable core whose steady-state flux is past the knee is NOT seedable
 // (the PF's magnetizing model is linear), so the seeder must decline and hand
 // back the ordinary cold start rather than a worse-than-cold mixture.
 const sat=rig({id:3,type:'xfmr',x:0,y:0,params:{V1:20000,V2:4000,R:0.4,L:6,Lm:900,lknee:40,Lsat:20}});
 const sp=meas(sat,'pfinit'), ss=meas(sat,'seeded');
 const vetoed=!sp.err&&!ss.err&&Math.abs(sp.res-ss.res)<1e-6;
 console.log('passive history [saturated core]: veto falls back to cold exactly, machines-only',
  sp.err?'ERR':sp.res.toFixed(3),'% vs seeded',ss.err?'ERR':ss.res.toFixed(3),'%',vetoed?'PASS':'FAIL');
 if(!vetoed) allOk=false;
 record('powerflow','passive-history init: cline / xfmr3 / xfmr3w / xfmrsat families + saturation veto',allOk);
}

// ---- passive-history seeding, measurement-window family (SPEC §5 item 32,
// "pq" first per the handoff). pq/zip/im/svc/wt4/hvdc are shunt CURRENT
// SOURCES, not series branches, so they are not part of the all-or-nothing
// SEED_REQUIRED set and their tolerance is NOT the <0.05%/<0.5% bar used for
// the CASES loop above: the seed derives the exact discrete steady state of
// pq's own v2f/vbuf/icmd recursion (SPEC §2 "Measurement-window pre-fill"),
// but pq's commanded current still feeds back through the source's own
// impedance (icmd depends on v, v = vs − icmd·Rs), and that closed loop's TRUE
// periodic steady state carries small harmonics beyond the PF's fundamental
// phasor the seed is built from. Measured varying Rs alone: the residual
// scales linearly with it (0.140% at Rs=0.05Ω down to 0.0001% at Rs=5e-5Ω),
// confirming it is bounded by source impedance exactly as designed, not a
// bug — so the bar here is "much better than unseeded", not "near zero". ----
{
 const F=50, W2=2*Math.PI*F;
 const meas=(build,mode)=>{ build();
  const keep={};
  if(mode!=='cold'){ const pf=solvePowerFlow();
   if(pf.err||!pf.converged) return {err:pf.err||'not converged'};
   S.blocks.forEach(b=>{ if(b.pfV&&b.pfV[0]) keep[b.id]=b.pfV[0]; });
   if(mode==='pfinit') S.blocks.forEach(b=>{ delete b.pfV; }); }
  const r=simulate(3,200,null,50,50);
  if(r.err) return {err:r.err};
  let res=0,over=0,nb=0;
  r.probeMeta.forEach((pm,pi)=>{ const z=keep[pm.id]; if(!z) return;
   const ref=Math.SQRT2*Math.hypot(z.re,z.im); if(!(ref>0)) return; nb++;
   let pk=0; r.vp[pi][0].forEach(v=>{ if(Math.abs(v)>pk) pk=Math.abs(v); });
   over=Math.max(over,100*(pk-ref)/ref);
   for(let k=0;k<r.t.length;k++){ const t=r.t[k]/1000; if(t>1/F) break;
    const e=Math.SQRT2*(z.re*Math.sin(W2*t)+z.im*Math.cos(W2*t));
    res=Math.max(res,100*Math.abs(r.vp[pi][0][k]-e)/ref); } });
  return {res,over,nb};
 };
 const MWCASES=[
  ['pq', ()=>{ S.blocks.length=0;S.wires.length=0;S.vconv='ph';
   S.blocks.push({id:1,type:'src',x:0,y:0,params:{Vrms:277,f:50,Rs:0.05}},
    {id:3,type:'pq',x:0,y:0,params:{P:8,Q:3,f:50,Tf:20,vmin:50}},
    {id:5,type:'gnd',x:0,y:0,params:{}},{id:6,type:'gnd',x:0,y:0,params:{}},
    {id:7,type:'probe',x:0,y:0,params:{}});
   S.wires.push({a:[1,1],b:[3,0]},{a:[3,1],b:[6,0]},
    {a:[1,0],b:[5,0]},{a:[7,0],b:[3,0]}); }],
  ['zip', ()=>{ S.blocks.length=0;S.wires.length=0;S.vconv='ph';
   S.blocks.push({id:1,type:'src',x:0,y:0,params:{Vrms:277,f:50,Rs:0.05}},
    {id:3,type:'zip',x:0,y:0,params:{P:8,Q:3,V0:277,az:0.4,ai:0.3,ap:0.3,bz:0.4,bi:0.3,bp:0.3,f:50,Tf:20,vmin:50}},
    {id:5,type:'gnd',x:0,y:0,params:{}},{id:6,type:'gnd',x:0,y:0,params:{}},
    {id:7,type:'probe',x:0,y:0,params:{}});
   S.wires.push({a:[1,1],b:[3,0]},{a:[3,1],b:[6,0]},
    {a:[1,0],b:[5,0]},{a:[7,0],b:[3,0]}); }],
  ['wt4', ()=>{ S.blocks.length=0;S.wires.length=0;S.vconv='ph';
   S.blocks.push({id:1,type:'src',x:0,y:0,params:{Vrms:277,f:50,Rs:0.5}},
    {id:2,type:'line',x:0,y:0,params:{R:0.2,L:2,Rm:0,Lm:0,C:0}},
    {id:3,type:'wt4',x:0,y:0,params:{Prated:1,vrated:12,vw:10,vw2:0,tgust:-1,Q0:0.2,Imax:150,vmin:50,f0:50}},
    {id:4,type:'gnd',x:0,y:0,params:{}},{id:5,type:'gnd',x:0,y:0,params:{}},
    {id:7,type:'rlc',x:0,y:0,params:{R:10,L:-1,C:-1}},{id:8,type:'gnd',x:0,y:0,params:{}},
    {id:6,type:'probe',x:0,y:0,params:{}});
   S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,1]},{a:[3,0],b:[5,0]},{a:[1,0],b:[4,0]},
    {a:[2,1],b:[7,0]},{a:[7,1],b:[8,0]},{a:[6,0],b:[2,1]}); }],
  ['hvdc', ()=>{ S.blocks.length=0;S.wires.length=0;S.vconv='ph';
   S.blocks.push({id:1,type:'src',x:0,y:0,params:{Vrms:277,f:50,Rs:0.5}},
    {id:2,type:'line',x:0,y:0,params:{R:0.2,L:2,Rm:0,Lm:0,C:0}},
    {id:3,type:'hvdc',x:0,y:0,params:{Pset:2,Tp:50,VdcRef:800,Cdc:20000,kp:0.5,ki:20,Prate:200,eff:0.97,QA:0,QB:0,Imax:200,vmin:50,f0:50}},
    {id:4,type:'line',x:0,y:0,params:{R:0.2,L:2,Rm:0,Lm:0,C:0}},
    {id:5,type:'src',x:0,y:0,params:{Vrms:277,f:50,Rs:0.5}},
    {id:6,type:'gnd',x:0,y:0,params:{}},{id:7,type:'gnd',x:0,y:0,params:{}},
    {id:10,type:'rlc',x:0,y:0,params:{R:10,L:-1,C:-1}},{id:11,type:'gnd',x:0,y:0,params:{}},
    {id:12,type:'rlc',x:0,y:0,params:{R:10,L:-1,C:-1}},{id:13,type:'gnd',x:0,y:0,params:{}},
    {id:8,type:'probe',x:0,y:0,params:{}},{id:9,type:'probe',x:0,y:0,params:{}});
   S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,1]},{a:[1,0],b:[6,0]},{a:[5,0],b:[7,0]},
    {a:[2,1],b:[10,0]},{a:[10,1],b:[11,0]},{a:[4,1],b:[12,0]},{a:[12,1],b:[13,0]},
    {a:[8,0],b:[2,1]},{a:[9,0],b:[4,1]}); }],
  // im is the measurement-window family member that ALSO carries real
  // electromechanical state (Ed/Eq/slip), so its seed is the induction-motor
  // torque balance, not just a boxcar prefill (SPEC §2). Fixture: a stiff
  // source feeds the motor directly (no line — im has no LPF on its injected
  // current, unlike wt4, so a series L against a stiff bus self-sustains a
  // trapezoidal Nyquist ring; the existing src->im cold test is stable for
  // the same reason). Unseeded, Ed=Eq=0 at t=0 so the first update()
  // computes the DOL inrush V/(Rs+jX') (~7x the steady current), dipping the
  // bus through the source resistance over the first cycle; seeded, Ed/Eq
  // and the window are at the steady operating point so the motor reaches
  // its steady current in one step and the bus sits at its small,
  // source-impedance-bounded steady dip. icmd stays cold in both (im is
  // absent from buildYbus, so the PF bus models no motor load), so the bus
  // deviates from the PF waveform by the motor's real draw — the bar is
  // "much better than unseeded", like wt4.
  ['im', ()=>{ S.blocks.length=0;S.wires.length=0;S.vconv='ph';
   S.blocks.push({id:1,type:'src',x:0,y:0,params:{Vrms:277,f:50,Rs:0.1}},
    {id:3,type:'im',x:0,y:0,params:{Rs:0.45,Lls:4,Lm:120,Rr:0.6,Llr:4,H:0.5,Sbase:15,PL:5,kexp:2,s0:0.03,f0:50}},
    {id:4,type:'gnd',x:0,y:0,params:{}},{id:5,type:'gnd',x:0,y:0,params:{}},
    {id:7,type:'probe',x:0,y:0,params:{}});
   S.wires.push({a:[1,1],b:[3,0]},{a:[3,1],b:[5,0]},
    {a:[1,0],b:[4,0]},{a:[7,0],b:[3,0]}); }]
 ];
 let mwOk=true;
 MWCASES.forEach(([name,build])=>{
  const p=meas(build,'pfinit'), s=meas(build,'seeded');
  if(p.err||s.err){ console.log('passive history ['+name+']: solver error',p.err||s.err); mwOk=false; return; }
  const exercised=p.res>0.25, clean=s.res<1&&s.over<1&&s.res*5<p.res;
  console.log('passive history ['+name+']: unseeded',p.res.toFixed(3),'% dev / seeded',s.res.toFixed(4),
   '% dev,',s.over.toFixed(2),'% over (fixture must bite >0.25%, seeded <1% and >5x better)',
   (exercised&&clean)?'PASS':'FAIL');
  if(!(exercised&&clean)) mwOk=false;
 });
 record('powerflow','passive-history init: pq/zip/wt4/hvdc/im measurement window pre-fill', mwOk);
}

// ---- passive-history seeding, vsw (SPEC §5 item 32). vsw is a PURE SENSOR
// (no stamp, no injection), so unlike pq/zip its seeding has no observable
// effect on any bus voltage — the only thing to check is its own decision
// timing. Its RMS window is a genuine one-cycle BOXCAR average (no filter
// memory like pq's v2f), so seeding is just the general ring-buffer rule with
// the window left FULL; `state`/`dwell` are deliberately left cold (real
// control behavior, not a measurement artifact). Fixture: a line sags the bus
// below Von, so the controller should command close as soon as its dwell
// timer (Td) elapses. Unseeded, the window is EMPTY at t=0 and the update()
// guard skips the decision entirely until it fills (NW steps, one cycle) —
// so cold start pays a full extra cycle before the dwell timer can even
// start; seeded, the window is already valid and the dwell timer starts
// immediately. ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'line',x:0,y:0,params:{R:4,L:15,Rm:0,Lm:0,C:0}},
  {id:3,type:'rlc',x:0,y:0,params:{R:10,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}},{id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:0}},
  {id:8,type:'gnd',x:0,y:0,params:{}},
  {id:9,type:'vsw',x:0,y:0,params:{brkId:6,mode:0,Von:250,Voff:280,Td:50,f:60}}
 );
 S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]},
  {a:[6,0],b:[2,1]},{a:[6,1],b:[8,0]},{a:[9,0],b:[2,1]});
 const closeTime=mode=>{
  if(mode!=='cold'){ const pf=solvePowerFlow();
   if(pf.err||!pf.converged) return {err:pf.err||'not converged'};
   if(mode==='pfinit') S.blocks.forEach(b=>{ delete b.pfV; }); }
  const r=simulate(3,150,null,50,50);
  if(r.err) return {err:r.err};
  const vi=r.curMeta.findIndex(m=>m.kind==='vsw');
  const arr=r.aux[vi];
  for(let i=0;i<arr.length;i++) if(arr[i]===1) return {t:r.t[i]};
  return {t:null};
 };
 const pf0=closeTime('pfinit'), sd=closeTime('seeded');
 if(pf0.err||sd.err){ console.log('passive history [vsw]: solver error',pf0.err||sd.err); record('powerflow','passive-history init: vsw measurement window',false); }
 else {
  const Td=50; // ms, matches params.Td above
  const seededOk = sd.t!==null && Math.abs(sd.t-Td)<2;
  const unseededLater = pf0.t!==null && sd.t!==null && (pf0.t-sd.t)>10;
  console.log('passive history [vsw]: unseeded closes at',pf0.t,'ms / seeded closes at',sd.t,
   'ms (seeded must land within 2ms of Td='+Td+'ms, unseeded >10ms later)',
   (seededOk&&unseededLater)?'PASS':'FAIL');
  record('powerflow','passive-history init: vsw measurement window (boxcar RMS pre-fill)', seededOk&&unseededLater);
 }
}

// ---- passive-history seeding, svc (SPEC §5 item 32). wbuf (one-cycle boxcar,
// balanced 3-phase => constant s2 = Vrms², trivial to seed) and qbuf (pq's
// quarter-period trick) seed by the general rule; `Iq` itself stays cold —
// solvePowerFlow() does not model svc's own droop (absent from buildYbus
// entirely), so there is no PF-consistent steady-state Iq the way there is a
// steady-state icmd for pq. The observable effect is the SAME start-up gate
// vsw has (`if (this.wcnt >= NW)`): unseeded, Iq stays frozen at exactly 0
// until the window fills (one cycle); seeded, the integrator can act from
// t=0. Checked well inside that first cycle, at a time both circuits still
// share the same network state (svc hasn't influenced anything yet either
// way, since STATCOM current is a Norton injection with no G stamped). ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'line',x:0,y:0,params:{R:4,L:15,Rm:0,Lm:0,C:0}},
  {id:3,type:'rlc',x:0,y:0,params:{R:10,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}},{id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'svc',x:0,y:0,params:{mode:0,Vref:277,Xs:0.5,Ki:200,Bmax:0.02,Bmin:-0.02,Imax:10,f:60}}
 );
 S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]},
  {a:[6,0],b:[2,1]});
 const iqAt5ms=mode=>{
  if(mode!=='cold'){ const pf=solvePowerFlow();
   if(pf.err||!pf.converged) return {err:pf.err||'not converged'};
   if(mode==='pfinit') S.blocks.forEach(b=>{ delete b.pfV; }); }
  const r=simulate(3,20,null,50,50);
  if(r.err) return {err:r.err};
  const si=r.curMeta.findIndex(m=>m.kind==='svc');
  let idx=0; for(let i=0;i<r.t.length;i++) if(r.t[i]<=5) idx=i;
  return {Iq:r.aux[si][idx]};
 };
 const pf0=iqAt5ms('pfinit'), sd=iqAt5ms('seeded');
 if(pf0.err||sd.err){ console.log('passive history [svc]: solver error',pf0.err||sd.err); record('powerflow','passive-history init: svc measurement window',false); }
 else {
  const unseededFrozen = Math.abs(pf0.Iq)<1e-9;
  const seededMoving = Math.abs(sd.Iq)>1;
  console.log('passive history [svc]: unseeded Iq@5ms',pf0.Iq,'/ seeded Iq@5ms',sd.Iq.toFixed(3),
   '(unseeded must still be frozen at 0, seeded must already be integrating)',
   (unseededFrozen&&seededMoving)?'PASS':'FAIL');
  record('powerflow','passive-history init: svc measurement window (boxcar + quarter-period pre-fill)', unseededFrozen&&seededMoving);
 }
}

// ---- passive-history seeding, relay (SPEC §5 item 32). relay's stamp() is a
// fixed near-short conductance with an EMPTY inject() -- its own current is
// always exactly vb*GON, recomputed fresh every step, so it has no history
// that could disagree with the rest of the seeded network (why it was never
// in SEED_REQUIRED). Its Irms boxcar is the same one-cycle rule as vsw's,
// applied to current instead of voltage. Fixture: a line's own cold-start
// L/R inrush (line is SEED_REQUIRED, correctly seeded elsewhere) suppresses
// the apparent fault current for the first several ms when UNSEEDED, so the
// relay doesn't even register the overcurrent yet; seeded, the line carries
// the true fault current from t=0 and relay's own accurate window lets it
// start accumulating toward trip immediately. ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:9,type:'line',x:0,y:0,params:{R:0.5,L:20,Rm:0,Lm:0,C:0}},
  {id:2,type:'relay',x:0,y:0,params:{Ipu:20,curve:'VI',TD:0.5,Iinst:0,brkId:6,f:60}},
  {id:3,type:'rlc',x:0,y:0,params:{R:0.5,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}},{id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:0}},
  {id:8,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[9,0]},{a:[9,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]},
  {a:[6,0],b:[2,0]},{a:[6,1],b:[8,0]});
 const fracAt1ms=mode=>{
  if(mode!=='cold'){ const pf=solvePowerFlow();
   if(pf.err||!pf.converged) return {err:pf.err||'not converged'};
   if(mode==='pfinit') S.blocks.forEach(b=>{ delete b.pfV; }); }
  const r=simulate(3,10,null,50,50);
  if(r.err) return {err:r.err};
  const ri=r.curMeta.findIndex(m=>m.kind==='relay');
  let idx=0; for(let i=0;i<r.t.length;i++) if(r.t[i]<=1) idx=i;
  return {frac:r.aux[ri][idx]};
 };
 const pf0=fracAt1ms('pfinit'), sd=fracAt1ms('seeded');
 if(pf0.err||sd.err){ console.log('passive history [relay]: solver error',pf0.err||sd.err); record('powerflow','passive-history init: relay measurement window',false); }
 else {
  const unseededDark = pf0.frac===0;
  const seededSeeing = sd.frac>0;
  console.log('passive history [relay]: unseeded frac@1ms',pf0.frac,'/ seeded frac@1ms',sd.frac.toFixed(6),
   '(unseeded must not register the fault yet, seeded must already be accumulating)',
   (unseededDark&&seededSeeing)?'PASS':'FAIL');
  record('powerflow','passive-history init: relay measurement window (current boxcar pre-fill)', unseededDark&&seededSeeing);
 }
}

// ---- induction motor (im): steady-state slip + stator current vs the
// steady-state equivalent circuit solved INDEPENDENTLY here (Thevenin
// torque balance by bisection + full input impedance), SPEC section 2.
// The third-order model's steady state must reproduce the equivalent
// circuit exactly; tolerance covers phasor extraction + settling. ----
{
 const IMP={Rs:0.45,Lls:4,Lm:120,Rr:0.6,Llr:4,H:0.5,Sbase:15,PL:10,kexp:2,s0:0.03,f0:60};
 const build=(s0)=>{ S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.01}},
   {id:2,type:'im',x:0,y:0,params:Object.assign({},IMP,{s0})},
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[2,1],b:[4,0]});
 };
 // independent analytical reference: complex helpers + equivalent circuit
 const C=(re,im)=>({re,im}), cA=(a,b)=>C(a.re+b.re,a.im+b.im), cM=(a,b)=>C(a.re*b.re-a.im*b.im,a.re*b.im+a.im*b.re);
 const cD=(a,b)=>{const d=b.re*b.re+b.im*b.im; return C((a.re*b.re+a.im*b.im)/d,(a.im*b.re-a.re*b.im)/d);};
 const cAbs=a=>Math.hypot(a.re,a.im);
 const ws=2*Math.PI*IMP.f0, V=277;
 const Xls=ws*IMP.Lls*1e-3, Xm=ws*IMP.Lm*1e-3, Xlr=ws*IMP.Llr*1e-3, Rs=IMP.Rs, Rr=IMP.Rr, PL0=IMP.PL*1000;
 const Zs=C(Rs,Xls), jXm=C(0,Xm);
 const Vth=V*cAbs(cD(jXm,cA(Zs,jXm)));
 const Zth=cD(cM(jXm,Zs),cA(Zs,jXm));
 const Pag=s=>{const I2=Vth/cAbs(cA(cA(Zth,C(Rr/s,0)),C(0,Xlr))); return 3*I2*I2*Rr/s;};
 const bal=s=>Pag(s)-PL0*Math.pow(1-s,IMP.kexp);
 let lo=1e-4,hi=0.3; // bal<0 at lo (Pag~0), >0 at hi for these params
 for(let it=0;it<60;it++){const mid=(lo+hi)/2; if(bal(mid)>0)hi=mid; else lo=mid;}
 const sStar=(lo+hi)/2;
 const Zrot=cD(cM(jXm,cA(C(Rr/sStar,0),C(0,Xlr))),cA(C(Rr/sStar,0),C(0,Xm+Xlr)));
 const I1exp=V/cAbs(cA(Zs,Zrot));

 build(IMP.s0);
 const r=simulate(3,2500,null,50,0);
 if(r.err){console.log('im: solver error:',r.err,'FAIL');process.exit(1);}
 const mi=r.curMeta.findIndex(m=>m.kind==='im');
 const sSim=r.aux[mi][r.aux[mi].length-1];
 const tail=r.t.map((_,i)=>i).filter(i=>r.t[i]>r.t[r.t.length-1]-1000/IMP.f0); // last full cycle
 const I1sim=Math.sqrt(tail.reduce((a,i)=>a+r.ic[mi][0][i]**2,0)/tail.length);
 const eS=Math.abs(sSim-sStar)/sStar*100, eI=Math.abs(I1sim-I1exp)/I1exp*100;
 console.log('im steady slip sim:',sSim.toFixed(5),'analytical:',sStar.toFixed(5),'error:',eS.toFixed(2)+'%',eS<2?'PASS':'FAIL');
 console.log('im stator Irms sim:',I1sim.toFixed(2),'A, analytical:',I1exp.toFixed(2),'A, error:',eI.toFixed(2)+'%',eI<2?'PASS':'FAIL');

 // DOL start from standstill: slip must fall monotonically-ish under fan load
 build(1);
 const r2=simulate(3,400,null,50,0);
 const mi2=r2.curMeta.findIndex(m=>m.kind==='im');
 const sAt=ms=>{let k=0; r2.t.forEach((tv,i)=>{if(tv<=ms)k=i;}); return r2.aux[mi2][k];};
 const s100=sAt(100), s400=sAt(400);
 const sMin=Math.min(...r2.aux[mi2]), sMax=Math.max(...r2.aux[mi2]);
 const startOK=s100<1&&s400<s100&&s400<0.9&&s400>0&&sMin>-0.05&&sMax<=1.001; // physical band: no overspeed runaway, no reverse
 console.log('im DOL start: slip 1 ->',s100.toFixed(3),'(100ms) ->',s400.toFixed(3),'(400ms), range ['+sMin.toFixed(3)+','+sMax.toFixed(3)+'], accelerating within physical band',startOK?'PASS':'FAIL');
 record('im','steady slip + stator Irms vs equivalent circuit + DOL start', !(eS>=2||eI>=2||!startOK));
}

// ---- ZIP composite load: drawn P/Q vs the polynomial evaluated by hand,
// at nominal voltage and at a depressed voltage (SPEC section 2). Same
// few-percent measurement class as pq (shared v2f machinery). ----
{
 const ZP={P:8,Q:3,V0:277,az:0.4,ai:0.3,ap:0.3,bz:0.4,bi:0.3,bp:0.3,f:60,Tf:20,vmin:50};
 const runAt=(Vrms)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms,f:60,Rs:0.01}},
   {id:2,type:'zip',x:0,y:0,params:Object.assign({},ZP)},
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[2,1],b:[4,0]});
  // Explicit plotUs=250 (dec=5): ZIP shares pq's v2f tracker + quarter-period
  // reactive reference, so the forward-shift Q estimator below is dec-sensitive
  // in the same way (see the pq test and the wt4 test). Pin the spacing so the
  // test is deterministic and not coupled to the auto-cap policy.
  const r=simulate(3,400,null,50,250);
  if(r.err){console.log('zip: solver error:',r.err,'FAIL');process.exit(1);}
  const zi=r.curMeta.findIndex(m=>m.kind==='zip');
  const dtOut=r.t[1]-r.t[0];
  const win=Math.max(1,Math.round(1000/60/dtOut)), shift=Math.max(1,Math.round(win/4));
  const v=r.bv[zi][0], i=r.ic[zi][0], n=Math.min(v.length,i.length);
  let sp=0,sq=0,cnt=0;
  for(let k=0;k<n;k++){ if(r.t[k]<=300)continue; // steady tail only
   sp+=v[k]*i[k]; const j=Math.min(n-1,k+shift); sq+=v[k]*i[j]; cnt++; }
  return {P:sp/cnt, Q:sq/cnt}; // PER-PHASE (phase 0); the params are the 3-ph total, see poly()
 };
 // /3: zip's P/Q are the block's THREE-PHASE TOTAL (SPEC §2 "Power convention")
 // while runAt measures one phase, so the polynomial's per-phase share is a
 // third of it. Guards the convention — a full-P-per-phase injection reads 3x.
 const poly=(V,c0,z,ii,pp)=>c0*1000/3*(z*(V/ZP.V0)**2+ii*(V/ZP.V0)+pp);
 const cases=[[277,'V0'],[222,'0.8 V0']];
 let bad=false;
 cases.forEach(([V,label])=>{
  const m=runAt(V);
  const Pexp=poly(V,ZP.P,ZP.az,ZP.ai,ZP.ap), Qexp=poly(V,ZP.Q,ZP.bz,ZP.bi,ZP.bp);
  const eP=Math.abs(m.P-Pexp)/Pexp*100, eQ=Math.abs(m.Q-Qexp)/Qexp*100;
  console.log('zip @ '+label+': P sim',(m.P/1000).toFixed(3),'kW vs poly',(Pexp/1000).toFixed(3),'kW ('+eP.toFixed(2)+'%)',eP<3?'PASS':'FAIL');
  console.log('zip @ '+label+': Q sim',(m.Q/1000).toFixed(3),'kvar vs poly',(Qexp/1000).toFixed(3),'kvar ('+eQ.toFixed(2)+'%)',eQ<3?'PASS':'FAIL');
  if(eP>=3||eQ>=3)bad=true;
 });
 record('zip','P/Q vs polynomial at V0 and 0.8*V0', !bad);
}

// ---- ZIP constant-Z part must be STAMPED, not injected (SPEC section 2). ----
// The Z part is a fixed admittance. Injecting it off the previous step's
// voltage (which is what pq does, correctly, for its constant-POWER law) makes
// an explicit feedback loop of gain G_z/G_node that diverges as soon as the
// load conductance passes the node's own companion conductance.
//
// This fixture puts the node in exactly that regime: it is fed through a large
// series inductance and nothing else, so G_node = dt/(2L) = 2.5e-4 S against
// the load's G_z = 0.035 S, a gain of ~140. Injected, it reaches NaN; stamped,
// it is an ordinary passive branch and cannot. Found on the Spain study, where
// the giveaway was that the run blew up after the same ~4 STEPS at every
// timestep from 20 us to 1 ms — a physical instability has a time constant in
// seconds and blows up at the same ABSOLUTE time whatever the timestep.
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.01}},
  {id:2,type:'rlc',x:0,y:0,params:{R:0.05,L:100,C:-1}},
  {id:3,type:'zip',x:0,y:0,params:{P:8,Q:3,V0:277,az:1,ai:0,ap:0,bz:1,bi:0,bp:0,f:60,Tf:20,vmin:0}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,0],b:[4,0]},{a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[5,0]});
 const r=simulate(3,200,null,50,50);
 if(r.err){console.log('zip stamped-Z: solver error:',r.err,'FAIL');process.exit(1);}
 const zi=r.curMeta.findIndex(m=>m.kind==='zip');
 const srcPk=277*Math.SQRT2;
 let peak=0, nan=false;
 for(let ph=0;ph<3;ph++) for(const v of r.bv[zi][ph]){ if(!isFinite(v)){nan=true;break;} peak=Math.max(peak,Math.abs(v)); }
 // Bounded by the source it hangs off: anything past a few pu is the loop.
 const ok = !nan && peak < 3*srcPk;
 console.log('zip stamped-Z: peak |v|',nan?'NaN':peak.toFixed(1),'V vs source peak',srcPk.toFixed(1),
   'V (gain G_z/G_node ~140; injected-Z reaches NaN here)',ok?'PASS':'FAIL');
 record('zip','constant-Z part is stamped, so a high G_z/G_node node stays bounded', ok);
}

// ---- overcurrent relay (50/51, IEEE C37.112): timed trip vs the closed-
// form curve at steady M, instantaneous element, below-pickup hold, and
// the brkId validation error (SPEC section 2). ----
{
 const build=(relayParams)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:1}},
   {id:3,type:'relay',x:0,y:0,params:Object.assign({Ipu:13.85,curve:'VI',TD:0.3,Iinst:0,brkId:2,f:60},relayParams)},
   {id:4,type:'rlc',x:0,y:0,params:{R:3.5,L:-1,C:-1}},
   {id:5,type:'gnd',x:0,y:0,params:{}},
   {id:6,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[1,0],b:[5,0]},{a:[4,1],b:[6,0]});
 };
 // steady M: Irms = 277/(0.5+3.5) = 69.25 A, Ipu=13.85 -> M = 5.0
 // VI curve: t = TD*(19.61/(M^2-1)+0.491) = 0.3*1.3081 = 392.4 ms
 const tExp=0.3*(19.61/24+0.491)*1000;
 build({});
 const r=simulate(3,600,null,50,0);
 if(r.err){console.log('relay: solver error:',r.err,'FAIL');process.exit(1);}
 const ri=r.curMeta.findIndex(m=>m.kind==='relay'), bi=r.curMeta.findIndex(m=>m.kind==='brk');
 const tTrip=r.t[r.aux[ri].findIndex(v=>v>=1)];
 let tClear=0; r.t.forEach((tv,k)=>{ if(Math.abs(r.ic[bi][0][k])>1) tClear=tv; });
 const okTrip=tTrip>=tExp-8&&tTrip<=tExp+33, okClear=tClear>=tTrip&&tClear<=tTrip+9;
 console.log('relay 51 timed trip at',tTrip.toFixed(1),'ms vs curve',tExp.toFixed(1),'ms (window/zero-crossing slop allowed)',okTrip?'PASS':'FAIL');
 console.log('relay pole cleared at current zero',tClear.toFixed(1),'ms (<=8.3ms after trip)',okClear?'PASS':'FAIL');

 build({Iinst:30}); // 50 element: 69 A > 30 A -> trip inside ~2 cycles
 const r2=simulate(3,200,null,50,0);
 const ri2=r2.curMeta.findIndex(m=>m.kind==='relay'), bi2=r2.curMeta.findIndex(m=>m.kind==='brk');
 const tTrip2=r2.t[r2.aux[ri2].findIndex(v=>v>=1)];
 let tClear2=0; r2.t.forEach((tv,k)=>{ if(Math.abs(r2.ic[bi2][0][k])>1) tClear2=tv; });
 const ok50=tTrip2!==undefined&&tTrip2<35&&tClear2<45;
 console.log('relay 50 instantaneous: trip',(tTrip2===undefined?'never':tTrip2.toFixed(1)+'ms')+', cleared',tClear2.toFixed(1)+'ms (both <2-3 cycles)',ok50?'PASS':'FAIL');

 build({Ipu:100}); // M = 0.69 -> must hold
 const r3=simulate(3,300,null,50,0);
 const ri3=r3.curMeta.findIndex(m=>m.kind==='relay'), bi3=r3.curMeta.findIndex(m=>m.kind==='brk');
 const fracEnd=r3.aux[ri3][r3.aux[ri3].length-1];
 const stillOn=Math.abs(r3.ic[bi3][0][r3.ic[bi3][0].length-2])>1||Math.abs(r3.ic[bi3][0][r3.ic[bi3][0].length-1])>1;
 const okHold=fracEnd===0&&stillOn;
 console.log('relay below pickup (M=0.69): trip integral',fracEnd,', breaker still conducting',stillOn,okHold?'PASS':'FAIL');

 build({brkId:99}); // validation: nonexistent breaker id must be a clear error
 const r4=simulate(3,60,null,50,0);
 const okErr=!!(r4.err&&/Relay #3/.test(r4.err));
 console.log('relay bad brkId -> validation error:',okErr?'PASS':'FAIL',r4.err||'(no error!)');
 record('relay','50/51: timed trip + instantaneous + hold + bad-brkId error', okTrip&&okClear&&ok50&&okHold&&okErr);
}

// ---- distance / line-protection relay (`zrel`): the apparent impedance it
// measures must be the real ohms of the downstream network (this is what
// catches a peak-vs-RMS scaling slip between the V and I correlators, which
// shows up as a clean sqrt(2) error), a fault inside zone 1 must trip the
// target breaker, and one outside every reachable zone must not.
// Circuit: src(Rs=0.5) - brk#2 - zrel#3 - line#4 - load#5 - gnd, with the
// fault applied at the FAR end of the line (the relay's reach point).
// Line: R = 0.6078, L = 9.1435 mH -> Z = 3.5 ohm at 80 deg (60 Hz).
{
 const RL=0.6078, LmH=9.1435, RLOAD=20;
 const XL=2*Math.PI*60*LmH*1e-3;
 // Apparent impedance the relay should see: line in series with (Rf || load).
 const Zexp=(Rf)=>{ const Rp = Rf>0 ? (Rf*RLOAD)/(Rf+RLOAD) : RLOAD; return Math.hypot(RL+Rp, XL); };
 const build=(Rf,params)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:1}},
   {id:3,type:'zrel',x:0,y:0,params:Object.assign({Z1:5,T1:0,Z2:10,T2:200,Z3:20,T3:400,theta:80,mode:'mho',Imin:0,tarm:0,brkId:2,f:60},params)},
   {id:4,type:'rlc',x:0,y:0,params:{R:RL,L:LmH,C:-1}},
   {id:5,type:'rlc',x:0,y:0,params:{R:RLOAD,L:-1,C:-1}},
   {id:6,type:'gnd',x:0,y:0,params:{}},
   {id:7,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,0]},{a:[1,0],b:[6,0]},{a:[5,1],b:[7,0]});
  if(Rf>0){ S.blocks.push({id:8,type:'fault',x:0,y:0,params:{Rf:Rf,ton:30,toff:-1,ph:0}}); S.wires.push({a:[8,0],b:[4,1]}); }
 };
 const run=(Rf,params)=>{
  build(Rf,params);
  const r=simulate(3,200,null,50,0);
  if(r.err) return {err:r.err};
  const zi=r.curMeta.findIndex(m=>m.kind==='zrel');
  const bi=r.curMeta.map((m,k)=>[m,k]).find(o=>o[0].kind==='brk'&&o[0].id===2)[1];
  const n=r.t.length;
  const Zend=r.aux[zi].slice(n-5).reduce((a,b)=>a+b,0)/5;
  let tClear=0; r.t.forEach((tv,k)=>{ if(Math.abs(r.ic[bi][0][k])>1) tClear=tv; });
  return {Z:Zend, tClear, tEnd:r.t[n-1]};
 };

 // 1. Healthy load. Z = 20.894 ohm at 9.5 deg, far outside the 5 ohm zone-1
 //    mho circle (center 2.5 at 80 deg, radius 2.5) -> no trip.
 const a=run(0,{});
 if(a.err){console.log('zrel healthy: solver error:',a.err,'FAIL');process.exit(1);}
 const eA=Zexp(0), errA=Math.abs(a.Z-eA)/eA*100;
 const heldA=a.tClear>=a.tEnd-1;
 console.log('zrel healthy load: |Z| =',a.Z.toFixed(3),'vs',eA.toFixed(3),'ohm ('+errA.toFixed(2)+'%), breaker held',heldA);
 const okZ=errA<2, okHold=heldA;

 // 2. Rf = 0.2 at the reach point: Z = 3.54 ohm at 77 deg, inside zone 1
 //    (T1 = 0) -> trip within a cycle of the 30 ms fault, pole clears at the
 //    next current zero (<= 8.3 ms later).
 const b=run(0.2,{});
 if(b.err){console.log('zrel zone-1 fault: solver error:',b.err,'FAIL');process.exit(1);}
 console.log('zrel zone-1 fault (|Z| ->',Zexp(0.2).toFixed(2),'ohm): breaker cleared at',b.tClear.toFixed(1),'ms (fault 30 ms, expect 30-60)');
 const okTrip=b.tClear>30&&b.tClear<60;

 // 3. Rf = 10: Z = 8.05 ohm at 25 deg. Outside zone 1 and outside zone 2
 //    (center 5 at 80 deg, radius 5); inside zone 3 but T3 = 400 ms > the
 //    200 ms run, so the breaker must still be closed at the end AND the
 //    measured impedance must be right.
 const c=run(10,{});
 if(c.err){console.log('zrel resistive fault: solver error:',c.err,'FAIL');process.exit(1);}
 const eC=Zexp(10), errC=Math.abs(c.Z-eC)/eC*100;
 const heldC=c.tClear>=c.tEnd-1;
 console.log('zrel resistive fault: |Z| =',c.Z.toFixed(3),'vs',eC.toFixed(3),'ohm ('+errC.toFixed(2)+'%), breaker held',heldC);
 const okZ2=errC<2, okRemote=heldC;

 // 4. Start-up regression: a relay must not trip on its own first look at a
 //    healthy line. The correlator frame has to keep turning while the
 //    one-cycle window fills, or the first sample after the fill is 0/0 and a
 //    garbage Z near the origin sits deep inside every mho circle. Tight
 //    reaches (1/1.5/2 ohm) against a 20.9 ohm load make that failure loud:
 //    nothing legitimate can reach these zones, so any trip is the bug.
 const d=run(0,{Z1:1,Z2:1.5,Z3:2});
 if(d.err){console.log('zrel start-up: solver error:',d.err,'FAIL');process.exit(1);}
 const okStart=d.tClear>=d.tEnd-1;
 console.log('zrel start-up with tight reaches (1/1.5/2 ohm, load 20.9 ohm): breaker held',okStart);

 // 5. Validation: a nonexistent target breaker must produce a clear error.
 build(0,{brkId:99});
 const e=simulate(3,60,null,50,0);
 const okErr=!!(e.err&&/Distance relay #3/.test(e.err));
 console.log('zrel bad brkId -> validation error:',okErr?'PASS':'FAIL',e.err||'(no error!)');

 // 6. Validation: a 3-ph-only element must refuse a 1-ph run.
 build(0,{});
 const f=simulate(1,60,null,50,0);
 const okPh=!!(f.err&&/Distance relay #3/.test(f.err)&&/3-phase/.test(f.err));
 console.log('zrel in 1-ph mode -> validation error:',okPh?'PASS':'FAIL',f.err||'(no error!)');

 record('zrel','apparent-Z accuracy, mho zone-1 trip, out-of-reach hold, start-up hold, validation',
   okZ&&okHold&&okTrip&&okZ2&&okRemote&&okStart&&okErr&&okPh);
}

// ---- zrel out-of-step (double-blinder): two sources 0.5 Hz apart slip against
// each other continuously, which is the condition distance ZONES cannot see (a
// separation swing is a resistive excursion and a mho circle set at the line
// angle has almost no resistive coverage). The blinder scheme discriminates on
// TRANSIT TIME: a swing walks the locus from the outer blinder to the inner one
// over tens of ms, a fault steps across in one sample.
// srcA(60 Hz) - brk#2 - zrel#3 - rlc#4 (1 ohm + 10 mH) - srcB. Zone reaches are
// deliberately unreachable (0.3/0.4/0.5 ohm) so ONLY the OOS element can trip.
{
 const build=(fB,VB,oos,withFault)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:1}},
   {id:3,type:'zrel',x:0,y:0,params:{Z1:0.3,T1:0,Z2:0.4,T2:500,Z3:0.5,T3:900,
      theta:62,mode:'mho',Imin:0,tarm:0,oos:oos,RB1:3,RB2:8,Tsw:50,brkId:2,f:60}},
   {id:4,type:'rlc',x:0,y:0,params:{R:1,L:10,C:-1}},
   {id:5,type:'src',x:0,y:0,params:{Vrms:VB,f:fB,Rs:0.5}},
   {id:6,type:'gnd',x:0,y:0,params:{}},
   {id:7,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,1]},
    {a:[1,0],b:[6,0]},{a:[5,0],b:[7,0]});
  if(withFault){ S.blocks.push({id:8,type:'fault',x:0,y:0,params:{Rf:0.2,ton:300,toff:-1,ph:0}});
    S.wires.push({a:[8,0],b:[3,1]}); }
 };
 const openAt=(Tms)=>{
  const r=simulate(3,Tms,null,50,0);
  if(r.err) return {err:r.err};
  const i=r.curMeta.findIndex(m=>m.kind==='brk');
  let last=-1, ever=false;
  r.t.forEach((tv,k)=>{ const c=Math.abs(r.ic[i][0][k]); if(c>2){last=tv;ever=true;} });
  return {open:(ever&&last<r.t[r.t.length-1]-2)?last:-1, ever};
 };

 // Slipping, OOS off: the zones cannot see the swing, so nothing may trip.
 // This is the negative control that makes the two below mean something.
 build(60.5,277,0,false);
 const off=openAt(2500);
 if(off.err){console.log('zrel OOS off: solver error:',off.err,'FAIL');process.exit(1);}
 console.log('zrel OOS off, slipping: breaker',off.open<0?'held (zones cannot see a swing)':'OPENED at '+off.open.toFixed(0)+'ms');
 const okOff=off.open<0&&off.ever;

 // Slipping, trip on the way OUT: the slip period is 2 s, so the trip lands
 // late in the first slip, after the locus has crossed and is leaving.
 build(60.5,277,1,false);
 const out=openAt(2500);
 if(out.err){console.log('zrel OOS way-out: solver error:',out.err,'FAIL');process.exit(1);}
 console.log('zrel OOS trip-on-way-out: breaker opened at',out.open<0?'never':out.open.toFixed(0)+'ms','(expect 1500-2200, late in the 2 s slip)');
 const okOut=out.open>1500&&out.open<2200;

 // Same slip, trip on the way IN: must fire strictly earlier than way-out.
 build(60.5,277,2,false);
 const inn=openAt(2500);
 if(inn.err){console.log('zrel OOS way-in: solver error:',inn.err,'FAIL');process.exit(1);}
 console.log('zrel OOS trip-on-way-in: breaker opened at',inn.open<0?'never':inn.open.toFixed(0)+'ms','(expect earlier than way-out)');
 const okIn=inn.open>0&&inn.open<out.open;

 // Steady load flow (both 60 Hz, 277 vs 230 V so real current flows) with the
 // OOS element armed: no slip, so it must hold.
 build(60,230,1,false);
 const st=openAt(2500);
 if(st.err){console.log('zrel OOS steady: solver error:',st.err,'FAIL');process.exit(1);}
 console.log('zrel OOS steady load, armed: breaker',st.open<0?'held':'OPENED at '+st.open.toFixed(0)+'ms','(carrying current:',st.ever+')');
 const okSteady=st.open<0&&st.ever;

 // A FAULT steps the impedance inside the blinders in one sample. Transit time
 // is far below Tsw, so it must NOT be declared a swing (the zones are set
 // unreachable here, so a trip could only come from the OOS element).
 build(60,277,1,true);
 const flt=openAt(1200);
 if(flt.err){console.log('zrel OOS fault: solver error:',flt.err,'FAIL');process.exit(1);}
 console.log('zrel OOS fault-not-swing: breaker',flt.open<0?'held (fault transit < Tsw)':'OPENED at '+flt.open.toFixed(0)+'ms');
 const okFault=flt.open<0;

 // Validation: the blinders are an ordered pair.
 build(60.5,277,1,false);
 S.blocks.find(b=>b.type==='zrel').params.RB1=0;
 S.blocks.find(b=>b.type==='zrel').params.RB2=0;
 const ve=simulate(3,100,null,50,0);
 const okErr2=!!(ve.err&&/Distance relay #3/.test(ve.err)&&/RB2 > RB1/.test(ve.err));
 console.log('zrel OOS bad blinders -> validation error:',okErr2?'PASS':'FAIL',ve.err||'(no error!)');

 record('zrel-oos','double-blinder: way-out/way-in trip on a real slip, hold on load, fault is not a swing, validation',
   okOff&&okOut&&okIn&&okSteady&&okFault&&okErr2);
}

// ---- node frequency at probes and buses. Machines already report f (syncgen
// rotor, gfl/gtrip PLL), but NETWORK frequency had no reading of its own: the
// only way to get it at a bus was to hang a threshold-free gtrip there as a
// sensor. Every probe and bus on a 3-ph AC node now carries an SRF-PLL.
{
 const build=(fsrc,nphWanted)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:fsrc,Rs:0.5}},
   {id:2,type:'bus',x:0,y:0,params:{name:'B1',taps:4,len:200,Vbase:480,Vhi:0,Vlo:0,area:0,zone:0,owner:0}},
   {id:3,type:'rlc',x:0,y:0,params:{R:10,L:20,C:-1}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'gnd',x:0,y:0,params:{}},
   {id:6,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[1,0],b:[5,0]},{a:[6,0],b:[2,2]});
  return nphWanted;
 };
 const fOf=(r,id)=>{
  const pi=r.probeMeta.findIndex(m=>m.id===id);
  if(pi<0) return {err:'no probe meta'};
  return {hasF:!!r.probeMeta[pi].hasF, ser:r.fp?r.fp[pi]:null};
 };
 // 1. Steady 60 Hz: both the bus and the probe must read 60.000, and the
 //    reading must be the SAME on both (one node, one frequency).
 build(60,3);
 const r1=simulate(3,600,null,50,0);
 if(r1.err){console.log('probe f: solver error:',r1.err,'FAIL');process.exit(1);}
 const b1=fOf(r1,2), p1=fOf(r1,6);
 const tail=s=>s.slice(-20).reduce((a,b)=>a+b,0)/20;
 const fb=tail(b1.ser), fpv=tail(p1.ser);
 console.log('node f @60Hz: bus',fb.toFixed(4),'Hz, probe',fpv.toFixed(4),'Hz (expect 60.0000)');
 const ok60=Math.abs(fb-60)<0.01&&Math.abs(fpv-60)<0.01&&Math.abs(fb-fpv)<1e-6;

 // 2. A different source frequency must actually be TRACKED, not assumed:
 //    50 Hz must read 50, not the 60 the PLL was seeded at.
 build(50,3);
 const r2=simulate(3,600,null,50,0);
 if(r2.err){console.log('probe f 50Hz: solver error:',r2.err,'FAIL');process.exit(1);}
 const f50=tail(fOf(r2,2).ser);
 console.log('node f @50Hz: bus',f50.toFixed(4),'Hz (expect 50.0000, seeded from the src)');
 const ok50=Math.abs(f50-50)<0.01;

 // 3. An off-nominal source the PLL must pull to: nominal comes from the src
 //    block, so drive 59.2 Hz and confirm the loop converges there.
 build(59.2,3);
 const r3=simulate(3,600,null,50,0);
 if(r3.err){console.log('probe f 59.2: solver error:',r3.err,'FAIL');process.exit(1);}
 const f592=tail(fOf(r3,2).ser);
 console.log('node f @59.2Hz: bus',f592.toFixed(4),'Hz (expect 59.2000)');
 const okOff=Math.abs(f592-59.2)<0.02;

 // 4. 1-ph run: a positive-sequence PLL needs three phases, so there must be
 //    NO frequency series rather than a misleading flat 60.
 build(60,1);
 const r4=simulate(1,200,null,50,0);
 if(r4.err){console.log('probe f 1-ph: solver error:',r4.err,'FAIL');process.exit(1);}
 const b4=fOf(r4,2);
 console.log('node f in 1-ph mode: hasF =',b4.hasF,'series =',b4.ser===null?'null':'present','(expect false/null)');
 const ok1ph=b4.hasF===false&&b4.ser===null;

 record('probe-f','node frequency at probes/buses: tracks 60/50/59.2 Hz, bus==probe, absent in 1-ph',
   ok60&&ok50&&okOff&&ok1ph);
}

// ---- vector-group transformer (xfmr3): Dy11 magnitude + 30 deg lead, Yy0
// regression, SLG zero-sequence blocking through the delta, ungrounded-wye
// fault suppression, and the positive-sequence PF ratio (SPEC section 2). ----
{
 const build=(conn,Rn2,withFault)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  // V1/V2 are line-line nameplate voltages; the winding ratio a = (V1/V2)*(k2/k1)
  // with k = sqrt3 for a wye side, 1 for a delta side. Derive V1/V2 from conn so
  // the internal winding ratio stays a = 2 for every connection tested.
  const k1 = conn[0]==='Y'?Math.sqrt(3):1, k2 = conn[1]==='y'?Math.sqrt(3):1;
  const V1 = 2*120*k1/k2, V2 = 120; // a = (V1/V2)*(k2/k1) = 2
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.05}},
   {id:2,type:'xfmr3',x:0,y:0,params:{conn,V1,V2,R:0.05,L:0.3,Rn1:0,Rn2}},
   {id:3,type:'rlc',x:0,y:0,params:{R:100,L:-1,C:-1}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'gnd',x:0,y:0,params:{}},
   {id:6,type:'probe',x:0,y:0,params:{}},
   {id:7,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]},{a:[6,0],b:[2,0]},{a:[7,0],b:[2,1]});
  if(withFault){ S.blocks.push({id:8,type:'fault',x:0,y:0,params:{Rf:0.5,ton:60,toff:-1,ph:1}}); S.wires.push({a:[8,0],b:[2,1]}); }
 };
 const phasorOf=(r,pi,ph)=>{ const w=2*Math.PI*60; const tEnd=r.t[r.t.length-1]; let re=0,im=0,n=0;
  for(let k=0;k<r.t.length;k++){ if(r.t[k]<tEnd-50)continue; const th=w*r.t[k]*1e-3;
   re+=r.vp[pi][ph][k]*Math.sin(th); im+=r.vp[pi][ph][k]*Math.cos(th); n++; }
  return {m:Math.hypot(2*re/n,2*im/n), a:Math.atan2(2*im/n,2*re/n)*180/Math.PI}; };
 const wrap=d=>{ while(d>180)d-=360; while(d<=-180)d+=360; return d; };

 build('Dy11',0,false);
 const r=simulate(3,200,null,50,0);
 if(r.err){console.log('xfmr3: solver error:',r.err,'FAIL');process.exit(1);}
 const p1=phasorOf(r,0,0), p2=phasorOf(r,1,0);
 const ratio=p2.m/p1.m, ratioExp=Math.sqrt(3)/2; // sqrt3*V1/a per SPEC (winding-ratio semantics)
 const shift=wrap(p2.a-p1.a);
 const eR=Math.abs(ratio-ratioExp)/ratioExp*100, eA=Math.abs(shift-30);
 console.log('xfmr3 Dy11 |V2|/|V1| =',ratio.toFixed(4),'vs sqrt3/a =',ratioExp.toFixed(4),'('+eR.toFixed(2)+'%)',eR<1?'PASS':'FAIL');
 console.log('xfmr3 Dy11 secondary leads by',shift.toFixed(2),'deg (expect +30)',eA<1.5?'PASS':'FAIL');

 build('Yy0',0,false);
 const rY=simulate(3,200,null,50,0);
 const q1=phasorOf(rY,0,0), q2=phasorOf(rY,1,0);
 const rYr=q2.m/q1.m, rYs=wrap(q2.a-q1.a);
 const eYr=Math.abs(rYr-0.5)/0.5*100, eYs=Math.abs(rYs);
 console.log('xfmr3 Yy0 |V2|/|V1| =',rYr.toFixed(4),'vs 1/a = 0.5 ('+eYr.toFixed(2)+'%), shift',rYs.toFixed(2),'deg (expect 0)',(eYr<1&&eYs<1.5)?'PASS':'FAIL');

 build('Dy11',0,true); // SLG on grounded-wye secondary: delta must block zero-seq from the source lines
 const rF=simulate(3,300,null,50,0);
 const si=rF.curMeta.findIndex(m=>m.type==='src'), fi=rF.curMeta.findIndex(m=>m.type==='fault');
 let zMax=0,aMax=0,ifMax=0;
 rF.t.forEach((tv,k)=>{ if(tv<150)return;
  const s0=rF.ic[si][0][k]+rF.ic[si][1][k]+rF.ic[si][2][k];
  zMax=Math.max(zMax,Math.abs(s0)); aMax=Math.max(aMax,Math.abs(rF.ic[si][0][k]));
  ifMax=Math.max(ifMax,Math.abs(rF.ic[fi][0][k])); });
 const zRatio=zMax/aMax;
 console.log('xfmr3 SLG behind Dy11: source zero-seq ratio',(zRatio*100).toFixed(3)+'% (delta blocks, <2%)',zRatio<0.02?'PASS':'FAIL','fault I peak',ifMax.toFixed(1),'A');

 build('Dy11',-1,true); // ungrounded wye secondary: no zero-seq return path, SLG current collapses
 const rU=simulate(3,300,null,50,0);
 const fu=rU.curMeta.findIndex(m=>m.type==='fault');
 let ifU=0; rU.t.forEach((tv,k)=>{ if(tv<150)return; ifU=Math.max(ifU,Math.abs(rU.ic[fu][0][k])); });
 const supp=ifMax/Math.max(ifU,1e-9);
 console.log('xfmr3 SLG on UNGROUNDED wye: fault I',ifU.toFixed(3),'A vs grounded',ifMax.toFixed(1),'A (suppression x'+supp.toFixed(0)+', expect >50x)',supp>50?'PASS':'FAIL');

 build('Dy11',0,false); // power flow through the complex-ratio stamp
 S.blocks.push({id:9,type:'bus',x:0,y:0,params:{name:'sec',taps:2,len:80}});
 S.wires.push({a:[9,0],b:[2,1]});
 const pfr=solvePowerFlow();
 const busV=pfr.busBlocks&&pfr.busBlocks.length?pfr.busBlocks[0].Vmag:0;
 const pfExp=Math.sqrt(3)*277/2;
 const ePF=Math.abs(busV-pfExp)/pfExp*100;
 console.log('xfmr3 PF |V2| =',busV.toFixed(1),'V vs',pfExp.toFixed(1),'V ('+ePF.toFixed(2)+'%), converged',pfr.converged,(pfr.converged&&ePF<2)?'PASS':'FAIL');

 record('xfmr3','Dy11 ratio+shift, Yy0, delta zero-seq block, U-wye suppress, PF', !(eR>=1||eA>=1.5||eYr>=1||eYs>=1.5||zRatio>=0.02||supp<=50||!pfr.converged||ePF>=2));
}

// ---- xfmr3/xfmr3w linear magnetizing shunt (Lm, PSS/E MAG2): open secondary,
// stiff Yy0 primary. The only primary current is the magnetizing current
// I = V_LN/(w*Lm); the leakage and Rs drops are negligible. This is the
// analytical oracle for the makeXfmr3s/makeXfmr3ws Lm shunt and the buildYbus
// +j/(w*Lm) stamp. Lm=0 is byte-identical to today (covered by the 95 checks). ----
{
 const w=2*Math.PI*60, Lm=0.1; // 100 mH
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.05}},
  {id:2,type:'xfmr3',x:0,y:0,params:{conn:'Yy0',V1:480,V2:240,R:0.05,L:0.3,Rn1:0,Rn2:0,Lm:Lm*1000}},
  {id:3,type:'gnd',x:0,y:0,params:{}},
  {id:4,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[4,0],b:[2,1]}); // open secondary, just a probe
 const rM=simulate(3,200,null,50,0);
 if(rM.err){console.log('xfmr3 Lm: solver error:',rM.err,'FAIL');process.exit(1);}
 const si=rM.curMeta.findIndex(m=>m.type==='src');
 const tEnd=rM.t[rM.t.length-1];
 // A pure-L magnetizing branch energized cold carries an undamped DC flux offset
 // (physical inrush) that the source/leakage resistance only slowly decays. The
 // settled AC magnetizing current is the oracle: Iac_rms = V_LN/(w*Lm). Remove
 // the per-cycle DC before RMS so the offset does not contaminate the check.
 let s=0,n=0; for(let k=0;k<rM.t.length;k++){ if(rM.t[k]<tEnd-50)continue; s+=rM.ic[si][0][k]; n++; }
 const dc=s/n; let vs=0; for(let k=0;k<rM.t.length;k++){ if(rM.t[k]<tEnd-50)continue; const d=rM.ic[si][0][k]-dc; vs+=d*d; }
 const iRms=Math.sqrt(vs/n), iExp=277/(w*Lm), eM=Math.abs(iRms-iExp)/iExp*100;
 console.log('xfmr3 Lm magnetizing Iac =',iRms.toFixed(3),'A vs V_LN/(wLm) =',iExp.toFixed(3),'A ('+eM.toFixed(2)+'%)',eM<3?'PASS':'FAIL');
 // same check on xfmr3w: primary is side 0 (always Y), open secondaries.
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.05}},
  {id:2,type:'xfmr3w',x:0,y:0,params:{conn:'Yy0y0',V1:480,V2:240,V3:120,R1:0.05,L1:0.3,R2:0.05,L2:0.3,R3:0.05,L3:0.3,Rn1:0,Rn2:0,Rn3:0,Lm:Lm*1000}},
  {id:3,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'probe',x:0,y:0,params:{}},
  {id:6,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[5,0],b:[2,1]},{a:[6,0],b:[2,2]});
 const rW=simulate(3,200,null,50,0);
 if(rW.err){console.log('xfmr3w Lm: solver error:',rW.err,'FAIL');process.exit(1);}
 const siW=rW.curMeta.findIndex(m=>m.type==='src');
 const tEndW=rW.t[rW.t.length-1];
 let sW=0,nW=0; for(let k=0;k<rW.t.length;k++){ if(rW.t[k]<tEndW-50)continue; sW+=rW.ic[siW][0][k]; nW++; }
 const dcW=sW/nW; let vsW=0; for(let k=0;k<rW.t.length;k++){ if(rW.t[k]<tEndW-50)continue; const d=rW.ic[siW][0][k]-dcW; vsW+=d*d; }
 const iRmsW=Math.sqrt(vsW/nW), eW=Math.abs(iRmsW-iExp)/iExp*100;
 console.log('xfmr3w Lm magnetizing Iac =',iRmsW.toFixed(3),'A vs',iExp.toFixed(3),'A ('+eW.toFixed(2)+'%)',eW<3?'PASS':'FAIL');
 record('xfmr3','linear magnetizing shunt Lm: open-secondary I = V_LN/(wLm)', !(eM>=3||eW>=3));
}

// ---- switched-shunt controller (vsw): sagging feeder closes the cap bank
// after the dwell delay and lands at the analytically predicted compensated
// voltage; healthy feeder never closes (SPEC section 2). ----
{
 const build=(Rload)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'line',x:0,y:0,params:{R:0.3,L:15,Rm:0,Lm:0,C:0}},
   {id:3,type:'rlc',x:0,y:0,params:{R:Rload,L:-1,C:-1}},
   {id:4,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:0}},
   {id:5,type:'cap',x:0,y:0,params:{C:50}},
   {id:6,type:'vsw',x:0,y:0,params:{brkId:4,mode:0,Von:250,Voff:280,Td:50,f:60}},
   {id:7,type:'gnd',x:0,y:0,params:{}},
   {id:8,type:'gnd',x:0,y:0,params:{}},
   {id:9,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[8,0]},{a:[1,0],b:[7,0]},
   {a:[2,1],b:[4,0]},{a:[4,1],b:[5,0]},{a:[5,1],b:[8,0]},{a:[6,0],b:[2,1]},{a:[9,0],b:[2,1]});
 };
 // analytical: Zs = Rs+Rl + jwL; V2 = E*Zp/(Zs+Zp), Zp = R || 1/(jwC) when bank in
 const w=2*Math.PI*60, E=277, Zs={re:0.8,im:w*15e-3};
 const cM2=(a,b2)=>({re:a.re*b2.re-a.im*b2.im,im:a.re*b2.im+a.im*b2.re});
 const cD2=(a,b2)=>{const d=b2.re*b2.re+b2.im*b2.im;return{re:(a.re*b2.re+a.im*b2.im)/d,im:(a.im*b2.re-a.re*b2.im)/d};};
 const cAdd2=(a,b2)=>({re:a.re+b2.re,im:a.im+b2.im});
 const mag2=a=>Math.hypot(a.re,a.im);
 const vDiv=(R,withC)=>{ let Zp={re:R,im:0};
  if(withC){ const Yc={re:1/R,im:w*50e-6}; Zp=cD2({re:1,im:0},Yc); }
  return E*mag2(cD2(Zp,cAdd2(Zs,Zp))); };
 build(12); // sagged feeder: ~243 V < Von
 const r=simulate(3,400,null,50,0);
 if(r.err){console.log('vsw: solver error:',r.err,'FAIL');process.exit(1);}
 const vi=r.curMeta.findIndex(m=>m.kind==='vsw'), bi=r.curMeta.findIndex(m=>m.kind==='brk');
 const tClose=r.t[r.aux[vi].findIndex(v=>v>=1)];
 const rmsTail=(sig)=>{ const tEnd=r.t[r.t.length-1]; let s=0,n=0;
  r.t.forEach((tv,k)=>{ if(tv<tEnd-50)return; s+=sig[k]*sig[k]; n++; }); return Math.sqrt(s/n); };
 const vRmsEnd=rmsTail(r.vp[0][0]);
 const vSagExp=vDiv(12,false), vCompExp=vDiv(12,true);
 const eComp=Math.abs(vRmsEnd-vCompExp/1)/vCompExp*100;
 const okT=tClose>=60&&tClose<=110; // ~1 cycle RMS settle + 50 ms dwell + margin
 const bankConducts=Math.abs(r.ic[bi][0][r.ic[bi][0].length-2])>0.5||Math.abs(r.ic[bi][0][r.ic[bi][0].length-1])>0.5;
 console.log('vsw sag: predicted',vSagExp.toFixed(1),'V < Von, bank closed at',(tClose||-1).toFixed(1),'ms (expect ~66-110)',okT?'PASS':'FAIL');
 console.log('vsw compensated Vrms',vRmsEnd.toFixed(1),'V vs analytical',vCompExp.toFixed(1),'V ('+eComp.toFixed(2)+'%), bank conducting',bankConducts,(eComp<2&&bankConducts)?'PASS':'FAIL');
 build(40); // healthy feeder: ~271 V > Von -> must never close
 const r2=simulate(3,300,null,50,0);
 const vi2=r2.curMeta.findIndex(m=>m.kind==='vsw');
 const closed2=r2.aux[vi2].some(v=>v>=1);
 console.log('vsw healthy feeder (~'+vDiv(40,false).toFixed(0)+' V): bank stayed open',!closed2?'PASS':'FAIL');
 record('vsw','sag closes bank at predicted V; healthy holds off', okT&&eComp<2&&bankConducts&&!closed2);
}

// ---- surge arrester (mov): sub-knee leakage only; above the knee the
// clamped peak matches the source/arrester divider analytically. ----
{
 const build=(Vrms)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms,f:60,Rs:0.5}},
   {id:2,type:'mov',x:0,y:0,params:{Vc:450,Rd:5}},
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[4,0],b:[2,0]});
 };
 build(277); // 392 V peak < 450 V knee: leakage only
 const r=simulate(3,100,null,50,0);
 if(r.err){console.log('mov: solver error:',r.err,'FAIL');process.exit(1);}
 const mi=r.curMeta.findIndex(m=>m.kind==='mov');
 const iMax=Math.max(...r.ic[mi][0].map(Math.abs));
 console.log('mov below knee: peak |i| =',iMax.toExponential(2),'A (leakage only, <1e-4)',iMax<1e-4?'PASS':'FAIL');

 build(400); // 565.7 V peak > knee: clamp divider
 const r2=simulate(3,100,null,50,0);
 const mi2=r2.curMeta.findIndex(m=>m.kind==='mov');
 const tail=r2.t.map((_,i)=>i).filter(i=>r2.t[i]>50);
 const vPk=Math.max(...tail.map(i=>Math.abs(r2.vp[0][0][i])));
 const iPk=Math.max(...tail.map(i=>Math.abs(r2.ic[mi2][0][i])));
 const Vs=400*Math.SQRT2, vExp=(Vs/0.5+450/5)/(1/0.5+1/5), iExp=(vExp-450)/5;
 const eV=Math.abs(vPk-vExp)/vExp*100, eI=Math.abs(iPk-iExp)/iExp*100;
 console.log('mov clamp: peak V',vPk.toFixed(1),'vs divider',vExp.toFixed(1),'('+eV.toFixed(2)+'%)',eV<1?'PASS':'FAIL');
 console.log('mov clamp: peak I',iPk.toFixed(2),'vs (v-Vc)/Rd',iExp.toFixed(2),'A ('+eI.toFixed(2)+'%)',eI<2?'PASS':'FAIL');
 record('mov','sub-knee leakage + clamp divider (V, I)', !(iMax>=1e-4||eV>=1||eI>=2));
}

// ---- Bergeron traveling-wave line (tline): open-end doubling exactly one
// travel time after energization; matched load passes the wave with unit
// gain and pure delay (SPEC section 2). ----
{
 const build=(loadR)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'tline',x:0,y:0,params:{Z:300,tau:1000,R:0}},
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'probe',x:0,y:0,params:{}},
   {id:5,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[4,0],b:[2,0]},{a:[5,0],b:[2,1]});
  if(loadR>0){ S.blocks.push({id:6,type:'rlc',x:0,y:0,params:{R:loadR,L:-1,C:-1}},{id:7,type:'gnd',x:0,y:0,params:{}});
   S.wires.push({a:[2,1],b:[6,0]},{a:[6,1],b:[7,0]}); }
 };
 build(0); // open end
 const r=simulate(3,4,null,50,0); // 4 ms, tau = 1 ms, all samples kept
 if(r.err){console.log('tline: solver error:',r.err,'FAIL');process.exit(1);}
 const v1=r.vp[0][0], v2=r.vp[1][0], tArr=r.t;
 const dtOut=tArr[1]-tArr[0], dTau=Math.round(1/dtOut); // samples per tau
 let preMax=0; tArr.forEach((tv,k)=>{ if(tv<0.99) preMax=Math.max(preMax,Math.abs(v2[k])); });
 let err2=0,ref=0;
 tArr.forEach((tv,k)=>{ if(tv<1.1||tv>2.9)return; const exp2=2*v1[k-dTau];
  err2=Math.max(err2,Math.abs(v2[k]-exp2)); ref=Math.max(ref,Math.abs(exp2)); });
 const relO=err2/ref*100;
 console.log('tline open end: |v2| before tau =',preMax.toExponential(1),'V (expect ~0), doubling error',relO.toFixed(2)+'% over (tau,3tau)',(preMax<1e-6&&relO<1)?'PASS':'FAIL');

 build(300); // matched: v2(t) = v1(t - tau), no reflection
 const r2=simulate(3,6,null,50,0);
 const v1m=r2.vp[0][0], v2m=r2.vp[1][0];
 let errM=0,refM=0;
 r2.t.forEach((tv,k)=>{ if(tv<1.1||tv>5.9)return; const exp2=v1m[k-dTau];
  errM=Math.max(errM,Math.abs(v2m[k]-exp2)); refM=Math.max(refM,Math.abs(exp2)); });
 const relM=errM/refM*100;
 console.log('tline matched load: v2 = v1(t-tau) error',relM.toFixed(2)+'% (pure delay, no reflection)',relM<1?'PASS':'FAIL');
 record('tline','open-end doubling at tau + matched-load pure delay', !(preMax>=1e-6||relO>=1||relM>=1));
}

// ---- syncgen exciter/governor (opt-in): AVR proportional fixed point vs
// the analytical impedance-divider prediction; governor lag deepens the
// transient but leaves steady frequency unchanged (SPEC section 2).
// Legacy invariance is covered by the untouched earlier syncgen tests. ----
{
 const build=(extra)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'syncgen',x:0,y:0,params:Object.assign({H:4,Sbase:200,Ra:0.05,Ld:2,f0:60,E0:277,Pm0:57,Kgov:15,D:25,Q0:0,mq:0.5,Tf:20,Tg:0,Pmax:0,Te:0,Ka:50,Vref:0,Emax:0,pfType:'PV',Vset:0},extra)},
   {id:2,type:'rlc',x:0,y:0,params:{R:4,L:-1,C:-1}},
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[2,1],b:[4,0]},{a:[5,0],b:[2,0]});
 };
 const rmsTail=(r,sig,win)=>{ const tEnd=r.t[r.t.length-1]; let s=0,n=0;
  r.t.forEach((tv,k)=>{ if(tv<tEnd-win)return; s+=sig[k]*sig[k]; n++; }); return Math.sqrt(s/n); };
 build({Te:0.05,Vref:277});
 const r=simulate(3,2500,null,50,0);
 if(r.err){console.log('avr: solver error:',r.err,'FAIL');process.exit(1);}
 const vt=rmsTail(r,r.vp[0][0],50);
 // analytical proportional fixed point: Vt = g(E0 + Ka Vref)/(1 + g Ka),
 // g = |R/(R + Ra + jX)| at f0
 const w=2*Math.PI*60, g=4/Math.hypot(4.05,w*2e-3);
 const vtExp=g*(277+50*277)/(1+g*50);
 const eA=Math.abs(vt-vtExp)/vtExp*100;
 console.log('syncgen AVR: terminal Vrms',vt.toFixed(1),'V vs proportional fixed point',vtExp.toFixed(1),'V ('+eA.toFixed(2)+'%)',eA<1.5?'PASS':'FAIL');

 const fTrace=(extra)=>{ build(extra);
  // load step at 500 ms: extra 12-ohm bank drops in through a breaker
  S.blocks.push({id:6,type:'brk',x:0,y:0,params:{tclose:500,topen:-1,init:0}},
                {id:7,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},{id:8,type:'gnd',x:0,y:0,params:{}});
  S.wires.push({a:[2,0],b:[6,0]},{a:[6,1],b:[7,0]},{a:[7,1],b:[8,0]});
  const rr=simulate(3,4000,null,100,0);
  const gi=rr.curMeta.findIndex(m=>m.kind==='syncgen');
  const fmin=Math.min(...rr.aux[gi].filter((_,k)=>rr.t[k]>400));
  return {fmin, fend:rr.aux[gi][rr.aux[gi].length-1]}; };
 const noLag=fTrace({}), lag=fTrace({Tg:0.5});
 const dSteady=Math.abs(lag.fend-noLag.fend)*1000;
 const okGov=lag.fmin<noLag.fmin-0.005&&dSteady<10;
 console.log('syncgen governor lag: f dip',lag.fmin.toFixed(3),'vs',noLag.fmin.toFixed(3),'Hz (deeper with lag), steady diff',dSteady.toFixed(2),'mHz (<10)',okGov?'PASS':'FAIL');
 record('syncgen','AVR proportional fixed point + governor lag deepens dip', eA<1.5&&okGov);
}

// ---- weak-bus start envelope (SPEC §5 item 35, §7). A machine tied to an
// infinite bus through a Thevenin reactance: SCR = 3*Vph^2/(Xth*Sbase). A COLD
// start (rotor angle 0) has to swing to its load angle, and below SCR ~1.72 at
// full dispatch that swing passes pull-out and the machine slips; the governor
// then holds it at an off-nominal speed, which is what this detects. Starting
// from the power flow removes the swing entirely and holds at every SCR tested.
// This guard pins BOTH sides of the documented envelope so neither the limit
// nor the remedy can regress silently. ----
{
 const VPH=277,F0=60,W=2*Math.PI*F0,SB=100;
 const build=(scr,Pm0)=>{ const xth=3*VPH*VPH/(scr*SB*1000);
  S.blocks.length=0;S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:VPH,f:F0,Rs:0.01}},
   {id:2,type:'line',x:0,y:0,params:{R:xth/10,L:xth/W*1000,Rm:0,Lm:0,C:0}},
   {id:3,type:'syncgen',x:0,y:0,params:{H:4,Sbase:SB,Ra:0.05,Ld:2,f0:F0,E0:VPH,Pm0,Kgov:15,D:25,
    Q0:0,mq:0.5,Tf:20,Tg:0,Pmax:0,Te:0,Ka:50,Vref:0,Emax:0,pfType:'PV',Vset:0,Qmax:0,Qmin:0}},
   {id:4,type:'gnd',x:0,y:0,params:{}},{id:5,type:'gnd',x:0,y:0,params:{}});
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,1]},{a:[1,0],b:[4,0]},{a:[3,0],b:[5,0]});
 };
 // locked == ends at synchronous speed. A pole slip always parks the governor
 // at an off-nominal frequency, so the two outcomes separate by >2 Hz.
 const lock=(scr,Pm0,withPF)=>{ build(scr,Pm0);
  if(withPF){const pf=solvePowerFlow(); if(!pf||!pf.converged)return {ok:false,fend:NaN};}
  const r=simulate(3,3000,null,100,500);
  if(r.err){console.log('weak-bus: solver error:',r.err,'FAIL');process.exit(1);}
  const f=r.aux[r.curMeta.findIndex(m=>m.kind==='syncgen')], fend=f[f.length-1];
  return {ok:Math.abs(fend-F0)<0.5, fend};
 };
 const stiff=lock(3.0,100,false), weak=lock(1.2,100,false), weakPF=lock(1.2,100,true);
 console.log('weak-bus envelope: cold @1.0 pu, SCR 3.0 -> f_end',stiff.fend.toFixed(3),'Hz locked',stiff.ok);
 console.log('weak-bus envelope: cold @1.0 pu, SCR 1.2 -> f_end',weak.fend.toFixed(3),'Hz locked',weak.ok,'(must slip: below the SCR 1.72 cold limit)');
 console.log('weak-bus envelope: PF-init @1.0 pu, SCR 1.2 -> f_end',weakPF.fend.toFixed(3),'Hz locked',weakPF.ok,'(power-flow init is the remedy)');
 record('syncgen','weak-bus start envelope: cold holds at SCR 3, slips at SCR 1.2, PF init holds there',
  stiff.ok&&!weak.ok&&weakPF.ok);
}

// ---- SVC/STATCOM (svc): closed loop lands on its droop line, lifts the
// sagged bus, and pins at the mode-specific ceiling (SPEC section 2). ----
{
 const build=(svcParams)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'line',x:0,y:0,params:{R:0.3,L:15,Rm:0,Lm:0,C:0}},
   {id:3,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
   {id:4,type:'svc',x:0,y:0,params:Object.assign({mode:0,Vref:260,Xs:0.5,Ki:200,Bmax:0.02,Bmin:-0.02,Imax:10,f:60},svcParams)},
   {id:5,type:'gnd',x:0,y:0,params:{}},
   {id:6,type:'gnd',x:0,y:0,params:{}},
   {id:7,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[6,0]},{a:[1,0],b:[5,0]},{a:[4,0],b:[2,1]},{a:[7,0],b:[2,1]});
 };
 const rmsTail=(r,sig)=>{ const tEnd=r.t[r.t.length-1]; let s=0,n=0;
  r.t.forEach((tv,k)=>{ if(tv<tEnd-50)return; s+=sig[k]*sig[k]; n++; }); return Math.sqrt(s/n); };
 build({});
 const r=simulate(3,600,null,50,0);
 if(r.err){console.log('svc: solver error:',r.err,'FAIL');process.exit(1);}
 const si=r.curMeta.findIndex(m=>m.kind==='svc');
 const vt=rmsTail(r,r.vp[0][0]), iq=r.aux[si][r.aux[si].length-1];
 const vSag=242.6; // uncompensated divider (same math as the vsw test)
 const droopErr=Math.abs((260-vt)-0.5*iq);
 console.log('svc droop line: Vref-V =',(260-vt).toFixed(2),'V vs Xs*Iq =',(0.5*iq).toFixed(2),'V (diff',droopErr.toFixed(2),'V, <1), lifted from ~'+vSag+' to',vt.toFixed(1),(droopErr<1&&vt>vSag+5)?'PASS':'FAIL');

 build({Vref:320}); // unreachable: SVC pins at Bmax -> Iq = Bmax*Vrms
 const r2=simulate(3,600,null,50,0);
 const si2=r2.curMeta.findIndex(m=>m.kind==='svc');
 const vt2=rmsTail(r2,r2.vp[0][0]), iq2=r2.aux[si2][r2.aux[si2].length-1];
 const eB=Math.abs(iq2-0.02*vt2)/(0.02*vt2)*100;
 console.log('svc ceiling (SVC mode): Iq =',iq2.toFixed(2),'A vs Bmax*Vrms =',(0.02*vt2).toFixed(2),'A ('+eB.toFixed(2)+'%)',eB<1?'PASS':'FAIL');

 build({Vref:320,mode:1,Imax:4}); // STATCOM ceiling: Iq = Imax flat
 const r3=simulate(3,600,null,50,0);
 const si3=r3.curMeta.findIndex(m=>m.kind==='svc');
 const iq3=r3.aux[si3][r3.aux[si3].length-1];
 const eI3=Math.abs(iq3-4)/4*100;
 console.log('svc ceiling (STATCOM mode): Iq =',iq3.toFixed(3),'A vs Imax = 4 ('+eI3.toFixed(2)+'%)',eI3<0.5?'PASS':'FAIL');
 record('svc','droop line + lift + SVC/STATCOM ceiling behavior', !(droopErr>=1||vt<=vSag+5||eB>=1||eI3>=0.5));
}

// ---- saturable transformer core (xfmr Lm/lknee/Lsat): linear-regime
// magnetizing RMS = V/(w*Lm); saturated steady peak matches the two-slope
// map i = lk/Lm + (lpk-lk)/Lsat. Lm=0 legacy invariance is covered by the
// untouched original xfmr assertions earlier in the suite. ----
{
 const build=(lknee)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'xfmr',x:0,y:0,params:{V1:240,V2:120,R:0.1,L:0.5,Lm:500,lknee,Lsat:20}},
   {id:3,type:'rlc',x:0,y:0,params:{R:10000,L:-1,C:-1}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'gnd',x:0,y:0,params:{}},
   {id:6,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[5,0]},{a:[1,0],b:[4,0]},{a:[6,0],b:[2,0]});
 };
 const w=2*Math.PI*60;
 build(0); // linear magnetizing branch: Irms = V/(w*Lm), run past the inrush decay (tau ~ Lm/Rs = 1 s)
 const r=simulate(3,6000,null,100,0);
 if(r.err){console.log('xfmr sat: solver error:',r.err,'FAIL');process.exit(1);}
 const si=r.curMeta.findIndex(m=>m.type==='src');
 const tail=r.t.map((_,k)=>k).filter(k=>r.t[k]>r.t[r.t.length-1]-1000/60);
 const rmsOf=(sig)=>Math.sqrt(tail.reduce((a,k)=>a+sig[k]**2,0)/tail.length);
 const vRms=rmsOf(r.vp[0][0]), iRms=rmsOf(r.ic[si][0]);
 const iExp=vRms/(w*0.5);
 const eL=Math.abs(iRms-iExp)/iExp*100;
 console.log('xfmr sat linear: mag Irms',iRms.toFixed(3),'A vs V/(wLm)',iExp.toFixed(3),'A ('+eL.toFixed(2)+'%)',eL<3?'PASS':'FAIL');

 build(0.8); // knee below operating flux (~1.04 V·s): saturated peaks.
 // plotUs=100 keeps EVERY sample: auto-decimation (~4 ms spacing) would
 // miss the ~3.6 ms saturation spikes entirely (found the hard way).
 const r2=simulate(3,6000,null,100,100);
 const si2=r2.curMeta.findIndex(m=>m.type==='src');
 const tail2=r2.t.map((_,k)=>k).filter(k=>r2.t[k]>r2.t[r2.t.length-1]-1000/60);
 const vRms2=Math.sqrt(tail2.reduce((a,k)=>a+r2.vp[0][0][k]**2,0)/tail2.length);
 const iPk=Math.max(...tail2.map(k=>Math.abs(r2.ic[si2][0][k])));
 const lpk=Math.SQRT2*vRms2/w;
 const iPkExp=0.8/0.5+(lpk-0.8)/0.02;
 const eS=Math.abs(iPk-iPkExp)/iPkExp*100;
 console.log('xfmr sat: peak mag I',iPk.toFixed(2),'A vs two-slope',iPkExp.toFixed(2),'A ('+eS.toFixed(2)+'%), lambda_pk',lpk.toFixed(3),'V·s vs knee 0.8',eS<5?'PASS':'FAIL');
 record('xfmr','saturable core: linear mag + two-slope peak', !(eL>=3||eS>=5));
}

// ---- three-winding transformer (xfmr3w): Yy0d1 per-winding ratios and
// shifts; delta-tertiary zero-sequence sink shown with an ungrounded
// primary (fault current exists ONLY via tertiary circulation). ----
{
 const build=(conn,Rn1,Rn3,withFault)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  // V1/V2/V3 are line-line nameplate voltages; winding ratios are derived as
  // a2 = (V1/V2)*(k2/k1), a3 = (V1/V3)*(k3/k1), k = sqrt3 (wye) or 1 (delta),
  // primary always wye (k1=sqrt3). Pick V1/V2/V3 from conn so a2=2, a3=4 hold
  // for every connection tested.
  const SQ3 = Math.sqrt(3);
  const k2 = conn[1]==='y'?SQ3:1, k3 = conn[3]==='y'?SQ3:1; // secondary, tertiary
  const V1 = 240*SQ3/k2, V2 = 120;            // a2 = (V1/V2)*(k2/SQ3) = 2
  const V3 = V1*k3/(4*SQ3);                   // a3 = (V1/V3)*(k3/SQ3) = 4
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.05}},
   {id:2,type:'xfmr3w',x:0,y:0,params:{conn,V1,V2,V3,R1:0.05,L1:0.3,R2:0.05,L2:0.3,R3:0.05,L3:0.3,Rn1,Rn2:0,Rn3}},
   {id:3,type:'rlc',x:0,y:0,params:{R:100,L:-1,C:-1}},
   {id:4,type:'rlc',x:0,y:0,params:{R:100,L:-1,C:-1}},
   {id:5,type:'gnd',x:0,y:0,params:{}},{id:6,type:'gnd',x:0,y:0,params:{}},{id:7,type:'gnd',x:0,y:0,params:{}},
   {id:8,type:'probe',x:0,y:0,params:{}},{id:9,type:'probe',x:0,y:0,params:{}},{id:10,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[5,0]},
   {a:[2,1],b:[3,0]},{a:[3,1],b:[6,0]},
   {a:[2,2],b:[4,0]},{a:[4,1],b:[7,0]},
   {a:[8,0],b:[2,0]},{a:[9,0],b:[2,1]},{a:[10,0],b:[2,2]});
  if(withFault){ S.blocks.push({id:11,type:'fault',x:0,y:0,params:{Rf:0.5,ton:60,toff:-1,ph:1}}); S.wires.push({a:[11,0],b:[2,1]}); }
 };
 const phasorOf=(r,pi,ph)=>{ const w=2*Math.PI*60; const tEnd=r.t[r.t.length-1]; let re=0,im=0,n=0;
  for(let k=0;k<r.t.length;k++){ if(r.t[k]<tEnd-50)continue; const th=w*r.t[k]*1e-3;
   re+=r.vp[pi][ph][k]*Math.sin(th); im+=r.vp[pi][ph][k]*Math.cos(th); n++; }
  return {m:Math.hypot(2*re/n,2*im/n), a:Math.atan2(2*im/n,2*re/n)*180/Math.PI}; };
 const wrap=d=>{ while(d>180)d-=360; while(d<=-180)d+=360; return d; };
 build('Yy0d1',0,0,false);
 const r=simulate(3,200,null,50,0);
 if(r.err){console.log('xfmr3w: solver error:',r.err,'FAIL');process.exit(1);}
 const p1=phasorOf(r,0,0), p2=phasorOf(r,1,0), p3=phasorOf(r,2,0);
 const r2e=Math.abs(p2.m/p1.m-0.5)/0.5*100, s2=Math.abs(wrap(p2.a-p1.a));
 const r3exp=1/(4*Math.sqrt(3));
 const r3e=Math.abs(p3.m/p1.m-r3exp)/r3exp*100, s3=Math.abs(wrap(p3.a-p1.a+30));
 console.log('xfmr3w Yy0d1: |V2|/|V1|',(p2.m/p1.m).toFixed(4),'vs 0.5 ('+r2e.toFixed(2)+'%), shift',wrap(p2.a-p1.a).toFixed(2),'deg',(r2e<1&&s2<1.5)?'PASS':'FAIL');
 console.log('xfmr3w Yy0d1: |V3|/|V1|',(p3.m/p1.m).toFixed(4),'vs 1/(a3*sqrt3) ('+r3e.toFixed(2)+'%), shift',wrap(p3.a-p1.a).toFixed(2),'deg (expect -30)',(r3e<1&&s3<1.5)?'PASS':'FAIL');

 build('Yy0d1',-1,0,true); // ungrounded primary: zero-seq only via delta tertiary
 const rF=simulate(3,300,null,50,0);
 const fi=rF.curMeta.findIndex(m=>m.type==='fault');
 let ifD=0; rF.t.forEach((tv,k)=>{ if(tv<150)return; ifD=Math.max(ifD,Math.abs(rF.ic[fi][0][k])); });
 build('Yy0y0',-1,-1,true); // tertiary wye ungrounded: NO zero-seq path at all
 const rN=simulate(3,300,null,50,0);
 const fn=rN.curMeta.findIndex(m=>m.type==='fault');
 let ifN=0; rN.t.forEach((tv,k)=>{ if(tv<150)return; ifN=Math.max(ifN,Math.abs(rN.ic[fn][0][k])); });
 const sink=ifD/Math.max(ifN,1e-9);
 console.log('xfmr3w delta tertiary as zero-seq sink: SLG fault I',ifD.toFixed(1),'A (d1 tertiary) vs',ifN.toFixed(3),'A (no path), x'+sink.toFixed(0),'(expect >50x)',sink>50?'PASS':'FAIL');
 record('xfmr3w','Yy0d1 ratios/shifts + delta tertiary zero-seq sink', !(r2e>=1||s2>=1.5||r3e>=1||s3>=1.5||sink<=50));
}

// ---- xfmr3w power-flow stamp (July 2026): the star (T) equivalent is REBUILT
// from primitives whose PF stamps are already validated — a series `rlc` for
// the primary arm out to a virtual star bus, then one `xfmr3` per remaining arm
// (leakage on the primary side, so it IS the primary-referred star arm). The
// two circuits are the same network, so every bus must agree to solver
// precision, for a wye AND for a delta tertiary (which must also carry the
// 30 deg shift). Before this stamp existed the PF refused the circuit outright.
{
 const HV=138000, LV=13800, TV=69000;
 const R1=0.4,L1=3.0,R2=0.6,L2=5.0,R3=0.9,L3=7.0;
 const common=()=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'gnd',x:0,y:0,params:{}},
   {id:2,type:'syncgen',x:0,y:0,params:{Pm0:0,Vset:HV,Sbase:100000,pfType:'slack',Ra:0.01,Ld:0.1}},
   {id:3,type:'bus',x:0,y:0,params:{name:'HV',taps:3,len:50,Vbase:HV}},
   {id:4,type:'bus',x:0,y:0,params:{name:'LV',taps:3,len:50,Vbase:LV}},
   {id:5,type:'bus',x:0,y:0,params:{name:'TERT',taps:3,len:50,Vbase:TV}},
   {id:6,type:'pq',x:0,y:0,params:{P:8000,Q:3000}},
   {id:7,type:'pq',x:0,y:0,params:{P:2500,Q:900}}
  );
  S.wires.push({a:[2,0],b:[1,0]},{a:[2,1],b:[3,0]},
   {a:[6,0],b:[4,0]},{a:[6,1],b:[1,0]},{a:[7,0],b:[5,0]},{a:[7,1],b:[1,0]});
 };
 const asBlock=d=>{ common();
  S.blocks.push({id:10,type:'xfmr3w',x:0,y:0,params:{conn:d?'Yy0d1':'Yy0y0',V1:HV,V2:LV,V3:TV,R1,L1,R2,L2,R3,L3,Rn1:0,Rn2:0,Rn3:0}});
  S.wires.push({a:[10,0],b:[3,1]},{a:[10,1],b:[4,1]},{a:[10,2],b:[5,1]}); };
 const asT=d=>{ common();
  S.blocks.push(
   {id:9,type:'bus',x:0,y:0,params:{name:'STAR',taps:3,len:50,Vbase:HV}},
   {id:10,type:'rlc',x:0,y:0,params:{R:R1,L:L1,C:-1}},
   {id:11,type:'xfmr3',x:0,y:0,params:{conn:'Yy0',V1:HV,V2:LV,R:R2,L:L2,Rn1:0,Rn2:0}},
   {id:12,type:'xfmr3',x:0,y:0,params:{conn:d?'Yd1':'Yy0',V1:HV,V2:TV,R:R3,L:L3,Rn1:0,Rn2:0}});
  S.wires.push({a:[10,0],b:[3,1]},{a:[10,1],b:[9,0]},
   {a:[11,0],b:[9,1]},{a:[11,1],b:[4,1]},{a:[12,0],b:[9,2]},{a:[12,1],b:[5,1]}); };
 const solve=()=>{ const r=solvePowerFlow({tol:1e-11,maxIter:200000});
  if(r.err){console.log('xfmr3w PF: solver error:',r.err,'FAIL');process.exit(1);}
  return Object.fromEntries(r.busBlocks.map(b=>[b.name,b])); };
 let worstY=0, worstD=0, tertShift=0;
 [false,true].forEach(d=>{
  asBlock(d); const a=solve();
  asT(d); const b=solve();
  let worst=0;
  ['HV','LV','TERT'].forEach(n=>{ worst=Math.max(worst,Math.abs(a[n].Vpu-b[n].Vpu),Math.abs(a[n].ang-b[n].ang)); });
  if(d){ worstD=worst; tertShift=a.TERT.ang-a.LV.ang; } else worstY=worst;
 });
 const okPF=worstY<1e-6&&worstD<1e-6&&Math.abs(Math.abs(tertShift)-30)<1;
 console.log('xfmr3w PF star stamp vs rlc+xfmr3 T: worst dev',worstY.toExponential(2),'(Yy0y0),',worstD.toExponential(2),'(Yy0d1), tertiary shift',tertShift.toFixed(2),'deg (expect -30)',okPF?'PASS':'FAIL');
 record('xfmr3w','power-flow star stamp matches an equivalent T of validated primitives', okPF);
}

// ---- Newton-Raphson power flow (July 2026) ----------------------------------
// Three properties, on a deliberately MULTI-VOLTAGE circuit (20 kV machine into
// 230 kV transmission and back down to 13.8 kV) because that is where the old
// single-base flat start was worst:
//  1. NR and Gauss-Seidel are two independent methods on the same equations, so
//     they must land on the same solution bus for bus. Anything else means one
//     of them found a different root — the exact failure that a flat-start NR
//     hit on a vendor case, converging quietly onto a 0.036 pu branch.
//  2. NR must get there in a handful of iterations. GS needed 1368 on IEEE
//     39-bus; the whole point of the change is the iteration count.
//  3. A bus with no source anywhere in its island must be REPORTED, not
//     divide by its zero Ybus diagonal and NaN every other bus in the case.
{
 const HV=230000, GV=20000, LV=13800;
 const build=orphan=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'gnd',x:0,y:0,params:{}},
   {id:2,type:'syncgen',x:0,y:0,params:{Pm0:0,Vset:GV,Sbase:200000,pfType:'slack',Ra:0.01,Ld:0.1}},
   {id:3,type:'syncgen',x:0,y:0,params:{Pm0:40000,Vset:GV,Sbase:100000,pfType:'PV',Ra:0.01,Ld:0.1}},
   {id:4,type:'bus',x:0,y:0,params:{name:'GEN1',taps:3,len:50,Vbase:GV}},
   {id:5,type:'bus',x:0,y:0,params:{name:'GEN2',taps:3,len:50,Vbase:GV}},
   {id:6,type:'bus',x:0,y:0,params:{name:'HVA',taps:4,len:50,Vbase:HV}},
   {id:7,type:'bus',x:0,y:0,params:{name:'HVB',taps:4,len:50,Vbase:HV}},
   {id:8,type:'bus',x:0,y:0,params:{name:'DIST',taps:3,len:50,Vbase:LV}},
   {id:10,type:'xfmr3',x:0,y:0,params:{conn:'Yd1',V1:GV,V2:HV,R:0.05,L:4,Rn1:0,Rn2:0}},
   {id:11,type:'xfmr3',x:0,y:0,params:{conn:'Yd1',V1:GV,V2:HV,R:0.05,L:4,Rn1:0,Rn2:0}},
   {id:12,type:'line',x:0,y:0,params:{R:8,L:110,Rm:0,Lm:0,C:1.2}},
   {id:13,type:'xfmr3',x:0,y:0,params:{conn:'Yy0',V1:HV,V2:LV,R:1.2,L:60,Rn1:0,Rn2:0}},
   {id:14,type:'pq',x:0,y:0,params:{P:55000,Q:18000}},
   {id:15,type:'pq',x:0,y:0,params:{P:9000,Q:3000}}
  );
  S.wires.push(
   {a:[2,0],b:[1,0]},{a:[2,1],b:[4,0]},{a:[3,0],b:[1,0]},{a:[3,1],b:[5,0]},
   {a:[10,0],b:[4,1]},{a:[10,1],b:[6,0]},{a:[11,0],b:[5,1]},{a:[11,1],b:[7,0]},
   {a:[12,0],b:[6,1]},{a:[12,1],b:[7,1]},
   {a:[13,0],b:[7,2]},{a:[13,1],b:[8,0]},
   {a:[14,0],b:[6,2]},{a:[14,1],b:[1,0]},{a:[15,0],b:[8,1]},{a:[15,1],b:[1,0]});
  // a load hanging on a bus with no branch to anywhere: exactly what an import
  // leaves behind when every element on that bus was a record it cannot model
  if(orphan){
   S.blocks.push({id:20,type:'bus',x:0,y:0,params:{name:'ORPHAN',taps:2,len:50,Vbase:LV}},
                 {id:21,type:'pq',x:0,y:0,params:{P:1000,Q:400}});
   S.wires.push({a:[21,0],b:[20,0]},{a:[21,1],b:[1,0]});
  }
 };
 build(false);
 const nr=solvePowerFlow({method:'nr'});
 const gs=solvePowerFlow({method:'gs',tol:1e-11,maxIter:200000});
 const G=Object.fromEntries(gs.busBlocks.map(b=>[b.name,b]));
 let dV=0,dA=0;
 nr.busBlocks.forEach(b=>{ dV=Math.max(dV,Math.abs(b.Vpu-G[b.name].Vpu)); dA=Math.max(dA,Math.abs(b.ang-G[b.name].ang)); });
 const okAgree=nr.converged&&gs.converged&&dV<1e-6&&dA<1e-4;
 console.log('PF NR vs GS: NR',nr.iters,'iters / GS',gs.iters,'iters, worst dVpu',dV.toExponential(2),'dAng',dA.toExponential(2),'deg',okAgree?'PASS':'FAIL');
 record('powerflow','Newton-Raphson and Gauss-Seidel agree bus for bus', okAgree);
 const okFast=nr.converged&&nr.iters<=10&&nr.method==='nr';
 console.log('PF NR iteration count:',nr.iters,'(expect <=10, GS needed '+gs.iters+')',okFast?'PASS':'FAIL');
 record('powerflow','Newton-Raphson converges in a handful of iterations', okFast);

 build(true);
 const orp=solvePowerFlow();
 const live=(orp.busBlocks||[]).filter(b=>!b.dead);
 const anyNaN=live.some(b=>!isFinite(b.Vpu));
 const named=(orp.deadBuses||[]).length===1&&orp.deadBuses[0]==='ORPHAN';
 const stillRight=live.length===5&&Math.abs(live.find(b=>b.name==='DIST').Vpu-G.DIST.Vpu)<1e-6;
 const okDead=orp.converged&&!anyNaN&&named&&stillRight&&orp.islands===2;
 console.log('PF de-energized bus: converged',orp.converged,'islands',orp.islands,'dead',JSON.stringify(orp.deadBuses),
  'NaN elsewhere',anyNaN,'(all buses were NaN pre-fix)',okDead?'PASS':'FAIL');
 record('powerflow','a bus with no source in its island is reported, not NaN', okDead);
}

// ---- generator reactive limits, shared buses, colocated load (July 2026) ----
// A PV bus holds its setpoint with whatever reactive it takes; a real machine
// has a band. Five properties on one hand-built circuit
// (slack - line - MID(machine[s], optional local load) - line - LOAD):
//  1. Pin: when the reactive the solution wants exceeds Qmax, the machine ends
//     up exactly ON Qmax and its bus sags below setpoint (it is now PQ).
//  2. Inert when slack: a band far wider than the demand must change nothing,
//     so the switch cannot quietly perturb a case it does not apply to.
//  3. NR and Gauss-Seidel enforce the SAME limit and agree bus for bus. The two
//     do it differently (NR converts the bus and re-solves; GS clamps per sweep
//     with no latch), so agreement is real evidence, not a shared bug.
//  4. Shared bus: two half-sized machines on one bus must give the identical
//     network solution as one full-sized machine. Until July 2026 the second
//     machine simply overwrote the first and half the dispatch vanished.
//  5. Colocated load: a 12 MW machine on a bus with a 5 MW load must load the
//     network exactly like a 7 MW machine on a clean bus. The solve used to
//     ignore the local draw and inject the full 12 MW.
{
 const GV=20000;
 const build=o=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'gnd',x:0,y:0,params:{}},
   {id:2,type:'syncgen',x:0,y:0,params:{Pm0:0,Vset:GV,Sbase:500000,pfType:'slack',Ra:0.01,Ld:0.1}},
   {id:4,type:'bus',x:0,y:0,params:{name:'SLK',taps:3,len:50,Vbase:GV}},
   {id:5,type:'bus',x:0,y:0,params:{name:'MID',taps:5,len:50,Vbase:GV}},
   {id:6,type:'bus',x:0,y:0,params:{name:'LOAD',taps:3,len:50,Vbase:GV}},
   {id:10,type:'line',x:0,y:0,params:{R:0.6,L:12,Rm:0,Lm:0,C:0}},
   {id:11,type:'line',x:0,y:0,params:{R:0.6,L:12,Rm:0,Lm:0,C:0}},
   {id:14,type:'pq',x:0,y:0,params:{P:30000,Q:20000}}
  );
  S.wires.push({a:[2,0],b:[1,0]},{a:[2,1],b:[4,0]},
   {a:[10,0],b:[4,1]},{a:[10,1],b:[5,0]},
   {a:[11,0],b:[5,1]},{a:[11,1],b:[6,0]},
   {a:[14,0],b:[6,1]},{a:[14,1],b:[1,0]});
  // the MID machine: one unit, or two half-sized units on the SAME bus
  const units=o.split?2:1, Pm=(o.Pm===undefined?12000:o.Pm);
  for(let k=0;k<units;k++){
   S.blocks.push({id:20+k,type:'syncgen',x:0,y:0,params:{
    Pm0:Pm/units,Vset:GV,Sbase:100000/units,pfType:'PV',Ra:0.01,Ld:0.1,
    Qmax:(o.Qmax||0)/units,Qmin:(o.Qmin||0)/units}});
   S.wires.push({a:[20+k,0],b:[1,0]},{a:[20+k,1],b:[5,2+k]});
  }
  if(o.localLoad){
   S.blocks.push({id:30,type:'pq',x:0,y:0,params:{P:o.localLoad,Q:0}});
   S.wires.push({a:[30,0],b:[5,4]},{a:[30,1],b:[1,0]});
  }
 };
 const vmap=r=>Object.fromEntries(r.busBlocks.map(b=>[b.name,b]));
 const worst=(a,b)=>{const B=vmap(b);let d=0;
  a.busBlocks.forEach(x=>{d=Math.max(d,Math.abs(x.Vpu-B[x.name].Vpu),Math.abs(x.ang-B[x.name].ang));});return d;};

 build({});                                  // no band declared: unlimited
 const base=solvePowerFlow({method:'nr'});
 const qWant=base.genInit.find(g=>g.id===20).pf.Q;   // reactive the machine asks for, VAr
 const QL=Math.round(qWant*0.5/1000);                // clamp it to half that, in kvar

 build({Qmax:QL,Qmin:-QL});
 const lim=solvePowerFlow({method:'nr'});
 const gl=lim.genInit.find(g=>g.id===20);
 const vMid=vmap(lim)['MID'].Vpu, vMid0=vmap(base)['MID'].Vpu;
 const okPin=lim.converged&&lim.nQlim===1&&gl.qlim==='max'&&gl.busType==='PQ'
  &&Math.abs(gl.pf.Q-QL*1000)<1&&vMid<vMid0-1e-4&&base.nQlim===0;
 console.log('PF Qlim pin: wanted',(qWant/1e6).toFixed(3),'Mvar, limit',(QL/1e3).toFixed(3),
  'Mvar, got',(gl.pf.Q/1e6).toFixed(6),'Mvar; MID',vMid0.toFixed(4),'->',vMid.toFixed(4),'pu',okPin?'PASS':'FAIL');
 record('powerflow','a generator over its Q limit is pinned at the limit and its bus sags', okPin);

 const gsl=solvePowerFlow({method:'gs',tol:1e-12,maxIter:400000});
 const dGS=worst(lim,gsl);
 const gGS=gsl.genInit.find(g=>g.id===20);
 const okGS=gsl.converged&&dGS<1e-5&&Math.abs(gGS.pf.Q-QL*1000)<Math.abs(QL);
 console.log('PF Qlim NR vs GS: worst dVpu/dAng',dGS.toExponential(2),'GS Q',(gGS.pf.Q/1e6).toFixed(6),'Mvar',okGS?'PASS':'FAIL');
 record('powerflow','Newton-Raphson and Gauss-Seidel enforce the same Q limit', okGS);

 build({Qmax:Math.abs(qWant*10/1000),Qmin:-Math.abs(qWant*10/1000)});
 const loose=solvePowerFlow({method:'nr'});
 const okLoose=loose.converged&&loose.nQlim===0&&worst(loose,base)<1e-9;
 console.log('PF Qlim slack band leaves the case untouched: worst d',worst(loose,base).toExponential(2),okLoose?'PASS':'FAIL');
 record('powerflow','a Q band that does not bind changes nothing', okLoose);

 build({split:true});
 const two=solvePowerFlow({method:'nr'});
 const mid=two.genInit.filter(g=>g.id>=20); // genInit also carries the slack machine
 const okSplit=two.converged&&worst(two,base)<1e-9&&mid.length===2
  &&Math.abs(mid[0].pf.P+mid[1].pf.P-base.genInit.find(g=>g.id===20).pf.P)<1;
 console.log('PF two machines on one bus == one machine of the sum: worst d',worst(two,base).toExponential(2),okSplit?'PASS':'FAIL');
 record('powerflow','machines sharing a bus aggregate instead of overwriting', okSplit);

 build({Pm:12000,localLoad:5000});
 const withLoad=solvePowerFlow({method:'nr'});
 build({Pm:7000});
 const netted=solvePowerFlow({method:'nr'});
 const okNet=withLoad.converged&&netted.converged&&worst(withLoad,netted)<1e-9;
 console.log('PF 12 MW gen + 5 MW local load == 7 MW gen: worst d',worst(withLoad,netted).toExponential(2),okNet?'PASS':'FAIL');
 record('powerflow','a generator bus injects its dispatch NET of the load on that bus', okNet);
}

// ---- the two imported LOAD-FLOW examples (July 2026) ------------------------
// These ship as power-flow cases, not EMT studies: a RAW file carries no dynamic
// data, so their machine H/droop are the importer's generic placeholders. What
// is asserted is therefore the steady state, and it is asserted so the files
// cannot silently drift if the importer or the solver changes. `vconv` is 'll'
// on both, so bus Vmag is line-to-line.
{
 const cases=[
  // file, buses, f0, expected pu window, and a spot check straight off the
  // source case's own bus records (VM in the RAW = the vendor's own answer)
  // ..., how many buses are expected to sit on a generator reactive limit, and
  // a list of [name, VM, VA] triples copied verbatim from the source case's bus
  // records: magnitude AND angle, so a transformer vector group cannot flip
  // sign or lose a factor of 3 without this failing (2026-07-24 in
  // DECISIONS.md: both harmonics entries below were 30 deg the wrong way and
  // BUS 8 was 0.956 instead of 0.938 before the delta landed on the right
  // winding).
  ['iec60909_hv_network.json', 11, 50, 0.92, 1.02, 'BUS1', 1.000, 1, []],
  ['ieee_harmonics_14bus.json', 16, 60, 0.93, 1.07, 'BUS 1', 1.060, 2,
   [['BUS 8', 0.93835, 15.5000], ['BUS 302', 0.96674, 14.0813], ['BUS 7', 0.96257, -14.5000]]]
 ];
 const vconv0=S.vconv;
 cases.forEach(([f,nb,f0,lo,hi,spotName,spotPu,nq,spots])=>{
  const raw=fs.readFileSync('examples/'+f,'utf8');
  const ex=JSON.parse(raw);
  // a shipped file must never carry a stale operating point: the app recomputes
  // pfInit on every solve, and a baked-in one would be silently used at load.
  // Counted from the FILE TEXT, because solvePowerFlow below writes pfInit onto
  // these very block objects.
  const stale=ex.blocks.filter(b=>b.pfInit).length;
  S.blocks.length=0; S.wires.length=0; S.vconv=ex.vconv||'ph';
  S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
  const r=solvePowerFlow();
  const buses=(r.busBlocks||[]);
  const spot=buses.find(b=>b.name===spotName);
  const vs=buses.filter(b=>!b.dead).map(b=>b.Vpu);
  // Every machine the solve flags as limited must be sitting exactly ON its own
  // declared limit — the point of the PV-to-PQ switch. Reported in kvar, so the
  // comparison is in kvar too.
  const lim=(r.genInit||[]).filter(g=>g.qlim);
  const byId={}; ex.blocks.forEach(b=>byId[b.id]=b);
  // PSS/E writes +/-9999 Mvar for "unlimited"; the block spells that 0/0, so a
  // file of real cases must contain BOTH kinds of machine — otherwise the
  // sentinel mapping has quietly turned every machine into a limited one.
  const mach=ex.blocks.filter(b=>b.type==='syncgen');
  const freeQ=mach.filter(b=>!b.params.Qmax&&!b.params.Qmin).length;
  const limOK=lim.every(g=>{
   const p=byId[g.id].params, want=(g.qlim==='max'?+p.Qmax:+p.Qmin)*1000;
   return Math.abs(g.pf.Q-want)<Math.max(1e-6*Math.abs(want),1);
  });
  // Bus-by-bus against the vendor's own solved answer. The angle check is the
  // sharp one: it is what a wrong vector group breaks, and a 30 deg error is
  // 300x this tolerance.
  const bad=(spots||[]).filter(([nm,vm,va])=>{
   const b=buses.find(x=>x.name===nm);
   return !b||Math.abs(b.Vpu-vm)>0.001||Math.abs(b.ang-va)>0.1;
  }).map(s=>s[0]);
  const ok=!r.err&&r.converged&&r.method==='nr'&&r.iters<=10&&buses.length===nb&&r.islands===1&&!r.nDead
   &&stale===0&&r.f0===f0&&Math.min(...vs)>lo&&Math.max(...vs)<hi
   &&spot&&Math.abs(spot.Vpu-spotPu)<0.005&&r.nQlim===nq&&lim.length>0&&limOK
   &&freeQ>0&&freeQ<mach.length&&bad.length===0;
  console.log(f.padEnd(26),r.err?('ERR '+r.err):(r.method.toUpperCase()+' '+r.iters+' iters, '+f0+' Hz, '+buses.length+' buses, Vpu['
   +Math.min(...vs).toFixed(3)+','+Math.max(...vs).toFixed(3)+'], '+spotName+'='+(spot?spot.Vpu.toFixed(3):'-')
   +' (RAW says '+spotPu.toFixed(3)+'), Qlim buses='+r.nQlim+'/'+nq+' ('+lim.length+' machines pinned, on-limit '+limOK+')'
   +', unlimited machines '+freeQ+'/'+mach.length+', stale pfInit='+stale
   +', V/angle spot checks '+((spots||[]).length-bad.length)+'/'+(spots||[]).length
   +(bad.length?' (off: '+bad.join(', ')+')':'')),ok?'PASS':'FAIL');
  record('examples',f+' power-flows to its source case voltages', ok);
 });
 S.vconv=vconv0; // these two examples are 'll'; leaking that breaks every later test
}

// ---- Type 4 wind (wt4): delivered P follows the cubic curve, caps at
// rating, steps on a gust; Q matches the dispatch (SPEC section 2). ----
{
 const build=(wt)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'line',x:0,y:0,params:{R:0.2,L:2,Rm:0,Lm:0,C:0}},
   {id:3,type:'wt4',x:0,y:0,params:Object.assign({Prated:100,vrated:12,vw:10,vw2:0,tgust:-1,Q0:10,Imax:150,vmin:50,f0:60},wt)},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,1]},{a:[3,0],b:[5,0]},{a:[1,0],b:[4,0]});
 };
 const pqOver=(r,wi,lo,hi)=>{ const dtOut=r.t[1]-r.t[0];
  const win=Math.max(1,Math.round(1000/60/dtOut)), sh=Math.max(1,Math.round(win/4));
  const v=r.bv[wi][0], i=r.ic[wi][0]; let sp=0,sq=0,n=0;
  r.t.forEach((tv,k)=>{ if(tv<lo||tv>hi)return; sp+=v[k]*i[k]; const j=Math.min(v.length-1,k+sh); sq+=v[k]*i[j]; n++; });
  return {P:3*sp/n/1000, Q:3*sq/n/1000}; }; // 3-phase totals, kW/kvar (raw sign: + = delivering for FLOW_REVERSED kinds)
 build({tgust:400,vw2:6});
 // plotUs=50 keeps all samples: decimation skews the quarter-period shift
 // and rotates real power into the Q estimate (P >> Q here)
 const r=simulate(3,800,null,50,50);
 if(r.err){console.log('wt4: solver error:',r.err,'FAIL');process.exit(1);}
 const wi=r.curMeta.findIndex(m=>m.kind==='wt4');
 const pre=pqOver(r,wi,250,390), post=pqOver(r,wi,650,790);
 const pExp1=100*Math.pow(10/12,3), pExp2=100*Math.pow(6/12,3);
 const e1=Math.abs(pre.P-pExp1)/pExp1*100, e2=Math.abs(post.P-pExp2)/pExp2*100;
 const eQ=Math.abs(pre.Q-10)/10*100;
 console.log('wt4 cubic: P',pre.P.toFixed(2),'kW vs',pExp1.toFixed(2),'('+e1.toFixed(2)+'%), after gust',post.P.toFixed(2),'vs',pExp2.toFixed(2),'('+e2.toFixed(2)+'%)',(e1<2&&e2<2)?'PASS':'FAIL');
 // 6% bar: with P/Q ~ 6, even the residual quarter-sample quantization of
 // the shift (83 vs 83.33 samples) leaks ~0.4 kvar of P into the estimate
 console.log('wt4 Q dispatch:',pre.Q.toFixed(2),'kvar vs 10 ('+eQ.toFixed(2)+'%)',eQ<6?'PASS':'FAIL');
 build({vw:15}); // cubic would be 195 kW: must cap at rating
 const r2=simulate(3,500,null,50,50);
 const wi2=r2.curMeta.findIndex(m=>m.kind==='wt4');
 const cap=pqOver(r2,wi2,300,490);
 const eC=Math.abs(cap.P-100)/100*100;
 console.log('wt4 rating cap: P',cap.P.toFixed(2),'kW vs 100 ('+eC.toFixed(2)+'%)',eC<2?'PASS':'FAIL');
 record('wt4','cubic tracking + rating cap + gust step + Q dispatch', !(e1>=2||e2>=2||eQ>=6||eC>=2));
}

// ---- Transmission-grade GFL solar inverter (gfl): a current-source primitive
// (SPEC section 5 item 33). Validation: fixed-P/Q setpoint tracking at unity and
// at leading/lagging PF; current limit held at 1.2x through a depressing fault;
// voltage-floor ride-through with no I=P/V runaway; stability on a weak bus
// (SCR~3); and the PLL following a network not already at f0 (the feature
// wt4's free-running clock lacks). Per-unit on a 250 MVA / 40 kV base; phase
// values used here (vconv='ph'), so Vrated = 23094 V (40 kV LL). ----
{
 const Vph=23094, Sbase=250000; // 40 kV LL -> phase RMS, 250 MVA plant
 const Irated=Sbase*1000/(3*Vph), ImaxAbs=1.2*Irated;
 const pqOver=(r,gi,lo,hi,f)=>{ const dtOut=r.t[1]-r.t[0];
  const win=Math.max(1,Math.round(1000/f/dtOut)), sh=Math.max(1,Math.round(win/4));
  const v=r.bv[gi][0], i=r.ic[gi][0]; let sp=0,sq=0,n=0;
  r.t.forEach((tv,k)=>{ if(tv<lo||tv>hi)return; sp+=v[k]*i[k]; const j=Math.min(v.length-1,k+sh); sq+=v[k]*i[j]; n++; });
  return {P:3*sp/n/1000, Q:3*sq/n/1000}; }; // 3-phase totals, kW/kvar (+ = delivering)
 const irmsMax=(r,gi,lo,hi)=>{ let mx=0; r.t.forEach((tv,k)=>{ if(tv<lo||tv>hi)return; mx=Math.max(mx,Math.abs(r.ic[gi][0][k])); }); return mx/Math.SQRT2; };
 const vrmsMax=(r,gi,lo,hi)=>{ let mx=0; r.t.forEach((tv,k)=>{ if(tv<lo||tv>hi)return; mx=Math.max(mx,Math.abs(r.bv[gi][0][k])); }); return mx/Math.SQRT2; };
 const build=(P0,Q0,extra)=>{ S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:Vph,f:60,Rs:0.5}},
   {id:2,type:'line',x:0,y:0,params:{R:0.2,L:2,Rm:0,Lm:0,C:0}},
   {id:3,type:'gfl',x:0,y:0,params:Object.assign({Sbase,Vrated:Vph,P0,Q0,Imax:1.2,Vfloor:0.5,Xt:0.1,Emax:0,KpPLL:30,KiPLL:900,f0:60},extra||{})},
   {id:4,type:'gnd',x:0,y:0,params:{}}, {id:5,type:'gnd',x:0,y:0,params:{}});
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,1]},{a:[3,0],b:[5,0]},{a:[1,0],b:[4,0]}); };

 // 1. Unity-PF setpoint tracking.
 build(100000,0);
 let r=simulate(3,1000,null,50,50);
 if(r.err){console.log('gfl: solver error:',r.err,'FAIL');process.exit(1);}
 let gi=r.curMeta.findIndex(m=>m.kind==='gfl');
 let pq=pqOver(r,gi,700,990,60);
 let eP=Math.abs(pq.P-100000)/1000, eQ=Math.abs(pq.Q)/1000;
 console.log('gfl unity PF:  P',pq.P.toFixed(0),'kW (want 100000), Q',pq.Q.toFixed(0),'kvar (want 0)');
 record('gfl','setpoint tracking: unity PF', !(eP>=5||eQ>=5));

 // 2. Leading and lagging PF.
 build(80000,-60000); r=simulate(3,1000,null,50,50); gi=r.curMeta.findIndex(m=>m.kind==='gfl'); pq=pqOver(r,gi,700,990,60);
 let ePl=Math.abs(pq.P-80000)/800, eQl=Math.abs(pq.Q+60000)/600;
 console.log('gfl leading PF: P',pq.P.toFixed(0),'kW (want 80000), Q',pq.Q.toFixed(0),'kvar (want -60000)');
 build(80000,60000); r=simulate(3,1000,null,50,50); gi=r.curMeta.findIndex(m=>m.kind==='gfl'); pq=pqOver(r,gi,700,990,60);
 let ePg=Math.abs(pq.P-80000)/800, eQg=Math.abs(pq.Q-60000)/600;
 console.log('gfl lagging PF:  P',pq.P.toFixed(0),'kW (want 80000), Q',pq.Q.toFixed(0),'kvar (want 60000)');
 record('gfl','setpoint tracking: leading and lagging PF', !(ePl>=5||eQl>=5||ePg>=5||eQg>=5));

 // 3. Current limit held at 1.2x through a depressing fault (above the floor).
 build(200000,0,{Vfloor:0.2});
 S.blocks.push({id:6,type:'fault',x:0,y:0,params:{Rf:1.0,ton:400,toff:700,ph:0}});
 S.wires.push({a:[2,1],b:[6,0]}); // fault the gfl bus (ground is internal to the fault)
 r=simulate(3,1000,null,50,50); gi=r.curMeta.findIndex(m=>m.kind==='gfl');
 const iPre=irmsMax(r,gi,300,390), iFlt=irmsMax(r,gi,500,690), iPost=irmsMax(r,gi,800,990);
 const vFlt=vrmsMax(r,gi,500,690);
 const ePre=Math.abs(iPre-(200000000/(3*vrmsMax(r,gi,300,390))))/iPre*100;
 const eLim=Math.abs(iFlt-ImaxAbs)/ImaxAbs*100;
 console.log('gfl current limit: pre',iPre.toFixed(0),'A, fault',iFlt.toFixed(0),'A (limit',ImaxAbs.toFixed(0),', V',vFlt.toFixed(0),'V/'+(vFlt/Vph).toFixed(2)+'pu, ratio',(iFlt/ImaxAbs).toFixed(2),'), post',iPost.toFixed(0),'A');
 record('gfl','current limit at 1.2x through a fault + recovery', !(ePre>=5||eLim>=10||iPost<100));

 // 4. Voltage floor ride-through: a held bolted fault drives V to ~0; injection
 //    ramps to zero (no I=P/V runaway), and the current stays bounded.
 build(100000,0);
 S.blocks.push({id:6,type:'fault',x:0,y:0,params:{Rf:0.05,ton:400,toff:800,ph:0}});
 S.wires.push({a:[2,1],b:[6,0]});
 r=simulate(3,1000,null,50,50); gi=r.curMeta.findIndex(m=>m.kind==='gfl');
 const iF4=irmsMax(r,gi,500,790), vF4=vrmsMax(r,gi,500,790);
 console.log('gfl voltage floor: held bolted fault -> Irms',iF4.toFixed(1),'A (want ~0, no runaway), Vrms',vF4.toFixed(0),'V ('+(vF4/Vph).toFixed(2)+'pu)');
 record('gfl','voltage floor ride-through: no I=P/V runaway', !(iF4>50));

 // 5. Weak-bus stability (SCR ~3): gfl settles to its setpoint on a weak bus.
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:Vph,f:60,Rs:0.2}},
  {id:2,type:'line',x:0,y:0,params:{R:0.5,L:1.5,Rm:0,Lm:0,C:0}}, // |Z|~0.75, SCR~3
  {id:3,type:'gfl',x:0,y:0,params:{Sbase,Vrated:Vph,P0:100000,Q0:0,Imax:1.2,Vfloor:0.5,f0:60}},
  {id:4,type:'gnd',x:0,y:0,params:{}}, {id:5,type:'gnd',x:0,y:0,params:{}});
 S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,1]},{a:[3,0],b:[5,0]},{a:[1,0],b:[4,0]});
 r=simulate(3,1500,null,50,50);
 if(r.err){console.log('gfl weak-bus: solver error:',r.err,'FAIL');process.exit(1);}
 gi=r.curMeta.findIndex(m=>m.kind==='gfl'); pq=pqOver(r,gi,1200,1490,60);
 const fEnd=r.aux[gi].slice(-50).reduce((s,x)=>s+x,0)/50;
 const eW=Math.abs(pq.P-100000)/1000;
 console.log('gfl weak-bus (SCR~3): P',pq.P.toFixed(0),'kW (want 100000), fpll',fEnd.toFixed(3),'Hz');
 record('gfl','weak-bus stability (SCR~3): settles to setpoint', !(eW>=5||!isFinite(fEnd)||Math.abs(fEnd-60)>1));

 // 6. PLL follows a network NOT at f0 (the feature wt4's free-running clock
 //    lacks): src at 61 Hz, gfl f0=60 -> the PLL tracks to 61 Hz.
 build(100000,0); S.blocks[0].params.f=61;
 r=simulate(3,1500,null,50,50); gi=r.curMeta.findIndex(m=>m.kind==='gfl');
 const f61=r.aux[gi].slice(-50).reduce((s,x)=>s+x,0)/50;
 pq=pqOver(r,gi,1200,1490,61);
 console.log('gfl PLL track: src=61Hz, gfl f0=60 -> fpll',f61.toFixed(3),'Hz (want 61), P',pq.P.toFixed(0),'kW');
 record('gfl','PLL follows a network not at f0', !(Math.abs(f61-61)>0.1));
}

// ---- VSC-HVDC (hvdc): scheduled transfer with efficiency deficit, link
// regulation, and reversal (SPEC section 2). Two separate grids. ----
{
 const build=(Pset)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'line',x:0,y:0,params:{R:0.2,L:2,Rm:0,Lm:0,C:0}},
   {id:3,type:'hvdc',x:0,y:0,params:{Pset,Tp:50,VdcRef:800,Cdc:20000,kp:0.5,ki:20,Prate:200,eff:0.97,QA:0,QB:0,Imax:200,vmin:50,f0:60}},
   {id:4,type:'line',x:0,y:0,params:{R:0.2,L:2,Rm:0,Lm:0,C:0}},
   {id:5,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:6,type:'gnd',x:0,y:0,params:{}},{id:7,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,1]},{a:[1,0],b:[6,0]},{a:[5,0],b:[7,0]});
 };
 const pOfSrc=(r,idx,lo,hi)=>{ let s=0,n=0;
  r.t.forEach((tv,k)=>{ if(tv<lo||tv>hi)return; s+=r.bv[idx][0][k]*r.ic[idx][0][k]+r.bv[idx][1][k]*r.ic[idx][1][k]+r.bv[idx][2][k]*r.ic[idx][2][k]; n++; });
  return s/n/1000; }; // raw 3-ph kW: + = src generating (FLOW_REVERSED raw)
 build(50);
 const r=simulate(3,900,null,50,50);
 if(r.err){console.log('hvdc: solver error:',r.err,'FAIL');process.exit(1);}
 const hs=r.curMeta.findIndex(m=>m.kind==='hvdc');
 const srcs=r.curMeta.map((m,k)=>m.type==='src'?k:-1).filter(k=>k>=0);
 const pA=pOfSrc(r,srcs[0],600,890), pB=pOfSrc(r,srcs[1],600,890);
 const vdc=r.aux[hs][r.aux[hs].length-1];
 // analytical: unity-pf constant-P at the converter bus behind Z=Rs+Rl+jX;
 // src signal plane is AFTER its internal Rs, so terminal power adds only
 // the LINE R loss. V solves E^2=(V+R*I)^2+(X*I)^2 with I=Pc/(3V).
 const w2=2*Math.PI*60, Rz=0.7, Xz=w2*2e-3, Rl=0.2, E=277;
 const termP=(Pc)=>{ let I=Pc/(3*E), Vv=E;
  for(let it=0;it<40;it++){ Vv=Math.sqrt(Math.max(1,E*E-(Xz*I)**2))-Rz*I; I=Pc/(3*Vv); }
  return (Pc+3*Rl*I*I)/1000; };
 const pAexp=termP((50/0.97)*1000), pBexp=termP(-50000);
 const eA=Math.abs(pA-pAexp)/Math.abs(pAexp)*100, eB=Math.abs(pB-pBexp)/Math.abs(pBexp)*100;
 const eV=Math.abs(vdc-800)/800*100;
 console.log('hvdc transfer: grid A supplies',pA.toFixed(2),'kW (exp',pAexp.toFixed(2),',',eA.toFixed(2)+'%), grid B receives',(-pB).toFixed(2),'kW (exp',(-pBexp).toFixed(2),',',eB.toFixed(2)+'%)',(eA<3&&eB<3)?'PASS':'FAIL');
 console.log('hvdc link: Vdc',vdc.toFixed(1),'V vs 800 ('+eV.toFixed(2)+'%)',eV<1?'PASS':'FAIL');
 build(-30);
 const r2=simulate(3,900,null,50,50);
 const srcs2=r2.curMeta.map((m,k)=>m.type==='src'?k:-1).filter(k=>k>=0);
 const pA2=pOfSrc(r2,srcs2[0],600,890), pB2=pOfSrc(r2,srcs2[1],600,890);
 const okRev=pA2<-25&&pB2>28; // grid A receives ~29, grid B supplies ~31
 console.log('hvdc reversal (Pset=-30): grid A',pA2.toFixed(2),'kW (receives), grid B',pB2.toFixed(2),'kW (supplies)',okRev?'PASS':'FAIL');
 record('hvdc','scheduled transfer + link regulation + reversal', !(eA>=3||eB>=3||eV>=1||!okRev));
}

// ---- aggregation current-scaling coupler (scale): a small reference-unit
// load is scaled up by N to represent N identical parallel replicas (SPEC
// section 2, PNNL-38817 / ERCOT GRIT "current scaling" convention). Purely
// resistive so the independent check is a plain series-divider solve:
// I_local = Vsrc/(R + Rf + N*Rs), V1 = I_local*R, I_net = N*I_local.
// Two N values, one of them non-integer (N need not be a literal replica
// count). ----
{
 const build=(N)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.1}},
   {id:2,type:'scale',x:0,y:0,params:{N,Rf:0.02}},
   {id:3,type:'rlc',x:0,y:0,params:{R:50,L:-1,C:-1}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'gnd',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[5,0]},{a:[1,0],b:[4,0]});
 };
 const rms=(v,lo,hi,t)=>{let s=0,n=0;for(let i=0;i<t.length;i++)if(t[i]>lo&&t[i]<hi){s+=v[i]*v[i];n++;}return Math.sqrt(s/Math.max(1,n));};
 const check=(N,Rs,Rf,R,Vsrc)=>{
  build(N);
  const r=simulate(3,150,null,50,50);
  if(r.err){console.log('scale N='+N+': solver error:',r.err,'FAIL');process.exit(1);}
  const si=r.curMeta.findIndex(m=>m.kind==='scale');
  const iLocal=rms(r.ic[si][0],30,140,r.t), v1=rms(r.bv[si][0],30,140,r.t), iNet=rms(r.aux[si],30,140,r.t);
  const iLocalExp=Vsrc/(R+Rf+N*Rs), v1Exp=iLocalExp*R, iNetExp=N*iLocalExp;
  const e1=Math.abs(iLocal-iLocalExp)/iLocalExp*100, e2=Math.abs(v1-v1Exp)/v1Exp*100, e3=Math.abs(iNet-iNetExp)/iNetExp*100;
  console.log('scale N='+N+': I_local',iLocal.toFixed(3),'A vs',iLocalExp.toFixed(3),'('+e1.toFixed(2)+'%), V1',v1.toFixed(2),'V vs',v1Exp.toFixed(2),'('+e2.toFixed(2)+'%), I_net',iNet.toFixed(3),'A vs',iNetExp.toFixed(3),'('+e3.toFixed(2)+'%)',(e1<1&&e2<1&&e3<1)?'PASS':'FAIL');
  return e1<1&&e2<1&&e3<1;
 };
 const ok1=check(100,0.1,0.02,50,277);   // integer replica count
 const ok2=check(2.5,0.1,0.02,50,277);   // non-integer N
 record('scale','current-scaling: I_net = N*I_local (integer + non-integer N)', ok1&&ok2);
}

// ---- frequency-dependent line (fdline): Bergeron degenerate case at
// waveform level; 60 Hz transfer vs an independent complex two-port solve
// of the same rational Zc/H (SPEC section 2). ----
{
 const build=(fd,loadR)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'fdline',x:0,y:0,params:fd},
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'probe',x:0,y:0,params:{}},
   {id:5,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[3,0]},{a:[4,0],b:[2,0]},{a:[5,0],b:[2,1]});
  if(loadR>0){ S.blocks.push({id:6,type:'rlc',x:0,y:0,params:{R:loadR,L:-1,C:-1}},{id:7,type:'gnd',x:0,y:0,params:{}});
   S.wires.push({a:[2,1],b:[6,0]},{a:[6,1],b:[7,0]}); }
 };
 // 1) degenerate to Bergeron: flat Zc, unity dc gain, fast H pole
 build({Zh:300,Zlf:300,fz:100,att:1,fh:20000,tau:1000},0);
 const r=simulate(3,4,null,50,0);
 if(r.err){console.log('fdline: solver error:',r.err,'FAIL');process.exit(1);}
 const v1=r.vp[0][0], v2=r.vp[1][0];
 const dTau=Math.round(1/(r.t[1]-r.t[0]));
 let preMax=0,errO=0,refO=0;
 r.t.forEach((tv,k)=>{ if(tv<0.95)preMax=Math.max(preMax,Math.abs(v2[k]));
  if(tv<1.2||tv>2.9)return; const ex=2*v1[k-dTau];
  errO=Math.max(errO,Math.abs(v2[k]-ex)); refO=Math.max(refO,Math.abs(ex)); });
 const relO=errO/refO*100;
 console.log('fdline Bergeron limit: |v2| pre-tau',preMax.toExponential(1),'V, open-end doubling error',relO.toFixed(2)+'% (<3)',(preMax<0.5&&relO<3)?'PASS':'FAIL');

 // 2) full rational transfer at 60 Hz vs independent complex solve
 const FD={Zh:250,Zlf:320,fz:100,att:0.9,fh:2000,tau:1000};
 build(FD,250);
 const r2=simulate(3,300,null,50,50);
 const phasorOf=(rr,pi)=>{ const w=2*Math.PI*60; const tEnd=rr.t[rr.t.length-1]; let re=0,im=0,n=0;
  for(let k=0;k<rr.t.length;k++){ if(rr.t[k]<tEnd-50)continue; const th=w*rr.t[k]*1e-3;
   re+=rr.vp[pi][0][k]*Math.sin(th); im+=rr.vp[pi][0][k]*Math.cos(th); n++; }
  return {re:2*re/n, im:2*im/n}; };
 const P1=phasorOf(r2,0), P2=phasorOf(r2,1);
 const simMag=Math.hypot(P2.re,P2.im)/Math.hypot(P1.re,P1.im);
 const simAng=(Math.atan2(P2.im,P2.re)-Math.atan2(P1.im,P1.re))*180/Math.PI;
 // independent solve: V1-Zc*I1 = H*V2*(1-Zc/R); V2*(1+Zc/R) = H*(V1+Zc*I1)
 const w=2*Math.PI*60;
 const C2=(re,im)=>({re,im}), cA2=(a,b2)=>C2(a.re+b2.re,a.im+b2.im), cS2=(a,b2)=>C2(a.re-b2.re,a.im-b2.im);
 const cM3=(a,b2)=>C2(a.re*b2.re-a.im*b2.im,a.re*b2.im+a.im*b2.re);
 const cD3=(a,b2)=>{const d=b2.re*b2.re+b2.im*b2.im;return C2((a.re*b2.re+a.im*b2.im)/d,(a.im*b2.re-a.re*b2.im)/d);};
 const pz=2*Math.PI*FD.fz, ph=2*Math.PI*FD.fh;
 const Zc=cA2(C2(FD.Zh,0),cD3(C2((FD.Zlf-FD.Zh)*pz,0),C2(pz,w)));
 const Hr=cD3(C2(FD.att*ph,0),C2(ph,w));
 const dl=w*FD.tau*1e-6, H=cM3(Hr,C2(Math.cos(dl),-Math.sin(dl)));
 // eliminate I1 via F1=V1+Zc*I1, B1=V1-Zc*I1: B1=H*F2, B2=H*F1 with
 // F2=V2(1-Zc/R), B2=V2(1+Zc/R) => F1=B2/H; V1=(F1+B1)/2
 const kR=cD3(Zc,C2(250,0));
 const V2u=C2(1,0); // unit V2, solve ratio
 const F2=cS2(V2u,cM3(kR,V2u)), B2=cA2(V2u,cM3(kR,V2u));
 const F1=cD3(B2,H), B1=cM3(H,F2);
 const V1c=cM3(C2(0.5,0),cA2(F1,B1));
 const magExp=1/Math.hypot(V1c.re,V1c.im);
 const angExp=-Math.atan2(V1c.im,V1c.re)*180/Math.PI;
 let dAg=simAng-angExp; while(dAg>180)dAg-=360; while(dAg<=-180)dAg+=360;
 const eM=Math.abs(simMag-magExp)/magExp*100, eAg=Math.abs(dAg);
 console.log('fdline 60 Hz transfer: |V2/V1|',simMag.toFixed(4),'vs analytic',magExp.toFixed(4),'('+eM.toFixed(2)+'%), phase',simAng.toFixed(2),'vs',angExp.toFixed(2),'deg (d='+eAg.toFixed(2)+')',(eM<2&&eAg<2)?'PASS':'FAIL');
 record('fdline','Bergeron limit + 60Hz transfer vs independent two-port solve', !(preMax>=0.5||relO>=3||eM>=2||eAg>=2));
}

// ---- Series RLC (rlc): -1-sentinel limiting cases cross-checked against the
// standalone load/line/cap blocks, plus a full 3-element steady state, plus a
// switched (be/CDA) case (SPEC section 2, July 2026) ----
{
 const Vs=277, Rs=0.5, w=2*Math.PI*60;
 const runDivider=blk=>{ // src(Rs)->blk->gnd divider, probe at the shared node
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:Vs,f:60,Rs}},
   Object.assign({id:2,x:0,y:0},blk),
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[4,0]},{a:[1,0],b:[3,0]},{a:[5,0],b:[2,0]});
  runEMT();
  const [t3,,vp3]=plotArgs, vv=vp3[0][0];
  return Math.max(...vv.filter((_,i)=>t3[i]>60).map(Math.abs));
 };

 // (a) rlc-as-resistor (L,C absent) vs analytical. The standalone R (load)
 // block was removed July 2026; rlc with L,C absent is its replacement, so
 // there is no separate load block to cross-check against any more.
 const vRlcR=runDivider({type:'rlc',params:{R:12,L:-1,C:-1}});
 const expR=Vs*Math.SQRT2*12/(Rs+12);
 const errRvA=Math.abs(vRlcR-expR)/expR*100;
 console.log('rlc-as-R: sim',vRlcR.toFixed(2),'V, analytical',expR.toFixed(2),'V ('+errRvA.toFixed(2)+'%)',errRvA<2?'PASS':'FAIL');

 // (b) rlc-as-RL (C absent) vs line (same R,L, C=0)
 const vRlcRL=runDivider({type:'rlc',params:{R:0.3,L:2,C:-1}});
 const vLine=runDivider({type:'line',params:{R:0.3,L:2,Rm:0,Lm:0,C:0}});
 const ZrlExp=Math.hypot(Rs+0.3,w*2e-3);
 const expRL=Vs*Math.SQRT2*Math.hypot(0.3,w*2e-3)/ZrlExp;
 const errRlcRL=Math.abs(vRlcRL-vLine)/vLine*100, errRLvA=Math.abs(vRlcRL-expRL)/expRL*100;
 console.log('rlc-as-RL: sim',vRlcRL.toFixed(2),'V vs line block',vLine.toFixed(2),'V (Δ'+errRlcRL.toFixed(3)+'%), analytical',expRL.toFixed(2),'V ('+errRLvA.toFixed(2)+'%)',(errRlcRL<0.1&&errRLvA<2)?'PASS':'FAIL');

 // (c) rlc-as-capacitor (R,L absent) vs cap
 const vRlcC=runDivider({type:'rlc',params:{R:-1,L:-1,C:100}});
 const vCap=runDivider({type:'cap',params:{C:100}});
 const Zc=1/(w*100e-6);
 const expC=Vs*Math.SQRT2*Zc/Math.hypot(Rs,Zc);
 const errRlcC=Math.abs(vRlcC-vCap)/vCap*100, errCvA=Math.abs(vRlcC-expC)/expC*100;
 console.log('rlc-as-C: sim',vRlcC.toFixed(2),'V vs cap block',vCap.toFixed(2),'V (Δ'+errRlcC.toFixed(3)+'%), analytical',expC.toFixed(2),'V ('+errCvA.toFixed(2)+'%)',(errRlcC<0.1&&errCvA<2)?'PASS':'FAIL');

 // (d) full 3-element series RLC (R,L,C all present) vs analytical |Z| divider
 const Rf=10, Lf=5e-3, Cf=100e-6;
 const vRlcFull=runDivider({type:'rlc',params:{R:Rf,L:5,C:100}});
 const Xf=w*Lf-1/(w*Cf);
 const Zfull=Math.hypot(Rs+Rf,Xf);
 const expFull=Vs*Math.SQRT2*Math.hypot(Rf,Xf)/Zfull;
 const errFull=Math.abs(vRlcFull-expFull)/expFull*100;
 console.log('rlc full R+L+C: sim',vRlcFull.toFixed(2),'V vs analytical',expFull.toFixed(2),'V ('+errFull.toFixed(2)+'%)',errFull<2?'PASS':'FAIL');

 record('rlc','sentinel limiting cases + full RLC vs analytical divider', !(errRvA>=2||errRlcRL>=0.1||errRLvA>=2||errRlcC>=0.1||errCvA>=2||errFull>=2));
}

// ---- switched series RLC: exercise the be/CDA half-step at a breaker
// closing event, confirm bounded settling with no spurious growth ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 const Vs=277, Rs=0.5, Rload=1, Rf=10, Lf=5, Cf=100;
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:Vs,f:60,Rs}},
  {id:2,type:'brk',x:0,y:0,params:{tclose:30,topen:-1,init:0}},
  {id:3,type:'rlc',x:0,y:0,params:{R:Rf,L:Lf,C:Cf}},
  {id:4,type:'rlc',x:0,y:0,params:{R:Rload,L:-1,C:-1}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'gnd',x:0,y:0,params:{}},
  {id:7,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},
  {a:[1,0],b:[5,0]},{a:[4,1],b:[6,0]},{a:[7,0],b:[3,1]}
 );
 runEMT();
 const [t4,,vp4]=plotArgs, vSw=vp4[0][0];
 const finite=vSw.every(x=>Number.isFinite(x));
 const w2=2*Math.PI*60;
 const X=w2*(Lf*1e-3)-1/(w2*Cf*1e-6);
 const Ztot=Math.hypot(Rs+Rf+Rload,X);
 const expSw=Vs*Math.SQRT2*Rload/Ztot;
 const vSettled=Math.max(...vSw.filter((_,i)=>t4[i]>90).map(Math.abs));
 const vAny=Math.max(...vSw.map(x=>Number.isFinite(x)?Math.abs(x):0));
 const errSw=Math.abs(vSettled-expSw)/expSw*100;
 const noBlowup=vAny<expSw*2.5; // generous margin: no CDA-induced runaway
 console.log('rlc switched (be-branch): finite',finite,'settled',vSettled.toFixed(2),'V vs analytical',expSw.toFixed(2),'V ('+errSw.toFixed(2)+'%), peak anywhere',vAny.toFixed(2),'V, no-blowup',noBlowup,(finite&&errSw<2&&noBlowup)?'PASS':'FAIL');
 record('rlc','switched be/CDA half-step: bounded settling, no blowup', finite&&errSw<2&&noBlowup);
}

// ---- Parallel RLC (rlcp): -1-sentinel limiting cases cross-checked against the
// standalone load/line/cap blocks, plus full 3-branch steady state, resonance
// peak check (parallel peaks impedance at f0 — opposite of series), and a
// switched (be/CDA) case (SPEC section 2, July 2026) ----
{
 const Vs=277, Rs=0.5, w=2*Math.PI*60;
 const runDivider=blk=>{ // src(Rs)->blk->gnd divider, probe at the shared node
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:Vs,f:60,Rs}},
   Object.assign({id:2,x:0,y:0},blk),
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[4,0]},{a:[1,0],b:[3,0]},{a:[5,0],b:[2,0]});
  runEMT();
  const [t3,,vp3]=plotArgs, vv=vp3[0][0];
  return Math.max(...vv.filter((_,i)=>t3[i]>60).map(Math.abs));
 };

 // (a) rlcp-as-resistor (L,C absent) vs analytical. Standalone R (load)
 // block removed July 2026; rlcp with L,C absent is the parallel-R replacement.
 const vRlcpR=runDivider({type:'rlcp',params:{R:12,L:-1,C:-1}});
 const expR=Vs*Math.SQRT2*12/(Rs+12);
 const errRvA=Math.abs(vRlcpR-expR)/expR*100;
 console.log('rlcp-as-R: sim',vRlcpR.toFixed(2),'V, analytical',expR.toFixed(2),'V ('+errRvA.toFixed(2)+'%)',errRvA<2?'PASS':'FAIL');

 // (b) rlcp-as-inductor (R,C absent) vs line with R=0
 const vRlcpL=runDivider({type:'rlcp',params:{R:-1,L:2,C:-1}});
 const vLine=runDivider({type:'line',params:{R:0,L:2,Rm:0,Lm:0,C:0}});
 const ZlExp=Math.hypot(Rs,w*2e-3);
 const expL=Vs*Math.SQRT2*w*2e-3/ZlExp;
 const errRlcpL=Math.abs(vRlcpL-vLine)/vLine*100, errLvA=Math.abs(vRlcpL-expL)/expL*100;
 console.log('rlcp-as-L: sim',vRlcpL.toFixed(2),'V vs line(R=0) block',vLine.toFixed(2),'V (Δ'+errRlcpL.toFixed(3)+'%), analytical',expL.toFixed(2),'V ('+errLvA.toFixed(2)+'%)',(errRlcpL<0.1&&errLvA<2)?'PASS':'FAIL');

 // (c) rlcp-as-capacitor (R,L absent) vs cap
 const vRlcpC=runDivider({type:'rlcp',params:{R:-1,L:-1,C:100}});
 const vCap=runDivider({type:'cap',params:{C:100}});
 const Zc=1/(w*100e-6);
 const expC=Vs*Math.SQRT2*Zc/Math.hypot(Rs,Zc);
 const errRlcpC=Math.abs(vRlcpC-vCap)/vCap*100, errCvA=Math.abs(vRlcpC-expC)/expC*100;
 console.log('rlcp-as-C: sim',vRlcpC.toFixed(2),'V vs cap block',vCap.toFixed(2),'V (Δ'+errRlcpC.toFixed(3)+'%), analytical',expC.toFixed(2),'V ('+errCvA.toFixed(2)+'%)',(errRlcpC<0.1&&errCvA<2)?'PASS':'FAIL');

 // (d) full 3-branch parallel admittance divider: Y = 1/R + 1/(jwL) + jwC,
 // Zblk = 1/Y, then Vtap = Vs_peak * Zblk / (Rs + Zblk) magnitude
 const Rp=50, Lp=20, Cp=100;
 const Yre=1/Rp, Yim=-1/(w*Lp*1e-3)+w*Cp*1e-6;
 const Zblk={re:Yre/(Yre*Yre+Yim*Yim), im:-Yim/(Yre*Yre+Yim*Yim)}; // 1/Y in rectangular
 const Ztot={re:Rs+Zblk.re, im:Zblk.im};
 const expFull=Vs*Math.SQRT2*Math.hypot(Zblk.re,Zblk.im)/Math.hypot(Ztot.re,Ztot.im);
 const vRlcpFull=runDivider({type:'rlcp',params:{R:Rp,L:Lp,C:Cp}});
 const errFull=Math.abs(vRlcpFull-expFull)/expFull*100;
 console.log('rlcp full R||L||C: sim',vRlcpFull.toFixed(2),'V vs analytical admittance divider',expFull.toFixed(2),'V ('+errFull.toFixed(2)+'%)',errFull<2?'PASS':'FAIL');

 // (e) resonance check: parallel RLC peaks in impedance at f0 = 1/(2pi*sqrt(LC)),
 // unlike series which dips. Compare |V| at f0 vs 0.8*f0 and 1.2*f0 — f0 must
 // be HIGHER, confirming the topology is truly parallel, not copy-pasted series.
 const Rt=100, Lt=5, Ct=100;
 const f0=1/(2*Math.PI*Math.sqrt(Lt*1e-3*Ct*1e-6));
 const runAtF=(freq)=>{
  S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:Vs,f:freq,Rs}},
   {id:2,type:'rlcp',x:0,y:0,params:{R:Rt,L:Lt,C:Ct}},
   {id:3,type:'gnd',x:0,y:0,params:{}},
   {id:4,type:'gnd',x:0,y:0,params:{}},
   {id:5,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[4,0]},{a:[1,0],b:[3,0]},{a:[5,0],b:[2,0]});
  runEMT();
  const [tr,,vpr]=plotArgs, vvr=vpr[0][0];
  return Math.max(...vvr.filter((_,i)=>tr[i]>60).map(Math.abs));
 };
 const vF0=runAtF(f0), vF80=runAtF(0.8*f0), vF120=runAtF(1.2*f0);
 const peaksAtResonance=vF0>vF80&&vF0>vF120;
 console.log('rlcp resonance: |V| at f0=',vF0.toFixed(2),'V, at 0.8*f0=',vF80.toFixed(2),'V, at 1.2*f0=',vF120.toFixed(2),'V (parallel peaks at f0)',peaksAtResonance?'PASS':'FAIL');

 record('rlcp','sentinel limiting cases + full RLCP + resonance peak', !(errRvA>=2||errRlcpL>=0.1||errLvA>=2||errRlcpC>=0.1||errCvA>=2||errFull>=2||!peaksAtResonance));
}

// ---- switched parallel RLC: exercise the be/CDA half-step at a breaker
// closing event, confirm bounded settling with no spurious growth ----
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 const Vs=277, Rs=0.5, Rload=1, Rp=100, Lp=5, Cp=100;
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:Vs,f:60,Rs}},
  {id:2,type:'brk',x:0,y:0,params:{tclose:30,topen:-1,init:0}},
  {id:3,type:'rlcp',x:0,y:0,params:{R:Rp,L:Lp,C:Cp}},
  {id:4,type:'rlc',x:0,y:0,params:{R:Rload,L:-1,C:-1}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'gnd',x:0,y:0,params:{}},
  {id:7,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},
  {a:[1,0],b:[5,0]},{a:[4,1],b:[6,0]},{a:[7,0],b:[3,1]}
 );
 runEMT();
 const [t4,,vp4]=plotArgs, vSw=vp4[0][0];
 const finite=vSw.every(x=>Number.isFinite(x));
 const w2=2*Math.PI*60;
 // analytical: parallel Y = 1/Rp + 1/(jwL) + jwC, Zblk=1/Y, then divider through Rs+Rload
 const Yre=1/Rp, Yim=-1/(w2*Lp*1e-3)+w2*Cp*1e-6;
 const Zblk={re:Yre/(Yre*Yre+Yim*Yim), im:-Yim/(Yre*Yre+Yim*Yim)};
 // total impedance from source to load: Rs + Zblk + Rload
 const Ztot={re:Rs+Rload+Zblk.re, im:Zblk.im};
 const expSw=Vs*Math.SQRT2*Rload/Math.hypot(Ztot.re,Ztot.im);
 const vSettled=Math.max(...vSw.filter((_,i)=>t4[i]>90).map(Math.abs));
 const vAny=Math.max(...vSw.map(x=>Number.isFinite(x)?Math.abs(x):0));
 const errSw=Math.abs(vSettled-expSw)/expSw*100;
 const noBlowup=vAny<expSw*2.5; // generous margin: no CDA-induced runaway
 console.log('rlcp switched (be-branch): finite',finite,'settled',vSettled.toFixed(2),'V vs analytical',expSw.toFixed(2),'V ('+errSw.toFixed(2)+'%), peak anywhere',vAny.toFixed(2),'V, no-blowup',noBlowup,(finite&&errSw<2&&noBlowup)?'PASS':'FAIL');
 record('rlcp','switched be/CDA half-step: bounded settling, no blowup', finite&&errSw<2&&noBlowup);
}

// ---- new standalone checks for blocks that previously had no dedicated
// assertion (SPEC §5 item 9 coverage gap): cpl (constant-power load), src
// (isolated source: open-circuit EMF + frequency), gnd (pins node to 0),
// probe (passive node-voltage read, does not load). Plus an independent-solver
// cross-check of the demo circuit pointing a second block at
// tests/reference/phasor.js alongside the pi-line check. ----

// cpl: a battery-held DC bus feeds a constant-power load; at steady state the
// cpl draws exactly P/Vbus and the battery supplies that same current.
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'batt',x:0,y:0,params:{Vref:360,Imax:50,kp:2,ki:2000,Ah:0.02,soc0:100,Ichg:10}},
  {id:2,type:'cap',x:0,y:0,params:{C:1000}},
  {id:3,type:'cpl',x:0,y:0,params:{P:10,vmin:300}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push(
  {a:[1,1],b:[2,0]},{a:[2,1],b:[4,0]},
  {a:[2,0],b:[3,0]},{a:[3,1],b:[5,0]},
  {a:[1,0],b:[4,0]},{a:[6,0],b:[2,0]}
 );
 els_stubs.phmode.value='1';
 runEMT();
 els_stubs.phmode.value='3';
 console.log('cpl status:', els_stubs.stat.textContent);
 const [tC,,vpC,elsC,ieC]=plotArgs;
 const avg=(a,lo)=>{ const s=a.filter((_,i)=>tC[i]>lo); return s.reduce((x,y)=>x+y,0)/s.length; };
 const vBus=avg(vpC[0][0],90);
 const ci=elsC.findIndex(e=>e.kind==='cpl'), bi=elsC.findIndex(e=>e.kind==='batt');
 const iCpl=avg(ieC[ci][0],90), iBatt=avg(ieC[bi][0],90);
 const iExp=10000/vBus;
 const errCpl=Math.abs(Math.abs(iCpl)-iExp)/iExp*100;
 const errBal=Math.abs(Math.abs(iBatt)-Math.abs(iCpl))/Math.max(1e-9,Math.abs(iCpl))*100;
 console.log('cpl: bus |V|',vBus.toFixed(1),'V (battery Vref 360)',Math.abs(vBus-360)<3.6?'PASS':'FAIL');
 console.log('cpl: drawn I',Math.abs(iCpl).toFixed(2),'A vs P/Vbus',iExp.toFixed(2),'A, error:',errCpl.toFixed(2)+'%',errCpl<2?'PASS':'FAIL');
 console.log('cpl: battery supplies the load (power balance)',errBal.toFixed(2)+'%',errBal<2?'PASS':'FAIL');
 record('cpl','DC constant-power load: I=P/V + battery power balance', Math.abs(vBus-360)<3.6&&errCpl<2&&errBal<2);
}

// src: open-circuit (probe only, no load) terminal voltage equals Vrms*sqrt2
// and the source sets the frequency exactly. The demo divider test elsewhere
// exercises src under load; this is the isolated source model.
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'gnd',x:0,y:0,params:{}},
  {id:3,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[3,0]},{a:[1,0],b:[2,0]});
 runEMT();
 console.log('src status:', els_stubs.stat.textContent);
 const [tS,,vpS]=plotArgs;
 const v=vpS[0][0];
 const vPk=Math.max(...v.map(Math.abs));
 const vExp=277*Math.SQRT2;
 const errV=Math.abs(vPk-vExp)/vExp*100;
 // frequency from interpolated zero upcrossings
 const xs=[];
 for(let i=1;i<v.length;i++){ if(tS[i]>10&&tS[i]<100&&v[i-1]<0&&v[i]>=0) xs.push(tS[i-1]+(tS[i]-tS[i-1])*(-v[i-1])/(v[i]-v[i-1])); }
 let fMeas=0; if(xs.length>=2) fMeas=1000*(xs.length-1)/(xs[xs.length-1]-xs[0]);
 const errF=Math.abs(fMeas-60);
 console.log('src: open-circuit |V| peak',vPk.toFixed(2),'V vs',vExp.toFixed(2),'V ('+errV.toFixed(3)+'%), frequency',fMeas.toFixed(3),'Hz (expect 60), |df|',errF.toFixed(3),'Hz');
 record('src','open-circuit EMF = Vrms*sqrt2 + frequency = f', errV<0.1&&errF<0.05);
}

// gnd: a grounded node sits at exactly 0 V (the solver's reference).
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
  {id:3,type:'gnd',x:0,y:0,params:{}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[4,0]},{a:[1,0],b:[3,0]},{a:[5,0],b:[3,0]});
 runEMT();
 console.log('gnd status:', els_stubs.stat.textContent);
 const [tG,,vpG]=plotArgs;
 const g=vpG[0][0];
 const gMax=Math.max(...g.map(Math.abs));
 console.log('gnd: grounded node |V| max',gMax.toExponential(2),'V (expect ~0)');
 record('gnd','grounded node pins to 0 V', gMax<1e-6);
}

// probe: reads node voltage without loading it. The same node read by two
// independent probes must be identical, and the probe reading must equal the
// node the bus test already verified (a passive tap).
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
  {id:3,type:'gnd',x:0,y:0,params:{}},
  {id:4,type:'gnd',x:0,y:0,params:{}},
  {id:5,type:'probe',x:0,y:0,params:{}},
  {id:6,type:'probe',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[4,0]},{a:[1,0],b:[3,0]},{a:[5,0],b:[2,0]},{a:[6,0],b:[2,0]});
 runEMT();
 console.log('probe status:', els_stubs.stat.textContent);
 const [tP,,vpP]=plotArgs;
 const a=vpP[0][0], b=vpP[1][0];
 let dmax=0; for(let i=0;i<a.length;i++) dmax=Math.max(dmax,Math.abs(a[i]-b[i]));
 const finite=a.every(x=>Number.isFinite(x));
 console.log('probe: two probes on same node, max |diff|',dmax.toExponential(2),'V, all finite',finite);
 record('probe','passive read: two probes on same node agree, no loading', dmax<1e-9&&finite);
}

// Independent-solver cross-check of the demo circuit (src + line + rlc load)
// via tests/reference/phasor.js. The demo's existing check uses a hand-rolled
// series-divider formula; this one solves the same circuit as a 2-node complex
// nodal system through the independent helper, a different code path than
// either the hand formula or the time-domain companion model.
{
 const ex={blocks:[
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'line',x:0,y:0,params:{R:0.3,L:2,Rm:0,Lm:0,C:0}},
  {id:3,type:'rlc',x:0,y:0,params:{R:12,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}},{id:5,type:'gnd',x:0,y:0,params:{}},
  {id:6,type:'probe',x:0,y:0,params:{}}
 ],wires:[{a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[1,0],b:[4,0]},{a:[3,1],b:[5,0]},{a:[6,0],b:[2,1]}]};
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(...ex.blocks); S.wires.push(...ex.wires);
 runEMT();
 const [tD,,vpD]=plotArgs;
 const v=vpD[0][0];
 const vmax=Math.max(...v.filter((_,i)=>tD[i]>60).map(Math.abs));
 const PH=require('./tests/reference/phasor.js');
 const w=2*Math.PI*60, Rs=0.5, Rl=0.3, Lh=2e-3, Rload=12, Vs=277*Math.SQRT2;
 // 2 unknown nodes: A (after source Rs), B (load bus, between line and load).
 // Norton of the source injects Vs/Rs into A; line is the A<->B series branch;
 // load is B to ground; nothing else shunts either node.
 const Vp=PH.nodalSolve(2, PH.c(0,0),
  { 0: PH.c(Vs/Rs, 0) },
  [ {from:-1,to:0,y:PH.c(1/Rs,0)},
    {from:0,to:1,y:PH.cinv(PH.c(Rl, w*Lh))},
    {from:-1,to:1,y:PH.c(1/Rload,0)} ]);
 const refMag=PH.cabs(Vp[1]);
 const err=Math.abs(vmax-refMag)/refMag*100;
 console.log('demo independent nodal solve: sim',vmax.toFixed(2),'V vs helper',refMag.toFixed(2),'V, error:',err.toFixed(2)+'%',err<1?'PASS':'FAIL');
 record('solver','demo circuit: independent 2-node nodal cross-check (phasor.js)', err<1);
}

// ==== July 2026 solver-review regression guards ====
// Each check below pins a fix from the 2026-07-20 solver/physics review
// (DECISIONS.md): DC-clamp single-copy for per-phase-looped spanning lines,
// power-flow series-element handling, and the silent-NaN failure class.

// pi-line on a DC network must run ONE copy: before the fix the ph-loop
// stamped the same DC unknown nph times (3 parallel lines, R/3 — measured
// 348.4 V here instead of 327.3). 1-ph and 3-ph must agree with the divider.
{
 const battP={Vref:360,Imax:50,kp:2,ki:2000,Ah:0.02,soc0:100,Ichg:10};
 const build=(lineP)=>{ S.blocks.length=0; S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'batt',x:0,y:0,params:Object.assign({},battP)},
   {id:2,type:'cap',x:0,y:0,params:{C:1000}},
   {id:3,type:'line',x:0,y:0,params:lineP},
   {id:4,type:'rlc',x:0,y:0,params:{R:10,L:-1,C:-1}},
   {id:5,type:'gnd',x:0,y:0,params:{}},
   {id:6,type:'probe',x:0,y:0,params:{}}
  );
  S.wires.push({a:[1,0],b:[5,0]},{a:[1,1],b:[2,0]},{a:[2,1],b:[5,0]},
   {a:[1,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,0]},{a:[6,0],b:[4,0]});
 };
 const vEnd=(nph,lineP,Tms)=>{ build(lineP); const r=simulate(nph,Tms,null,50,0);
  if(r.err){console.log('  err:',r.err); return NaN;} const v=r.vp[0][0]; return v[v.length-1]; };
 const pi1=vEnd(1,{R:1,L:1,Rm:0,Lm:0,C:10},200), pi3=vEnd(3,{R:1,L:1,Rm:0,Lm:0,C:10},200);
 const piExp=360*10/11;
 const okPi=Math.abs(pi1-piExp)/piExp<0.01 && Math.abs(pi3-piExp)/piExp<0.01;
 console.log('pi-line on DC: 1-ph',pi1.toFixed(1),'V, 3-ph',pi3.toFixed(1),'V, divider',piExp.toFixed(1),'V',okPi?'PASS':'FAIL');
 record('line','pi-line on DC runs one copy (3-ph == 1-ph == divider)', okPi);
 // same clamp fix for the Bergeron line: lumped R divider must hold in both modes
 const tl3=(()=>{ // same circuit shape with a tline in the line slot
  const bt=(nph)=>{ S.blocks.length=0; S.wires.length=0; S.vconv='ph';
   S.blocks.push(
    {id:1,type:'batt',x:0,y:0,params:Object.assign({},battP)},
    {id:2,type:'cap',x:0,y:0,params:{C:1000}},
    {id:3,type:'tline',x:0,y:0,params:{Z:50,tau:100,R:10}},
    {id:4,type:'rlc',x:0,y:0,params:{R:50,L:-1,C:-1}},
    {id:5,type:'gnd',x:0,y:0,params:{}},
    {id:6,type:'probe',x:0,y:0,params:{}}
   );
   S.wires.push({a:[1,0],b:[5,0]},{a:[1,1],b:[2,0]},{a:[2,1],b:[5,0]},
    {a:[1,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,0]},{a:[6,0],b:[4,0]});
   const r=simulate(nph,100,null,50,0);
   if(r.err){console.log('  err:',r.err); return NaN;} const v=r.vp[0][0]; return v[v.length-1]; };
  return [bt(1),bt(3)]; })();
 const tlExp=360*50/60;
 const okTl=Math.abs(tl3[0]-tlExp)/tlExp<0.01 && Math.abs(tl3[1]-tlExp)/tlExp<0.01;
 console.log('tline on DC: 1-ph',tl3[0].toFixed(1),'V, 3-ph',tl3[1].toFixed(1),'V, divider',tlExp.toFixed(1),'V',okTl?'PASS':'FAIL');
 record('tline','tline on DC runs one copy (lumped-R divider both modes)', okTl);
}

// power flow: a series relay must be stamped (its EMT closed-breaker
// conductance), not silently sever the network — before the fix the PF
// "converged" with the downstream bus at 0 V while the EMT run gave 264 V.
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'brk',x:0,y:0,params:{tclose:0,topen:-1,init:1,nOps:1}},
  {id:3,type:'relay',x:0,y:0,params:{Ipu:1000,curve:'VI',TD:0.5,Iinst:0,brkId:2,f:60}},
  {id:4,type:'rlc',x:0,y:0,params:{R:10,L:-1,C:-1}},
  {id:5,type:'bus',x:0,y:0,params:{name:'LOAD',taps:1,len:50,Vbase:0}},
  {id:6,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,0],b:[6,0]},{a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},
  {a:[3,1],b:[4,0]},{a:[4,1],b:[6,0]},{a:[5,0],b:[4,0]});
 const pfr=solvePowerFlow();
 const loadBus=pfr.busBlocks&&pfr.busBlocks.find(bb=>bb.name==='LOAD');
 const okRly=!pfr.err&&pfr.converged&&loadBus&&Math.abs(loadBus.Vmag-277)/277<0.005;
 console.log('PF series relay: converged',pfr.err?('ERR '+pfr.err):pfr.converged,'load bus',loadBus?loadBus.Vmag.toFixed(1):'-','V (expect ~277, was 0 pre-fix)',okRly?'PASS':'FAIL');
 record('powerflow','series relay stamped: downstream bus stays connected', okRly);
 // an unstampable series block (tline here) must be rejected with a clear
 // error, not a converged solution with dead downstream buses
 S.blocks[2]={id:3,type:'tline',x:0,y:0,params:{Z:300,tau:100,R:0}};
 const pfr2=solvePowerFlow();
 const okRej=!!(pfr2.err&&pfr2.err.includes('series element'));
 console.log('PF unstampable series block:',pfr2.err||'NO ERROR',okRej?'PASS':'FAIL');
 record('powerflow','tline/fdline/scale/tap rejected with clear PF error', okRej);
}

// silent-NaN class: an invalid transformer ratio and a 0 Ω / 0 mH series
// branch both used to run the whole simulation and output NaN with no error.
{
 S.blocks.length=0; S.wires.length=0; S.vconv='ph';
 S.blocks.push(
  {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
  {id:2,type:'xfmr',x:0,y:0,params:{V1:240,V2:0,R:0.1,L:0.5,Lm:0,lknee:0,Lsat:20}},
  {id:3,type:'rlc',x:0,y:0,params:{R:10,L:-1,C:-1}},
  {id:4,type:'gnd',x:0,y:0,params:{}}
 );
 S.wires.push({a:[1,0],b:[4,0]},{a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]});
 const rx=simulate(3,20,null,50,0);
 const okXV=!!(rx.err&&rx.err.includes('winding voltages'));
 console.log('xfmr V2=0:',rx.err||'NO ERROR',okXV?'PASS':'FAIL');
 record('xfmr','V2=0 rejected with clear error (no silent NaN run)', okXV);
 // 0 Ω / 0 mH line: caught by the first-step NaN guard
 S.blocks[1]={id:2,type:'line',x:0,y:0,params:{R:0,L:0,Rm:0,Lm:0,C:0}};
 const rn=simulate(3,20,null,50,0);
 const okNaN=!!(rn.err&&rn.err.includes('NaN'));
 console.log('0Ω/0mH line:',rn.err||'NO ERROR',okNaN?'PASS':'FAIL');
 record('solver','first-step NaN guard catches invalid stamp', okNaN);
 // rlcp R=0 in series is now a floored hard short (1e-6 Ω), not an
 // Infinity stamp that NaNs the LU: divider must read the full source drop
 S.blocks[1]={id:2,type:'rlcp',x:0,y:0,params:{R:0,L:-1,C:-1}};
 const rs=simulate(1,50,null,50,0);
 let okShort=false, vpk=0;
 if(!rs.err){
  const li=rs.curMeta.findIndex(m=>m.type==='rlc');
  const v=rs.bv[li][0].filter((_,i)=>rs.t[i]>30);
  vpk=Math.max(...v.map(Math.abs));
  const exp=277*Math.SQRT2*10/10.5;
  okShort=Number.isFinite(vpk)&&Math.abs(vpk-exp)/exp<0.02;
  console.log('series rlcp R=0: load peak',vpk.toFixed(1),'V vs divider',exp.toFixed(1),'V',okShort?'PASS':'FAIL');
 } else console.log('series rlcp R=0: unexpected error',rs.err,'FAIL');
 record('rlcp','R=0 floored short: series use solves finite + divider', okShort);
}

// ---- single-phase lateral tap (tap): a lateral off a 3-phase feeder must
// (a) match an INDEPENDENT complex-phasor solve of the same circuit,
// (b) leave the two untapped phases exactly symmetric, and (c) sag only the
// tapped phase. 50 Hz + 50 us step gives 400 samples per cycle exactly, so
// every RMS window here is an integer number of cycles (the standing project
// rule -- a fractional window made the two untapped phases disagree by 0.6%
// in a circuit where symmetry demands they match to machine precision).
{
 const F=50,Rs=0.5,Rl=0.3,Ll=2,Rload=20,R3=40,V=277,Rc=1e-4;
 const mk=ph=>{
  S.blocks.length=0;S.wires.length=0;S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:V,f:F,Rs:Rs}},
   {id:2,type:'bus',x:0,y:0,params:{name:'FEEDER',taps:3,len:50,Vbase:0}},
   {id:3,type:'tap',x:0,y:0,params:{ph:ph,Rc:Rc}},
   {id:4,type:'line',x:0,y:0,params:{R:Rl,L:Ll,Rm:0,Lm:0,C:0}},
   {id:5,type:'rlc',x:0,y:0,params:{R:Rload,L:-1,C:-1}},
   {id:6,type:'gnd',x:0,y:0,params:{}},{id:7,type:'gnd',x:0,y:0,params:{}},
   {id:8,type:'probe',x:0,y:0,params:{}},
   {id:9,type:'rlc',x:0,y:0,params:{R:R3,L:-1,C:-1}},
   {id:10,type:'gnd',x:0,y:0,params:{}});
  S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,0]},
   {a:[1,0],b:[6,0]},{a:[5,1],b:[7,0]},{a:[8,0],b:[4,1]},{a:[2,2],b:[9,0]},{a:[9,1],b:[10,0]});
 };
 const w=2*Math.PI*F;
 const ci=a=>{const d=a.re*a.re+a.im*a.im;return{re:a.re/d,im:-a.im/d};};
 const cm=(a,b)=>({re:a.re*b.re-a.im*b.im,im:a.re*b.im+a.im*b.re});
 const cadd=(a,b)=>({re:a.re+b.re,im:a.im+b.im});
 const cab=a=>Math.hypot(a.re,a.im);
 const Ys=ci({re:Rs,im:0}),Y3=ci({re:R3,im:0}),Yl=ci({re:Rc+Rl+Rload,im:w*Ll*1e-3});
 const VbT=cm({re:V,im:0},cm(Ys,ci(cadd(cadd(Ys,Y3),Yl))));
 const VbU=cm({re:V,im:0},cm(Ys,ci(cadd(Ys,Y3))));
 const IlatX=cab(cm(VbT,Yl)),VlatX=IlatX*Rload,I3T=cab(cm(VbT,Y3)),I3U=cab(cm(VbU,Y3));
 const SPC=Math.round(1/F/50e-6),WIN=5*SPC;
 const rmsW=a=>{const t=a.slice(a.length-WIN);return Math.sqrt(t.reduce((s,x)=>s+x*x,0)/WIN);};
 let allOk=true;
 for(const ph of [1,2,3]){
  mk(ph);
  const r=simulate(3,200,null,50,0);
  if(r.err){console.log('tap phase '+ph+': solver error',r.err,'FAIL');allOk=false;break;}
  const li=r.curMeta.findIndex(m=>m.id===5), pi=r.probeMeta.findIndex(m=>m.id===8),
        b3=r.curMeta.findIndex(m=>m.id===9);
  const metaOk=r.curMeta[li].np===1&&r.curMeta[li].ph0===ph-1&&r.probeMeta[pi].ph1===ph-1;
  const Il=rmsW(r.ic[li][0]),Vl=rmsW(r.vp[pi][0]);
  const i3=[0,1,2].map(p=>rmsW(r.ic[b3][p]));
  const un=[0,1,2].filter(p=>p!==ph-1);
  const sym=Math.abs(i3[un[0]]-i3[un[1]]);
  const eI=Math.abs(Il-IlatX)/IlatX, eV=Math.abs(Vl-VlatX)/VlatX;
  const eT=Math.abs(i3[ph-1]-I3T)/I3T, eU=Math.max.apply(null,un.map(p=>Math.abs(i3[p]-I3U)/I3U));
  const sag=i3[ph-1]<I3U*0.999;
  const ok=metaOk&&eI<0.01&&eV<0.01&&eT<0.01&&eU<0.01&&sym<1e-9&&sag;
  console.log('tap phase '+'ABC'[ph-1]+': I '+Il.toFixed(3)+'/'+IlatX.toFixed(3)
   +' V '+Vl.toFixed(1)+'/'+VlatX.toFixed(1)+' 3ph['+i3.map(x=>x.toFixed(3)).join(',')
   +'] sym '+sym.toExponential(1)+(metaOk?'':' META-FAIL')+' '+(ok?'PASS':'FAIL'));
  allOk=allOk&&ok;
 }
 record('tap','1-ph lateral on A/B/C vs independent phasor solve (<1%), untapped phases symmetric', allOk);

 // phase identity: the lateral voltage must track ITS OWN source phase
 mk(3);
 { const r=simulate(3,200,null,50,0);
   const pi=r.probeMeta.findIndex(m=>m.id===8);
   const ts=r.t.slice(r.t.length-WIN),vl=r.vp[pi][0].slice(r.vp[pi][0].length-WIN);
   const corr=k=>{const rf=ts.map(tm=>Math.sin(w*tm/1000+[0,-2*Math.PI/3,2*Math.PI/3][k]));
     return vl.reduce((a,x,i)=>a+x*rf[i],0)/Math.sqrt(vl.reduce((a,x)=>a+x*x,0)*rf.reduce((a,x)=>a+x*x,0));};
   const c=[0,1,2].map(corr);
   const ok=Math.abs(c[2])>0.99&&Math.abs(c[0])<0.7&&Math.abs(c[1])<0.7;
   console.log('tap phase identity (C lateral) corr A/B/C:',c.map(x=>x.toFixed(3)).join(' '),ok?'PASS':'FAIL');
   record('tap','lateral voltage tracks its own source phase, not A', ok);
 }

 // 1-ph pole-top transformer on a lateral: the phase must propagate THROUGH
 // the transformer to its secondary. Without this the secondary silently
 // stayed 3-phase and only one of its three phases was ever energized.
 { S.blocks.length=0;S.wires.length=0;S.vconv='ph';
   S.blocks.push(
    {id:1,type:'src',x:0,y:0,params:{Vrms:2400,f:60,Rs:0.5}},
    {id:2,type:'tap',x:0,y:0,params:{ph:2,Rc:1e-4}},
    {id:3,type:'xfmr',x:0,y:0,params:{V1:2400,V2:240,R:0.2,L:1,Lm:0,lknee:0}},
    {id:4,type:'rlc',x:0,y:0,params:{R:2,L:-1,C:-1}},
    {id:5,type:'gnd',x:0,y:0,params:{}},{id:6,type:'gnd',x:0,y:0,params:{}},
    {id:7,type:'probe',x:0,y:0,params:{}});
   S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,0]},
    {a:[1,0],b:[6,0]},{a:[7,0],b:[3,1]});
   const r=simulate(3,200,null,50,0);
   let ok=false,pk=0;
   if(!r.err){
    const pi=r.probeMeta.findIndex(m=>m.id===7);
    const v=r.vp[pi][0].slice(Math.floor(r.vp[pi][0].length*0.7));
    pk=Math.max.apply(null,v.map(Math.abs));
    ok=r.probeMeta[pi].ph1===1&&pk>300&&pk<345;
   }
   console.log('tap + 1-ph xfmr 2400/240 on phase B: secondary peak',pk.toFixed(1),'V',ok?'PASS':'FAIL');
   record('tap','phase propagates through a 1-ph transformer to its secondary', ok);
 }

 // error paths: only a tap may bridge, spanning-model blocks are refused on a
 // lateral, the positive-sequence PF refuses the circuit, 1-ph is transparent.
 { const base=()=>{S.blocks.length=0;S.wires.length=0;S.vconv='ph';
    S.blocks.push({id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
     {id:2,type:'tap',x:0,y:0,params:{ph:2,Rc:1e-4}},
     {id:3,type:'line',x:0,y:0,params:{R:0.3,L:2,Rm:0,Lm:0,C:0}},
     {id:4,type:'rlc',x:0,y:0,params:{R:20,L:-1,C:-1}},
     {id:5,type:'gnd',x:0,y:0,params:{}},{id:6,type:'gnd',x:0,y:0,params:{}});
    S.wires.push({a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,0]},{a:[1,0],b:[6,0]});};
   base();S.wires.push({a:[3,1],b:[1,1]});
   const e1=simulate(3,20,null,50,0).err||'';
   const ok1=e1.indexOf('single-phase lateral')>=0&&e1.indexOf('Phase Tap')>=0;
   base();S.blocks[2]={id:3,type:'tline',x:0,y:0,params:{Z:300,tau:100,R:0}};
   const e2=simulate(3,20,null,50,0).err||'';
   const ok2=e2.indexOf('not supported on a single-phase lateral')>=0;
   base();
   const e3=(solvePowerFlow()||{}).err||'';
   const ok3=e3.indexOf('Phase Tap')>=0;
   base();
   const ok4=!simulate(1,20,null,50,0).err;
   console.log('tap errors: bridge',ok1?'PASS':'FAIL','| spanning-on-lateral',ok2?'PASS':'FAIL',
    '| PF refused',ok3?'PASS':'FAIL','| 1-ph transparent',ok4?'PASS':'FAIL');
   record('tap','only a tap may bridge; spanning models and PF refused; 1-ph transparent',
    ok1&&ok2&&ok3&&ok4);
 }
}

// ---- relay / vsw / pfc on a single-phase lateral (SPEC §2 phase tap) ----
// relay and vsw get a very strong invariant for free: a lateral is
// phase-to-neutral and phase A has ZERO phase shift, so a phase-A lateral
// inside a 3-ph run must reproduce the same sub-circuit run in 1-ph mode
// EXACTLY (the 1-ph rig carries a matching 1e-4 Ω resistor standing in for the
// tap's connector, so the two circuits are electrically identical). pfc has no
// such invariant -- 1-ph MODE abstracts its AC side away entirely -- so it is
// validated on physics instead.
{
 const G = id => ({ id, type: 'gnd', x: 0, y: 0, params: {} });
 const load = (ckt, nph, T) => { S.blocks = ckt.B; S.wires = ckt.W; S.vconv = 'ph'; return simulate(nph, T, null, 50, 0); };

 // --- relay: identical current AND identical trip instant ---
 const relayCkt = tap => {
   const B = [{ id: 1, type: 'src', x: 0, y: 0, params: { Vrms: 277, f: 60, Rs: 0.5 } }, G(2)];
   const W = [{ a: [1, 0], b: [2, 0] }];
   B.push(tap ? { id: 3, type: 'tap', x: 0, y: 0, params: { ph: 1, Rc: 1e-4 } }
              : { id: 3, type: 'rlc', x: 0, y: 0, params: { R: 1e-4, L: -1, C: -1 } });
   W.push({ a: [1, 1], b: [3, 0] });
   // TD=0.1 so the VI curve actually trips inside the run (TD=0.5 needs ~300 ms
   // and would silently reduce this to a quiescent comparison)
   B.push({ id: 10, type: 'relay', x: 0, y: 0, params: { Ipu: 8, curve: 'VI', TD: 0.1, Iinst: 0, brkId: 11, f: 60 } },
          { id: 11, type: 'brk', x: 0, y: 0, params: { tclose: 0, topen: -1, init: 1, nOps: 1 } },
          { id: 12, type: 'rlc', x: 0, y: 0, params: { R: 20, L: -1, C: -1 } }, G(13),
          { id: 14, type: 'fault', x: 0, y: 0, params: { Rf: 2, ton: 60, toff: -1, ph: 0 } });
   W.push({ a: [3, 1], b: [10, 0] }, { a: [10, 1], b: [11, 0] }, { a: [11, 1], b: [12, 0] },
          { a: [12, 1], b: [13, 0] }, { a: [14, 0], b: [11, 1] });
   return { B, W };
 };
 {
  const a = load(relayCkt(false), 1, 300), b = load(relayCkt(true), 3, 300);
  let ok = false, worst = 1, wa = 1, tA = -1, tB = -2;
  if (a.err || b.err) console.log('relay lateral: solver error', a.err || b.err, 'FAIL');
  else {
   const ia = a.curMeta.findIndex(m => m.id === 10), ib = b.curMeta.findIndex(m => m.id === 10);
   const sa = a.ic[ia][0], sb = b.ic[ib][0];
   worst = 0; for (let k = 0; k < Math.min(sa.length, sb.length); k++)
     worst = Math.max(worst, Math.abs(sa[k] - sb[k]) / (Math.abs(sa[k]) + 1));
   const aa = a.aux[ia] || [], ab = b.aux[ib] || [];
   wa = 0; for (let k = 0; k < Math.min(aa.length, ab.length); k++) wa = Math.max(wa, Math.abs(aa[k] - ab[k]));
   tA = aa.findIndex(x => x >= 1); tB = ab.findIndex(x => x >= 1);
   // one trace, tagged phase A, not three
   const meta = b.curMeta[ib].np === 1 && b.curMeta[ib].ph0 === 0;
   ok = worst < 1e-9 && wa < 1e-9 && tA === tB && tA > 0 && meta;
   console.log('relay on lateral vs 1-ph: max rel I diff ' + worst.toExponential(1)
     + ', trip-frac diff ' + wa.toExponential(1) + ', trip sample ' + tA + ' vs ' + tB
     + ' ' + (ok ? 'PASS' : 'FAIL'));
  }
  record('relay', 'phase-A lateral reproduces the 1-ph circuit exactly, incl. trip instant', ok);
 }

 // --- vsw: identical bus voltage AND identical bank-close instant ---
 const vswCkt = tap => {
   const B = [{ id: 1, type: 'src', x: 0, y: 0, params: { Vrms: 277, f: 60, Rs: 6 } }, G(2)];
   const W = [{ a: [1, 0], b: [2, 0] }];
   B.push(tap ? { id: 3, type: 'tap', x: 0, y: 0, params: { ph: 1, Rc: 1e-4 } }
              : { id: 3, type: 'rlc', x: 0, y: 0, params: { R: 1e-4, L: -1, C: -1 } });
   W.push({ a: [1, 1], b: [3, 0] });
   B.push({ id: 10, type: 'vsw', x: 0, y: 0, params: { brkId: 11, mode: 0, Von: 250, Voff: 280, Td: 20, f: 60 } },
          { id: 11, type: 'brk', x: 0, y: 0, params: { tclose: -1, topen: -1, init: 0, nOps: 1 } },
          { id: 12, type: 'cap', x: 0, y: 0, params: { C: 120 } }, G(13),
          { id: 14, type: 'rlc', x: 0, y: 0, params: { R: 14, L: -1, C: -1 } }, G(15),
          { id: 16, type: 'probe', x: 0, y: 0, params: {} });
   W.push({ a: [3, 1], b: [10, 0] }, { a: [3, 1], b: [11, 0] }, { a: [11, 1], b: [12, 0] },
          { a: [12, 1], b: [13, 0] }, { a: [3, 1], b: [14, 0] }, { a: [14, 1], b: [15, 0] },
          { a: [16, 0], b: [3, 1] });
   return { B, W };
 };
 {
  const a = load(vswCkt(false), 1, 300), b = load(vswCkt(true), 3, 300);
  let ok = false;
  if (a.err || b.err) console.log('vsw lateral: solver error', a.err || b.err, 'FAIL');
  else {
   const pa = a.probeMeta.findIndex(m => m.id === 16), pb = b.probeMeta.findIndex(m => m.id === 16);
   const va = a.vp[pa][0], vb = b.vp[pb][0];
   let worst = 0; for (let k = 0; k < Math.min(va.length, vb.length); k++)
     worst = Math.max(worst, Math.abs(va[k] - vb[k]) / (Math.abs(va[k]) + 1));
   const ia = a.curMeta.findIndex(m => m.id === 10), ib = b.curMeta.findIndex(m => m.id === 10);
   const sa = a.aux[ia] || [], sb = b.aux[ib] || [];
   const onA = sa.findIndex(x => x > 0.5), onB = sb.findIndex(x => x > 0.5);
   ok = worst < 1e-9 && onA === onB && onA > 0 && b.probeMeta[pb].ph1 === 0;
   console.log('vsw on lateral vs 1-ph: max rel V diff ' + worst.toExponential(1)
     + ', bank closes at sample ' + onA + ' vs ' + onB + ' ' + (ok ? 'PASS' : 'FAIL'));
  }
  record('vsw', 'phase-A lateral reproduces the 1-ph circuit exactly, incl. bank-close instant', ok);
 }

 // --- pfc: the single-phase AC side is NEW physics (SPEC §2). Lossless AVM,
 // so power in at the AC terminal must equal power out at the DC terminal;
 // the draw must be unity power factor; and the answer must not depend on
 // WHICH phase the lateral sits on. 50 Hz + 50 us = 400 samples/cycle exactly,
 // so the averaging window is whole cycles (single-phase v*i pulsates at 2f
 // with amplitude equal to its own mean -- a fractional window is a ~3% error
 // here, not a rounding detail).
 // This also guards the instability the phasor injection exists to prevent:
 // the earlier instantaneous-conductance draw self-excited to +/-53 kV on
 // exactly this circuit, which the terminal-voltage bound below catches.
 {
  const pfcCkt = ph => ({
    B: [{ id: 1, type: 'src', x: 0, y: 0, params: { Vrms: 277, f: 50, Rs: 0.3 } }, G(2),
        { id: 3, type: 'tap', x: 0, y: 0, params: { ph: ph, Rc: 1e-4 } },
        { id: 4, type: 'line', x: 0, y: 0, params: { R: 0.2, L: 0.5, Rm: 0, Lm: 0, C: 0 } },
        { id: 5, type: 'pfc', x: 0, y: 0, params: { Vref: 380, Imax: 40, kp: 2, ki: 2000, Vac: 277, tgrid: -1, rev: 0, f: 50 } },
        { id: 6, type: 'cap', x: 0, y: 0, params: { C: 4000 } }, G(7),
        { id: 8, type: 'cpl', x: 0, y: 0, params: { P: 4, vmin: 300 } }, G(9),
        { id: 10, type: 'probe', x: 0, y: 0, params: {} }, { id: 11, type: 'probe', x: 0, y: 0, params: {} }],
    W: [{ a: [1, 0], b: [2, 0] }, { a: [1, 1], b: [3, 0] }, { a: [3, 1], b: [4, 0] }, { a: [4, 1], b: [5, 0] },
        { a: [5, 1], b: [6, 0] }, { a: [6, 1], b: [7, 0] }, { a: [8, 0], b: [5, 1] }, { a: [8, 1], b: [9, 0] },
        { a: [10, 0], b: [4, 1] }, { a: [11, 0], b: [5, 1] }]
  });
  let allOk = true;
  for (const ph of [1, 2, 3]) {
   const r = load(pfcCkt(ph), 3, 300);
   if (r.err) { console.log('pfc lateral ph' + ph + ': solver error', r.err, 'FAIL'); allOk = false; break; }
   const pAC = r.probeMeta.findIndex(m => m.id === 10), pDC = r.probeMeta.findIndex(m => m.id === 11);
   const li = r.curMeta.findIndex(m => m.id === 4), pi = r.curMeta.findIndex(m => m.id === 5);
   const N = r.t.length, SPC = Math.round(1 / 50 / 50e-6), idx = [];
   for (let k = N - 5 * SPC; k < N; k++) idx.push(k);
   const mean = f => idx.reduce((a, k) => a + f(k), 0) / idx.length;
   const vac = r.vp[pAC][0], iac = r.ic[li][0], vdc = r.vp[pDC][0], idc = r.ic[pi][0];
   // line term0 = tap side, term1 = pfc side, so its current is positive INTO
   // the pfc: v*i is the power absorbed, no sign correction needed.
   const Pac = mean(k => vac[k] * iac[k]), Pdc = mean(k => vdc[k] * idc[k]);
   const mv = mean(k => vac[k]), mi = mean(k => iac[k]);
   const cov = mean(k => (vac[k] - mv) * (iac[k] - mi));
   const sv = Math.sqrt(mean(k => (vac[k] - mv) ** 2)), si = Math.sqrt(mean(k => (iac[k] - mi) ** 2));
   const pf = cov / (sv * si);
   const vrms = Math.sqrt(mean(k => vac[k] ** 2));
   const err = Math.abs(Pac - Pdc) / Math.abs(Pdc);
   // terminal must sit just BELOW the 277 V source (absorbing, and bounded --
   // the old unstable draw ran to 53 kV here)
   const sane = vrms > 200 && vrms < 277;
   const ok = err < 0.02 && pf > 0.99 && sane;
   console.log('pfc lateral on ' + 'ABC'[ph - 1] + ': P_ac ' + (Pac / 1000).toFixed(4)
     + ' kW, P_dc ' + (Pdc / 1000).toFixed(4) + ' kW, pf ' + pf.toFixed(4)
     + ', terminal ' + vrms.toFixed(1) + ' V ' + (ok ? 'PASS' : 'FAIL'));
   allOk = allOk && ok;
  }
  record('pfc', 'single-phase lateral AC side: P balance, unity pf, stable, phase-independent', allOk);
 }
}

// ---- single-phase GFM inverter (SPEC §2), on a lateral and in 1-ph mode ----
// The droop/GFL controller was given a single-phase P/Q measurement (one-cycle
// projection onto the inverter's OWN rotating reference, so it does not mistune
// off-nominal the way a fixed quarter-cycle delay would). Four checks:
//   A. a phase-A lateral reproduces the same circuit in 1-ph mode (a lateral is
//      phase-to-neutral, phase A has zero shift), to numerical noise.
//   B. islanded droop into R lands on the analytical f/P fixed point AND draws
//      ~0 reactive power (the phantom-Q regression the θ projection fixes).
//   C. reactive power into an R-L load matches an INDEPENDENT phasor solve.
//   D. the AC current limiter (Iacmax) is REFUSED single-phase: one-cycle-stale
//      P/Q cannot hold current during a fault (measured 91% over limit while the
//      EMF slipped ~104 deg), so it errors rather than silently misbehaving.
{
 const G = id => ({ id, type: 'gnd', x: 0, y: 0, params: {} });
 const gp = o => Object.assign({ E0: 277, f0: 50, mp: 1, mq: 0.5, P0: 0, Q0: 0, Rf: 0.1, Lf: 1,
   Tf: 20, mode: 0, kiP: 0.05, kiQ: 2, Idcmax: 100, Iacmax: 0 }, o);
 const load = (B, W, nph, T) => { S.blocks = B; S.wires = W; S.vconv = 'ph'; return simulate(nph, T, null, 50, 0); };

 // --- A. lateral vs 1-ph-mode equivalence (GFL so it holds a setpoint) ---
 const eqCkt = tap => {
   const B = [{ id: 1, type: 'src', x: 0, y: 0, params: { Vrms: 277, f: 60, Rs: 0.5 } }, G(2)];
   const W = [{ a: [1, 0], b: [2, 0] }];
   B.push(tap ? { id: 3, type: 'tap', x: 0, y: 0, params: { ph: 1, Rc: 1e-4 } }
              : { id: 3, type: 'rlc', x: 0, y: 0, params: { R: 1e-4, L: -1, C: -1 } });
   W.push({ a: [1, 1], b: [3, 0] });
   // proper GFL gains (mp=0.05, kiP/kiQ per the 3-ph GFL test); mp=1 makes the
   // frequency PI explode. Tied straight to the stiff source, no local load, so
   // the setpoint is what it actually delivers.
   B.push({ id: 10, type: 'gfm', x: 0, y: 0, params: gp({ mode: 1, f0: 60, mp: 0.05, kiP: 0.15, kiQ: 25, P0: 5, Q0: 1, Lf: 3 }) }, G(11),
          { id: 14, type: 'probe', x: 0, y: 0, params: {} });
   W.push({ a: [10, 1], b: [3, 1] }, { a: [10, 0], b: [11, 0] }, { a: [14, 0], b: [3, 1] });
   return { B, W };
 };
 {
  const a = load(eqCkt(false).B, eqCkt(false).W, 1, 600), b = load(eqCkt(true).B, eqCkt(true).W, 3, 600);
  let ok = false;
  if (a.err || b.err) console.log('gfm 1-ph equivalence: solver error', a.err || b.err, 'FAIL');
  else {
   const pa = a.probeMeta.findIndex(m => m.id === 14), pb = b.probeMeta.findIndex(m => m.id === 14);
   const va = a.vp[pa][0], vb = b.vp[pb][0];
   let worst = 0; for (let k = 0; k < Math.min(va.length, vb.length); k++)
     worst = Math.max(worst, Math.abs(va[k] - vb[k]) / (Math.abs(va[k]) + 1));
   const ea = a.curEls.find(e => e.b.id === 10), eb = b.curEls.find(e => e.b.id === 10);
   // 1e-6 rel: the tap is a bare 1/Rc conductance while the 1-ph-mode standin
   // is an rlc R-only companion — identical physics, ~1e-7 numerical residue
   // through the GFM history state. Pf agreeing to 6 digits is the real proof.
   // (i) lateral == 1-ph mode to numerical noise, AND (ii) the GFL setpoint is
   // actually delivered single-phase (5 kW / 1 kvar), not just equal-but-wrong.
   const setP = Math.abs(eb.Pf - 5000) / 5000 < 0.05, setQ = Math.abs(eb.Qf - 1000) / 1000 < 0.05;
   ok = worst < 1e-6 && Math.abs(ea.Pf - eb.Pf) < 1 && ea.nEff === 1 && eb.nEff === 1 && setP && setQ;
   console.log('gfm lateral vs 1-ph mode: max rel V diff ' + worst.toExponential(1)
     + ', Pf ' + (ea.Pf / 1000).toFixed(4) + ' vs ' + (eb.Pf / 1000).toFixed(4)
     + ' kW (setpoint 5), Qf ' + (eb.Qf / 1000).toFixed(4) + ' kvar (setpoint 1) '
     + (ok ? 'PASS' : 'FAIL'));
  }
  record('gfm', 'single-phase GFL: lateral == 1-ph mode AND delivers its P0/Q0 setpoint', ok);
 }

 // --- B. islanded 1-ph droop fixed point + zero phantom Q ---
 {
  const R = 25, E0 = 277, f0 = 50, mp = 1, mq = 0.5, P0 = 0, Q0 = 0, Rf = 0.1, Lf = 1e-3;
  const B = [{ id: 1, type: 'gfm', x: 0, y: 0, params: gp({ E0, f0, mp, mq, P0, Q0, Rf: 0.1, Lf: 1 }) }, G(2),
             { id: 3, type: 'rlc', x: 0, y: 0, params: { R, L: -1, C: -1 } }, G(4),
             { id: 5, type: 'probe', x: 0, y: 0, params: {} }];
  const W = [{ a: [1, 0], b: [2, 0] }, { a: [1, 1], b: [3, 0] }, { a: [3, 1], b: [4, 0] }, { a: [5, 0], b: [1, 1] }];
  const r = load(B, W, 1, 3000);
  let ok = false;
  if (r.err) console.log('gfm island droop: solver error', r.err, 'FAIL');
  else {
   // fixed point (SPEC's 3-ph form without the factor 3): Q=0 into R so E=E0+mq*Q0,
   // f = f0 - mp*(P/1000 - P0), P = (E/|Zf+R|)^2 * R
   const E = E0 + mq * Q0;
   let f = f0; for (let it = 0; it < 500; it++) {
     const X = 2 * Math.PI * f * Lf, Z = Math.hypot(Rf + R, X), P = (E / Z) * (E / Z) * R;
     f = f0 - mp * (P / 1000 - P0);
   }
   const X = 2 * Math.PI * f * Lf, Z = Math.hypot(Rf + R, X), Pexp = (E / Z) * (E / Z) * R;
   const pi = r.probeMeta.findIndex(m => m.id === 5), v = r.vp[pi][0], t = r.t;
   const from = t.findIndex(x => x > t[t.length - 1] - 1000);
   let first = -1, last = -1, n = 0;
   for (let k = from + 1; k < v.length; k++) if (v[k - 1] < 0 && v[k] >= 0) { if (first < 0) first = t[k]; last = t[k]; n++; }
   const fMeas = n > 1 ? (n - 1) / ((last - first) / 1000) : 0;
   const el = r.curEls.find(e => e.b.id === 1), Pm = Math.abs(el.Pf);
   const eF = Math.abs(fMeas - f), eP = Math.abs(Pm - Pexp) / Pexp;
   ok = eF < 0.02 && eP < 0.02 && Math.abs(el.Qf) < 150;
   console.log('gfm island 1-ph droop: f ' + fMeas.toFixed(3) + ' Hz (exp ' + f.toFixed(3)
     + '), P ' + (Pm / 1000).toFixed(3) + ' kW (exp ' + (Pexp / 1000).toFixed(3)
     + '), Qf ' + (el.Qf).toFixed(1) + ' var (exp ~0) ' + (ok ? 'PASS' : 'FAIL'));
  }
  record('gfm', 'single-phase island droop fixed point + no phantom Q into a resistive load', ok);
 }

 // --- C. single-phase Q vs an independent phasor solve (R-L island) ---
 {
  const R = 25, L = 40e-3;
  const B = [{ id: 1, type: 'gfm', x: 0, y: 0, params: gp({ E0: 277, f0: 50, mp: 1, mq: 0.5, Lf: 1 }) }, G(2),
             { id: 3, type: 'rlc', x: 0, y: 0, params: { R: 25, L: 40, C: -1 } }, G(4),
             { id: 5, type: 'probe', x: 0, y: 0, params: {} }];
  const W = [{ a: [1, 0], b: [2, 0] }, { a: [1, 1], b: [3, 0] }, { a: [3, 1], b: [4, 0] }, { a: [5, 0], b: [1, 1] }];
  const r = load(B, W, 1, 3000);
  let ok = false;
  if (r.err) console.log('gfm 1-ph Q: solver error', r.err, 'FAIL');
  else {
   const el = r.curEls.find(e => e.b.id === 1);
   const ci = r.curMeta.findIndex(m => m.id === 1), pi = r.probeMeta.findIndex(m => m.id === 5);
   const v = r.vp[pi][0], i = r.ic[ci][0], t = r.t;
   let first = -1, last = -1, n = 0;
   for (let k = t.length - 4000 + 1; k < v.length; k++) if (v[k - 1] < 0 && v[k] >= 0) { if (first < 0) first = t[k]; last = t[k]; n++; }
   const f = (n - 1) / ((last - first) / 1000);
   const i0 = t.findIndex(x => x >= first), i1 = t.findIndex(x => x >= last), w = 2 * Math.PI * f;
   let Vr = 0, Vi = 0, Ir = 0, Ii = 0, cnt = 0;
   for (let k = i0; k < i1; k++) { const th = w * (t[k] - t[i0]) / 1000;
     Vr += v[k] * Math.sin(th); Vi += v[k] * Math.cos(th); Ir += i[k] * Math.sin(th); Ii += i[k] * Math.cos(th); cnt++; }
   Vr *= Math.SQRT2 / cnt; Vi *= Math.SQRT2 / cnt; Ir *= Math.SQRT2 / cnt; Ii *= Math.SQRT2 / cnt;
   const Pind = Vr * Ir + Vi * Ii, Qind = Vi * Ir - Vr * Ii;
   const tanInd = Math.abs(Qind / Pind), tanMod = Math.abs(el.Qf / el.Pf);
   const Sind = Math.hypot(Pind, Qind), Smod = Math.hypot(el.Pf, el.Qf);
   ok = Math.abs(tanMod - tanInd) / tanInd < 0.05 && Math.abs(Smod - Sind) / Sind < 0.05;
   console.log('gfm 1-ph Q vs waveform phasor: |Q/P| ' + tanMod.toFixed(3) + ' vs ' + tanInd.toFixed(3)
     + ' (analytic ' + (2 * Math.PI * f * L / R).toFixed(3) + '), |S| '
     + (Smod / 1000).toFixed(3) + ' vs ' + (Sind / 1000).toFixed(3) + ' kVA ' + (ok ? 'PASS' : 'FAIL'));
  }
  record('gfm', 'single-phase reactive power matches an independent phasor solve', ok);
 }

 // --- D. Iacmax refused single-phase (lateral AND 1-ph mode) ---
 {
  const B = [{ id: 1, type: 'src', x: 0, y: 0, params: { Vrms: 277, f: 50, Rs: 0.5 } }, G(2),
             { id: 3, type: 'tap', x: 0, y: 0, params: { ph: 2, Rc: 1e-4 } },
             { id: 10, type: 'gfm', x: 0, y: 0, params: gp({ mode: 0, Iacmax: 40 }) }, G(11),
             { id: 12, type: 'rlc', x: 0, y: 0, params: { R: 25, L: -1, C: -1 } }, G(13)];
  const W = [{ a: [1, 0], b: [2, 0] }, { a: [1, 1], b: [3, 0] }, { a: [10, 1], b: [3, 1] }, { a: [10, 0], b: [11, 0] },
             { a: [3, 1], b: [12, 0] }, { a: [12, 1], b: [13, 0] }];
  const eLat = (load(B, W, 3, 50).err || '');
  const B2 = [{ id: 1, type: 'src', x: 0, y: 0, params: { Vrms: 277, f: 50, Rs: 0.5 } }, G(2),
              { id: 10, type: 'gfm', x: 0, y: 0, params: gp({ mode: 0, Iacmax: 40 }) }, G(11),
              { id: 12, type: 'rlc', x: 0, y: 0, params: { R: 25, L: -1, C: -1 } }, G(13)];
  const W2 = [{ a: [1, 0], b: [2, 0] }, { a: [10, 1], b: [1, 1] }, { a: [10, 0], b: [11, 0] },
              { a: [1, 1], b: [12, 0] }, { a: [12, 1], b: [13, 0] }];
  const e1 = (load(B2, W2, 1, 50).err || '');
  // and it must STILL run 3-ph with the same limiter (no over-broad refusal)
  const B3 = [{ id: 1, type: 'src', x: 0, y: 0, params: { Vrms: 277, f: 50, Rs: 0.5 } }, G(2),
              { id: 10, type: 'gfm', x: 0, y: 0, params: gp({ mode: 0, Iacmax: 40 }) }, G(11),
              { id: 12, type: 'rlc', x: 0, y: 0, params: { R: 25, L: -1, C: -1 } }, G(13)];
  const W3 = [{ a: [1, 0], b: [2, 0] }, { a: [10, 1], b: [1, 1] }, { a: [10, 0], b: [11, 0] },
              { a: [1, 1], b: [12, 0] }, { a: [12, 1], b: [13, 0] }];
  const e3 = (load(B3, W3, 3, 50).err || '');
  const ok = eLat.includes('current limit') && e1.includes('current limit') && e3 === '';
  console.log('gfm Iacmax single-phase: refused on lateral ' + (eLat.includes('current limit') ? 'PASS' : 'FAIL')
    + ', refused in 1-ph mode ' + (e1.includes('current limit') ? 'PASS' : 'FAIL')
    + ', still allowed 3-ph ' + (e3 === '' ? 'PASS' : 'FAIL'));
  record('gfm', 'AC current limiter refused single-phase, still allowed 3-phase', ok);
 }

 // --- E. DC port on a single-phase lateral: the inverter draws exactly the
 // power it delivers from a battery-held DC bus (lossless AVM), same property
 // the 3-ph DC-port test checks. ---
 {
  const B = [{ id: 1, type: 'src', x: 0, y: 0, params: { Vrms: 277, f: 60, Rs: 0.5 } }, G(2),
             { id: 3, type: 'tap', x: 0, y: 0, params: { ph: 2, Rc: 1e-4 } },
             { id: 10, type: 'gfm', x: 0, y: 0, params: gp({ mode: 1, f0: 60, mp: 0.05, kiP: 0.15, kiQ: 25, P0: 5, Q0: 0, Lf: 3 }) }, G(23),
             { id: 20, type: 'batt', x: 0, y: 0, params: { Vref: 400, Imax: 50, Ichg: 20, kp: 1, ki: 50, Ah: 20, soc0: 80 } },
             { id: 21, type: 'cap', x: 0, y: 0, params: { C: 5000 } }, G(22),
             { id: 24, type: 'probe', x: 0, y: 0, params: {} }];
  const W = [{ a: [1, 0], b: [2, 0] }, { a: [1, 1], b: [3, 0] }, { a: [10, 1], b: [3, 1] }, { a: [10, 0], b: [23, 0] },
             { a: [10, 2], b: [21, 0] }, { a: [20, 1], b: [21, 0] }, { a: [21, 1], b: [22, 0] }, { a: [20, 0], b: [22, 0] },
             { a: [24, 0], b: [10, 2] }];
  const r = load(B, W, 3, 700);
  let ok = false, vmean = 0, pdc = 0, pac = 0;
  if (r.err) console.log('gfm 1-ph DC port: solver error', r.err, 'FAIL');
  else {
   const el = r.curEls.find(e => e.b.id === 10);
   const pi = r.probeMeta.findIndex(m => m.id === 24), vdc = r.vp[pi][0], t = r.t;
   const from = t.findIndex(x => x > 600);
   vmean = vdc.slice(from).reduce((a, b) => a + b, 0) / (vdc.length - from);
   pac = el.Pf; pdc = el.idc * vmean;
   ok = Math.abs(vmean - 400) < 4 && Math.abs(pdc - pac) / Math.abs(pac) < 0.05;
   console.log('gfm 1-ph lateral DC port: bus ' + vmean.toFixed(1) + ' V (batt 400), P_ac '
     + (pac / 1000).toFixed(3) + ' kW, P_dc ' + (pdc / 1000).toFixed(3) + ' kW ' + (ok ? 'PASS' : 'FAIL'));
  }
  record('gfm', 'single-phase lateral DC port: DC power = AC power (lossless AVM)', ok);
 }
}

// ---- Latching generation-trip relay (gtrip): SPEC §5 item 34, the seven
// validation targets of SPEC §2 "Validation". Trip detection is ALWAYS the
// target breaker's current going to zero and staying there, never the aux
// signal: gtrip's aux is the measured FREQUENCY in Hz (not a 0/1 state like
// vsw's bank flag), so `aux >= 1` is true at every sample and asserts nothing.
{
 const G=id=>({id,type:'gnd',x:0,y:0,params:{}});
 const GT=(id,brkId,o)=>({id,type:'gtrip',x:0,y:0,params:Object.assign(
  {brkId,Vov:0,Vuv:0,Tdv:100,hysV:2,Fov:0,Fuv:0,Tdf:300,hysF:0.05,Vblk:0,f0:60,KpPLL:30,KiPLL:900},o)});
 const SG=(id,Pm0)=>({id,type:'syncgen',x:0,y:0,params:{H:4,Sbase:100,Ra:0.05,Ld:2,f0:60,E0:277,
  Pm0,Kgov:15,D:25,Q0:0,mq:0.5,Tf:20,Tg:0,Pmax:0,Te:0,Ka:50,Vref:0,Emax:0,pfType:'slack',Vset:0,Qmax:0,Qmin:0}});
 // ms at which breaker `id` cleared and STAYED clear (never carries again), or
 // -1 if it never opened. The latch means "stayed clear" is part of the claim.
 const clearTime=(r,id)=>{
  const bi=r.curMeta.findIndex(m=>m.kind==='brk'&&m.id===id); if(bi<0)return -1;
  const ic=r.ic[bi][0]; let peak=0; ic.forEach(v=>{const a=Math.abs(v);if(a>peak)peak=a;});
  if(peak<=0)return -1; const th=0.02*peak;
  let last=-1; for(let k=0;k<ic.length;k++) if(Math.abs(ic[k])>th) last=k;
  return (last<0||last>=ic.length-1)?-1:r.t[last+1];
 };
 const fSig=(r,id)=>r.aux[r.curMeta.findIndex(m=>m.kind==='gtrip'&&m.id===id)];
 const fTail=(r,id)=>{const a=fSig(r,id);return a.slice(-20).reduce((s,x)=>s+x,0)/20;};
 // Shared feeder for targets 1/2/4/5: src -> line -> bus. A permanent 40 Ω load
 // sits behind the TARGET breaker #3; a sheddable load sits behind breaker #5.
 // Opening #5 raises the bus voltage, so the 59 element sees a real
 // solver-driven step rather than a scripted source change.
 const feeder=o=>{
  S.blocks.length=0;S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:o.f||60,Rs:0.5}},
   {id:2,type:'line',x:0,y:0,params:{R:0.3,L:15,Rm:0,Lm:0,C:0}},
   {id:3,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:1,nOps:1}},
   {id:4,type:'rlc',x:0,y:0,params:{R:40,L:-1,C:-1}},
   {id:5,type:'brk',x:0,y:0,params:o.brkA||{tclose:-1,topen:-1,init:0,nOps:1}},
   {id:6,type:'rlc',x:0,y:0,params:{R:o.Rshed||12,L:-1,C:-1}},
   GT(7,3,o.gt||{}),G(8),G(9));
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[8,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[9,0]},
   {a:[2,1],b:[5,0]},{a:[5,1],b:[6,0]},{a:[6,1],b:[9,0]},{a:[7,0],b:[2,1]});
 };

 // -- Target 1: PLL frequency accuracy on nominal and off-nominal grids. All
 // thresholds 0, so the relay is a pure bus-frequency meter and must not trip.
 let ok1=true;
 for(const fg of [60,61,58.5]){
  feeder({f:fg});
  const r=simulate(3,1500,null,50,50);
  if(r.err){console.log('gtrip 1: solver error:',r.err,'FAIL');process.exit(1);}
  const fm=fTail(r,7), e=Math.abs(fm-fg), noTrip=clearTime(r,3)<0;
  console.log('gtrip 1 (PLL accuracy): grid',fg,'Hz -> measured',fm.toFixed(4),
   'Hz, err',e.toFixed(5),'| disarmed relay held',noTrip);
  if(e>0.01||!noTrip) ok1=false;
 }
 record('gtrip','PLL bus-frequency accuracy (60/61/58.5 Hz) and disarmed hold',ok1);

 // -- Target 2: 59 definite time. Shedding the 12 Ω load at 200 ms lifts the
 // bus from ~222 V to ~269 V past the 250 V pickup; the trip must land at
 // 200 + Tdv, plus up to one RMS window and one current zero.
 feeder({Rshed:12,brkA:{tclose:-1,topen:200,init:1,nOps:1},gt:{Vov:250,Tdv:100}});
 let r=simulate(3,600,null,50,50);
 if(r.err){console.log('gtrip 2: solver error:',r.err,'FAIL');process.exit(1);}
 const t59=clearTime(r,3);
 console.log('gtrip 2 (59 definite time): step at 200 ms, Tdv 100 ms -> cleared at',
  t59.toFixed(1),'ms (expect 300 to 340)');
 record('gtrip','59 definite-time trip on a solver-driven voltage step', t59>=300&&t59<=340);

 // -- Target 3: 81U on a single-machine island. Governor droop fixes the
 // steady frequency at f0 - (Pe - Pm0)/(Kgov + D), so with the load held and
 // Kgov + D = 40 kW/Hz, each 10 kW of Pm0 must shift f by exactly 0.250 Hz.
 // Also cross-checks the PLL against the machine's own rotor-speed state.
 const island=(Pm0,gt)=>{
  S.blocks.length=0;S.wires.length=0; S.vconv='ph';
  S.blocks.push(SG(1,Pm0),
   {id:2,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:1,nOps:1}},
   {id:3,type:'rlc',x:0,y:0,params:{R:8,L:-1,C:-1}},GT(4,2,gt||{}),G(5),G(6));
  S.wires.push({a:[1,0],b:[5,0]},{a:[1,1],b:[2,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[6,0]},{a:[4,0],b:[1,1]});
 };
 const fIsl=[],dRotor=[];
 for(const Pm0 of [10,20,30]){
  island(Pm0,{});
  r=simulate(3,4000,null,50,200);
  if(r.err){console.log('gtrip 3: solver error:',r.err,'FAIL');process.exit(1);}
  const si=r.curMeta.findIndex(m=>m.kind==='syncgen');
  const rot=r.aux[si].slice(-20).reduce((s,x)=>s+x,0)/20;
  fIsl.push(fTail(r,4)); dRotor.push(Math.abs(fTail(r,4)-rot));
 }
 const slope1=fIsl[1]-fIsl[0], slope2=fIsl[2]-fIsl[1], slopeExp=10/(15+25);
 const okSlope=Math.abs(slope1-slopeExp)<0.002&&Math.abs(slope2-slopeExp)<0.002;
 const okRotor=Math.max(...dRotor)<0.005;
 console.log('gtrip 3 (81U island): f =',fIsl.map(x=>x.toFixed(3)).join(' / '),
  'Hz for Pm0 10/20/30 kW; droop step',slope1.toFixed(4),'/',slope2.toFixed(4),
  'Hz (analytic',slopeExp.toFixed(4)+'), max |PLL - rotor|',Math.max(...dRotor).toFixed(4),'Hz');
 // settled f is 59.546 Hz at Pm0 = 10 kW: a pickup above it trips, one below it
 // sees only the cold-start rotor swing, which is shorter than Tdf and is
 // correctly ridden through by the definite-time delay.
 island(10,{Fuv:59.8,Tdf:300}); const rTrip=simulate(3,4000,null,50,200);
 island(10,{Fuv:59.3,Tdf:300}); const rHold=simulate(3,4000,null,50,200);
 if(rTrip.err||rHold.err){console.log('gtrip 3b: solver error:',rTrip.err||rHold.err,'FAIL');process.exit(1);}
 const tT=clearTime(rTrip,2), tH=clearTime(rHold,2);
 console.log('gtrip 3 (81U trip/hold): Fuv 59.8 -> cleared at',tT.toFixed(0),
  'ms; Fuv 59.3 -> cleared at',tH.toFixed(0),'ms (must be -1)');
 record('gtrip','81U: exact governor-droop slope, PLL matches rotor, trips above / holds below',
  okSlope&&okRotor&&tT>0&&tH<0);

 // -- Target 4: latch. The shed load returns at 400 ms and the bus drops back
 // below pickup; the target breaker must never carry current again.
 feeder({Rshed:12,brkA:{tclose:-1,topen:200,init:1,nOps:2,tclose2:400,topen2:-1},gt:{Vov:250,Tdv:100}});
 r=simulate(3,900,null,50,50);
 if(r.err){console.log('gtrip 4: solver error:',r.err,'FAIL');process.exit(1);}
 const t4=clearTime(r,3), bi4=r.curMeta.findIndex(m=>m.kind==='brk'&&m.id===3);
 let iAfter=0; r.t.forEach((tv,k)=>{if(tv>450)iAfter=Math.max(iAfter,Math.abs(r.ic[bi4][0][k]));});
 console.log('gtrip 4 (latch): cleared at',t4.toFixed(1),
  'ms; max |i| after the 400 ms load return',iAfter.toFixed(4),'A (vsw would have reclosed)');
 record('gtrip','latch holds after the bus returns below pickup', t4>0&&t4<400&&iAfter<0.01);

 // -- Target 5: pickup/dropout hysteresis. Identical circuit and identical dip
 // (bus 269 V -> 247 V at 250 ms); only the dropout band changes. With the band
 // wide enough to contain the dip the element stays picked up and the timer
 // keeps RUNNING, so the trip still lands at the definite time; with a narrow
 // band the dip passes dropout and resets it. A timer that merely FROZE in the
 // band (the pre-fix behaviour) fails the first case.
 feeder({Rshed:24,brkA:{tclose:-1,topen:200,init:1,nOps:2,tclose2:250,topen2:-1},gt:{Vov:250,Tdv:100,hysV:10}});
 const rWide=simulate(3,700,null,50,50);
 feeder({Rshed:24,brkA:{tclose:-1,topen:200,init:1,nOps:2,tclose2:250,topen2:-1},gt:{Vov:250,Tdv:100,hysV:1}});
 const rNarrow=simulate(3,700,null,50,50);
 if(rWide.err||rNarrow.err){console.log('gtrip 5: solver error:',rWide.err||rNarrow.err,'FAIL');process.exit(1);}
 const tW=clearTime(rWide,3), tN=clearTime(rNarrow,3);
 console.log('gtrip 5 (hysteresis): dropout 225 V (dip inside band) -> cleared at',tW.toFixed(1),
  'ms; dropout 247.5 V (dip past it) -> cleared at',tN.toFixed(0),'ms (must be -1)');
 record('gtrip','59 hysteresis: timer runs through the band, resets past dropout', tW>=300&&tW<=340&&tN<0);

 // -- Target 6: undervoltage supervision of the 81 elements (27 blocks 81).
 // The 81U pickup sits ABOVE the running frequency so the element is picked up
 // continuously and only its dwell timer stands between it and a trip. A held
 // bolted fault from 600 ms then either does or does not stop that timer.
 const faulted=(Vblk,ton)=>{
  S.blocks.length=0;S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'line',x:0,y:0,params:{R:0.3,L:15,Rm:0,Lm:0,C:0}},
   {id:3,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:1,nOps:1}},
   {id:4,type:'rlc',x:0,y:0,params:{R:40,L:-1,C:-1}},
   {id:5,type:'fault',x:0,y:0,params:{Rf:0.05,ton,toff:-1,ph:3}},
   GT(6,3,{Fuv:60.5,Tdf:700,Vblk}),G(7),G(8));
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[7,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},
   {a:[4,1],b:[8,0]},{a:[5,0],b:[2,1]},{a:[6,0],b:[2,1]});
 };
 faulted(220,600); const rBlk=simulate(3,2000,null,50,50);
 faulted(0,600);   const rUnb=simulate(3,2000,null,50,50);
 faulted(220,1e9); const rCtl=simulate(3,2000,null,50,50);
 if(rBlk.err||rUnb.err||rCtl.err){console.log('gtrip 6: solver error:',rBlk.err||rUnb.err||rCtl.err,'FAIL');process.exit(1);}
 const tBlk=clearTime(rBlk,3), tUnb=clearTime(rUnb,3), tCtl=clearTime(rCtl,3);
 console.log('gtrip 6 (81 undervoltage supervision): Vblk 220 V -> cleared at',tBlk.toFixed(0),
  'ms (must be -1); Vblk 0 -> cleared at',tUnb.toFixed(0),'ms; no fault, Vblk 220 -> cleared at',tCtl.toFixed(0),'ms');
 record('gtrip','Vblk holds the 81 timers on a collapsed bus (control still trips)',
  tBlk<0&&tUnb>0&&tCtl>0&&tCtl<1200);

 // -- Target 7: two-plant cascade, item 34's headline. Plants A and B share a
 // 45 kW load; A's breaker is scripted open at 2 s. B then carries all of it,
 // the island droops to ~59.40 Hz, and B's OWN 81U (pickup 59.7) trips it. The
 // claim is carried by the control: with A left online the island holds at
 // ~59.93 Hz and B never trips, so B's trip is solver-driven, not scripted.
 const cascade=tA=>{
  S.blocks.length=0;S.wires.length=0; S.vconv='ph';
  S.blocks.push(SG(1,20),
   {id:2,type:'brk',x:0,y:0,params:{tclose:-1,topen:tA,init:1,nOps:1}},
   SG(3,20),
   {id:4,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:1,nOps:1}},
   {id:5,type:'rlc',x:0,y:0,params:{R:5,L:-1,C:-1}},
   GT(6,4,{Fuv:59.7,Tdf:300}),G(7),G(8),G(9));
  S.wires.push({a:[1,0],b:[7,0]},{a:[1,1],b:[2,0]},{a:[2,1],b:[5,0]},
   {a:[3,0],b:[8,0]},{a:[3,1],b:[4,0]},{a:[4,1],b:[5,0]},
   {a:[5,1],b:[9,0]},{a:[6,0],b:[5,0]});
 };
 cascade(2000); const rCas=simulate(3,6000,null,50,200);
 cascade(-1);   const rNoA=simulate(3,6000,null,50,200);
 if(rCas.err||rNoA.err){console.log('gtrip 7: solver error:',rCas.err||rNoA.err,'FAIL');process.exit(1);}
 const tA7=clearTime(rCas,2), tB7=clearTime(rCas,4), tB7c=clearTime(rNoA,4);
 let fCtl=1e9; rNoA.t.forEach((tv,k)=>{if(tv>800)fCtl=Math.min(fCtl,fSig(rNoA,6)[k]);});
 console.log('gtrip 7 (two-plant cascade): A cleared at',tA7.toFixed(0),'ms, B cleared at',tB7.toFixed(0),
  'ms (>= A + Tdf =',(tA7+300).toFixed(0)+')');
 console.log('gtrip 7 (control, A stays online): B cleared at',tB7c.toFixed(0),
  'ms (must be -1); island frequency never below',fCtl.toFixed(3),'Hz vs pickup 59.7');
 record('gtrip','two-plant cascade: B trips from its own measurement only after A is lost',
  tB7>0&&tA7>0&&tB7>=tA7+300&&tB7c<0&&fCtl>59.7);

 // Target 8: cause reporting. The relay knows which element tripped it
 // (same idea as zrel's oosTripped) and must say so via curMeta.cause: '81U'
 // for gtrip 3's droop trip, '27' for a bolted-fault undervoltage trip below,
 // and null (no cause) for a relay that never trips.
 const causeOf=(r,id)=>{const m=r.curMeta.find(m=>m.kind==='gtrip'&&m.id===id);return m?m.cause:undefined;};
 const c81U=causeOf(rTrip,4);
 const faulted27=(Vuv,Tdv)=>{
  S.blocks.length=0;S.wires.length=0; S.vconv='ph';
  S.blocks.push(
   {id:1,type:'src',x:0,y:0,params:{Vrms:277,f:60,Rs:0.5}},
   {id:2,type:'line',x:0,y:0,params:{R:0.3,L:15,Rm:0,Lm:0,C:0}},
   {id:3,type:'brk',x:0,y:0,params:{tclose:-1,topen:-1,init:1,nOps:1}},
   {id:4,type:'rlc',x:0,y:0,params:{R:40,L:-1,C:-1}},
   {id:5,type:'fault',x:0,y:0,params:{Rf:0.05,ton:600,toff:-1,ph:0}},
   GT(6,3,{Vuv,Tdv}),G(7),G(8));
  S.wires.push({a:[1,1],b:[2,0]},{a:[1,0],b:[7,0]},{a:[2,1],b:[3,0]},{a:[3,1],b:[4,0]},
   {a:[4,1],b:[8,0]},{a:[5,0],b:[2,1]},{a:[6,0],b:[2,1]});
 };
 faulted27(200,100);
 const r27=simulate(3,2000,null,50,50);
 if(r27.err){console.log('gtrip 8: solver error:',r27.err,'FAIL');process.exit(1);}
 const c27=causeOf(r27,6);
 feeder({f:60}); // gtrip 1's pure-meter config: all thresholds 0, never trips
 const rNone=simulate(3,1500,null,50,50);
 if(rNone.err){console.log('gtrip 8: solver error:',rNone.err,'FAIL');process.exit(1);}
 const cNone=causeOf(rNone,7);
 console.log('gtrip 8 (cause reporting): 81U trip reports',c81U,
  '; 27 trip reports',c27,'; disarmed relay reports',cNone);
 record('gtrip','relay reports which element tripped it (cause), null when it never trips',
  c81U==='81U'&&c27==='27'&&cNone===null);
}

summary();
