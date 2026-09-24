'use strict';

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const DERIBIT = 'https://www.deribit.com/api/v2';
const BYBIT = 'https://api.bybit.com';
const BINANCE_COINM = 'https://dapi.binance.com';
const XOOMAR = 'https://xoomar.com';
const BYK = 'https://bykaranteli.com';
const LUNO_SNAPSHOT = './data/luno.enc.json';
const HISTORY_KEY = 'crypto_radar_live_history_v20';
const LUNO_KEY = 'crypto_radar_luno_sync_key_v19';
const state = {
  tab: 'home', loading: false, data: null, started: false,
  lastErrors: [], autoTimer: null,
  credentials: null, luno: null, lunoLoading: false, lunoError: null, lunoLastSync: null,
  liq: {
    provider: null, at: null,
    market: {total:null,longUsd:null,shortUsd:null,events:null},
    BTC: {total:null,longUsd:null,shortUsd:null,events:null},
    ETH: {total:null,longUsd:null,shortUsd:null,events:null}
  }
};
const $ = s => document.querySelector(s);
const content = $('#content');

function n(v){
  if(typeof v==='number') return Number.isFinite(v)?v:null;
  if(typeof v!=='string') return null;
  let s=v.trim().replace(/,/g,'');
  if(!s) return null;
  let mult=1;
  const m=s.match(/(-?\d+(?:\.\d+)?)\s*([KMBT])?/i);
  if(!m) return null;
  const suffix=(m[2]||'').toUpperCase();
  if(suffix==='K') mult=1e3; else if(suffix==='M') mult=1e6; else if(suffix==='B') mult=1e9; else if(suffix==='T') mult=1e12;
  const x=Number(m[1])*mult;
  return Number.isFinite(x)?x:null;
}
function money(v,c='USD',d=0){ if(v==null||!Number.isFinite(v)) return '—'; return new Intl.NumberFormat('en-MY',{style:'currency',currency:c,maximumFractionDigits:d}).format(v); }
function compact(v){ if(v==null||!Number.isFinite(v)) return '—'; return new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2}).format(v); }
function pct(v,d=2){ if(v==null||!Number.isFinite(v)) return '—'; return `${v>0?'+':''}${v.toFixed(d)}%`; }
function clsDelta(v){ return v>0?'pos':v<0?'neg':''; }
function escapeHtml(s){ return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function toast(msg){ const el=$('#toast'); el.textContent=msg; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.add('hidden'),2200); }

async function fetchWithTimeout(url,opts={},timeoutMs=6500){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try { return await fetch(url,{...opts,signal:controller.signal,cache:'no-store'}); }
  catch(e){ if(e?.name==='AbortError') throw new Error(`Timeout ${new URL(url).hostname}`); throw e; }
  finally { clearTimeout(timer); }
}
async function fetchJson(url,opts={},timeoutMs=6500){
  const r=await fetchWithTimeout(url,opts,timeoutMs);
  const text=await r.text();
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  try { return text?JSON.parse(text):{}; } catch { throw new Error(`Invalid JSON from ${new URL(url).hostname}`); }
}

function normalizePct(v){
  const x=n(v); if(x==null) return null;
  if(x>=0&&x<=1.0001) return x*100;
  if(x>=0&&x<=100.0001) return x;
  return null;
}
function keyNorm(s){ return String(s||'').replace(/[^a-z0-9]/gi,'').toLowerCase(); }
function entriesDeep(root,maxDepth=5){
  const out=[],seen=new Set();
  function walk(v,path=[],depth=0){
    if(v==null||typeof v!=='object'||depth>maxDepth||seen.has(v)) return;
    seen.add(v);
    if(Array.isArray(v)){ v.forEach((x,i)=>walk(x,path.concat(String(i)),depth+1)); return; }
    out.push({obj:v,path});
    for(const [k,x] of Object.entries(v)) walk(x,path.concat(k),depth+1);
  }
  walk(root); return out;
}
function getAny(obj, regexes){
  if(!obj||typeof obj!=='object') return null;
  for(const [k,v] of Object.entries(obj)){
    const nk=keyNorm(k);
    if(regexes.some(r=>r.test(nk))){ const x=n(v); if(x!=null) return x; }
  }
  return null;
}
function findSymbolRow(raw,asset){
  const A=String(asset).toUpperCase();
  const rows=[];
  const root=raw?.data??raw;
  for(const {obj,path} of entriesDeep(root,6)){
    let id='';
    for(const k of ['symbol','coin','asset','ticker','contract','name']) if(obj[k]!=null){ id=String(obj[k]).toUpperCase(); break; }
    const p=path.join('/').toUpperCase();
    if(id===A||id===A+'USDT'||id.startsWith(A+'-')||id.startsWith(A+'/')||p.endsWith('/'+A)||p.endsWith('/'+A+'USDT')) rows.push(obj);
  }
  return rows;
}
function ratioFromR(r,provider){
  const R=n(r); if(R==null||R<=0) return null;
  const longPct=100*R/(1+R), shortPct=100/(1+R);
  return {longPct,shortPct,ratio:R,provider};
}
function parseByKPositioning(raw,asset){
  const rows=findSymbolRow(raw,asset);
  for(const row of rows){
    // Prefer Binance global account ratio because it counts all accounts equally.
    let R=getAny(row,[/^globalls$/, /^globallongshort/, /^binanceglobal/, /glob.*ratio/, /global.*ls/]);
    if(R!=null){ const z=ratioFromR(R,'ByKaranteli · Binance global accounts'); if(z) return z; }
    // Fallback: Bybit publishes share of accounts long directly.
    const bybitLong=normalizePct(getAny(row,[/bybit.*long/, /bybit.*pct/, /bybit.*share/]));
    if(bybitLong!=null&&bybitLong>=0&&bybitLong<=100) return {longPct:bybitLong,shortPct:100-bybitLong,ratio:(100-bybitLong)?bybitLong/(100-bybitLong):null,provider:'ByKaranteli · Bybit account share'};
    // Generic global ratio fallback.
    R=getAny(row,[/longshort/, /lsratio/, /^ratio$/]);
    if(R!=null){ const z=ratioFromR(R,'ByKaranteli · account ratio'); if(z) return z; }
  }
  return null;
}
function parseLiqRow(row){
  if(!row||typeof row!=='object') return null;
  let longUsd=getAny(row,[/^long$/, /^longs$/, /long.*usd/, /long.*liq/, /long.*liquid/]);
  let shortUsd=getAny(row,[/^short$/, /^shorts$/, /short.*usd/, /short.*liq/, /short.*liquid/]);
  let total=getAny(row,[/^total$/, /total.*usd/, /liquidated$/, /notional$/]);
  const events=getAny(row,[/^count$/, /^events$/, /event.*count/, /positions/]);
  if(total==null&&longUsd!=null&&shortUsd!=null) total=longUsd+shortUsd;
  if(longUsd==null&&shortUsd==null&&total==null) return null;
  return {total,longUsd,shortUsd,events};
}
function parseByKLiquidations(raw){
  const root=raw?.data??raw;
  let market=null;
  for(const key of ['recorded','market','totals','summary']){ if(root?.[key]){ market=parseLiqRow(root[key]); if(market) break; } }
  if(!market) market=parseLiqRow(root);
  if(!market) market={total:null,longUsd:null,shortUsd:null,events:null};
  function coin(asset){
    for(const row of findSymbolRow(root,asset)){ const p=parseLiqRow(row); if(p) return p; }
    // Known containers often use by_symbol / symbols / coins.
    for(const key of ['by_symbol','bySymbol','symbols','coins','top_symbols','topSymbols']){
      const x=root?.[key];
      if(Array.isArray(x)){
        const r=x.find(v=>String(v?.symbol||v?.coin||'').toUpperCase().startsWith(asset));
        const p=parseLiqRow(r); if(p) return p;
      }
    }
    return {total:null,longUsd:null,shortUsd:null,events:null};
  }
  return {provider:'ByKaranteli · recorded multi-venue',at:Date.now(),market,BTC:coin('BTC'),ETH:coin('ETH')};
}
async function loadByKPositioning(){
  const out={BTC:null,ETH:null,ts:Date.now()};
  const [b,e]=await Promise.allSettled([
    fetchJson(`${BYK}/api/public/positioning?symbol=BTCUSDT`,{},6500),
    fetchJson(`${BYK}/api/public/positioning?symbol=ETHUSDT`,{},6500)
  ]);
  if(b.status==='fulfilled') out.BTC=parseByKPositioning(b.value,'BTC');
  if(e.status==='fulfilled') out.ETH=parseByKPositioning(e.value,'ETH');
  if(!out.BTC&&!out.ETH){
    const msgs=[]; if(b.status==='rejected') msgs.push(`BTC ${b.reason?.message||b.reason}`); if(e.status==='rejected') msgs.push(`ETH ${e.reason?.message||e.reason}`);
    throw new Error(msgs.join('; ')||'ByKaranteli positioning schema not recognized');
  }
  return out;
}
async function loadByKLiquidations(){
  const j=await fetchJson(`${BYK}/api/public/liquidations`,{},7000);
  const out=parseByKLiquidations(j);
  if(out.market.total==null&&out.BTC.total==null&&out.ETH.total==null) throw new Error('ByKaranteli liquidation schema not recognized');
  return out;
}


