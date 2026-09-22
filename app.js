'use strict';

const LUNO = 'https://api.luno.com';
const BINANCE = 'https://fapi.binance.com';
const BYBIT = 'https://api.bybit.com';
const SETTINGS_KEY = 'crypto_radar_credentials_v1';
const HISTORY_KEY = 'crypto_radar_market_history_v1';
const state = { tab:'home', credentials:null, demo:false, loading:false, data:null, liquidation:{BTCUSDT:emptyLiq(),ETHUSDT:emptyLiq()}, sockets:{} };
const $ = (s) => document.querySelector(s);
const content = $('#content');

function emptyLiq(){return {connected:false,startedAt:Date.now(),longUSD:0,shortUSD:0,count:0,lastAt:null};}
function n(v){const x=Number(v);return Number.isFinite(x)?x:0;}
function money(v,c='USD',d=0){if(v==null||!Number.isFinite(v))return '—';return new Intl.NumberFormat('en-MY',{style:'currency',currency:c,maximumFractionDigits:d}).format(v)}
function compact(v){if(v==null||!Number.isFinite(v))return '—';return new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2}).format(v)}
function pct(v,d=2){if(v==null||!Number.isFinite(v))return '—';return `${v>0?'+':''}${v.toFixed(d)}%`}
function clsDelta(v){return v>0?'pos':v<0?'neg':''}
function escapeHtml(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.remove('hidden');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.add('hidden'),2400)}

