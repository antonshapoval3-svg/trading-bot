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
      {chat_id:TG_CHAT,text,parse_mode:"Markdown"});
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
      messages:[{role:"user",content:`Tu es un analyste de trading. Aujourd'hui c'est le ${today}.

IMPORTANT : Recherche d'abord sur le web le prix actuel du GOLD et du DAX maintenant, les news du jour, et le calendrier economique.

Ensuite reponds UNIQUEMENT avec ce format exact pour Telegram (utilise * pour le gras, pas de # ou ##) :

🌅 *BRIEFING — ${today}*

━━━━━━━━━━━━━━━
🥇 *GOLD (XAU/USD)*
━━━━━━━━━━━━━━━
💰 Prix : [METS LE VRAI PRIX ICI]
📈 Tendance : [haussiere/baissiere/neutre]
🎯 Resistance : [niveau] | Support : [niveau]
💡 Trade : [LONG / SHORT / NEUTRE]
⚠️ Risque : [risque principal]

━━━━━━━━━━━━━━━
📈 *DAX (GER40)*
━━━━━━━━━━━━━━━
💰 Prix : [METS LE VRAI PRIX ICI]
📈 Tendance : [haussiere/baissiere/neutre]
🎯 Resistance : [niveau] | Support : [niveau]
💡 Trade : [LONG / SHORT / NEUTRE]
⚠️ Risque : [risque principal]

━━━━━━━━━━━━━━━
📅 *AGENDA DU JOUR*
━━━━━━━━━━━━━━━
[heure] - [annonce] - [impact H/M/L]
[heure] - [annonce] - [impact H/M/L]

━━━━━━━━━━━━━━━
📰 *NEWS CLES*
━━━━━━━━━━━━━━━
• [news 1]
• [news 2]
• [news 3]

━━━━━━━━━━━━━━━
🧠 *STRATEGIE DU JOUR*
━━━━━━━━━━━━━━━
[2-3 phrases de synthese]

_Claude AI Trading_`}]
    },{headers:{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}});

    const txt=res.data.content.find(b=>b.type==="text")?.text||"Erreur contenu";
    console.log("Briefing genere - longueur:",txt.length);

    // Envoie en plusieurs messages si trop long
    if(txt.length>3800){
      const parts=[];
      let remaining=txt;
      while(remaining.length>0){
        let cut=remaining.lastIndexOf("\n",3800);
        if(cut<=0) cut=3800;
        parts.push(remaining.substring(0,cut));
        remaining=remaining.substring(cut).trim();
      }
      for(const part of parts){
        await sendTelegram(part);
        await new Promise(r=>setTimeout(r,500));
      }
    } else {
      await sendTelegram(txt);
    }
    console.log("Briefing envoye !");
  }catch(e){
    console.error("Briefing error:",e.response?.data||e.message);
    await sendTelegram("Erreur generation briefing matinal: "+e.message);
  }
}


function scheduleBriefing(){
  const now=new Date();
  const next=new Date();
  next.setUTCHours(7,30,0,0);
  if(now>=next) next.setDate(next.getDate()+1);
  const delay=next-now;
  console.log("Prochain briefing dans "+Math.round(delay/60000)+" minutes");
  setTimeout(()=>{
    sendMorningBriefing();
    setInterval(sendMorningBriefing, 24*60*60*1000);
  }, delay);
}

app.post("/webhook", async(req,res)=>{
  console.log("Alerte recue:",req.body);
  res.sendStatus(200);
  const {symbol,action,price,timeframe,high,low,volume,vwap,poc}=req.body;
  const date=new Date().toISOString().split("T")[0];
  const trades=loadTrades();
  trades.unshift({id:Date.now(),symbol:(symbol||"UNKNOWN").toUpperCase(),side:action==="BUY"?"BUY":"SELL",date,entry:parseFloat(price)||0,sl:0,tp:0,size:1,status:"open",exit:0,pnl:0,netPnl:0,strategy:"EMA+VWAP",emotion:"Neutre",notes:"Signal "+action+" TF:"+timeframe+" VWAP:"+(vwap||"-")+" POC:"+(poc||"-"),duration:"",vwap:vwap||"-",poc:poc||"-",volume:volume||0});
  saveTrades(trades);
  try{
    const r=await axios.post("https://api.anthropic.com/v1/messages",{
      model:"claude-sonnet-4-6",max_tokens:1024,
      messages:[{role:"user",content:"Signal de trading recus : Actif: "+symbol+" | Action: "+action+" | Prix: "+price+" | Timeframe: "+timeframe+" | H/L: "+high+"/"+low+" | Volume: "+volume+" | VWAP: "+(vwap||"-")+" | POC: "+(poc||"-")+"\n\nReponds en francais format Telegram:\nSIGNAL "+action+" - "+symbol+"\nPrix : "+price+"\nContexte : [tendance]\nTechnique : [EMA, VWAP, POC]\nRecommandation : [ACHETER/VENDRE/ATTENDRE]\nSL : [prix] | TP : [prix]\nRisques : [risques]"}]
    },{headers:{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}});
    await sendTelegram(r.data.content[0].text);
  }catch(e){ console.error("Erreur:",e.response?.data||e.message); }
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