function b64(bytes){ return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function unb64(s){ return Uint8Array.from(atob(s),c=>c.charCodeAt(0)); }
async function pinKey(pin,salt){
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pin),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:180000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function encryptCredentials(creds,pin){
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await pinKey(pin,salt);
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(creds)));
  return JSON.stringify({v:1,salt:b64(salt),iv:b64(iv),ct:b64(ct)});
}
async function decryptCredentials(blob,pin){
  const x=JSON.parse(blob),salt=unb64(x.salt),iv=unb64(x.iv),key=await pinKey(pin,salt);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,unb64(x.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}
function hexBytes(hex){
  const s=String(hex||'').trim();
  if(!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error('Sync Key 必须是 64 位 HEX');
  const out=new Uint8Array(32); for(let i=0;i<32;i++) out[i]=parseInt(s.slice(i*2,i*2+2),16); return out;
}
function randomSyncKey(){ const b=crypto.getRandomValues(new Uint8Array(32)); return [...b].map(x=>x.toString(16).padStart(2,'0')).join(''); }
async function copyTextRobust(text){
  const value=String(text||'');
  if(!value) throw new Error('没有可复制的 Sync Key');
  if(navigator.clipboard?.writeText){
    try{ await navigator.clipboard.writeText(value); return true; }catch{}
  }
  const ta=document.createElement('textarea');
  ta.value=value; ta.setAttribute('readonly','');
  ta.style.position='fixed'; ta.style.left='-9999px'; ta.style.top='0'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0,value.length);
  let ok=false; try{ ok=document.execCommand('copy'); }catch{}
  ta.remove();
  if(!ok) throw new Error('浏览器没有允许自动复制');
  return true;
}

async function decryptLunoSnapshot(blob,syncKey){
  if(!blob||blob.v!==1||blob.alg!=='AES-256-GCM') throw new Error('Encrypted Luno snapshot format not recognized');
  const key=await crypto.subtle.importKey('raw',hexBytes(syncKey),{name:'AES-GCM'},false,['decrypt']);
  const iv=unb64(blob.iv),ct=unb64(blob.ct),aad=new TextEncoder().encode('crypto-radar-luno-v1');
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},key,ct);
  return JSON.parse(new TextDecoder().decode(plain));
}
function tradeSide(t){
  const ty=String(t?.type||'').toUpperCase();
  if(ty==='BID'||ty==='BUY') return 'BUY';
  if(ty==='ASK'||ty==='SELL') return 'SELL';
  return t?.is_buy===true?'BUY':t?.is_buy===false?'SELL':'UNKNOWN';
}
function movingCost(trades){
  let inv=0,cost=0,buys=0,sells=0;
  for(const t of [...(trades||[])].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0))){
    const side=tradeSide(t),price=n(t.price),base=n(t.base)??n(t.volume),counter=n(t.counter)??(price!=null&&base!=null?price*base:null);
    const feeBase=n(t.fee_base)||0,feeCounter=n(t.fee_counter)||0;
    if(price==null||base==null||base<=0||counter==null) continue;
    if(side==='BUY'){
      const received=Math.max(0,base-feeBase),spent=Math.max(0,counter+feeCounter);
      inv+=received; cost+=spent; buys++;
    } else if(side==='SELL'){
      const removed=Math.max(0,base+feeBase),avg=inv>0?cost/inv:0,actual=Math.min(removed,inv);
      inv=Math.max(0,inv-actual); cost=Math.max(0,cost-avg*actual); sells++;
    }
  }
  return {inventory:inv,cost,avg:inv>0?cost/inv:null,buys,sells};
}
function accountBuckets(asset,balances){
  const rows=(balances||[]).filter(x=>String(x.asset).toUpperCase()===asset);
  const buckets={spot:0,staking:0,earn:0,savings:0,other:0,accounts:[]};
  for(const x of rows){
    const q=n(x.balance)||0,t=String(x.account_type||'UNKNOWN').toUpperCase();
    if(t==='SPOT'||t==='TRANSACTIONAL') buckets.spot+=q;
    else if(t==='STAKING') buckets.staking+=q;
    else if(t==='EARN') buckets.earn+=q;
    else if(t==='SAVINGS') buckets.savings+=q;
    else buckets.other+=q;
    buckets.accounts.push({id:String(x.account_id||''),type:t,balance:q,available:n(x.available)});
  }
  buckets.total=buckets.spot+buckets.staking+buckets.earn+buckets.savings+buckets.other;
  return buckets;
}

