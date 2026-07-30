/* Procedural Web Audio engine lifted out of index.html on request, to be
   pasted back as a finishing touch. Call sites were initAudio(), boostWhoosh(),
   thumpSound(power) and updateAudio(dt). */
/*═══════════════════════════════════════════════════════════════════════════
  16 · AUDIO (procedural, Web Audio)
═══════════════════════════════════════════════════════════════════════════*/
const AUD = { ctx:null, ready:false };
function initAudio(){
  if(AUD.ctx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if(!Ctx) return;
  const ctx = new Ctx();
  AUD.ctx = ctx;

  const master = ctx.createGain(); master.gain.value = 0.0; master.connect(ctx.destination);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value=-14; comp.knee.value=22; comp.ratio.value=8;
  comp.attack.value=0.004; comp.release.value=0.22;
  comp.connect(master);
  AUD.master = master;

  /* ---- engine: harmonic stack through a resonant filter ---- */
  const engGain = ctx.createGain(); engGain.gain.value=0;
  const engFilt = ctx.createBiquadFilter();
  engFilt.type='lowpass'; engFilt.frequency.value=760; engFilt.Q.value=2.2;
  const growl = ctx.createBiquadFilter();
  growl.type='peaking'; growl.frequency.value=180; growl.Q.value=1.6; growl.gain.value=9;
  engGain.connect(growl); growl.connect(engFilt); engFilt.connect(comp);

  const oscs=[];
  const harm=[[0.5,0.32,'sawtooth'],[1,0.5,'sawtooth'],[2,0.26,'square'],[3,0.14,'sawtooth'],[4.5,0.08,'square']];
  for(const [mul,amp,type] of harm){
    const o=ctx.createOscillator(); o.type=type;
    const g=ctx.createGain(); g.gain.value=amp;
    o.connect(g); g.connect(engGain); o.start();
    oscs.push({o,mul});
  }
  AUD.eng={gain:engGain, filt:engFilt, oscs, growl};

  /* ---- noise buffer ---- */
  const nb = ctx.createBuffer(1, ctx.sampleRate*3, ctx.sampleRate);
  const nd = nb.getChannelData(0);
  for(let i=0;i<nd.length;i++) nd[i]=Math.random()*2-1;
  function noiseSrc(){ const s=ctx.createBufferSource(); s.buffer=nb; s.loop=true; s.start(); return s; }

  /* ---- intake / induction ---- */
  const indG=ctx.createGain(); indG.gain.value=0;
  const indF=ctx.createBiquadFilter(); indF.type='bandpass'; indF.frequency.value=420; indF.Q.value=1.1;
  noiseSrc().connect(indF); indF.connect(indG); indG.connect(comp);
  AUD.ind={g:indG,f:indF};

  /* ---- wind ---- */
  const wG=ctx.createGain(); wG.gain.value=0;
  const wF=ctx.createBiquadFilter(); wF.type='lowpass'; wF.frequency.value=500; wF.Q.value=0.6;
  const wH=ctx.createBiquadFilter(); wH.type='highpass'; wH.frequency.value=180;
  noiseSrc().connect(wH); wH.connect(wF); wF.connect(wG); wG.connect(comp);
  AUD.wind={g:wG,f:wF};

  /* ---- tyre roar ---- */
  const tG=ctx.createGain(); tG.gain.value=0;
  const tF=ctx.createBiquadFilter(); tF.type='bandpass'; tF.frequency.value=240; tF.Q.value=0.9;
  noiseSrc().connect(tF); tF.connect(tG); tG.connect(comp);
  AUD.tyre={g:tG,f:tF};

  /* ---- screech ---- */
  const sG=ctx.createGain(); sG.gain.value=0;
  const sF=ctx.createBiquadFilter(); sF.type='bandpass'; sF.frequency.value=1750; sF.Q.value=7.5;
  const sF2=ctx.createBiquadFilter(); sF2.type='bandpass'; sF2.frequency.value=3100; sF2.Q.value=11;
  const n=noiseSrc(); n.connect(sF); n.connect(sF2);
  sF.connect(sG); sF2.connect(sG); sG.connect(comp);
  AUD.scr={g:sG,f:sF,f2:sF2};

  /* ---- ambience: night crickets / day birds ---- */
  const aG=ctx.createGain(); aG.gain.value=0;          // level
  const aTrem=ctx.createGain(); aTrem.gain.value=0.5;  // chirp envelope, 0…1
  const aF=ctx.createBiquadFilter(); aF.type='bandpass'; aF.frequency.value=2400; aF.Q.value=3.5;
  const aLfo=ctx.createOscillator(); aLfo.type='sine'; aLfo.frequency.value=7.4;
  const aLg=ctx.createGain(); aLg.gain.value=0.5;
  // the LFO must modulate a stage *before* the level control — summed onto the
  // level itself it would swing the ambience to full scale at any speed
  aLfo.connect(aLg); aLg.connect(aTrem.gain); aLfo.start();
  noiseSrc().connect(aF); aF.connect(aTrem); aTrem.connect(aG); aG.connect(comp);
  AUD.amb={g:aG,f:aF,lfo:aLfo};

  AUD.ready=true;
  AUD.comp = comp;
  master.gain.setTargetAtTime(0.85, ctx.currentTime, 1.2);
}
function boostWhoosh(){
  if(!AUD.ready) return;
  const ctx=AUD.ctx, t=ctx.currentTime;
  const nb=ctx.createBufferSource();
  const buf=ctx.createBuffer(1, ctx.sampleRate*1.1, ctx.sampleRate);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1);
  nb.buffer=buf;
  const f=ctx.createBiquadFilter(); f.type='bandpass'; f.Q.value=1.4;
  f.frequency.setValueAtTime(240,t);
  f.frequency.exponentialRampToValueAtTime(4200,t+0.55);
  const g=ctx.createGain();
  g.gain.setValueAtTime(0.0001,t);
  g.gain.exponentialRampToValueAtTime(0.42,t+0.07);
  g.gain.exponentialRampToValueAtTime(0.0001,t+0.95);
  nb.connect(f); f.connect(g); g.connect(AUD.comp);
  nb.start(t); nb.stop(t+1.05);
}
function thumpSound(power){
  if(!AUD.ready || power<0.12) return;
  const ctx=AUD.ctx,t=ctx.currentTime;
  const o=ctx.createOscillator(); o.type='sine';
  o.frequency.setValueAtTime(120,t); o.frequency.exponentialRampToValueAtTime(38,t+0.22);
  const g=ctx.createGain();
  g.gain.setValueAtTime(Math.min(0.6,power*0.7),t);
  g.gain.exponentialRampToValueAtTime(0.0001,t+0.3);
  o.connect(g); g.connect(AUD.comp); o.start(t); o.stop(t+0.32);
}
function updateAudio(dt){
  if(!AUD.ready) return;
  const ctx=AUD.ctx, T=ctx.currentTime, k=0.06;
  const spd=Math.abs(car.vLong), spdN=clamp(spd/72,0,1);
  const rpmN = clamp((car.rpm-850)/7750, 0, 1);
  const base = 34 + rpmN*118;
  for(const {o,mul} of AUD.eng.oscs) o.frequency.setTargetAtTime(base*mul, T, k);
  const load = clamp(input.th*0.8 + car.boostAmt*0.4 + rpmN*0.35, 0, 1);
  AUD.eng.gain.gain.setTargetAtTime(0.10 + load*0.20, T, k);
  AUD.eng.filt.frequency.setTargetAtTime(520 + rpmN*3400 + load*900, T, k);
  AUD.eng.growl.gain.setTargetAtTime(6 + load*10, T, k);
  AUD.ind.g.gain.setTargetAtTime(load*0.075 + car.boostAmt*0.10, T, k);
  AUD.ind.f.frequency.setTargetAtTime(380+rpmN*1500, T, k);

  AUD.wind.g.gain.setTargetAtTime(Math.pow(spdN,1.7)*0.30, T, 0.10);
  AUD.wind.f.frequency.setTargetAtTime(340+spdN*2400, T, 0.10);

  AUD.tyre.g.gain.setTargetAtTime(spdN*0.11*(1+car.offroad*1.7), T, 0.10);
  AUD.tyre.f.frequency.setTargetAtTime(160+spdN*420+car.offroad*300, T, 0.10);

  AUD.scr.g.gain.setTargetAtTime(car.screech*0.20, T, 0.05);
  AUD.scr.f.frequency.setTargetAtTime(1500+car.screech*900+Math.sin(T*9)*120, T, 0.05);

  const night = SKYST.star;
  AUD.amb.g.gain.setTargetAtTime((1-spdN)*(1-spdN)*0.16, T, 0.4);
  AUD.amb.f.frequency.setTargetAtTime(night>0.4 ? 4200 : 2100, T, 0.6);
  AUD.amb.lfo.frequency.setTargetAtTime(night>0.4 ? 11 : 3.1, T, 0.6);
}
