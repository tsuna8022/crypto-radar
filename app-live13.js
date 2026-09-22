'use strict';

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const DERIBIT = 'https://www.deribit.com/api/v2';
const OKX = 'https://www.okx.com';
const HISTORY_KEY = 'crypto_radar_live_history_v13';
const state = {
  tab: 'home', loading: false, data: null, started: false,
  lastErrors: [], autoTimer: null
};
const $ = s => document.querySelector(s);
const content = $('#content');

function n(v){ const x=Number(v); return Number.isFinite(x)?x:null; }
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
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({type:'metaAndAssetCtxs'})
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
      longPct:null, shortPct:null, ratio:null, at:Date.now()
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
    funding:f!=null?f*100:null, fundingPeriod:'8H',
    oiUSD:oi, oi24:oi24FromLocal(asset,oi),
    longPct:null, shortPct:null, ratio:null, at:Date.now()
  };
}
async function deribitCore(){
  const [b,e]=await Promise.all([deribitOne('BTC'),deribitOne('ETH')]);
  return {BTC:b,ETH:e,provider:'Deribit'};
}

async function okxRatio(asset){
  try {
    const j=await fetchJson(`${OKX}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${asset}&period=1H`,{},4500);
    const arr=j?.data;
    if(!Array.isArray(arr)||!arr.length) return null;
    const row=[...arr].sort((a,b)=>Number(b?.[0]||0)-Number(a?.[0]||0))[0];
    const ratio=n(row?.[1]);
    if(ratio==null||ratio<=0) return null;
    return {ratio,longPct:ratio/(1+ratio)*100,shortPct:100/(1+ratio),provider:'OKX LIVE'};
  } catch { return null; }
}

async function loadCore(){
  const errors=[];
  try { return {...await hyperliquidCore(),errors}; }
  catch(e){ errors.push(`Hyperliquid: ${e.message||e}`); }
  try { return {...await deribitCore(),errors}; }
  catch(e){ errors.push(`Deribit: ${e.message||e}`); }
  throw new Error(errors.join(' | ')||'No live market source');
}

function attachOptional(base,ratio){
  if(!ratio) return base;
  return {...base,longPct:ratio.longPct,shortPct:ratio.shortPct,ratio:ratio.ratio,ratioProvider:ratio.provider};
}

function fundingState(m){
  if(m.funding==null) return 'Unknown';
  const x=Math.abs(m.funding);
  const high=m.fundingPeriod==='1H'?0.02:0.12;
  const elevated=m.fundingPeriod==='1H'?0.008:0.05;
  return x>=high?'High':x>=elevated?'Elevated':'Normal';
}
function analyze(m){
  const p=m.price24, oi=m.oi24, fs=fundingState(m);
  let regime='Live market';
  let ex='真实市场数据已连接。OI 24H 需要本机累积历史后才会出现。';
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
  const d=state.data;
  if(!d) return '';
  const coreOk=d.btcM?.live&&d.ethM?.live;
  const ratioOk=d.btcM?.longPct!=null||d.ethM?.longPct!=null;
  const label=coreOk?(ratioOk?'LIVE DATA':'LIVE CORE'):'PARTIAL LIVE';
  const klass=coreOk?'good':'warn';
  return `<span class="pill ${klass}">● ${label}</span>`;
}

async function refresh(){
  if(state.loading) return;
  state.loading=true; $('#refreshBtn').classList.add('loading');
  if(!state.data) render();
  try {
    const core=await loadCore();
    let btc=core.BTC, eth=core.ETH;
    const [br,er]=await Promise.all([okxRatio('BTC'),okxRatio('ETH')]);
    btc=attachOptional(btc,br); eth=attachOptional(eth,er);
    saveHistory(btc,eth);
    btc.oi24=oi24FromLocal('BTC',btc.oiUSD); eth.oi24=oi24FromLocal('ETH',eth.oiUSD);
    state.data={btcM:btc,ethM:eth,provider:core.provider,errors:core.errors||[],refreshedAt:Date.now()};
    state.lastErrors=core.errors||[];
    render(); toast('LIVE 数据已更新');
  } catch(e){
    state.lastErrors=[String(e.message||e)];
    if(!state.data){
      content.innerHTML=`<div class="error"><b>LIVE 数据连接失败</b><br><br>${escapeHtml(e.message||String(e))}<br><br>没有启用 Demo 假数据。点右上角 ↻ 重试。</div>`;
    } else toast('本次刷新失败，保留上一笔 LIVE 数据');
  } finally {
    state.loading=false; $('#refreshBtn').classList.remove('loading'); if(state.data) render();
  }
}

