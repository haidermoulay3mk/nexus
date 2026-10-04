"""HTML/CSS/JS for the Nexus dashboard (kept out of server.py).

Minimalist main view + a full-screen "Jarvis" voice mode with an animated,
audio-reactive arc-reactor. Data is fetched client-side from the JSON API, so
this template only needs CSS/JS/logo substitution (no f-string data injection).
"""

from __future__ import annotations

LOGO_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'
    '<rect x="8" y="8" width="240" height="240" rx="56" fill="#06080d"/>'
    '<path d="M90 174 V82 L166 174 V82" fill="none" stroke="#38bdf8" '
    'stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>'
    '<circle cx="166" cy="82" r="15" fill="#7dd3fc"/></svg>'
)

_CSS = r"""
:root{--bg:#04070d;--ink:#e9f2fb;--dim:#7c8aa0;--cyan:#38bdf8;--cyan2:#7dd3fc;
  --line:rgba(56,189,248,.16);--panel:rgba(12,18,28,.82);}
*{box-sizing:border-box;}
html,body{height:100%;}
body{margin:0;background:var(--bg);color:var(--ink);overflow-x:hidden;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  background-image:radial-gradient(1000px 600px at 50% -10%,rgba(56,189,248,.10),transparent 60%),
    radial-gradient(800px 600px at 50% 120%,rgba(56,189,248,.06),transparent 55%);}
.topbar{display:flex;align-items:center;gap:12px;padding:18px 26px;}
.topbar .logo svg{width:28px;height:28px;display:block;filter:drop-shadow(0 0 6px rgba(56,189,248,.5));}
.brand{font-weight:600;letter-spacing:5px;font-size:16px;text-shadow:0 0 18px rgba(56,189,248,.5);}
.spacer{flex:1;}
.status{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dim);
  text-transform:uppercase;letter-spacing:.08em;}
.status .dot{width:8px;height:8px;border-radius:50%;background:#3b4658;}
.status .dot.on{background:#34d399;box-shadow:0 0 8px #34d399;}
.gear{cursor:pointer;color:var(--dim);font-size:18px;padding:6px;border-radius:8px;}
.gear:hover{color:var(--cyan);background:rgba(56,189,248,.08);}

.stage{max-width:760px;margin:0 auto;padding:6vh 24px 40px;text-align:center;}
.orb{width:128px;height:128px;margin:0 auto 22px;cursor:pointer;position:relative;}
.orb canvas{width:128px;height:128px;display:block;}
.orb .hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:10px;letter-spacing:.12em;color:var(--cyan2);text-transform:uppercase;
  opacity:.0;transition:opacity .2s;pointer-events:none;}
.orb:hover .hint{opacity:.85;}
.tagline{color:var(--dim);font-size:14px;margin-bottom:18px;letter-spacing:.02em;}
.tagline b{color:var(--cyan2);font-weight:600;}
.cmd{display:flex;gap:10px;max-width:620px;margin:0 auto;}
.cmd input{flex:1;padding:15px 18px;border-radius:14px;border:1px solid var(--line);
  background:rgba(4,9,16,.8);color:var(--ink);font-size:16px;outline:none;
  transition:box-shadow .15s,border-color .15s;}
.cmd input::placeholder{color:#56627a;}
.cmd input:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(56,189,248,.16),0 0 26px rgba(56,189,248,.16);}
.cmd button{padding:0 22px;border-radius:14px;border:0;cursor:pointer;font-weight:600;font-size:15px;
  background:linear-gradient(180deg,#38bdf8,#1c9fe0);color:#04121d;}
.cmd button:hover{filter:brightness(1.08);}
#answer{margin:22px auto 0;max-width:620px;color:#cdd9e8;line-height:1.6;min-height:1.2em;text-align:left;}
.today{margin-top:26px;display:flex;gap:18px;justify-content:center;flex-wrap:wrap;
  color:var(--dim);font-size:12px;letter-spacing:.04em;text-transform:uppercase;}
.today b{color:var(--cyan2);font-weight:600;}

/* Settings modal */
.modal{position:fixed;inset:0;background:rgba(2,5,10,.72);backdrop-filter:blur(4px);
  display:none;align-items:center;justify-content:center;z-index:40;padding:20px;}
.modal.open{display:flex;}
.sheet{width:100%;max-width:640px;max-height:88vh;overflow:auto;background:var(--panel);
  border:1px solid var(--line);border-radius:18px;padding:22px 24px;box-shadow:0 30px 80px -30px #000;}
.sheet h2{margin:0 0 4px;font-size:15px;letter-spacing:.04em;}
.sheet h3{margin:20px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--cyan);}
.sheet p{color:var(--dim);font-size:13px;margin:4px 0 0;}
.sheet a{color:var(--cyan2);}
.sheet input{width:100%;margin:8px 0;padding:11px 13px;border-radius:10px;border:1px solid var(--line);
  background:rgba(4,9,16,.8);color:var(--ink);}
.sheet button{padding:10px 16px;border-radius:10px;border:0;cursor:pointer;font-weight:600;
  background:linear-gradient(180deg,#38bdf8,#1c9fe0);color:#04121d;}
.sheet .row{display:flex;gap:10px;}
.sheet .row input{flex:1;}
.close-x{float:right;cursor:pointer;color:var(--dim);font-size:20px;line-height:1;}
.close-x:hover{color:var(--cyan);}
.chip{display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(56,189,248,.1);
  border:1px solid var(--line);font-size:12px;color:#bfe3fb;margin:4px 6px 0 0;}
.chip-x{color:#fca5a5;cursor:pointer;font-weight:700;margin-left:6px;text-decoration:none;}
.msg{font-size:13px;color:var(--cyan2);margin-top:8px;min-height:1em;}

/* Full-screen Jarvis voice mode */
.voice{position:fixed;inset:0;background:radial-gradient(circle at 50% 50%,#040a12,#010306 70%);
  display:none;flex-direction:column;align-items:center;justify-content:center;z-index:60;}
.voice.open{display:flex;}
#reactor{position:absolute;inset:0;width:100%;height:100%;}
.voice .vcenter{position:relative;text-align:center;pointer-events:none;padding:0 8vw;}
.voice .vstate{font-size:12px;letter-spacing:.32em;text-transform:uppercase;color:var(--cyan2);
  text-shadow:0 0 16px rgba(56,189,248,.7);}
.voice .vtext{margin-top:14px;font-size:clamp(18px,3vw,30px);color:#eaf6ff;font-weight:300;
  line-height:1.4;max-width:760px;min-height:1.4em;text-shadow:0 0 22px rgba(56,189,248,.25);}
.voice .vhint{position:absolute;bottom:26px;left:0;right:0;text-align:center;color:var(--dim);
  font-size:12px;letter-spacing:.06em;}
.voice .vexit{position:absolute;top:22px;right:26px;color:var(--dim);font-size:22px;cursor:pointer;
  pointer-events:auto;}
.voice .vdbg{position:absolute;bottom:22px;left:0;right:0;text-align:center;color:#5b6678;
  font-size:11px;letter-spacing:.04em;}
.voice .vexit:hover{color:var(--cyan);}
.voice .jarvis-mark{margin:20px auto 0;width:min(220px,70vw);height:min(220px,70vw);
  display:flex;align-items:center;justify-content:center;border-radius:50%;
  color:#dff6ff;font-size:20px;font-weight:700;letter-spacing:.22em;text-indent:.22em;
  text-shadow:0 0 18px rgba(56,189,248,.9);border:1px solid rgba(125,211,252,.36);
  box-shadow:0 0 36px rgba(56,189,248,.16),inset 0 0 34px rgba(56,189,248,.12);}
.voice .vclock{margin-top:22px;font-size:36px;letter-spacing:.12em;font-weight:300;color:#f7fbff;
  text-shadow:0 0 20px rgba(56,189,248,.38);}
.voice .vdate{margin-top:4px;color:#8fa4ba;font-size:11px;letter-spacing:.18em;text-transform:uppercase;}
.voice .vcontrols{margin-top:26px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;
  pointer-events:auto;}
.voice .vcontrols button{width:46px;height:46px;border-radius:50%;border:1px solid var(--line);
  background:rgba(6,16,28,.78);color:#dff6ff;cursor:pointer;font-size:16px;
  box-shadow:0 0 22px rgba(56,189,248,.10);}
.voice .vcontrols button:hover{border-color:rgba(125,211,252,.65);box-shadow:0 0 26px rgba(56,189,248,.22);}
.voice .vcontrols button.primary{background:rgba(56,189,248,.18);color:#7dd3fc;}
.voice .vcontrols button.danger{color:#fda4af;border-color:rgba(253,164,175,.24);}
.voice .vcontrols button:disabled{opacity:.42;cursor:not-allowed;box-shadow:none;}
.voice .vtranscript{margin-top:16px;color:#8fa4ba;font-size:13px;min-height:1.2em;}
.voice .ptt{display:none;}
@media(max-width:760px){.cmd{flex-direction:column;}.cmd button{padding:12px;}}
"""

