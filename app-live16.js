'use strict';

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const DERIBIT = 'https://www.deribit.com/api/v2';
const BYBIT = 'https://api.bybit.com';
const BINANCE_COINM = 'https://dapi.binance.com';
const XOOMAR = 'https://xoomar.com';
const BYK = 'https://bykaranteli.com';
const HISTORY_KEY = 'crypto_radar_live_history_v16';
const state = {
  tab: 'home', loading: false, data: null, started: false,
  lastErrors: [], autoTimer: null,
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
  const ratioOk=d.btcM?.longPct!=null&&d.ethM?.longPct!=null;
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
    const [ratios,be,ee,liq]=await Promise.allSettled([loadByKPositioning(),loadEtf('BTC'),loadEtf('ETH'),loadByKLiquidations()]);
    const ratioPack=ratios.status==='fulfilled'?ratios.value:null;
    const ratioB=ratioPack?.BTC||null, ratioE=ratioPack?.ETH||null;
    const etfB=be.status==='fulfilled'?be.value:null, etfE=ee.status==='fulfilled'?ee.value:null;
    if(liq.status==='fulfilled') state.liq=liq.value;
    btc=attachOptional(btc,ratioB,etfB); eth=attachOptional(eth,ratioE,etfE);
    saveHistory(btc,eth); btc.oi24=oi24FromLocal('BTC',btc.oiUSD); eth.oi24=oi24FromLocal('ETH',eth.oiUSD);
    const optErrors=[];
    if(!ratioB) optErrors.push(`BTC Long/Short: ${ratios.reason?.message||'ByKaranteli unavailable'}`);
    if(!ratioE) optErrors.push(`ETH Long/Short: ${ratios.reason?.message||'ByKaranteli unavailable'}`);
    if(!etfB) optErrors.push(`BTC ETF: ${be.reason?.message||be.reason||'unavailable'}`);
    if(!etfE) optErrors.push(`ETH ETF: ${ee.reason?.message||ee.reason||'unavailable'}`);
    if(liq.status!=='fulfilled') optErrors.push(`Liquidation 24H: ${liq.reason?.message||liq.reason||'unavailable'}`);
    state.data={btcM:btc,ethM:eth,provider:core.provider,errors:[...(core.errors||[]),...optErrors],refreshedAt:Date.now()};
    state.lastErrors=state.data.errors; render(); toast('LIVE 数据已更新');
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
function renderHome(){
  const d=state.data,a=analyze(d.btcM);
  content.innerHTML=`${hero('BTC',d.btcM)}
    <section class="section"><div class="section-title"><h3>现在发生什么？</h3><small>${a.regime}</small></div><div class="card analysis"><strong>${a.regime}</strong><br>${a.ex}<div class="facts"><span class="chip">Price 24H ${pct(d.btcM.price24)}</span><span class="chip">OI 24H ${pct(d.btcM.oi24)}</span><span class="chip">Funding ${d.btcM.funding==null?'—':d.btcM.funding.toFixed(4)+'%'}</span><span class="chip">Long ${d.btcM.longPct==null?'—':d.btcM.longPct.toFixed(1)+'%'}</span></div></div></section>
    <div class="grid"><div class="metric"><div class="label">Leverage Risk</div><div class="value">${a.risk}</div></div><div class="metric"><div class="label">24H Volume</div><div class="value">${compact(d.btcM.volume)}</div></div></div>
    ${etfMini('BTC',d.btcM)}${liqMini('BTC')}
    <section class="section"><div class="section-title"><h3>ETH LIVE</h3><small>${escapeHtml(d.ethM.provider)}</small></div>${miniAsset(d.ethM)}</section>`;
}
function miniAsset(m){
  return `<div class="card"><div class="asset-header"><div><div class="asset-name">${money(m.price,'USD',0)}</div><div class="asset-balance">24H <span class="delta ${clsDelta(m.price24)}">${pct(m.price24)}</span></div></div><span class="pill good">LIVE</span></div><div class="grid"><div class="metric"><div class="label">OI</div><div class="value">${compact(m.oiUSD)}</div></div><div class="metric"><div class="label">Funding ${m.fundingPeriod||''}</div><div class="value">${m.funding==null?'—':m.funding.toFixed(4)+'%'}</div></div></div></div>`;
}
function renderPortfolio(){ content.innerHTML=`<div class="empty"><b>Luno 暂时不连接</b><br><br>先把 LIVE 市场数据补齐并确认稳定。下一步才接你的 Luno Read-only。</div>`; }
function marketCard(asset,m){
  const a=analyze(m),l=state.liq[asset];
  return `<section class="section"><div class="section-title"><h3>${asset} Market Structure</h3><small>${escapeHtml(m.provider)}</small></div><div class="card"><div class="grid three">
    <div class="metric"><div class="label">Price 24H</div><div class="value delta ${clsDelta(m.price24)}">${pct(m.price24)}</div></div>
    <div class="metric"><div class="label">OI · venue</div><div class="value">${compact(m.oiUSD)}</div><div class="note">${escapeHtml(m.provider.split(" ")[0])} · 24H ${m.oi24==null?'收集中':pct(m.oi24)}</div></div>
    <div class="metric"><div class="label">Funding ${m.fundingPeriod||''}</div><div class="value">${m.funding==null?'—':m.funding.toFixed(4)+'%'}</div></div>
    <div class="metric"><div class="label">Long accounts</div><div class="value">${m.longPct==null?'—':m.longPct.toFixed(1)+'%'}</div><div class="note">${m.ratioProvider||'source unavailable'}</div></div>
    <div class="metric"><div class="label">Short accounts</div><div class="value">${m.shortPct==null?'—':m.shortPct.toFixed(1)+'%'}</div></div>
    <div class="metric"><div class="label">24H Volume</div><div class="value">${compact(m.volume)}</div></div>
    <div class="metric"><div class="label">ETF latest</div><div class="value delta ${clsDelta(m.etf?.latest)}">${m.etf?money(m.etf.latest,'USD',0):'—'}</div><div class="note">${m.etf?.latestDate||'unavailable'}</div></div>
    <div class="metric"><div class="label">Long liq · 24H</div><div class="value">${compact(l.longUsd)}</div><div class="note">${escapeHtml(state.liq?.provider||'unavailable')}</div></div>
    <div class="metric"><div class="label">Short liq · 24H</div><div class="value">${compact(l.shortUsd)}</div><div class="note">${l.events!=null?Math.round(l.events).toLocaleString('en')+' events':'measured'}</div></div>
  </div></div><div class="card analysis"><div class="row"><span class="left">Regime</span><span class="right">${a.regime}</span></div><div class="row"><span class="left">Leverage risk</span><span class="right"><span class="pill ${a.risk==='High'?'bad':a.risk==='Normal'?'good':'warn'}">${a.risk}</span></span></div><p>${a.ex}</p></div></section>`;
}
function renderMarket(){
  const d=state.data,ml=state.liq?.market||{};
  const globalLiq=ml.total!=null?`<section class="section"><div class="section-title"><h3>Cross-venue Liquidation · 24H</h3><small>${escapeHtml(state.liq.provider||'ByKaranteli')}</small></div><div class="card"><div class="grid three"><div class="metric"><div class="label">Total</div><div class="value">${compact(ml.total)}</div></div><div class="metric"><div class="label">Longs</div><div class="value">${compact(ml.longUsd)}</div></div><div class="metric"><div class="label">Shorts</div><div class="value">${compact(ml.shortUsd)}</div></div></div>${ml.events!=null?`<div class="fineprint">过去 24H 共 ${Math.round(ml.events).toLocaleString('en')} 个已记录公开强平事件。</div>`:''}</div></section>`:`<section class="section"><div class="section-title"><h3>Cross-venue Liquidation · 24H</h3><small>ByKaranteli embed fallback</small></div><div class="card" style="padding:10px"><iframe src="https://bykaranteli.com/embed/liquidations" width="100%" height="330" style="border:0;border-radius:12px;background:#0b0e14" loading="lazy" title="24h liquidations"></iframe></div></section>`;
  const posFallback=(!d.btcM?.ratioProvider||!d.ethM?.ratioProvider)?`<section class="section"><div class="section-title"><h3>Positioning fallback</h3><small>ByKaranteli embeds</small></div><div class="card" style="padding:10px"><iframe src="https://bykaranteli.com/embed/positioning/BTC" width="100%" height="210" style="border:0;border-radius:12px;background:#0b0e14" loading="lazy" title="BTC positioning"></iframe><div style="height:10px"></div><iframe src="https://bykaranteli.com/embed/positioning/ETH" width="100%" height="210" style="border:0;border-radius:12px;background:#0b0e14" loading="lazy" title="ETH positioning"></iframe></div></section>`:'';
  content.innerHTML=`${marketCard('BTC',d.btcM)}${marketCard('ETH',d.ethM)}${posFallback}${globalLiq}<p class="fineprint">Long/Short 是账户比例，不是全市场 Long 金额 vs Short 金额。Liquidation 优先读取 ByKaranteli 自有多交易所强平记录的过去 24H 汇总；ETF 为发行商文件推算值，可能存在覆盖缺口。当前 OI / Funding 来自核心 venue（例如 Hyperliquid），不是全市场总 OI。</p>`;
}
function renderSettings(){
  const d=state.data;
  content.innerHTML=`<section class="section"><div class="section-title"><h3>LIVE Source Status</h3>${liveBadge()}</div><div class="card">
    <div class="row"><span class="left">Core provider</span><span class="right">${escapeHtml(d.provider)}</span></div>
    <div class="row"><span class="left">BTC core</span><span class="right">${d.btcM?.live?'LIVE':'OFFLINE'}</span></div>
    <div class="row"><span class="left">ETH core</span><span class="right">${d.ethM?.live?'LIVE':'OFFLINE'}</span></div>
    <div class="row"><span class="left">Long/Short BTC</span><span class="right">${d.btcM?.ratioProvider||'Unavailable'}</span></div>
    <div class="row"><span class="left">Long/Short ETH</span><span class="right">${d.ethM?.ratioProvider||'Unavailable'}</span></div>
    <div class="row"><span class="left">ETF BTC</span><span class="right">${d.btcM?.etf?.provider||'Unavailable'}</span></div>
    <div class="row"><span class="left">ETF ETH</span><span class="right">${d.ethM?.etf?.provider||'Unavailable'}</span></div>
    <div class="row"><span class="left">Liquidation 24H</span><span class="right">${state.liq?.market?.total!=null?escapeHtml(state.liq.provider||'LIVE'):'Unavailable'}</span></div>
    <div class="row"><span class="left">Luno</span><span class="right">Not connected yet</span></div>
    <div class="row"><span class="left">Trading functions</span><span class="right">None</span></div>
  </div>${state.lastErrors.length?`<div class="error">Optional source log:<br>${state.lastErrors.map(escapeHtml).join('<br>')}</div>`:''}
  <button id="clearHistBtn" class="btn ghost full" style="margin-top:10px">清除本机 OI 历史</button><p class="fineprint">OI 24H 是这台手机自己累计的核心 venue LIVE OI 快照。Liquidation 优先读取 ByKaranteli 过去 24H recorded feed；若 JSON 失败，市场页保留官方 liquidation embed。Long/Short 优先读取 ByKaranteli positioning API；若数值解析失败，市场页保留 BTC / ETH positioning embeds。ETF 数据由 XOOMAR 从 ETF 发行商文件读取并计算，页面中已标明覆盖限制。</p></section>`;
  $('#clearHistBtn').onclick=()=>{localStorage.removeItem(HISTORY_KEY);toast('OI 历史已清除');};
}
function render(){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===state.tab));
  if(!state.data){content.innerHTML=`<div class="empty">${state.loading?'正在连接 LIVE 市场…':'等待开始…'}</div>`;return;}
  if(state.tab==='home')renderHome();else if(state.tab==='portfolio')renderPortfolio();else if(state.tab==='market')renderMarket();else renderSettings();
}

function startAutoRefresh(){clearInterval(state.autoTimer);state.autoTimer=setInterval(()=>{if(!document.hidden&&state.started)refresh();},60000);}
function init(){
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render();});
  $('#refreshBtn').onclick=refresh;
  $('#startLiveBtn').onclick=()=>{state.started=true;$('#startDialog').close();refresh();startAutoRefresh();};
  $('#startDialog').showModal();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.started&&state.data&&Date.now()-state.data.refreshedAt>90000)refresh();});
  render(); if('serviceWorker'in navigator){navigator.serviceWorker.getRegistrations?.().then(rs=>rs.forEach(r=>r.unregister())).catch(()=>{});}
}
window.addEventListener('load',init);