function hero(asset,m){
  return `<section class="hero">
    <div class="hero-top">
      <div>
        <div class="coin">${asset} · ${escapeHtml(m.provider)}</div>
        <div class="price">${money(m.price,'USD',0)}</div>
        <div class="sub">24H <span class="delta ${clsDelta(m.price24)}">${pct(m.price24)}</span> · ${new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
      </div>${liveBadge()}
    </div>
    <div class="grid">
      <div class="metric"><div class="label">Open Interest</div><div class="value">${compact(m.oiUSD)}</div><div class="note">24H ${m.oi24==null?'收集中':`<span class="delta ${clsDelta(m.oi24)}">${pct(m.oi24)}</span>`}</div></div>
      <div class="metric"><div class="label">Funding ${m.fundingPeriod||''}</div><div class="value">${m.funding==null?'—':m.funding.toFixed(4)+'%'}</div><div class="note">${fundingState(m)}</div></div>
    </div>
  </section>`;
}
function renderHome(){
  const d=state.data,a=analyze(d.btcM);
  content.innerHTML=`${hero('BTC',d.btcM)}
    <section class="section"><div class="section-title"><h3>现在发生什么？</h3><small>${a.regime}</small></div>
      <div class="card analysis"><strong>${a.regime}</strong><br>${a.ex}
        <div class="facts"><span class="chip">Price 24H ${pct(d.btcM.price24)}</span><span class="chip">OI 24H ${pct(d.btcM.oi24)}</span><span class="chip">Funding ${d.btcM.funding==null?'—':d.btcM.funding.toFixed(4)+'%'}</span></div>
      </div>
    </section>
    <div class="grid"><div class="metric"><div class="label">Leverage Risk</div><div class="value">${a.risk}</div></div><div class="metric"><div class="label">24H Volume</div><div class="value">${compact(d.btcM.volume)}</div></div></div>
    <section class="section"><div class="section-title"><h3>ETH LIVE</h3><small>${escapeHtml(d.ethM.provider)}</small></div>${miniAsset(d.ethM)}</section>
    <div class="notice warning">这一版没有 Demo 市场数字。ETF Flow 与 Liquidation 暂时不参与判断，等核心 LIVE 稳定后再加。</div>`;
}
function miniAsset(m){
  return `<div class="card"><div class="asset-header"><div><div class="asset-name">${money(m.price,'USD',0)}</div><div class="asset-balance">24H <span class="delta ${clsDelta(m.price24)}">${pct(m.price24)}</span></div></div><span class="pill good">LIVE</span></div><div class="grid"><div class="metric"><div class="label">OI</div><div class="value">${compact(m.oiUSD)}</div></div><div class="metric"><div class="label">Funding ${m.fundingPeriod||''}</div><div class="value">${m.funding==null?'—':m.funding.toFixed(4)+'%'}</div></div></div></div>`;
}
function renderPortfolio(){
  content.innerHTML=`<div class="empty"><b>Luno 暂时不连接</b><br><br>先确认 LIVE 市场数据稳定。下一步才接你的 Luno Read-only。</div>`;
}
function marketCard(asset,m){
  const a=analyze(m);
  return `<section class="section"><div class="section-title"><h3>${asset} Market Structure</h3><small>${escapeHtml(m.provider)}</small></div>
    <div class="card"><div class="grid three">
      <div class="metric"><div class="label">Price 24H</div><div class="value delta ${clsDelta(m.price24)}">${pct(m.price24)}</div></div>
      <div class="metric"><div class="label">Open Interest</div><div class="value">${compact(m.oiUSD)}</div><div class="note">24H ${m.oi24==null?'收集中':pct(m.oi24)}</div></div>
      <div class="metric"><div class="label">Funding ${m.fundingPeriod||''}</div><div class="value">${m.funding==null?'—':m.funding.toFixed(4)+'%'}</div></div>
      <div class="metric"><div class="label">Long accounts</div><div class="value">${m.longPct==null?'—':m.longPct.toFixed(1)+'%'}</div><div class="note">${m.ratioProvider||'optional source unavailable'}</div></div>
      <div class="metric"><div class="label">Short accounts</div><div class="value">${m.shortPct==null?'—':m.shortPct.toFixed(1)+'%'}</div></div>
      <div class="metric"><div class="label">24H Volume</div><div class="value">${compact(m.volume)}</div></div>
    </div></div>
    <div class="card analysis"><div class="row"><span class="left">Regime</span><span class="right">${a.regime}</span></div><div class="row"><span class="left">Leverage risk</span><span class="right"><span class="pill ${a.risk==='High'?'bad':a.risk==='Normal'?'good':'warn'}">${a.risk}</span></span></div><p>${a.ex}</p></div>
  </section>`;
}
function renderMarket(){
  const d=state.data;
  content.innerHTML=`${marketCard('BTC',d.btcM)}${marketCard('ETH',d.ethM)}<p class="fineprint">Long/Short ratio 是账户比例，不是全市场 Long 金额与 Short 金额。若该公共来源在手机网络不可达，这里会显示 “—”，不会填 Demo。</p>`;
}
function renderSettings(){
  const d=state.data;
  content.innerHTML=`<section class="section"><div class="section-title"><h3>LIVE Source Status</h3>${liveBadge()}</div>
    <div class="card">
      <div class="row"><span class="left">Core provider</span><span class="right">${escapeHtml(d.provider)}</span></div>
      <div class="row"><span class="left">BTC core</span><span class="right">${d.btcM?.live?'LIVE':'OFFLINE'}</span></div>
      <div class="row"><span class="left">ETH core</span><span class="right">${d.ethM?.live?'LIVE':'OFFLINE'}</span></div>
      <div class="row"><span class="left">Long/Short source</span><span class="right">${d.btcM?.ratioProvider||'Unavailable'}</span></div>
      <div class="row"><span class="left">Luno</span><span class="right">Not connected yet</span></div>
      <div class="row"><span class="left">Trading functions</span><span class="right">None</span></div>
    </div>
    ${state.lastErrors.length?`<div class="error">Fallback log: ${state.lastErrors.map(escapeHtml).join('<br>')}</div>`:''}
    <button id="clearHistBtn" class="btn ghost full" style="margin-top:10px">清除本机 OI 历史</button>
    <p class="fineprint">OI 24H 是这台手机自己累计的 LIVE OI 快照。第一次使用时显示“收集中”；约 24 小时后才有真正的 24H 对比。</p>
  </section>`;
  $('#clearHistBtn').onclick=()=>{localStorage.removeItem(HISTORY_KEY);toast('OI 历史已清除');};
}
function render(){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===state.tab));
  if(!state.data){ content.innerHTML=`<div class="empty">${state.loading?'正在连接 LIVE 市场…':'等待开始…'}</div>`; return; }
  if(state.tab==='home') renderHome(); else if(state.tab==='portfolio') renderPortfolio(); else if(state.tab==='market') renderMarket(); else renderSettings();
}

function startAutoRefresh(){
  clearInterval(state.autoTimer);
  state.autoTimer=setInterval(()=>{ if(!document.hidden&&state.started) refresh(); },60000);
}
function init(){
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render();});
  $('#refreshBtn').onclick=refresh;
  $('#startLiveBtn').onclick=()=>{state.started=true;$('#startDialog').close();refresh();startAutoRefresh();};
  $('#startDialog').showModal();
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&state.started&&state.data&&Date.now()-state.data.refreshedAt>90000) refresh(); });
  render();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations?.().then(rs=>rs.forEach(r=>r.unregister())).catch(()=>{});
  }
}
window.addEventListener('load',init);