_JS = r"""
const $ = (id) => document.getElementById(id);
const ans = $('answer');

/* ---------- today / status ---------- */
async function loadToday(){
  try{
    const d = await (await fetch('/api/today')).json();
    $('statusDot').className = 'dot' + (d.ready ? ' on':'');
    $('statusText').textContent = d.provider === 'gemini' ? 'Gemini' : (d.ready ? 'Local' : 'Offline');
    $('today').innerHTML =
      '<span><b>'+d.weak+'</b> weak topics</span>'+
      '<span><b>'+d.open_tasks+'</b> tasks</span>'+
      '<span><b>'+d.emails+'</b> inbox · <b>'+d.calendars+'</b> calendar</span>';
  }catch(e){}
}

/* ---------- ask (typed) ---------- */
async function askNexus(text, opts){
  opts = opts || {};
  if(!text.trim()) return null;
  if(!opts.silent) ans.textContent = 'Thinking…';
  try{
    const d = await (await fetch('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text})})).json();
    const out = (d.agent? '['+d.agent+'] ':'') + (d.answer||'');
    if(!opts.silent) ans.textContent = out;
    return d.answer || '';
  }catch(e){ if(!opts.silent) ans.textContent='Error: '+e; return ''; }
}
$('askForm').addEventListener('submit', e=>{ e.preventDefault(); askNexus($('askInput').value); });

/* ---------- settings modal ---------- */
const modal = $('settings');
$('gear').onclick = ()=>{ modal.classList.add('open'); loadSettings(); loadConnections(); };
$('closeSettings').onclick = ()=> modal.classList.remove('open');
modal.addEventListener('click', e=>{ if(e.target===modal) modal.classList.remove('open'); });

async function loadSettings(){
  try{ const d = await (await fetch('/api/settings')).json();
    $('gemStatus').textContent = d.gemini_set ? 'Gemini key saved — cloud brain active.' : 'No Gemini key — using local Ollama.';
  }catch(e){}
}
$('gemSave').onclick = async ()=>{
  const key = $('gemKey').value.trim();
  $('gemMsg').textContent = 'Saving…';
  const d = await (await fetch('/api/settings/gemini',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key})})).json();
  $('gemMsg').textContent = d.message || 'Saved.'; $('gemKey').value=''; loadSettings(); loadToday();
};

async function loadConnections(){
  try{
    const d = await (await fetch('/api/connections')).json();
    const box = $('connList'); box.innerHTML='';
    (d.emails||[]).forEach(e=>box.appendChild(chip('@ '+e,'email',e)));
    (d.calendars||[]).forEach(c=>box.appendChild(chip('# '+c,'calendar',c)));
    if(!(d.emails||[]).length && !(d.calendars||[]).length) box.textContent='Nothing connected yet.';
  }catch(e){}
}
function chip(label,kind,id){
  const s=document.createElement('span'); s.className='chip'; s.textContent=label+' ';
  const x=document.createElement('a'); x.textContent='×'; x.className='chip-x';
  x.onclick=async()=>{ const u=kind==='email'?'/api/connections/email/remove':'/api/connections/calendar/remove';
    const b=kind==='email'?{email:id}:{name:id};
    await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); loadConnections(); loadToday(); };
  s.appendChild(x); return s;
}
$('emailSave').onclick = async ()=>{
  $('connMsg').textContent='Connecting…';
  const d=await(await fetch('/api/connections/email',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:$('emEmail').value.trim(),password:$('emPass').value.trim()})})).json();
  $('connMsg').textContent=(d.ok?'✓ ':'✗ ')+(d.message||d.error); if(d.ok){$('emPass').value='';loadConnections();loadToday();}
};
$('calSave').onclick = async ()=>{
  $('connMsg').textContent='Connecting…';
  const d=await(await fetch('/api/connections/calendar',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:$('calName').value.trim(),url:$('calUrl').value.trim()})})).json();
  $('connMsg').textContent=(d.ok?'✓ ':'✗ ')+(d.message||d.error); if(d.ok){$('calUrl').value='';loadConnections();loadToday();}
};

/* ---------- speech: reliable Windows voice (server), browser fallback ---------- */
let jarvisVoice=null, speaking=false;
function pickVoice(){ const vs=speechSynthesis.getVoices();
  jarvisVoice = vs.find(v=>/en-GB/i.test(v.lang)) || vs.find(v=>/^en/i.test(v.lang)) || vs[0] || null; }
if('speechSynthesis' in window){ pickVoice(); speechSynthesis.onvoiceschanged=pickVoice; }
function browserSpeak(text){ return new Promise(res=>{
  if(!('speechSynthesis' in window) || !text){ res(); return; }
  try{ const u=new SpeechSynthesisUtterance(text.replace(/[\*\#\`>_]/g,''));
    if(jarvisVoice) u.voice=jarvisVoice; u.onend=()=>res(); u.onerror=()=>res();
    speechSynthesis.speak(u); }catch(e){ res(); } }); }
// Prefer browser/WebView speech so Stop can cancel it instantly; fall back to
// Windows SAPI on the server when the Web Speech API is unavailable.
async function speakAsync(text){
  if(!text) return; speaking=true;
  setButtons();
  if('speechSynthesis' in window){
    await browserSpeak(text);
    speaking=false; setButtons();
    return;
  }
  try{
    const r = await fetch('/api/speak',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text})});
    const d = await r.json();
    if(d && d.ok){ speaking=false; setButtons(); return; }
  }catch(e){}
  speaking=false; setButtons();
}
function stopSpeaking(){ speaking=false; try{ speechSynthesis.cancel(); }catch(e){} setButtons(); }

/* ---------- arc reactor canvas ---------- */
const canvas=$('reactor'); const ctx=canvas.getContext('2d');
let amp=0, t=0, vState='idle', rafId=null;
function resizeCanvas(){ const r=window.devicePixelRatio||1; canvas.width=innerWidth*r; canvas.height=innerHeight*r;
  ctx.setTransform(r,0,0,r,0,0); }
addEventListener('resize',resizeCanvas);

function drawReactor(){
  t+=0.016;
  const w=innerWidth,h=innerHeight,cx=w/2,cy=h/2;
  const base=Math.min(w,h)*0.16;
  // target amplitude by state
  let target = 0.06;
  if(vState==='listening') target = 0.14 + micLevel*1.4;
  else if(vState==='speaking') target = 0.45 + 0.3*Math.abs(Math.sin(t*9)) + (speaking?0.1:0);
  else if(vState==='thinking') target = 0.18 + 0.08*Math.sin(t*4);
  amp += (target-amp)*0.12;
  const col = vState==='thinking' ? '245,158,11' : '56,189,248';

  ctx.clearRect(0,0,w,h);
  ctx.save(); ctx.translate(cx,cy);
  ctx.shadowColor='rgba('+col+',0.9)';

  // core glow
  const coreR = base*(0.55+amp*0.7);
  const g = ctx.createRadialGradient(0,0,0,0,0,coreR*1.6);
  g.addColorStop(0,'rgba('+col+',0.95)'); g.addColorStop(0.4,'rgba('+col+',0.35)'); g.addColorStop(1,'rgba('+col+',0)');
  ctx.shadowBlur=60; ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,coreR*1.6,0,7); ctx.fill();
  ctx.shadowBlur=30; ctx.fillStyle='rgba('+col+',0.9)'; ctx.beginPath(); ctx.arc(0,0,coreR*0.5,0,7); ctx.fill();

  // rotating dashed rings
  function ring(r,segs,rot,lw,a){ ctx.lineWidth=lw; ctx.strokeStyle='rgba('+col+','+a+')'; ctx.shadowBlur=18;
    for(let i=0;i<segs;i++){ const a0=rot+i/segs*Math.PI*2, a1=a0+(Math.PI*2/segs)*0.6;
      ctx.beginPath(); ctx.arc(0,0,r,a0,a1); ctx.stroke(); } }
  ring(base*1.15, 3, t*0.6, 3, 0.9);
  ring(base*1.5, 24, -t*0.3, 2, 0.5);
  ring(base*1.9, 6, t*0.18, 6, 0.5+amp*0.4);

  // reactive waveform ring
  ctx.lineWidth=2; ctx.strokeStyle='rgba('+col+',0.85)'; ctx.shadowBlur=16; ctx.beginPath();
  const N=120, rr=base*2.25;
  for(let i=0;i<=N;i++){ const a=i/N*Math.PI*2;
    const dr = Math.sin(a*8 + t*3)*amp*base*0.5 + Math.sin(a*3 - t*2)*amp*base*0.3;
    const r=rr+dr; const x=Math.cos(a)*r, y=Math.sin(a)*r;
    i?ctx.lineTo(x,y):ctx.moveTo(x,y); }
  ctx.closePath(); ctx.stroke();

  // ticks
  ctx.shadowBlur=8;
  for(let i=0;i<60;i++){ const a=i/60*Math.PI*2; const on=(i%5===0);
    const r0=base*2.5, r1=r0+(on?14:7); ctx.lineWidth=on?2:1;
    ctx.strokeStyle='rgba('+col+','+(on?0.7:0.3)+')';
    ctx.beginPath(); ctx.moveTo(Math.cos(a)*r0,Math.sin(a)*r0); ctx.lineTo(Math.cos(a)*r1,Math.sin(a)*r1); ctx.stroke(); }

  ctx.restore();
  rafId=requestAnimationFrame(drawReactor);
}

/* ---------- voice: browser mic (sphere + speech), Windows voice for replies ---------- */
const voiceEl=$('voice');
let voiceActive=false, busy=false, rec=null, recRunning=false;
const WAKE=/\b(wake up|wake|hey|hi|hello|morning|good morning|good evening|nexus|jarvis|you there|you up|listen|computer|talk to me|are you there)\b/i;
const SLEEP=/\b(go to sleep|sleep now|take a break|stand down|that'?s all|that is all|goodbye|good bye|bye now|shut down|stop listening|dismiss|quiet now|never mind)\b/i;
function setVState(s,text){ vState=s; $('vstate').textContent=s.toUpperCase();
  if(text!==undefined) $('vtext').textContent=text; }
function dbg(m){ const e=$('vdbg'); if(e) e.textContent=m; }

/* Microphone -> sphere reactivity (and confirms the mic is accessible). */
let micStream=null,audioCtx=null,analyser=null,micData=null,micLevel=0;
async function startMic(){
  try{
    micStream=await navigator.mediaDevices.getUserMedia({audio:true});
    audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    analyser=audioCtx.createAnalyser(); analyser.fftSize=512;
    audioCtx.createMediaStreamSource(micStream).connect(analyser);
    micData=new Uint8Array(analyser.frequencyBinCount); pollMic();
  }catch(e){ micLevel=0; dbg('mic blocked: '+(e.name||e)); }
}
function pollMic(){ if(!analyser) return; analyser.getByteTimeDomainData(micData);
  let s=0; for(let i=0;i<micData.length;i++){ const v=(micData[i]-128)/128; s+=v*v; }
  micLevel=Math.min(1,Math.sqrt(s/micData.length)*3); requestAnimationFrame(pollMic); }
function stopMic(){ try{micStream&&micStream.getTracks().forEach(t=>t.stop());}catch(e){}
  try{audioCtx&&audioCtx.close();}catch(e){} micStream=audioCtx=analyser=null; micLevel=0; }

/* Spoken turns come from the Python recognizer; the browser mic is only used for
   visual reactivity when permission is available. No background capture starts
   until the voice console is opened. */
async function postJSON(url){
  try{ return await (await fetch(url,{method:'POST'})).json(); }
  catch(e){ return {ok:false,error:String(e)}; }
}
async function getJSON(url){
  try{ return await (await fetch(url)).json(); }
  catch(e){ return {ok:false,error:String(e)}; }
}
function setButtons(){
  const listen=$('voiceListen'), stop=$('voiceStop'), mute=$('voiceMute');
  if(listen) listen.disabled = busy || !voiceActive;
  if(stop) stop.disabled = !speaking && vState!=='speaking';
  if(mute) mute.textContent = micStream ? 'M' : 'M';
}
function updateClock(){
  const now=new Date();
  const hh=String(now.getHours()).padStart(2,'0');
  const mm=String(now.getMinutes()).padStart(2,'0');
  const clk=$('vclock'), date=$('vdate');
  if(clk) clk.textContent=hh+':'+mm;
  if(date) date.textContent=now.toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long'});
}
async function refreshVoiceStatus(){
  const d=await getJSON('/api/voice/status');
  if(!d.ready){
    const miss=(d.missing||[]).join(', ');
    dbg(miss ? 'voice extras missing: '+miss : 'voice disabled');
  }else{
    dbg((d.provider==='gemini'?'Gemini':'Local')+' voice mode ready');
  }
  return d;
}
async function voiceTurn(){
  if(busy || !voiceActive) return;
  busy=true; setButtons(); setVState('listening','');
  $('vtranscript').textContent='';
  const d = await postJSON('/api/voice/listen');
  if(!voiceActive){ busy=false; setButtons(); return; }
  if(!d.ok){
    setVState('idle', d.error || 'Microphone unavailable.');
    dbg(d.hint || d.error || '');
    busy=false; setButtons(); return;
  }
  if(!d.handled){
    setVState('idle','');
    dbg('no speech detected');
    busy=false; setButtons(); return;
  }
  const heard=d.transcript||'';
  $('vtranscript').textContent=heard;
  dbg(heard ? 'heard: '+heard : '');
  if(SLEEP.test(heard)){ busy=false; exitVoice(); return; }
  setVState('thinking', heard);
  await new Promise(r=>setTimeout(r,120));
  setVState('speaking', d.reply||'');
  setButtons();
  await speakAsync(d.reply||'');
  if(voiceActive) setVState('idle','');
  busy=false; setButtons();
}

async function enterVoice(){
  if(voiceActive) return; voiceActive=true;
  voiceEl.classList.add('open'); resizeCanvas(); updateClock(); if(!rafId) drawReactor();
  setVState('idle',''); $('vtranscript').textContent='';
  await refreshVoiceStatus();
  startMic(); setButtons();
}
function exitVoice(){
  if(!voiceActive) return; voiceActive=false; busy=false;
  stopSpeaking(); stopMic(); voiceEl.classList.remove('open'); setVState('idle',''); setButtons();
}
function muteMic(){
  if(micStream) stopMic(); else startMic();
}
$('vexit').onclick=exitVoice;
$('orb').onclick=enterVoice;
$('voiceListen').onclick=voiceTurn;
$('voiceStop').onclick=()=>{ stopSpeaking(); setVState('idle',''); setButtons(); };
$('voiceMute').onclick=()=>{ muteMic(); setButtons(); };
addEventListener('keydown',e=>{
  if(e.key==='Escape') exitVoice();
  if((e.ctrlKey || e.metaKey) && e.code==='Space'){ e.preventDefault(); voiceActive ? voiceTurn() : enterVoice(); }
});
setInterval(updateClock, 1000);

/* idle orb on the main screen */
const oc=$('orbCanvas'); const octx=oc&&oc.getContext('2d'); let ot=0;
function drawOrb(){ if(!octx) return; ot+=0.016; octx.clearRect(0,0,128,128);
  octx.save(); octx.translate(64,64); const p=0.5+0.5*Math.sin(ot*2);
  octx.shadowColor='rgba(56,189,248,0.9)'; octx.shadowBlur=16+p*10; octx.lineWidth=2;
  octx.strokeStyle='rgba(56,189,248,'+(0.45+p*0.4)+')';
  octx.beginPath(); octx.arc(0,0,42,ot*0.6,ot*0.6+4.4); octx.stroke();
  octx.beginPath(); octx.arc(0,0,32,-ot*0.8,-ot*0.8+3.4); octx.stroke();
  octx.fillStyle='rgba(125,211,252,'+(0.55+p*0.3)+')'; octx.beginPath(); octx.arc(0,0,7+p*3,0,7); octx.fill();
  octx.restore(); requestAnimationFrame(drawOrb); }
drawOrb();

/* boot */
resizeCanvas(); loadToday();
setInterval(loadToday, 60000);
"""