function transactionTrades(asset,entries){
  const expected=asset==='BTC'?'XBTMYR':'ETHMYR';
  const out=[];
  for(const t of entries||[]){
    const td=t?.detail_fields?.trade_details||t?.trade_details||null;
    if(!td) continue;
    const pair=String(td.pair||'').toUpperCase();
    if(pair && pair!==expected) continue;
    const delta=n(t.balance_delta);
    const price=n(td.price);
    let volume=Math.abs(n(td.volume)??delta??0);
    if(delta==null||delta===0||price==null||!Number.isFinite(volume)||volume<=0) continue;
    const side=delta>0?'BUY':'SELL';
    out.push({
      type:side, is_buy:side==='BUY', price:String(price), base:String(volume), volume:String(volume),
      counter:String(price*volume), fee_base:'0', fee_counter:'0', timestamp:n(t.timestamp)||0,
      sequence:n(td.sequence)??n(t.row_index)??0, source:'account_transaction'
    });
  }
  const seen=new Set();
  return out.sort((a,b)=>(a.timestamp||0)-(b.timestamp||0)).filter(t=>{
    const key=[t.timestamp,t.type,t.price,t.base,t.sequence].join('|');
    if(seen.has(key)) return false; seen.add(key); return true;
  });
}
function costTradesFromSnapshot(asset,snap){
  const txs=asset==='BTC'?(snap.btcTransactions||[]):(snap.ethTransactions||[]);
  const derived=transactionTrades(asset,txs);
  const exchange=asset==='BTC'?(snap.btcTrades||[]):(snap.ethTrades||[]);
  if(derived.length) return {trades:derived,source:'Luno transactions'};
  return {trades:exchange,source:exchange.length?'Luno Exchange':'No trade history'};
}
function fundingSimple(m){
  const s=fundingState(m);
  return s==='High'?'偏高':s==='Elevated'?'稍高':s==='Normal'?'正常':'暂无';
}
function riskSimple(r){ return r==='High'?'高':r==='Elevated'?'偏高':'正常'; }
function liqDirection(asset){
  const l=state.liq?.[asset]||{},a=n(l.longUsd),b=n(l.shortUsd);
  if(a==null||b==null) return '暂无';
  if(a>b*1.25) return '多头爆仓较多';
  if(b>a*1.25) return '空头爆仓较多';
  return '多空接近';
}
function syncTime(){
  const t=state.luno?.at||state.lunoLastSync;
  if(!t) return '尚未同步';
  return new Date(t).toLocaleString('zh-MY',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
function buildLunoAsset(label,lunoAsset,balances,trades,currentMYR,currentUSD,costSource='') {
  const b=accountBuckets(lunoAsset,balances),c=movingCost(trades);
  const trackedQty=Math.min(b.total,Math.max(0,c.inventory));
  const trackedCost=c.avg!=null?c.avg*trackedQty:null;
  const trackedValue=currentMYR!=null?currentMYR*trackedQty:null;
  const trackedPnl=(trackedValue!=null&&trackedCost!=null)?trackedValue-trackedCost:null;
  const trackedReturn=(trackedPnl!=null&&trackedCost>0)?trackedPnl/trackedCost*100:null;
  const marketValue=currentMYR!=null?currentMYR*b.total:null;
  const impliedFx=(currentMYR!=null&&currentUSD)?currentMYR/currentUSD:null;
  const avgUSD=(c.avg!=null&&impliedFx)?c.avg/impliedFx:null;
  const coverage=b.total>0?trackedQty/b.total*100:null;
  return {asset:label,lunoAsset,total:b.total,spot:b.spot,staking:b.staking,earn:b.earn,savings:b.savings,other:b.other,accounts:b.accounts,
    currentMYR,currentUSD,marketValue,avgMYR:c.avg,avgUSD,tradeInventory:c.inventory,tradeCost:c.cost,trackedQty,trackedCost,trackedPnl,trackedReturn,coverage,
    untrackedQty:Math.max(0,b.total-trackedQty),buys:c.buys,sells:c.sells,costSource};
}
function tradeViews(asset,trades){
  return [...(trades||[])].sort((a,b)=>(b.timestamp||0)-(a.timestamp||0)).slice(0,30).map(t=>{
    const base=n(t.base)??n(t.volume)??0,price=n(t.price),counter=n(t.counter)??(price!=null?price*base:null);
    return {asset,side:tradeSide(t),timestamp:t.timestamp||0,price,volume:base,gross:counter,feeBase:n(t.fee_base)||0,feeCounter:n(t.fee_counter)||0};
  });
}
async function getLunoPortfolio(creds){
  const enc=await fetchJson(`${LUNO_SNAPSHOT}?t=${Date.now()}`,{},8000);
  const snap=await decryptLunoSnapshot(enc,creds.syncKey);
  if(!String(snap.schema||'').startsWith('crypto-radar-luno-snapshot-v')) throw new Error('Luno snapshot schema not recognized');
  const rows=snap.balances||[];
  const btcCost=costTradesFromSnapshot('BTC',snap),ethCost=costTradesFromSnapshot('ETH',snap);
  const btcTrades=btcCost.trades,ethTrades=ethCost.trades;
  const btcMYR=n(snap.btcMYR),ethMYR=n(snap.ethMYR);
  const btcUSD=state.data?.btcM?.price??null,ethUSD=state.data?.ethM?.price??null;
  return {
    btc:buildLunoAsset('BTC','XBT',rows,btcTrades,btcMYR,btcUSD,btcCost.source),
    eth:buildLunoAsset('ETH','ETH',rows,ethTrades,ethMYR,ethUSD,ethCost.source),
    btcTrades:tradeViews('BTC',btcTrades),ethTrades:tradeViews('ETH',ethTrades),warnings:snap.warnings||[],rawBalances:rows,
    at:Date.parse(snap.generatedAt||'')||Date.now(), generatedAt:snap.generatedAt||null
  };
}
async function refreshLuno({silent=false}={}){
  if(!state.credentials||state.lunoLoading) return;
  state.lunoLoading=true; state.lunoError=null; if(!silent) render();
  try{
    state.luno=await getLunoPortfolio(state.credentials); state.lunoLastSync=state.luno.at||Date.now(); state.lunoError=null;
    if(!silent) toast('Luno 加密快照已读取');
  }catch(e){
    const msg=String(e?.message||e);
    state.lunoError=/404|Failed to fetch|Load failed|NetworkError|Timeout/i.test(msg)?'还没有可读取的 Luno 加密快照。请先在 GitHub Actions 运行 Luno Sync，然后等 Pages 更新：'+msg:'Luno 快照读取失败：'+msg;
    if(!silent) toast('Luno 快照读取失败');
  }finally{ state.lunoLoading=false; render(); }
}
function savedLunoKey(){ return !!localStorage.getItem(LUNO_KEY); }

function readHistory(){
  try { const x=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]'); return Array.isArray(x)?x:[]; } catch { return []; }
}
function oi24FromLocal(asset,currentOi){
  if(currentOi==null) return null;
  const hist=readHistory().filter(x=>x?.[asset]?.oi>0);
  const target=Date.now()-24*3600*1000;
  const candidates=hist.filter(x=>x.t<=Date.now()-18*3600*1000);
  if(!candidates.length) return null;
  let best=candidates[0];
  for(const h of candidates){ if(Math.abs(h.t-target)<Math.abs(best.t-target)) best=h; }
  const old=n(best?.[asset]?.oi);
  if(!old) return null;
  return (currentOi-old)/old*100;
}
function saveHistory(btc,eth){
  try {
    const h=readHistory();
    h.push({t:Date.now(),BTC:{oi:btc?.oiUSD||null,p:btc?.price||null},ETH:{oi:eth?.oiUSD||null,p:eth?.price||null}});
    const cutoff=Date.now()-8*24*3600*1000;
    const trimmed=h.filter(x=>x.t>=cutoff).slice(-500);
    localStorage.setItem(HISTORY_KEY,JSON.stringify(trimmed));
  } catch {}
}

async function hyperliquidCore(){
  const raw=await fetchJson(HL_INFO,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'metaAndAssetCtxs'})
  },7000);
  if(!Array.isArray(raw)||raw.length<2) throw new Error('Hyperliquid schema changed');
  const [meta,ctxs]=raw;
  const build=asset=>{
    const idx=meta?.universe?.findIndex(x=>x?.name===asset);
    if(idx==null||idx<0||!ctxs?.[idx]) throw new Error(`Hyperliquid missing ${asset}`);
    const c=ctxs[idx];
    const price=n(c.markPx)??n(c.midPx)??n(c.oraclePx);
    const prev=n(c.prevDayPx);
    const oiCoin=n(c.openInterest);
    const oiUSD=(oiCoin!=null&&price!=null)?oiCoin*price:null;
    return {
      asset, symbol:`${asset}-PERP`, provider:'Hyperliquid LIVE', live:true,
      price, price24:(price!=null&&prev)?(price-prev)/prev*100:null,
      volume:n(c.dayNtlVlm), funding:(n(c.funding)!=null?n(c.funding)*100:null), fundingPeriod:'1H',
      oiUSD, oi24:oi24FromLocal(asset,oiUSD),
      longPct:null, shortPct:null, ratio:null, ratioProvider:null,
      etf:null, at:Date.now()
    };
  };
  return {BTC:build('BTC'),ETH:build('ETH'),provider:'Hyperliquid'};
}

