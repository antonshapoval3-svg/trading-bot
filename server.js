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
      messages:[{role:"user",content:"Tu es un analyste de trading professionnel. Aujourd'hui c'est le "+today+".\n\nRecherche sur le web les informations du jour sur GOLD et DAX, puis genere ce briefing en francais :\n\n* BRIEFING MATINAL - "+today+" *\n\n--- GOLD (XAU/USD) ---\nPrix actuel : [prix]\nTendance : [haussiere/baissiere/neutre]\nZones cles :\n- Resistances : [niveaux]\n- Supports : [niveaux]\nSens du trade : [LONG/SHORT/NEUTRE]\nConfluence : [raisons]\nRisques : [risques]\n\n--- DAX (GER40) ---\nPrix actuel : [prix]\nTendance : [haussiere/baissiere/neutre]\nZones cles :\n- Resistances : [niveaux]\n- Supports : [niveaux]\nSens du trade : [LONG/SHORT/NEUTRE]\nConfluence : [raisons]\nRisques : [risques]\n\n--- AGENDA ECONOMIQUE ---\n[annonces importantes du jour avec heure et impact]\n\n--- NEWS IMPORTANTES ---\n[2-3 news cles du jour]\n\n--- RESUME STRATEGIQUE ---\n[synthese et strategie globale du jour]\n\nBriefing genere par Claude AI"}]
    },{headers:{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}});
    const txt=res.data.content.find(b=>b.type==="text")?.text||"Erreur contenu";
    if(txt.length>4000){
      const mid=txt.lastIndexOf("\n",4000);
      await sendTelegram(txt.substring(0,mid));
      await sendTelegram(txt.substring(mid));
    } else { await sendTelegram(txt); }
    console.log("Briefing envoye !");
  }catch(e){
    console.error("Briefing error:",e.response?.data||e.message);
    await sendTelegram("Erreur generation briefing matinal.");
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