_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nexus</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" href="/icon.png">
<link rel="apple-touch-icon" href="/icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#04070d">
<style>__CSS__</style></head><body>

<div class="topbar">
  <span class="logo">__LOGO__</span>
  <span class="brand">NEXUS</span>
  <span class="spacer"></span>
  <span class="status"><span id="statusDot" class="dot"></span><span id="statusText">…</span></span>
  <span id="gear" class="gear" title="Settings">&#9881;</span>
</div>

<div class="stage">
  <div id="orb" class="orb" title="Enter voice mode">
    <canvas id="orbCanvas" width="128" height="128"></canvas>
    <div class="hint">voice</div>
  </div>
  <div class="tagline">Tap the orb to talk, or type below.</div>
  <form id="askForm" class="cmd">
    <input id="askInput" type="text" placeholder="Ask Nexus anything…" autocomplete="off" autofocus>
    <button type="submit">Ask</button>
  </form>
  <div id="answer"></div>
  <div id="today" class="today"></div>
</div>

<!-- Settings modal -->
<div id="settings" class="modal">
  <div class="sheet">
    <span id="closeSettings" class="close-x">&times;</span>
    <h2>Settings</h2>

    <h3>Cloud brain (optional, free)</h3>
    <p>Paste a free Gemini API key for faster, smarter answers.
       Get one at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>.</p>
    <div class="row"><input id="gemKey" type="password" placeholder="Gemini API key"><button id="gemSave">Save</button></div>
    <p id="gemStatus"></p><div id="gemMsg" class="msg"></div>

    <h3>Email &amp; calendar</h3>
    <div id="connList" class="msg">Loading…</div>
    <p style="margin-top:12px">Add a Gmail account (email + 16-char App Password):</p>
    <div class="row"><input id="emEmail" type="text" placeholder="you@gmail.com">
      <input id="emPass" type="password" placeholder="App Password"><button id="emailSave">Add</button></div>
    <p style="margin-top:10px">Add a calendar (name + private iCal .ics link):</p>
    <div class="row"><input id="calName" type="text" placeholder="main">
      <input id="calUrl" type="text" placeholder="https://…/basic.ics"><button id="calSave">Add</button></div>
    <div id="connMsg" class="msg"></div>
  </div>
</div>

<!-- Full-screen Jarvis voice mode -->
<div id="voice" class="voice">
  <canvas id="reactor"></canvas>
  <span id="vexit" class="vexit" title="Exit">&times;</span>
  <div class="vcenter">
    <div id="vstate" class="vstate">IDLE</div>
    <div class="jarvis-mark">NEXUS</div>
    <div id="vclock" class="vclock">--:--</div>
    <div id="vdate" class="vdate"></div>
    <div id="vtext" class="vtext"></div>
    <div id="vtranscript" class="vtranscript"></div>
    <div class="vcontrols">
      <button id="voiceListen" class="primary" title="Listen">L</button>
      <button id="voiceStop" title="Stop speech">S</button>
      <button id="voiceMute" class="danger" title="Mic visualizer">M</button>
    </div>
    <button id="ptt" class="ptt" aria-hidden="true">Tap to talk</button>
  </div>
  <div id="vdbg" class="vdbg"></div>
</div>

<script>__JS__</script>
</body></html>"""


def render_home(nexus=None) -> str:
    return _HTML.replace("__CSS__", _CSS).replace("__JS__", _JS).replace("__LOGO__", LOGO_SVG)
