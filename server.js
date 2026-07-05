require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const path    = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json({limit:'10mb'}));
app.use(express.static(__dirname));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT       = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI     = process.env.MONGO_URI;

// MongoDB
let db;
async function connectMongo(){
  try{
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("trading-bot");
    console.log("MongoDB connecte !");
  }catch(e){ console.error("MongoDB erreur:", e.message); }
}
function getTrades(){ return db ? db.collection("trades") : null; }

// Telegram
async function sendTelegram(text){
  if(!text||!text.trim()) return;
  try{
    await axios.post("https://api.telegram.org/bot"+TG_TOKEN+"/sendMessage",
      {chat_id:TG_CHAT, text:text.trim()});
  }catch(e){ console.error("Telegram error:", e.response?.data||e.message); }
}

// Extraction texte
function extractText(data){
  if(!data||!Array.isArray(data)) return "";
  const parts = data
    .filter(b => b.type==="text" && b.text && b.text.trim().length>20)
    .map(b => b.text.trim())
    .filter(t => !/^(I'll|Let me|Searching|Voici toutes)/i.test(t));
  return parts.join("\n\n").split("\n")
    .filter(l => !/^(I'll|Let me|---$)/i.test(l.trim()))
    .join("\n").trim();
}

// Briefing matinal
async function sendMorningBriefing(){
  const today = new Date().toLocaleDateString("fr-FR",{
    weekday:"long", year:"numeric", month:"long", day:"numeric"
  });
  console.log("Briefing du "+today+"...");
  try{
    const res = await axios.post("https://api.anthropic.com/v1/messages",{
      model:"claude-sonnet-4-6",
      max_tokens:2048,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      messages:[{
        role:"user",
        content:"Tu es un analyste de trading. Cherche le prix du GOLD et DAX et le calendrier economique de ce jour: "+today+". Reponds uniquement en francais avec ce format:\n\nBRIEFING "+today+"\n\nGOLD\nPrix: [prix]\nTendance: [haussier/baissier]\nSupport: [niveau] | Resistance: [niveau]\nSignal: [LONG/SHORT/NEUTRE]\n\nDAX\nPrix: [prix]\nTendance: [haussier/baissier]\nSupport: [niveau] | Resistance: [niveau]\nSignal: [LONG/SHORT/NEUTRE]\n\nANNONCES DU JOUR\n[heure] [annonce] [rouge/orange/jaune]\nCourt terme: [impact]\nLong terme: [impact]\n\nNEWS\n[news 1]\n[news 2]\n\nSTRATEGIE\n[2 phrases]\n\nAnton Trading Bot"
      }]
    },{headers:{
      "x-api-key":ANTHROPIC_KEY,
      "anthropic-version":"2023-06-01",
      "content-type":"application/json"
    }});

    const txt = extractText(res.data.content);
    console.log("Texte ("+txt.length+" chars):", txt.substring(0,80));

    if(!txt||txt.length<20){
      await sendTelegram("Erreur briefing: contenu vide");
      return;
    }

    if(txt.length>3800){
      let rem=txt;
      while(rem.length>0){
        let cut=rem.lastIndexOf("\n",3800);
        if(cut<=0) cut=3800;
        await sendTelegram(rem.substring(0,cut));
        rem=rem.substring(cut).trim();
        await new Promise(r=>setTimeout(r,500));
      }
    } else {
      await sendTelegram(txt);
    }
    console.log("Briefing envoye !");
  }catch(e){
    const errMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error("Briefing error:", errMsg);
    await sendTelegram("Erreur briefing: "+e.message);
  }
}

function scheduleBriefing(){
  const now=new Date(), next=new Date();
  next.setUTCHours(6,30,0,0);
  if(now>=next) next.setDate(next.getDate()+1);
  const delay=next-now;
  console.log("Prochain briefing dans "+Math.round(delay/60000)+" minutes (8h30 Paris)");
  setTimeout(()=>{
    sendMorningBriefing();
    setInterval(sendMorningBriefing,24*60*60*1000);
  },delay);
}

// Webhook TradingView
app.post("/webhook",async(req,res)=>{
  console.log("Alerte recue:",req.body);
  res.sendStatus(200);
  const {symbol,action,price,score,trend_4h,trend_30m} = req.body;
  const date=new Date().toISOString().split("T")[0];
  const col=getTrades();
  if(col){
    await col.insertOne({
      symbol:(symbol||"UNKNOWN").toUpperCase(),side:action==="BUY"?"BUY":"SELL",
      date,entry:parseFloat(price)||0,sl:0,tp:0,tp2:0,size:1,
      status:"open",pnl:0,netPnl:0,strategy:"Confluence Multi-TF",
      emotion:"Neutre",notes:"Signal "+action+" Score:"+(score||"--"),
      createdAt:new Date()
    });
  }
  try{
    const r=await axios.post("https://api.anthropic.com/v1/messages",{
      model:"claude-sonnet-4-6",max_tokens:1200,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      messages:[{role:"user",content:"Signal trading: "+symbol+" "+action+" a "+price+"$. Score: "+(score||"--")+"/10. Cherche le sentiment sur "+symbol+" et analyse en francais:\nSIGNAL "+action+" "+symbol+"\nPrix: "+price+"\nAnalyse: [2 lignes]\nSentiment: [news]\nRecommandation: [CONFIRMER/PRUDENT/IGNORER]\nSL: [prix] | TP: [prix]"}]
    },{headers:{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}});
    const txt=extractText(r.data.content);
    if(txt) await sendTelegram(txt);
  }catch(e){ console.error("Webhook error:",e.message); }
});

// API Trades
app.get("/api/trades",async(req,res)=>{
  try{
    const col=getTrades();
    if(!col) return res.json([]);
    const trades=await col.find({}).sort({createdAt:-1}).toArray();
    res.json(trades.map(t=>({...t,id:t._id.toString()})));
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/trades",async(req,res)=>{
  try{
    const col=getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    const trade={...req.body,createdAt:new Date()};
    delete trade.id;
    const result=await col.insertOne(trade);
    res.json({...trade,id:result.insertedId.toString(),_id:result.insertedId});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.put("/api/trades/:id",async(req,res)=>{
  try{
    const col=getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    const update={...req.body};
    delete update._id; delete update.id;
    await col.updateOne({_id:new ObjectId(req.params.id)},{$set:update});
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.delete("/api/trades/:id",async(req,res)=>{
  try{
    const col=getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    await col.deleteOne({_id:new ObjectId(req.params.id)});
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/briefing/test",(req,res)=>{
  res.json({message:"Briefing en cours..."});
  sendMorningBriefing();
});

app.get("/health",async(req,res)=>{
  const col=getTrades();
  const count=col?await col.countDocuments():0;
  res.json({status:"ok",trades:count,nextBriefing:"08:30 Paris",db:db?"connecte":"deconnecte"});
});

const PORT=process.env.PORT||3000;
app.listen(PORT,async()=>{
  console.log("Serveur demarre sur le port "+PORT);
  await connectMongo();
  scheduleBriefing();
});
