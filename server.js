require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json({limit:'10mb'}));
app.use(express.static(__dirname));

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT        = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI      = process.env.MONGO_URI;

// ─── MongoDB ──────────────────────────────────────────────────────
let db;
async function connectMongo(){
  try{
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("trading-bot");
    console.log("MongoDB connecte !");
  }catch(e){
    console.error("MongoDB erreur:", e.message);
  }
}

function getTrades(){
  return db ? db.collection("trades") : null;
}

// ─── Telegram ─────────────────────────────────────────────────────
async function sendTelegram(text){
  try{
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      {chat_id:TG_CHAT,text});
  }catch(e){ console.error("Telegram error:",e.response?.data||e.message); }
}

// ─── Briefing matinal ─────────────────────────────────────────────
async function sendMorningBriefing(){
  const today=new Date().toLocaleDateString("fr-FR",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
  console.log("Briefing du "+today+"...");
  try{
    const res=await axios.post("https://api.anthropic.com/v1/messages",{
      model:"claude-sonnet-4-6",
      max_tokens:2048,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      messages:[{role:"user",content:"Tu es un analyste de trading. Recherche le prix GOLD et DAX aujourd'hui le "+today+". Reponds en francais sans symboles speciaux:\n\nBRIEFING "+today+"\n\nGOLD\nPrix : [prix]\nTendance : [haussiere/baissiere]\nResistance : [niveau] | Support : [niveau]\nTrade : [LONG/SHORT/NEUTRE]\nRisque : [risque]\n\nDAX\nPrix : [prix]\nTendance : [haussiere/baissiere]\nResistance : [niveau] | Support : [niveau]\nTrade : [LONG/SHORT/NEUTRE]\nRisque : [risque]\n\nAGENDA DU JOUR\n[annonces importantes]\n\nNEWS\n[2-3 news cles]\n\nSTRATEGIE\n[synthese en 2 phrases]"}]
    },{headers:{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}});
    const txt=res.data.content.find(b=>b.type==="text")?.text||"Erreur contenu";
    if(txt.length>3800){
      let remaining=txt;
      while(remaining.length>0){
        let cut=remaining.lastIndexOf("\n",3800);
        if(cut<=0) cut=3800;
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
  console.log("Prochain briefing dans "+Math.round(delay/60000)+" minutes (8h30 Paris)");
  setTimeout(()=>{
    sendMorningBriefing();
    setInterval(sendMorningBriefing,24*60*60*1000);
  },delay);
}

// ─── Webhook TradingView ──────────────────────────────────────────
app.post("/webhook",async(req,res)=>{
  console.log("Alerte recue:",req.body);
  res.sendStatus(200);
  const {symbol,action,price,timeframe,score,trend_4h,trend_30m,trend_5m,vwap_pos,poc_pos,in_golden_zone,prev_day_zone,prev_day_high,prev_day_low}=req.body;
  const date=new Date().toISOString().split("T")[0];

  // Sauvegarde dans MongoDB
  const col=getTrades();
  if(col){
    await col.insertOne({
      symbol:(symbol||"UNKNOWN").toUpperCase(),
      side:action==="BUY"?"BUY":"SELL",
      date,entry:parseFloat(price)||0,
      sl:0,tp:0,tp2:0,size:1,
      status:"open",exit:0,pnl:0,netPnl:0,
      strategy:"Confluence Multi-TF",
      emotion:"Neutre",
      notes:"Signal "+action+" Score:"+(score||"—")+" 4H:"+(trend_4h||"—")+" 30m:"+(trend_30m||"—"),
      score:score||"—",createdAt:new Date()
    });
    console.log("Trade sauvegarde dans MongoDB");
  }

  // Analyse Claude
  try{
    const r=await axios.post("https://api.anthropic.com/v1/messages",{
      model:"claude-sonnet-4-6",max_tokens:1200,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      messages:[{role:"user",content:"Tu es un analyste de trading. Signal recu:\n- Actif: "+symbol+"\n- Signal: "+action+"\n- Prix: "+price+"\n- Score: "+(score||"—")+"/10\n- Tendance 4H: "+(trend_4h||"—")+"\n- Tendance 30min: "+(trend_30m||"—")+"\n- Tendance 5min: "+(trend_5m||"—")+"\n- VWAP: "+(vwap_pos||"—")+"\n- POC: "+(poc_pos||"—")+"\n- Zone Fibo: "+(in_golden_zone||"—")+"\n- Zone veille: "+(prev_day_zone||"—")+"\n\nCherche le sentiment actuel sur "+symbol+" et reponds en francais (utilise * pour gras):\n\nSIGNAL "+action+" "+symbol+" (Score: "+(score||"—")+")\nPrix : "+price+"\n\nAnalyse multi-timeframe :\n[2 lignes]\n\nSentiment marche :\n[news et sentiment]\n\nConfluence finale :\n[FORTE/MODEREE/FAIBLE]\n\nRecommandation :\n[CONFIRMER/PRUDENT/IGNORER]\n\nSL : [prix] | TP : [prix]"}]
    },{headers:{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}});
    const txt=r.data.content.find(b=>b.type==="text")?.text||"Erreur";
    await sendTelegram(txt);
  }catch(e){ console.error("Erreur analyse:",e.message); }
});

// ─── API Trades (MongoDB) ──────────────────────────────────────────
app.get("/api/trades",async(req,res)=>{
  try{
    const col=getTrades();
    if(!col) return res.json([]);
    const trades=await col.find({}).sort({createdAt:-1}).toArray();
    res.json(trades.map(t=>({...t,id:t._id.toString()})));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post("/api/trades",async(req,res)=>{
  try{
    const col=getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    const trade={...req.body,createdAt:new Date()};
    delete trade.id;
    const result=await col.insertOne(trade);
    res.json({...trade,id:result.insertedId.toString(),_id:result.insertedId});
  }catch(e){res.status(500).json({error:e.message});}
});

app.put("/api/trades/:id",async(req,res)=>{
  try{
    const col=getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    const update={...req.body};
    delete update._id;delete update.id;
    await col.updateOne({_id:new ObjectId(req.params.id)},{$set:update});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.delete("/api/trades/:id",async(req,res)=>{
  try{
    const col=getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    await col.deleteOne({_id:new ObjectId(req.params.id)});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── Briefing test ────────────────────────────────────────────────
app.get("/briefing/test",(req,res)=>{
  res.json({message:"Briefing en cours..."});
  sendMorningBriefing();
});

app.get("/health",async(req,res)=>{
  const col=getTrades();
  const count=col?await col.countDocuments():0;
  res.json({status:"ok",trades:count,nextBriefing:"08:30 Paris",db:db?"connecte":"deconnecte"});
});

// ─── Démarrage ────────────────────────────────────────────────────
const PORT=process.env.PORT||3000;
app.listen(PORT,async()=>{
  console.log("Serveur demarre sur le port "+PORT);
  await connectMongo();
  scheduleBriefing();
});