async function deribitOne(asset){
  const j=await fetchJson(`${DERIBIT}/public/ticker?instrument_name=${asset}-PERPETUAL`,{},6500);
  const x=j?.result;
  if(!x) throw new Error(`Deribit missing ${asset}`);
  const price=n(x.index_price)??n(x.mark_price)??n(x.last_price);
  const oi=n(x.open_interest);
  const f=n(x.funding_8h);
  return {
    asset, symbol:`${asset}-PERPETUAL`, provider:'Deribit LIVE', live:true,
    price, price24:n(x?.stats?.price_change), volume:n(x?.stats?.volume_usd)??n(x?.stats?.volume),
    funding:f!=null?f*100:null, fundingPeriod:'8H', oiUSD:oi, oi24:oi24FromLocal(asset,oi),
    longPct:null, shortPct:null, ratio:null, ratioProvider:null, etf:null, at:Date.now()
  };
}
async function deribitCore(){
  const [b,e]=await Promise.all([deribitOne('BTC'),deribitOne('ETH')]);
  return {BTC:b,ETH:e,provider:'Deribit'};
}


function parseEtfRows(j,asset){
  const rows=Array.isArray(j?.data)?j.data:[];
  const wanted=String(asset).toLowerCase();
  const filtered=rows.filter(r=>String(r?.asset||'').toLowerCase()===wanted && r?.date);
  const byDate=new Map();
  for(const r of filtered){
    const flow=n(r?.flowUsd);
    if(flow==null) continue;
    const d=String(r.date).slice(0,10);
    byDate.set(d,(byDate.get(d)||0)+flow);
  }
  const dates=[...byDate.keys()].sort().reverse();
  if(!dates.length) return null;
  const latestDate=dates[0], latest=byDate.get(latestDate);
  const fiveDates=dates.slice(0,5), five=fiveDates.reduce((s,d)=>s+(byDate.get(d)||0),0);
  return {latestDate,latest,five,days:fiveDates.length,provider:'XOOMAR issuer files',coverage:'issuer-file coverage'};
}
async function loadEtf(asset){
  const j=await fetchJson(`${XOOMAR}/api/markets/etf-flows?asset=${asset.toLowerCase()}&days=14`,{},6500);
  const out=parseEtfRows(j,asset);
  if(!out) throw new Error('ETF rows unavailable');
  return out;
}

async function loadCore(){
  const errors=[];
  try { return {...await hyperliquidCore(),errors}; }
  catch(e){ errors.push(`Hyperliquid: ${e.message||e}`); }
  try { return {...await deribitCore(),errors}; }
  catch(e){ errors.push(`Deribit: ${e.message||e}`); }
  throw new Error(errors.join(' | ')||'No live market source');
}
function attachOptional(base,ratio,etf){
  return {...base,
    longPct:ratio?.longPct??null, shortPct:ratio?.shortPct??null, ratio:ratio?.ratio??null, ratioProvider:ratio?.provider??null,
    etf:etf||null
  };
}

function fundingState(m){
  if(m.funding==null) return 'Unknown';
  const x=Math.abs(m.funding); const high=m.fundingPeriod==='1H'?0.02:0.12; const elevated=m.fundingPeriod==='1H'?0.008:0.05;
  return x>=high?'High':x>=elevated?'Elevated':'Normal';
}
function analyze(m){
  const p=m.price24, oi=m.oi24, fs=fundingState(m);
  let regime='Live market'; let ex='真实市场数据已连接。OI 24H 需要本机累积历史后才会出现。';
  if(p!=null&&oi!=null){
    if(p>0.5&&oi>2){regime='上涨 + 杠杆扩张';ex='价格与未平仓合约同时增加，说明新杠杆仓位正在进入。';}
    else if(p>0.5&&oi<-2){regime='上涨 + 去杠杆';ex='价格上涨但 OI 下降，常见于空头平仓或 squeeze 后仓位减少。';}
    else if(p<-0.5&&oi>2){regime='下跌 + 杠杆扩张';ex='价格下跌而 OI 增加，说明下跌过程中仍有新杠杆仓位进入。';}
    else if(p<-0.5&&oi<-2){regime='下跌 + 去杠杆';ex='价格与 OI 同时下降，常见于多头退出或杠杆清洗。';}
    else {regime='Mixed / range';ex='Price 与 OI 暂时没有形成很强的单一结构信号。';}
  }
  let risk='Normal';
  if(fs==='High'||(oi!=null&&Math.abs(oi)>12)) risk='High';
  else if(fs==='Elevated'||(oi!=null&&Math.abs(oi)>6)) risk='Elevated';
  return {regime,ex,risk,fs};
}