async function shaKey(pin,salt){
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pin),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:160000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
function b64(bytes){return btoa(String.fromCharCode(...new Uint8Array(bytes)))}
function unb64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
async function encryptCredentials(creds,pin){
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await shaKey(pin,salt);
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(creds)));
  return JSON.stringify({salt:b64(salt),iv:b64(iv),ct:b64(ct)});
}
async function decryptCredentials(blob,pin){
  const x=JSON.parse(blob),salt=unb64(x.salt),iv=unb64(x.iv),key=await shaKey(pin,salt);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,unb64(x.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}
function auth(creds){return 'Basic '+btoa(`${creds.keyId}:${creds.keySecret}`)}
async function fetchJson(url,opts={}){const r=await fetch(url,opts);const text=await r.text();if(!r.ok)throw new Error(`${r.status} ${r.statusText}${text?': '+text.slice(0,180):''}`);return text?JSON.parse(text):{};}
async function lunoJson(path,creds){return fetchJson(LUNO+path,{headers:{Authorization:auth(creds),Accept:'application/json'}})}

async function getLunoPortfolio(creds){
  const [balances,btcTrades,ethTrades,btcTicker,ethTicker,usdtTicker]=await Promise.all([
    lunoJson('/api/1/balance',creds),
    lunoJson('/api/1/listtrades?pair=XBTMYR&limit=1000&sort_desc=false',creds),
    lunoJson('/api/1/listtrades?pair=ETHMYR&limit=1000&sort_desc=false',creds),
    fetchJson(LUNO+'/api/1/ticker?pair=XBTMYR'),
    fetchJson(LUNO+'/api/1/ticker?pair=ETHMYR'),
    fetchJson(LUNO+'/api/1/ticker?pair=USDTMYR').catch(()=>null)
  ]);
  const b=balances.balance||[];const fx=usdtTicker?n(usdtTicker.last_trade):null;
  return {
    btc:buildAsset('BTC','XBT',b,btcTrades.trades||[],n(btcTicker.last_trade),fx),
    eth:buildAsset('ETH','ETH',b,ethTrades.trades||[],n(ethTicker.last_trade),fx),
    btcTrades:tradeViews('BTC',btcTrades.trades||[]),ethTrades:tradeViews('ETH',ethTrades.trades||[]),fx
  };
}
function movingCost(asset,trades){
  let inv=0,cost=0,buys=0,sells=0;[...trades].sort((a,b)=>a.timestamp-b.timestamp).forEach(t=>{const p=n(t.price),v=n(t.volume),fb=n(t.fee_base),fc=n(t.fee_counter);if(p<=0||v<=0)return;if(t.is_buy){const received=Math.max(0,v-fb);inv+=received;cost+=p*v+fc;buys++;}else{const removed=Math.min(Math.max(0,v+fb),inv);const avg=inv>0?cost/inv:0;inv-=removed;cost=Math.max(0,cost-avg*removed);sells++;}});return {asset,inventory:inv,cost,avg:inv>0?cost/inv:null,buys,sells};
}
function buildAsset(asset,lunoAsset,balances,trades,currentMYR,fx){
  let spot=0,staking=0,other=0;balances.filter(x=>x.asset===lunoAsset).forEach(x=>{const q=n(x.balance);if(['STAKING','EARN','SAVINGS'].includes(x.account_type))staking+=q;else if(['SPOT','TRANSACTIONAL'].includes(x.account_type))spot+=q;else other+=q;});
  const total=spot+staking+other,c=movingCost(asset,trades),currentUSD=fx?currentMYR/fx:null;
  const trackedCost=c.cost;const marketValue=currentMYR*total;const trackedPnl=marketValue-trackedCost;const ret=trackedCost>0?trackedPnl/trackedCost*100:null;
  return {asset,total,spot,staking,other,currentMYR,currentUSD,avgMYR:c.avg,avgUSD:c.avg&&fx?c.avg/fx:null,trackedCost,marketValue,pnl:trackedPnl,returnPct:ret,tradeInventory:c.inventory,buys:c.buys,sells:c.sells};
}
function tradeViews(asset,trades){return [...trades].sort((a,b)=>b.timestamp-a.timestamp).slice(0,30).map(t=>({asset,side:t.is_buy?'BUY':'SELL',timestamp:t.timestamp,price:n(t.price),volume:n(t.volume),gross:n(t.price)*n(t.volume),fee:n(t.fee_counter)}));}

async function marketSnapshot(symbol){try{return await binanceSnapshot(symbol)}catch(e){console.warn('Binance failed',e);return bybitSnapshot(symbol)}}
async function binanceSnapshot(symbol){
  const s=encodeURIComponent(symbol);const [ticker,premium,oi,oiHist,ratio]=await Promise.all([
    fetchJson(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${s}`),fetchJson(`${BINANCE}/fapi/v1/premiumIndex?symbol=${s}`),fetchJson(`${BINANCE}/fapi/v1/openInterest?symbol=${s}`),fetchJson(`${BINANCE}/futures/data/openInterestHist?symbol=${s}&period=1h&limit=25`),fetchJson(`${BINANCE}/futures/data/globalLongShortAccountRatio?symbol=${s}&period=1h&limit=1`)
  ]);const first=oiHist[0]?n(oiHist[0].sumOpenInterestValue):0,last=oiHist.at(-1)?n(oiHist.at(-1).sumOpenInterestValue):0,ls=ratio[0];
  return {symbol,provider:'Binance',price:n(ticker.lastPrice),price24:n(ticker.priceChangePercent),volume:n(ticker.quoteVolume),funding:n(premium.lastFundingRate)*100,oiUSD:last||n(oi.openInterest)*n(ticker.lastPrice),oi24:first&&last?(last-first)/first*100:null,longPct:ls?n(ls.longAccount)*100:null,shortPct:ls?n(ls.shortAccount)*100:null,ratio:ls?n(ls.longShortRatio):null,at:Date.now()};
}
async function bybitSnapshot(symbol){
  const s=encodeURIComponent(symbol);const [t,o,r]=await Promise.all([fetchJson(`${BYBIT}/v5/market/tickers?category=linear&symbol=${s}`),fetchJson(`${BYBIT}/v5/market/open-interest?category=linear&symbol=${s}&intervalTime=1h&limit=25`),fetchJson(`${BYBIT}/v5/market/account-ratio?category=linear&symbol=${s}&period=1h&limit=1`)]);const x=t.result.list[0],list=o.result.list||[],newest=n(list[0]?.openInterest||x.openInterest),oldest=n(list.at(-1)?.openInterest||newest),p=n(x.lastPrice),ls=r.result.list?.[0];
  return {symbol,provider:'Bybit',price:p,price24:n(x.price24hPcnt)*100,volume:n(x.turnover24h),funding:n(x.fundingRate)*100,oiUSD:n(x.openInterestValue)||newest*p,oi24:oldest?(newest-oldest)/oldest*100:null,longPct:ls?n(ls.buyRatio)*100:null,shortPct:ls?n(ls.sellRatio)*100:null,ratio:ls&&n(ls.sellRatio)?n(ls.buyRatio)/n(ls.sellRatio):null,at:Date.now()};
}
async function etfSnapshot(asset){
  const url=asset==='BTC'?'https://farside.co.uk/btc/':'https://farside.co.uk/eth/';
  let html='';try{const r=await fetch(url);if(r.ok)html=await r.text();}catch{}
  if(!html){const proxy='https://api.allorigins.win/raw?url='+encodeURIComponent(url);const r=await fetch(proxy);if(!r.ok)throw new Error('ETF public source unavailable');html=await r.text();}
  const rows=[];for(const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){const cells=[...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>m[1].replace(/<[^>]+>/g,'').replace(/&nbsp;/gi,' ').replace(/&#8211;|&ndash;/gi,'–').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim());if(cells.length<2||!/^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/.test(cells[0]))continue;const raw=cells.at(-1).replace(/\$/g,'').replace(/,/g,'').trim();if(!raw||raw==='-'||raw==='–'||/pending|n\/a/i.test(raw))continue;const neg=/^\(.*\)$/.test(raw),val=Number(raw.replace(/[()]/g,''));if(Number.isFinite(val))rows.push({date:cells[0],flow:neg?-val:val});}
  const last5=rows.slice(-5);return {asset,latest:rows.at(-1)||null,last5:last5.length?last5.reduce((a,x)=>a+x.flow,0):null,positive:last5.filter(x=>x.flow>0).length,source:'Farside'};
}

function startLiquidation(symbol){
  if(state.sockets[symbol])return;const liq=state.liquidation[symbol]=emptyLiq();let ws;
  const connect=()=>{try{ws=new WebSocket('wss://stream.bybit.com/v5/public/linear');state.sockets[symbol]=ws;ws.onopen=()=>{liq.connected=true;ws.send(JSON.stringify({op:'subscribe',args:[`allLiquidation.${symbol}`]}));renderIfMarket()};ws.onmessage=e=>{try{const msg=JSON.parse(e.data);if(!Array.isArray(msg.data))return;msg.data.forEach(x=>{const usd=n(x.v)*n(x.p);if(x.S==='Buy')liq.longUSD+=usd;else if(x.S==='Sell')liq.shortUSD+=usd;liq.count++;liq.lastAt=n(x.T)||Date.now();});renderIfMarket()}catch{}};ws.onclose=()=>{liq.connected=false;state.sockets[symbol]=null;setTimeout(connect,5000)};}catch{setTimeout(connect,5000)}};connect();
}
function renderIfMarket(){if(state.data&&(state.tab==='market'||state.tab==='home'))render()}

function analyze(m,etf,liq){
  const p=m?.price24,oi=m?.oi24,f=m?.funding;let regime='Mixed / range',ex='现有数据没有显示单一驱动因素明显占主导。';
  if(p!=null&&oi!=null){if(p>=1&&oi>=5){regime='上涨 + 杠杆扩张';ex='价格与 Open Interest 同时上升，说明上涨过程中有新杠杆仓位进入。';}else if(p>=1&&oi<=-3){regime='Short covering / 挤空';ex='价格上涨但 Open Interest 下降，旧仓位正在退出，空头回补可能是主要推动之一。';}else if(p<=-1&&oi<=-3){regime='Long flush / 去杠杆';ex='价格和 Open Interest 同时下降，符合多头平仓或清算造成的去杠杆。';}else if(p<=-1&&oi>=5){regime='下跌 + 杠杆扩张';ex='价格下跌而 Open Interest 增加，说明新的杠杆仓位在下跌中建立。';}}
  let risk='Medium';if(oi==null||f==null)risk='Unknown';else if(Math.abs(oi)<3&&Math.abs(f)<.02)risk='Low';else if(oi>10||Math.abs(f)>=.06)risk='High';
  if(f>.05)ex+=' Funding 明显偏正，Long 端较拥挤。'; else if(f<-.05)ex+=' Funding 明显偏负，Short 端较拥挤。';
  let long='Unknown';if(etf?.last5!=null)long=etf.last5>250?'Supportive':etf.last5<-250?'Stressed':'Mixed';
  if(long==='Supportive'&&risk==='High')ex+=' ETF 近几日仍是净流入，但短期杠杆偏高；长期资金和短期回撤风险要分开看。';
  if(long==='Stressed')ex+=' ETF 近几个交易日净流出，值得观察是否持续。';
  const facts=[`Price 24h ${pct(p)}`,`OI 24h ${pct(oi)}`,`Funding ${f==null?'—':f.toFixed(4)+'%'}`];if(etf?.latest)facts.push(`ETF ${etf.latest.flow>=0?'+':''}$${etf.latest.flow.toFixed(1)}m`);if(liq?.count)facts.push(`Live liq ${liq.count} events`);
  return {regime,risk,long,ex,facts};
}

async function refresh(){
  if(state.loading)return;state.loading=true;$('#refreshBtn').classList.add('loading');render();
  try{
    const [btcM,ethM,btcE,ethE]=await Promise.all([marketSnapshot('BTCUSDT'),marketSnapshot('ETHUSDT'),etfSnapshot('BTC').catch(()=>null),etfSnapshot('ETH').catch(()=>null)]);
    let portfolio=null;if(state.demo)portfolio=demoPortfolio(btcM,ethM);else if(state.credentials)portfolio=await getLunoPortfolio(state.credentials);
    state.data={portfolio,btcM,ethM,btcE,ethE,refreshedAt:Date.now()};saveHistory(state.data);toast('已更新');
  }catch(e){toast('更新失败');console.error(e);state.data={...(state.data||{}),error:e.message||String(e)};}
  finally{state.loading=false;$('#refreshBtn').classList.remove('loading');render();}
}
function demoPortfolio(btcM,ethM){
  const btcQty=.03614203,btcAvg=276684,ethQty=2.40963185,ethAvg=8715,fx=3.9;const make=(asset,q,avg,m)=>({asset,total:q,spot:asset==='BTC'?q:0,staking:asset==='ETH'?q:0,other:0,currentUSD:m.price,currentMYR:m.price*fx,avgMYR:avg,avgUSD:avg/fx,trackedCost:q*avg,marketValue:q*m.price*fx,pnl:q*m.price*fx-q*avg,returnPct:(m.price*fx-avg)/avg*100,tradeInventory:q,buys:asset==='BTC'?2:3,sells:0});return {btc:make('BTC',btcQty,btcAvg,btcM),eth:make('ETH',ethQty,ethAvg,ethM),btcTrades:[],ethTrades:[],fx};
}
function saveHistory(d){try{const h=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');h.push({t:Date.now(),btc:{p:d.btcM.price,oi:d.btcM.oiUSD,f:d.btcM.funding},eth:{p:d.ethM.price,oi:d.ethM.oiUSD,f:d.ethM.funding}});localStorage.setItem(HISTORY_KEY,JSON.stringify(h.slice(-180)));}catch{}}

function render(){document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===state.tab));if(!state.data){content.innerHTML=`<div class="empty">${state.loading?'正在读取市场数据…':'等待连接…'}</div>`;return;}if(state.tab==='home')renderHome();else if(state.tab==='portfolio')renderPortfolio();else if(state.tab==='market')renderMarket();else renderSettings();}
function hero(asset,m){const p=state.data.portfolio?.[asset.toLowerCase()],ret=p?.returnPct;return `<section class="hero"><div class="hero-top"><div><div class="coin">${asset} · ${escapeHtml(m.provider)}</div><div class="price">${money(m.price,'USD',0)}</div><div class="sub">24H <span class="delta ${clsDelta(m.price24)}">${pct(m.price24)}</span> · ${new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div></div>${p?`<span class="pill ${ret>=0?'good':'bad'}">你的 P/L ${pct(ret,1)}</span>`:''}</div>${p?`<div class="grid"><div class="metric"><div class="label">持仓</div><div class="value">${p.total.toFixed(asset==='BTC'?8:6)} ${asset}</div><div class="note">Spot ${p.spot.toFixed(6)} · Stake ${p.staking.toFixed(6)}</div></div><div class="metric"><div class="label">平均成本</div><div class="value">${money(p.avgUSD,'USD',0)}</div><div class="note">${money(p.avgMYR,'MYR',0)}</div></div></div>`:''}</section>`}
function renderHome(){const d=state.data,a=analyze(d.btcM,d.btcE,state.liquidation.BTCUSDT);content.innerHTML=`${d.error?`<div class="error">${escapeHtml(d.error)}</div>`:''}${hero('BTC',d.btcM)}<section class="section"><div class="section-title"><h3>现在发生什么？</h3><small>${a.regime}</small></div><div class="card analysis"><strong>${a.regime}</strong><br>${a.ex}<div class="facts">${a.facts.map(x=>`<span class="chip">${escapeHtml(x)}</span>`).join('')}</div></div></section><div class="grid three"><div class="metric"><div class="label">Leverage Risk</div><div class="value">${a.risk}</div></div><div class="metric"><div class="label">ETF 5 Sessions</div><div class="value ${clsDelta(d.btcE?.last5||0)}">${d.btcE?.last5==null?'—':(d.btcE.last5>=0?'+':'')+'$'+d.btcE.last5.toFixed(0)+'m'}</div></div><div class="metric"><div class="label">OI 24H</div><div class="value ${clsDelta(d.btcM.oi24)}">${pct(d.btcM.oi24)}</div></div></div><section class="section"><div class="section-title"><h3>ETH</h3></div>${miniAsset(d.portfolio?.eth,d.ethM)}</section><p class="fineprint">长期模式：这页优先显示你的成本、现货持仓与市场结构，不给 Buy/Sell 指令。</p>`;}
function miniAsset(p,m){return `<div class="card asset-header"><div><div class="asset-name">ETH ${money(m.price,'USD',0)}</div><div class="asset-balance">24H <span class="delta ${clsDelta(m.price24)}">${pct(m.price24)}</span>${p?` · ${p.total.toFixed(5)} ETH`:''}</div></div>${p?`<span class="pill ${p.returnPct>=0?'good':'bad'}">${pct(p.returnPct,1)}</span>`:''}</div>`}
function renderPortfolio(){const d=state.data,p=d.portfolio;if(!p){content.innerHTML='<div class="empty">未连接 Luno</div>';return;}content.innerHTML=`${assetPortfolio(p.btc,d.btcM,p.btcTrades)}${assetPortfolio(p.eth,d.ethM,p.ethTrades)}<div class="notice warning">平均成本由 Luno 成交记录计算。外部转入、转出或 staking reward 可能让“交易库存”和实际余额出现差异；App 会显示实际余额，但成本属于 trade-derived cost basis。</div>`;}
function assetPortfolio(p,m,trades){return `<section class="section"><div class="section-title"><h3>${p.asset} Portfolio</h3><small>${p.buys} buys · ${p.sells} sells</small></div><div class="card"><div class="asset-header"><div><div class="asset-name">${p.total.toFixed(p.asset==='BTC'?8:6)} ${p.asset}</div><div class="asset-balance">Market value ${money(p.marketValue,'MYR',0)}</div></div><span class="pill ${p.returnPct>=0?'good':'bad'}">${pct(p.returnPct,1)}</span></div><div class="grid"><div class="metric"><div class="label">Avg cost</div><div class="value">${money(p.avgMYR,'MYR',0)}</div><div class="note">≈ ${money(p.avgUSD,'USD',0)}</div></div><div class="metric"><div class="label">Tracked P/L</div><div class="value delta ${clsDelta(p.pnl)}">${money(p.pnl,'MYR',0)}</div><div class="note">Current ${money(m.price,'USD',0)}</div></div><div class="metric"><div class="label">Spot</div><div class="value">${p.spot.toFixed(6)}</div></div><div class="metric"><div class="label">Staking / Earn</div><div class="value">${p.staking.toFixed(6)}</div></div></div></div>${trades?.length?`<div class="card"><div class="section-title"><h3>最近成交</h3></div>${trades.slice(0,6).map(t=>`<div class="trade"><div><b class="delta ${t.side==='BUY'?'pos':'neg'}">${t.side}</b> ${t.volume.toFixed(6)} ${p.asset}<br><small>${new Date(t.timestamp).toLocaleDateString()}</small></div><div style="text-align:right"><b>${money(t.price,'MYR',0)}</b><br><small>${money(t.gross,'MYR',0)}</small></div></div>`).join('')}</div>`:''}</section>`}
function renderMarket(){const d=state.data;content.innerHTML=`${marketCard('BTC',d.btcM,d.btcE,state.liquidation.BTCUSDT)}${marketCard('ETH',d.ethM,d.ethE,state.liquidation.ETHUSDT)}<p class="fineprint">Long/Short ratio 是账户比例，不等于全市场 Long 金额比 Short 金额多。每张未平仓合约同时有 Long 与 Short。Liquidation 这里只统计 App 打开以后 Bybit public feed 收到的事件。</p>`;}
function marketCard(asset,m,e,liq){const a=analyze(m,e,liq);return `<section class="section"><div class="section-title"><h3>${asset} Market Structure</h3><small>${escapeHtml(m.provider)}</small></div><div class="card"><div class="grid three"><div class="metric"><div class="label">Price 24H</div><div class="value delta ${clsDelta(m.price24)}">${pct(m.price24)}</div></div><div class="metric"><div class="label">Open Interest</div><div class="value">${compact(m.oiUSD)}</div><div class="note">24H <span class="delta ${clsDelta(m.oi24)}">${pct(m.oi24)}</span></div></div><div class="metric"><div class="label">Funding</div><div class="value ${Math.abs(m.funding)>=.06?'delta neg':''}">${m.funding.toFixed(4)}%</div></div><div class="metric"><div class="label">Long accounts</div><div class="value">${m.longPct==null?'—':m.longPct.toFixed(1)+'%'}</div></div><div class="metric"><div class="label">Short accounts</div><div class="value">${m.shortPct==null?'—':m.shortPct.toFixed(1)+'%'}</div></div><div class="metric"><div class="label">ETF latest</div><div class="value ${clsDelta(e?.latest?.flow||0)}">${e?.latest?(e.latest.flow>=0?'+':'')+'$'+e.latest.flow.toFixed(0)+'m':'—'}</div></div></div></div><div class="card analysis"><div class="row"><span class="left">Regime</span><span class="right">${a.regime}</span></div><div class="row"><span class="left">Leverage risk</span><span class="right"><span class="pill ${a.risk==='High'?'bad':a.risk==='Low'?'good':'warn'}">${a.risk}</span></span></div><div class="row"><span class="left"><span class="status-dot ${liq.connected?'live':''}"></span>Live liquidation</span><span class="right">Long ${compact(liq.longUSD)} / Short ${compact(liq.shortUSD)}</span></div><p>${a.ex}</p></div></section>`}
function renderSettings(){const has=!!localStorage.getItem(SETTINGS_KEY);content.innerHTML=`<section class="section"><div class="section-title"><h3>Local & Read-only</h3></div><div class="card"><div class="row"><span class="left">Luno mode</span><span class="right">${state.demo?'Demo':state.credentials?'Connected':'Not connected'}</span></div><div class="row"><span class="left">Saved encrypted key</span><span class="right">${has?'Yes':'No'}</span></div><div class="row"><span class="left">Server</span><span class="right">None</span></div><div class="row"><span class="left">Trading functions</span><span class="right">None</span></div></div><button id="reconnectBtn" class="btn ghost full">重新连接 / 更换 Luno Key</button><button id="wipeBtn" class="btn ghost full" style="margin-top:9px;color:#ff9ba8">清除本机资料</button><div class="notice warning">建议 Luno Custom Key 只给 View balance + View transactions + View orders（1 + 2 + 32 = 35）。官方预设 “Read-only access” 当前文档列出的权限包含 Send，所以不要用那个 preset。</div><p class="fineprint">PWA 的 Secret 是用你设置的 PIN 经 PBKDF2 + AES-GCM 加密后存到浏览器本机。解锁后 Secret 会存在当前页面内存里，关闭页面后需要重新输入 PIN。</p></section>`;$('#reconnectBtn').onclick=()=>openSetup();$('#wipeBtn').onclick=()=>{if(confirm('清除本机保存的 API Key 和市场历史？')){localStorage.removeItem(SETTINGS_KEY);localStorage.removeItem(HISTORY_KEY);state.credentials=null;state.demo=false;state.data=null;openSetup();}};}

function openSetup(){const d=$('#setupDialog');$('#keyId').value='';$('#keySecret').value='';$('#pin').value='';$('#setupError').classList.add('hidden');d.showModal();}
async function init(){
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render()});$('#refreshBtn').onclick=refresh;
  $('#setupForm').addEventListener('submit',async e=>{e.preventDefault();const keyId=$('#keyId').value.trim(),keySecret=$('#keySecret').value.trim(),pin=$('#pin').value,save=$('#saveKey').checked,err=$('#setupError');err.classList.add('hidden');if(pin.length<6){err.textContent='PIN 至少 6 位';err.classList.remove('hidden');return;}const creds={keyId,keySecret};try{await lunoJson('/api/1/balance',creds);state.credentials=creds;state.demo=false;if(save)localStorage.setItem(SETTINGS_KEY,await encryptCredentials(creds,pin));else localStorage.removeItem(SETTINGS_KEY);$('#setupDialog').close();refresh();}catch(x){err.textContent=/Failed to fetch/i.test(String(x))?'手机浏览器无法直接访问 Luno 私有 API（可能是 CORS）。市场功能仍可用；Luno 账户读取需要改用本机 App 或一个代理。':'Luno 连接失败：'+(x.message||x);err.classList.remove('hidden');}});
  $('#demoBtn').onclick=()=>{state.demo=true;state.credentials=null;$('#setupDialog').close();refresh()};
  $('#unlockForm').addEventListener('submit',async e=>{e.preventDefault();const err=$('#unlockError');err.classList.add('hidden');try{state.credentials=await decryptCredentials(localStorage.getItem(SETTINGS_KEY),$('#unlockPin').value);state.demo=false;$('#unlockDialog').close();refresh();}catch{err.textContent='PIN 不正确';err.classList.remove('hidden')}});
  $('#resetLocalBtn').onclick=()=>{if(confirm('清除这台设备保存的 Luno API Key？')){localStorage.removeItem(SETTINGS_KEY);$('#unlockDialog').close();openSetup();}};
  startLiquidation('BTCUSDT');startLiquidation('ETHUSDT');
  const blob=localStorage.getItem(SETTINGS_KEY);if(blob)$('#unlockDialog').showModal();else openSetup();render();
  if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(console.warn);
}
window.addEventListener('load',init);
