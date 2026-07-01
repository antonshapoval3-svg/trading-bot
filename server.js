require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT        = process.env.TELEGRAM_CHAT_ID;
const TRADES_FILE    = path.join(__dirname, "trades.json");

function loadTrades(){
  try{ if(fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE,"utf8")); }
  catch(e){ console.error("Erreur lecture:",e.message); }
  return [];
}
function saveTrades(t){ fs.writeFileSync(TRADES_FILE,JSON.stringify(t,null,2)); }

async function sendTelegram(text){
  try{
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      {chat_id:TG_CHAT,text});
    console.log("Telegram OK");
  }catch(e){ console.error("Telegram error:",e.response?.data||e.message); }
}

async function sendMorningBriefing(){
  const today=new Date().toLocaleDateString("fr-FR",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
  console.log("Briefing du "+today+"...");
  try{
    const res=await axios.post("https://api.anthropic.com/v1/messages",{
      model:"claude-sonnet-4-6",
      max_tokens:2048,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      messages:[{role:"user",content:"Tu es un analyste de trading. Recherche le prix GOLD et DAX aujourd'hui le "+today+". Reponds en francais sans symboles speciaux:\n\nBRIEFING "+today+"\n\nGOLD\nPrix : [prix]\nTendance : [haussiere/baissiere]\nResistance : [niveau] | Support : [niveau]\nTrade : [LONG/SHORT/NEUTRE]\nRisque : [risque]\n\nDAX\nPrix : [prix]\nTendance : [haussiere/baissiere]\nResistance : [niveau] | Support : [niveau]\nTrade : [LONG/SHORT/NEUTRE]\nRisque : [risque]\n\nAGENDA\n[annonces importantes]\n\nNEWS\n[2-3 news cles]\n\nSTRATEGIE\n[synthese en 2 phrases]"
    },{headers:{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}});
    const txt=res.data.content.find(b=>b.type==="text")?.text||"Erreur contenu";
    console.log("Briefing genere, longueur:"+txt.length);
    if(txt.length>1500){
      let remaining=txt;
      while(remaining.length>0){
       let cut=remaining.lastIndexOf("\n",1500);
if(cut<=0) cut=1500;
        await sendTelegram(remaining.substring(0,cut));
        remaining=remaining.substring(cut).trim();
        await new Promise(r=>setTimeout(r,500));
      }
    } else {
      await sendTelegram(txt);
    }
    console.log("Briefing envoye !");
  }catch(e){
    console.error("Briefing error:",e.response?.data||e.message);
    await sendTelegram("Erreur briefing: "+e.message);
  }
}

function scheduleBriefing(){
  const now=new Date();
  const next=new Date();
  next.setUTCHours(6,30,0,0);
  if(now>=next) next.setDate(next.getDate()+1);
  const delay=next-now;
  const minutes=Math.round(delay/60000);
  console.log("Prochain briefing dans "+minutes+" minutes (8h30 CET)");
  setTimeout(()=>{
    sendMorningBriefing();
    setInterval(sendMorningBriefing,24*60*60*1000);
  },delay);
}

app.post("/webhook",async(req,res)=>{
  console.log("Alerte recue:",req.body);
  res.sendStatus(200);
  const {symbol,action,price,timeframe,high,low,volume,score,trend_4h,trend_30m,trend_5m,vwap_pos,poc_pos,in_golden_zone,prev_day_zone,prev_day_high,prev_day_low}=req.body;
  const date=new Date().toISOString().split("T")[0];
  const trades=loadTrades();
  trades.unshift({id:Date.now(),symbol:(symbol||"UNKNOWN").toUpperCase(),side:action==="BUY"?"BUY":"SELL",date,entry:parseFloat(price)||0,sl:0,tp:0,size:1,status:"open",exit:0,pnl:0,netPnl:0,strategy:"Confluence Multi-TF",emotion:"Neutre",notes:"Signal "+action+" — Score:"+( score||"—")+" 4H:"+(trend_4h||"—")+" 30m:"+(trend_30m||"—")+" 5m:"+(trend_5m||"—")+" VWAP:"+(vwap_pos||"—")+" POC:"+(poc_pos||"—")+" Fibo:"+(in_golden_zone||"—")+" Zone veille:"+(prev_day_zone||"—"),duration:"",score:score||"—",volume:volume||0});
  saveTrades(trades);
  console.log("Trade sauvegarde: "+symbol+" "+action+" @ "+price+" score:"+score);
  try{
    const r=await axios.post("https://api.anthropic.com/v1/messages",{
      model:"claude-sonnet-4-6",max_tokens:1200,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      messages:[{role:"user",content:"Tu es un analyste de trading. Signal de confluence recu sur TradingView :\n- Actif: "+symbol+"\n- Signal: "+action+"\n- Prix: "+price+"\n- Score confluence: "+(score||"—")+"/10\n- Tendance 4H: "+(trend_4h||"—")+"\n- Tendance 30min: "+(trend_30m||"—")+"\n- Tendance 5min: "+(trend_5m||"—")+"\n- VWAP: "+(vwap_pos||"—")+"\n- POC: "+(poc_pos||"—")+"\n- Zone royale Fibo: "+(in_golden_zone||"—")+"\n- Zone veille: "+(prev_day_zone||"—")+" (H:"+prev_day_high+" L:"+prev_day_low+")\n\nCherche sur le web le sentiment actuel des traders sur "+symbol+" et les news recentes. Puis reponds en francais format Telegram (utilise * pour gras) :\n\nSIGNAL "+action+" — "+symbol+" (Score: "+(score||"—")+")\nPrix : "+price+"\n\n* Analyse multi-timeframe : *\n[2 lignes sur alignement des TF]\n\n* Sentiment marche : *\n[ce que tu trouves sur sentiment/news]\n\n* Confluence finale : *\n[FORTE / MODEREE / FAIBLE / DIVERGENTE]\n\n* Recommandation : *\n[CONFIRMER / PRUDENT / IGNORER]\n\nSL suggere : [prix] | TP suggere : [prix]\nRisque : [1 phrase]"}]
    },{headers:{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}});
    const txt=r.data.content.find(b=>b.type==="text")?.text||"Erreur";
    await sendTelegram(txt);
    console.log("Analyse envoyee sur Telegram");
  }catch(e){ console.error("Erreur analyse:",e.response?.data||e.message); }
});

app.get("/api/trades",(req,res)=>res.json(loadTrades()));
app.post("/api/trades",(req,res)=>{const t=loadTrades();const n={id:Date.now(),...req.body};t.unshift(n);saveTrades(t);res.json(n);});
app.put("/api/trades/:id",(req,res)=>{const id=parseInt(req.params.id);const t=loadTrades();const i=t.findIndex(x=>x.id===id);if(i===-1)return res.status(404).json({error:"Non trouve"});t[i]={...t[i],...req.body};saveTrades(t);res.json(t[i]);});
app.delete("/api/trades/:id",(req,res)=>{let t=loadTrades();t=t.filter(x=>x.id!==parseInt(req.params.id));saveTrades(t);res.json({ok:true});});

app.get("/briefing/test",(req,res)=>{
  res.json({message:"Briefing en cours de generation..."});
  sendMorningBriefing();
});

app.get("/health",(req,res)=>res.json({status:"ok",trades:loadTrades().length,nextBriefing:"08:30 CET"}));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log("Serveur demarre sur le port "+PORT);
  scheduleBriefing();
});