function liveBadge(){
  const d=state.data;if(!d)return '';
  const coreOk=d.btcM?.live&&d.ethM?.live;
  const ratioOk=true; // ByKaranteli LIVE positioning embeds are the canonical positioning view in v1.7
  const etfOk=!!d.btcM?.etf&&!!d.ethM?.etf;
  const liqOk=state.liq?.market?.total!=null;
  let label='PARTIAL LIVE',klass='warn';
  if(coreOk&&ratioOk&&etfOk&&liqOk){label='LIVE DATA';klass='good';}
  else if(coreOk){label='LIVE CORE';klass='good';}
  return `<span class="pill ${klass}">● ${label}</span>`;
}

async function refresh(){
  if(state.loading) return;
  state.loading=true; $('#refreshBtn').classList.add('loading'); if(!state.data) render();
  try {
    const core=await loadCore(); let btc=core.BTC,eth=core.ETH;
    const [be,ee,liq]=await Promise.allSettled([loadEtf('BTC'),loadEtf('ETH'),loadByKLiquidations()]);
    const etfB=be.status==='fulfilled'?be.value:null, etfE=ee.status==='fulfilled'?ee.value:null;
    if(liq.status==='fulfilled') state.liq=liq.value;
    // Positioning is intentionally shown through ByKaranteli's live widgets instead of collapsing
    // several different venue/account metrics into one misleading universal Long% number.
    btc=attachOptional(btc,null,etfB); eth=attachOptional(eth,null,etfE);
    saveHistory(btc,eth); btc.oi24=oi24FromLocal('BTC',btc.oiUSD); eth.oi24=oi24FromLocal('ETH',eth.oiUSD);
    const optErrors=[];
    if(!etfB) optErrors.push(`BTC ETF: ${be.reason?.message||be.reason||'unavailable'}`);
    if(!etfE) optErrors.push(`ETH ETF: ${ee.reason?.message||ee.reason||'unavailable'}`);
    if(liq.status!=='fulfilled') optErrors.push(`Liquidation 24H: ${liq.reason?.message||liq.reason||'unavailable'}`);
    state.data={btcM:btc,ethM:eth,provider:core.provider,errors:[...(core.errors||[]),...optErrors],refreshedAt:Date.now()};
    state.lastErrors=state.data.errors; render(); toast('LIVE 数据已更新');
    if(state.credentials) await refreshLuno({silent:true});
  } catch(e){
    state.lastErrors=[String(e.message||e)];
    if(!state.data) content.innerHTML=`<div class="error"><b>LIVE 数据连接失败</b><br><br>${escapeHtml(e.message||String(e))}<br><br>没有启用 Demo 假数据。点右上角 ↻ 重试。</div>`;
    else toast('本次刷新失败，保留上一笔 LIVE 数据');
  } finally { state.loading=false; $('#refreshBtn').classList.remove('loading'); if(state.data) render(); }
}

function hero(asset,m){
  return `<section class="hero"><div class="hero-top"><div><div class="coin">${asset} · ${escapeHtml(m.provider)}</div><div class="price">${money(m.price,'USD',0)}</div><div class="sub">24H <span class="delta ${clsDelta(m.price24)}">${pct(m.price24)}</span> · ${new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div></div>${liveBadge()}</div>
    <div class="grid"><div class="metric"><div class="label">Open Interest · venue</div><div class="value">${compact(m.oiUSD)}</div><div class="note">${escapeHtml(m.provider.split(" ")[0])} · 24H ${m.oi24==null?'收集中':`<span class="delta ${clsDelta(m.oi24)}">${pct(m.oi24)}</span>`}</div></div><div class="metric"><div class="label">Funding ${m.fundingPeriod||''}</div><div class="value">${m.funding==null?'—':m.funding.toFixed(4)+'%'}</div><div class="note">${fundingState(m)}</div></div></div></section>`;
}
function liqMini(asset){
  const l=state.liq?.[asset]||{};
  return `<div class="card"><div class="section-title"><h3>${asset} Liquidation · 24H</h3><small>${escapeHtml(state.liq?.provider||'Unavailable')}</small></div><div class="grid"><div class="metric"><div class="label">Long liquidated</div><div class="value">${compact(l.longUsd)}</div></div><div class="metric"><div class="label">Short liquidated</div><div class="value">${compact(l.shortUsd)}</div></div></div><div class="fineprint">过去 24 小时多交易所实测强平；不是估算 liquidation heatmap。${l.events!=null?` 事件数 ${Math.round(l.events).toLocaleString('en')}`:''}</div></div>`;
}
function etfMini(asset,m){
  const e=m.etf;
  if(!e) return `<div class="card"><div class="section-title"><h3>${asset} ETF Flow</h3><small>Unavailable</small></div><div class="empty">ETF 数据源暂时无法访问；不会用假数据。</div></div>`;
  return `<div class="card"><div class="section-title"><h3>${asset} ETF Flow</h3><small>${escapeHtml(e.provider)}</small></div><div class="grid"><div class="metric"><div class="label">Latest · ${escapeHtml(e.latestDate)}</div><div class="value delta ${clsDelta(e.latest)}">${money(e.latest,'USD',0)}</div></div><div class="metric"><div class="label">Last ${e.days} days</div><div class="value delta ${clsDelta(e.five)}">${money(e.five,'USD',0)}</div></div></div><div class="fineprint">来源为发行商文件推算的 ETF flow，覆盖度可能不完整；不是交易所成交量。 <a href="https://xoomar.com/markets/api/etf-flows" target="_blank" rel="noopener" style="color:#7bd4ff">Source: XOOMAR</a></div></div>`;
}
function personalSummary(){
  if(!state.luno) return '';
  const b=state.luno.btc,e=state.luno.eth;
  const value=(b.marketValue||0)+(e.marketValue||0);
  const full=[b,e].every(x=>x.total<=0||(x.coverage!=null&&x.coverage>=99.5&&x.trackedCost!=null));
  const cost=(b.trackedCost||0)+(e.trackedCost||0);
  const pnl=full?value-cost:null;
  const ret=full&&cost>0?pnl/cost*100:null;
  return `<section class="section"><div class="section-title"><h3>我的资产</h3><small>Luno · ${escapeHtml(syncTime())}</small></div><div class="card"><div class="asset-header"><div><div class="label">当前总市值</div><div class="asset-name">${money(value,'MYR',0)}</div></div>${ret!=null?`<span class="pill ${ret>=0?'good':'bad'}">${pct(ret,1)}</span>`:''}</div><div class="grid"><div class="metric"><div class="label">${full?'总投入成本':'可计算成本'}</div><div class="value">${cost>0?money(cost,'MYR',0):'—'}</div></div><div class="metric"><div class="label">${full?'总盈亏':'盈亏'}</div><div class="value delta ${clsDelta(pnl)}">${pnl!=null?money(pnl,'MYR',0):'—'}</div><div class="note">${full?'按现有持仓计算':'成本资料还没完整'}</div></div></div>${!full?'<div class="notice warning" style="margin-top:12px">余额已经读到，但部分买入记录还没覆盖，所以总盈亏暂时不乱算。</div>':''}</div></section>`;
}
function renderHome(){
  const d=state.data,a=analyze(d.btcM);
  const p24=d.btcM.price24==null?'—':pct(d.btcM.price24);
  const oi=d.btcM.oi24==null?'收集中':pct(d.btcM.oi24);
  const ldir=liqDirection('BTC');
  content.innerHTML=`${personalSummary()}
    <section class="section"><div class="section-title"><h3>今天市场</h3><small>${escapeHtml(a.regime)}</small></div><div class="card analysis"><strong>${escapeHtml(a.regime)}</strong><br><span>${escapeHtml(a.ex)}</span><div class="grid" style="margin-top:14px"><div class="metric"><div class="label">BTC 24小时</div><div class="value delta ${clsDelta(d.btcM.price24)}">${p24}</div></div><div class="metric"><div class="label">杠杆仓位变化</div><div class="value">${oi}</div></div><div class="metric"><div class="label">资金费率</div><div class="value">${fundingSimple(d.btcM)}</div></div><div class="metric"><div class="label">24H 爆仓</div><div class="value" style="font-size:1rem">${ldir}</div></div></div></div></section>
    <section class="section"><div class="section-title"><h3>价格</h3><small>LIVE</small></div><div class="grid"><div class="metric"><div class="label">BTC</div><div class="value">${money(d.btcM.price,'USD',0)}</div><div class="note">24H ${pct(d.btcM.price24)}</div></div><div class="metric"><div class="label">ETH</div><div class="value">${money(d.ethM.price,'USD',0)}</div><div class="note">24H ${pct(d.ethM.price24)}</div></div></div></section>
    ${!state.luno?`<button id="homeConnectLuno" class="btn primary full">连接我的 Luno 持仓</button>`:''}`;
  const c=$('#homeConnectLuno'); if(c)c.onclick=openLunoSetup;
}
function miniAsset(m){
  return `<div class="card"><div class="asset-header"><div><div class="asset-name">${money(m.price,'USD',0)}</div><div class="asset-balance">24H <span class="delta ${clsDelta(m.price24)}">${pct(m.price24)}</span></div></div><span class="pill good">LIVE</span></div><div class="grid"><div class="metric"><div class="label">OI</div><div class="value">${compact(m.oiUSD)}</div></div><div class="metric"><div class="label">Funding ${m.fundingPeriod||''}</div><div class="value">${m.funding==null?'—':m.funding.toFixed(4)+'%'}</div></div></div></div>`;
}
function lunoAssetCard(p,m,trades){
  const full=p.total<=0||(p.coverage!=null&&p.coverage>=99.5&&p.avgMYR!=null);
  const qty=p.total.toFixed(p.asset==='BTC'?8:6);
  const spot=p.spot>0?`现货 ${p.spot.toFixed(p.asset==='BTC'?8:6)}`:'';
  const stake=p.staking>0?`质押 ${p.staking.toFixed(p.asset==='BTC'?8:6)}`:'';
  const split=[spot,stake].filter(Boolean).join(' · ');
  return `<section class="section"><div class="section-title"><h3>${p.asset}</h3><small>${p.buys||0} 次买入 · ${p.sells||0} 次卖出</small></div><div class="card"><div class="asset-header"><div><div class="asset-name">${qty} ${p.asset}</div><div class="asset-balance">当前市值 ${p.marketValue!=null?money(p.marketValue,'MYR',0):'—'}</div></div>${p.trackedReturn!=null?`<span class="pill ${p.trackedReturn>=0?'good':'bad'}">${pct(p.trackedReturn,1)}</span>`:''}</div><div class="grid"><div class="metric"><div class="label">平均买价</div><div class="value">${p.avgMYR!=null?money(p.avgMYR,'MYR',0):'—'}</div><div class="note">每 1 ${p.asset}</div></div><div class="metric"><div class="label">当前价格</div><div class="value">${p.currentMYR!=null?money(p.currentMYR,'MYR',0):'—'}</div><div class="note">Luno 快照价</div></div><div class="metric"><div class="label">盈亏</div><div class="value delta ${clsDelta(p.trackedPnl)}">${p.trackedPnl!=null?money(p.trackedPnl,'MYR',0):'—'}</div><div class="note">${p.trackedReturn!=null?pct(p.trackedReturn,1):'成本资料不足'}</div></div><div class="metric"><div class="label">持仓分布</div><div class="value" style="font-size:1rem">${split||'—'}</div></div></div>${!full?`<div class="notice warning" style="margin-top:12px">成本记录覆盖 ${p.coverage==null?'0.0':p.coverage.toFixed(1)}%。余额是真的，但平均买价/盈亏只会在找到对应买入记录后显示。</div>`:''}<div class="fineprint">成本来源：${escapeHtml(p.costSource||'暂无')}。最后同步：${escapeHtml(syncTime())}</div></div>${trades?.length?`<details class="card simple-details"><summary>查看最近交易</summary><div style="margin-top:12px">${trades.slice(0,8).map(t=>`<div class="trade"><div><b class="delta ${t.side==='BUY'?'pos':'neg'}">${t.side==='BUY'?'买入':'卖出'}</b> ${t.volume.toFixed(p.asset==='BTC'?8:6)} ${p.asset}<br><small>${new Date(t.timestamp).toLocaleString()}</small></div><div style="text-align:right"><b>${t.price!=null?money(t.price,'MYR',0):'—'}</b><br><small>${t.gross!=null?money(t.gross,'MYR',0):'—'}</small></div></div>`).join('')}</div></details>`:''}</section>`;
}
function renderPortfolio(){
  if(!state.credentials&&!state.luno){
    content.innerHTML=`<div class="empty"><b>还没连接 Luno</b><br><br>连接后这里只看：总市值、平均买价、当前价格和赚亏。<br><br><button id="connectLunoBtn" class="btn primary">连接 Luno 加密快照</button>${savedLunoKey()?'<br><br><button id="unlockLunoBtn" class="btn ghost">用 PIN 解锁已保存 Sync Key</button>':''}</div>`;
    $('#connectLunoBtn').onclick=openLunoSetup; const u=$('#unlockLunoBtn'); if(u)u.onclick=openLunoUnlock; return;
  }
  if(state.lunoLoading&&!state.luno){ content.innerHTML='<div class="empty">正在读取你的 Luno 资产…</div>'; return; }
  if(!state.luno){ content.innerHTML=`<div class="error">${escapeHtml(state.lunoError||'Luno 加密快照尚未读取成功')}</div><button id="retryLunoBtn" class="btn primary full">重试</button><button id="changeLunoBtn" class="btn ghost full" style="margin-top:10px">更换 Sync Key</button>`; $('#retryLunoBtn').onclick=()=>refreshLuno(); $('#changeLunoBtn').onclick=openLunoSetup; return; }
  const p=state.luno;
  content.innerHTML=`${personalSummary()}${lunoAssetCard(p.btc,state.data?.btcM,p.btcTrades)}${lunoAssetCard(p.eth,state.data?.ethM,p.ethTrades)}${p.warnings?.length?`<details class="card simple-details"><summary>数据提醒</summary><div class="fineprint" style="margin-top:10px">${p.warnings.map(escapeHtml).join('<br>')}</div></details>`:''}<button id="refreshLunoBtn" class="btn ghost full">重新读取最新快照</button>`;
  $('#refreshLunoBtn').onclick=()=>refreshLuno();
}
function marketCard(asset,m){
  const a=analyze(m),l=state.liq[asset];
  return `<section class="section"><div class="section-title"><h3>${asset} Market Structure</h3><small>${escapeHtml(m.provider)}</small></div><div class="card"><div class="grid three">
    <div class="metric"><div class="label">Price 24H</div><div class="value delta ${clsDelta(m.price24)}">${pct(m.price24)}</div></div>
    <div class="metric"><div class="label">OI · venue</div><div class="value">${compact(m.oiUSD)}</div><div class="note">${escapeHtml(m.provider.split(" ")[0])} · 24H ${m.oi24==null?'收集中':pct(m.oi24)}</div></div>
    <div class="metric"><div class="label">Funding ${m.fundingPeriod||''}</div><div class="value">${m.funding==null?'—':m.funding.toFixed(4)+'%'}</div></div>
    <div class="metric"><div class="label">Positioning</div><div class="value">LIVE</div><div class="note">ByKaranteli widget ↓</div></div>
    <div class="metric"><div class="label">Positioning note</div><div class="value" style="font-size:1rem">Multi-metric</div><div class="note">Binance / Bybit / OKX / taker</div></div>
    <div class="metric"><div class="label">24H Volume</div><div class="value">${compact(m.volume)}</div></div>
    <div class="metric"><div class="label">ETF latest</div><div class="value delta ${clsDelta(m.etf?.latest)}">${m.etf?money(m.etf.latest,'USD',0):'—'}</div><div class="note">${m.etf?.latestDate||'unavailable'}</div></div>
    <div class="metric"><div class="label">Long liq · 24H</div><div class="value">${compact(l.longUsd)}</div><div class="note">${escapeHtml(state.liq?.provider||'unavailable')}</div></div>
    <div class="metric"><div class="label">Short liq · 24H</div><div class="value">${compact(l.shortUsd)}</div><div class="note">${l.events!=null?Math.round(l.events).toLocaleString('en')+' events':'measured'}</div></div>
  </div></div><div class="card analysis"><div class="row"><span class="left">Regime</span><span class="right">${a.regime}</span></div><div class="row"><span class="left">Leverage risk</span><span class="right"><span class="pill ${a.risk==='High'?'bad':a.risk==='Normal'?'good':'warn'}">${a.risk}</span></span></div><p>${a.ex}</p></div></section>`;
}
function renderMarket(){
  const d=state.data,ba=analyze(d.btcM),ea=analyze(d.ethM),ml=state.liq?.market||{};
  const simple=(asset,m,a)=>`<section class="section"><div class="section-title"><h3>${asset}</h3><small>${escapeHtml(a.regime)}</small></div><div class="card"><div class="grid"><div class="metric"><div class="label">24小时涨跌</div><div class="value delta ${clsDelta(m.price24)}">${pct(m.price24)}</div></div><div class="metric"><div class="label">杠杆仓位变化</div><div class="value">${m.oi24==null?'收集中':pct(m.oi24)}</div></div><div class="metric"><div class="label">资金费率</div><div class="value">${fundingSimple(m)}</div><div class="note">${m.funding==null?'—':m.funding.toFixed(4)+'%'}</div></div><div class="metric"><div class="label">24H 爆仓</div><div class="value" style="font-size:1rem">${liqDirection(asset)}</div></div></div><div class="fineprint">${escapeHtml(a.ex)}</div></div></section>`;
  const globalLiq=ml.total!=null?`<div class="card"><div class="section-title"><h3>全市场爆仓 · 24H</h3><small>${escapeHtml(state.liq.provider||'ByKaranteli')}</small></div><div class="grid"><div class="metric"><div class="label">总额</div><div class="value">${compact(ml.total)}</div></div><div class="metric"><div class="label">多头</div><div class="value">${compact(ml.longUsd)}</div></div><div class="metric"><div class="label">空头</div><div class="value">${compact(ml.shortUsd)}</div></div></div></div>`:'';
  content.innerHTML=`<section class="section"><div class="section-title"><h3>看这 4 个就够了</h3><small>价格 · 杠杆 · 资金费率 · 爆仓</small></div><div class="notice warning">不知道专业词没关系。平时先看下面四项；更细的 OI、ETF、Positioning 放到“专业数据”里面。</div></section>${simple('BTC',d.btcM,ba)}${simple('ETH',d.ethM,ea)}<details class="card simple-details"><summary><b>专业数据</b>（需要时才展开）</summary><div style="margin-top:14px">${marketCard('BTC',d.btcM)}${marketCard('ETH',d.ethM)}${etfMini('BTC',d.btcM)}${etfMini('ETH',d.ethM)}${globalLiq}<div class="fineprint"><b>OI</b> = 杠杆合约未平仓总量；<b>Funding</b> = 多空双方定期支付的资金费率；<b>Liquidation</b> = 杠杆仓位被强制平仓；<b>ETF Flow</b> = ETF 资金流参考。Positioning 各交易所算法不同，不强行合并成一个数字。</div></div></details>`;
}
function renderSettings(){
  const d=state.data,has=savedLunoKey();
  const connected=!!state.luno;
  content.innerHTML=`<section class="section"><div class="section-title"><h3>设置</h3>${liveBadge()}</div><div class="card"><div class="row"><span class="left">Luno</span><span class="right">${connected?'已连接':'未连接'}</span></div><div class="row"><span class="left">最后同步</span><span class="right">${escapeHtml(syncTime())}</span></div><div class="row"><span class="left">本机保存 Sync Key</span><span class="right">${has?'是':'否'}</span></div><div class="row"><span class="left">交易功能</span><span class="right">无 · 只读</span></div></div>${state.lunoError?`<div class="error">${escapeHtml(state.lunoError)}</div>`:''}
  <button id="connectSettingsBtn" class="btn ghost full">${state.credentials?'更换 Sync Key':'连接 Luno'}</button>${has&&!state.credentials?'<button id="unlockSettingsBtn" class="btn ghost full" style="margin-top:10px">用 PIN 解锁 Sync Key</button>':''}
  <details class="card simple-details" style="margin-top:12px"><summary><b>高级数据状态</b></summary><div style="margin-top:12px"><div class="row"><span class="left">市场核心</span><span class="right">${escapeHtml(d.provider)}</span></div><div class="row"><span class="left">BTC / ETH</span><span class="right">${d.btcM?.live&&d.ethM?.live?'LIVE':'部分离线'}</span></div><div class="row"><span class="left">ETF</span><span class="right">${d.btcM?.etf&&d.ethM?.etf?'已连接':'部分不可用'}</span></div><div class="row"><span class="left">24H 爆仓</span><span class="right">${state.liq?.market?.total!=null?'已连接':'不可用'}</span></div><div class="row"><span class="left">Luno 传输</span><span class="right">GitHub Actions 加密快照</span></div></div></details>${has?'<button id="forgetLunoBtn" class="btn ghost full" style="margin-top:10px;color:#ff9ba8">清除本机 Sync Key</button>':''}<button id="clearHistBtn" class="btn ghost full" style="margin-top:10px">清除本机 OI 历史</button><p class="fineprint">你的 Luno Key ID / Secret 只放在 GitHub Secrets。网页只保存加密后的 Sync Key，不包含下单、Send 或 Withdraw 功能。</p></section>`;
  $('#connectSettingsBtn').onclick=openLunoSetup;
  const u=$('#unlockSettingsBtn'); if(u)u.onclick=openLunoUnlock;
  const f=$('#forgetLunoBtn'); if(f)f.onclick=()=>{ if(confirm('清除这台手机保存的 Luno Sync Key？')){ localStorage.removeItem(LUNO_KEY); state.credentials=null;state.luno=null;state.lunoError=null;render();toast('本机 Sync Key 已清除'); } };
  $('#clearHistBtn').onclick=()=>{localStorage.removeItem(HISTORY_KEY);toast('OI 历史已清除');};
}
function openLunoSetup(){
  $('#lunoSyncKey').value='';$('#lunoPin').value='';$('#lunoSave').checked=true;$('#lunoError').classList.add('hidden');$('#lunoDialog').showModal();
}
function openLunoUnlock(){ $('#unlockPin').value='';$('#unlockError').classList.add('hidden');$('#unlockDialog').showModal(); }
function render(){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===state.tab));
  if(!state.data){content.innerHTML=`<div class="empty">${state.loading?'正在连接 LIVE 市场…':'等待开始…'}</div>`;return;}
  if(state.tab==='home')renderHome();else if(state.tab==='portfolio')renderPortfolio();else if(state.tab==='market')renderMarket();else renderSettings();
}

function startAutoRefresh(){clearInterval(state.autoTimer);state.autoTimer=setInterval(()=>{if(!document.hidden&&state.started)refresh();},60000);}
function init(){
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render();});
  $('#refreshBtn').onclick=refresh;
  $('#startLiveBtn').onclick=async()=>{state.started=true;$('#startDialog').close();await refresh();startAutoRefresh();if(savedLunoKey()&&!state.credentials)setTimeout(openLunoUnlock,250);};
  $('#lunoCancel').onclick=()=>$('#lunoDialog').close();
  $('#unlockCancel').onclick=()=>$('#unlockDialog').close();
  $('#generateSyncKey').onclick=async()=>{
    const k=randomSyncKey(), input=$('#lunoSyncKey'); input.value=k; input.type='password'; $('#toggleSyncKey').textContent='显示 Sync Key';
    try{ await copyTextRobust(k); toast('Sync Key 已生成并复制'); }catch{ toast('Sync Key 已生成；请按“复制 Sync Key”'); }
  };
  $('#copySyncKey').onclick=async()=>{
    const input=$('#lunoSyncKey'),k=input.value.trim();
    if(!/^[0-9a-fA-F]{64}$/.test(k)){ toast('请先生成或输入 64 位 Sync Key'); return; }
    try{ await copyTextRobust(k); toast('Sync Key 已复制，可去 GitHub 粘贴'); }
    catch{ input.type='text'; input.focus(); input.select(); input.setSelectionRange(0,input.value.length); $('#toggleSyncKey').textContent='隐藏 Sync Key'; toast('自动复制失败：已选中，请长按后点 Copy'); }
  };
  $('#toggleSyncKey').onclick=()=>{
    const input=$('#lunoSyncKey'),btn=$('#toggleSyncKey');
    input.type=input.type==='password'?'text':'password'; btn.textContent=input.type==='password'?'显示 Sync Key':'隐藏 Sync Key';
  };
  $('#lunoForm').addEventListener('submit',async e=>{
    e.preventDefault(); const err=$('#lunoError'); err.classList.add('hidden');
    const syncKey=$('#lunoSyncKey').value.trim(),pin=$('#lunoPin').value,save=$('#lunoSave').checked;
    if(!/^[0-9a-fA-F]{64}$/.test(syncKey)){err.textContent='请输入 64 位 HEX Sync Key';err.classList.remove('hidden');return;}
    if(save&&pin.length<6){err.textContent='要保存 Sync Key，PIN 至少 6 位';err.classList.remove('hidden');return;}
    const creds={syncKey:syncKey.toLowerCase()};
    try{
      state.credentials=creds; state.lunoError=null;
      if(save) localStorage.setItem(LUNO_KEY,await encryptCredentials(creds,pin)); else localStorage.removeItem(LUNO_KEY);
      $('#lunoDialog').close(); state.tab='portfolio'; render(); await refreshLuno();
    }catch(x){
      err.textContent='Luno 快照读取失败：'+String(x?.message||x); err.classList.remove('hidden');
    }
  });
  $('#unlockForm').addEventListener('submit',async e=>{
    e.preventDefault(); const err=$('#unlockError'); err.classList.add('hidden');
    try{
      state.credentials=await decryptCredentials(localStorage.getItem(LUNO_KEY),$('#unlockPin').value);
      $('#unlockDialog').close(); state.tab='portfolio'; render(); await refreshLuno();
    }catch(x){
      const msg=String(x?.message||x); err.textContent=/OperationError|decrypt/i.test(msg)?'PIN 不正确':'解锁后快照读取失败：'+msg; err.classList.remove('hidden');
    }
  });
  $('#startDialog').showModal();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.started&&state.data&&Date.now()-state.data.refreshedAt>90000)refresh();});
  render(); if('serviceWorker'in navigator){navigator.serviceWorker.getRegistrations?.().then(rs=>rs.forEach(r=>r.unregister())).catch(()=>{});}
}
window.addEventListener('load',init);
