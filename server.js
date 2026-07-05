require("dotenv").config();
const express = require("express");
const axios   = require("axios");
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
  }catch(e){ console.error("MongoDB erreur:", e.message); }
}
function getTrades(){ return db ? db.collection("trades") : null; }

// ─── Telegram ─────────────────────────────────────────────────────
async function sendTelegram(text){
  try{
    if(!text||text.trim()==="") return;
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      {chat_id:TG_CHAT, text:text.trim()});
  }catch(e){ console.error("Telegram error:",e.response?.data||e.message); }
}

// ─── Extraction texte depuis réponse Claude ────────────────────────
function extractText(content){
  if(!content||!Array.isArray(content)) return "";
  const parts = content
    .filter(b => b.type === "text" && b.text && b.text.trim())
    .map(b => b.text.trim())
    .filter(t => {
      // Filtre les lignes d'intro de recherche web
      if(t.startsWith("I'll search")) return false;
      if(t.startsWith("I will search")) return false;
      if(t.startsWith("Let me search")) return false;
      if(t.startsWith("Searching")) return false;
      if(t.length < 20) return false;
      return true;
    });
  // Concatene et supprime aussi les lignes parasites en debut
  let result = parts.join("\n\n");
  result = result.replace(/^.*search.*simultaneously.*\n/i, "");
  result = result.replace(/^.*I'll.*\n/i, "");
  result = result.replace(/^Voici toutes les données compilées.*\n/i, "");
  result = result.replace(/^---\n/gm, "");
  return result.trim();
}

// ─── Briefing matinal ─────────────────────────────────────────────
async function sendMorningBriefing(){
  const today = new Date().toLocaleDateString("fr-FR",{
    weekday:"long", year:"numeric", month:"long", day:"numeric"
  });
  console.log("Briefing du "+today+"...");
  try{
    const res = await axios.post("https://api.anthropic.com/v1/messages",{
      model:"claude-sonnet-4-6",
      max_tokens:2048,
      tools:[{type:"web_search_20250305", name:"web_search"}],
      messages:[{role:"user", content:
  "Recherche le prix actuel du GOLD et DAX et le calendrier economique du " + today + ". Reponds en francais. Utilise exactement ce format avec ces emojis:\n\n" +"📊 BRIEFING " + today.toUpperCase() + "\n\n" +"━━━━━━━━━━━━━━━━━\n" +"🥇 GOLD (XAU/USD)\n" +"━━━━━━━━━━━━━━━━━\n" +"💰 Prix : [prix reel]\n" +"📈 Tendance : [HAUSSIER/BAISSIER/NEUTRE]\n" +"🛡 Support : [niveau]\n" +"🎯 Resistance : [niveau]\n" +"⚡ Signal : [LONG/SHORT/NEUTRE]\n\n" +"━━━━━━━━━━━━━━━━━\n" +"🇩🇪 DAX (GER40)\n" +"━━━━━━━━━━━━━━━━━\n" +"💰 Prix : [prix reel]\n" +"📈 Tendance : [HAUSSIER/BAISSIER/NEUTRE]\n" +"🛡 Support : [niveau]\n" +"🎯 Resistance : [niveau]\n" +"⚡ Signal : [LONG/SHORT/NEUTRE]\n\n" +"━━━━━━━━━━━━━━━━━\n" +"📅 ANNONCES DU JOUR\n" +"━━━━━━━━━━━━━━━━━\n" +"[Pour chaque annonce importante du jour:]\n" +"🔴/🟠/🟡 [heure Paris] — [nom annonce]\n" +"⚡ Court terme : [impact GOLD et DAX en quelques heures]\n" +"📆 Long terme : [impact GOLD et DAX en jours/semaines]\n\n" +"━━━━━━━━━━━━━━━━━\n" +"📰 NEWS CLES\n" +"━━━━━━━━━━━━━━━━━\n" +"• [news 1]\n" +"• [news 2]\n" +"• [news 3]\n\n" +"━━━━━━━━━━━━━━━━━\n" +"🧠 STRATEGIE DU JOUR\n" +"━━━━━━━━━━━━━━━━━\n" +"[synthese en 2 phrases]\n\n" +"🤖 Anton Trading Bot"
      }]
    },{headers:{
      "x-api-key":ANTHROPIC_KEY,
      "anthropic-version":"2023-06-01",
      "anthropic-beta":"interleaved-thinking-2025-05-14",
      "content-type":"application/json"
    }});

    const txt = extractText(res.data.content);
    console.log("Texte extrait ("+txt.length+" chars):", txt.substring(0,100)+"...");

    if(!txt || txt.length < 10){
      await sendTelegram("Erreur briefing: contenu vide recu de Claude");
      return;
    }

    // Envoie en plusieurs messages si trop long
    if(txt.length > 3800){
      let remaining = txt;
      while(remaining.length > 0){
        let cut = remaining.lastIndexOf("\n", 3800);
        if(cut <= 0) cut = 3800;
        await sendTelegram(remaining.substring(0, cut));
        remaining = remaining.substring(cut).trim();
        await new Promise(r => setTimeout(r, 500));
      }
    } else {
      await sendTelegram(txt);
    }
    console.log("Briefing envoye !");
  }catch(e){
    console.error("Briefing error:", e.response?.data||e.message);
    await sendTelegram("Erreur briefing: "+e.message);
  }
}

function scheduleBriefing(){
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(6,30,0,0);
  if(now >= next) next.setDate(next.getDate()+1);
  const delay = next - now;
  console.log("Prochain briefing dans "+Math.round(delay/60000)+" minutes (8h30 Paris)");
  setTimeout(()=>{
    sendMorningBriefing();
    setInterval(sendMorningBriefing, 24*60*60*1000);
  }, delay);
}

// ─── Webhook TradingView ──────────────────────────────────────────
app.post("/webhook", async(req,res)=>{
  console.log("Alerte recue:", req.body);
  res.sendStatus(200);
  const {symbol,action,price,score,trend_4h,trend_30m,trend_5m,vwap_pos,poc_pos,in_golden_zone,prev_day_zone} = req.body;
  const date = new Date().toISOString().split("T")[0];

  const col = getTrades();
  if(col){
    await col.insertOne({
      symbol:(symbol||"UNKNOWN").toUpperCase(), side:action==="BUY"?"BUY":"SELL",
      date, entry:parseFloat(price)||0, sl:0, tp:0, tp2:0, size:1,
      status:"open", pnl:0, netPnl:0, strategy:"Confluence Multi-TF",
      emotion:"Neutre", notes:"Signal "+action+" Score:"+(score||"—"),
      createdAt:new Date()
    });
  }

  try{
    const r = await axios.post("https://api.anthropic.com/v1/messages",{
      model:"claude-sonnet-4-6", max_tokens:1200,
      tools:[{type:"web_search_20250305", name:"web_search"}],
      messages:[{role:"user", content:
        "Signal de trading recu:\n"+
        "Actif: "+symbol+" | Signal: "+action+" | Prix: "+price+"\n"+
        "Score: "+(score||"—")+"/10 | 4H: "+(trend_4h||"—")+" | 30m: "+(trend_30m||"—")+"\n\n"+
        "Cherche le sentiment actuel sur "+symbol+" et analyse ce signal en francais:\n\n"+
        "SIGNAL "+action+" "+symbol+"\nPrix : "+price+"\nScore : "+(score||"—")+"/10\n\n"+
        "Analyse :\n[2 lignes]\n\nSentiment :\n[news]\n\nRecommandation : [CONFIRMER/PRUDENT/IGNORER]\nSL : [prix] | TP : [prix]"
      }]
    },{headers:{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}});
    const txt = extractText(r.data.content);
    if(txt) await sendTelegram(txt);
  }catch(e){ console.error("Erreur analyse:", e.message); }
});

// ─── API Trades ───────────────────────────────────────────────────
app.get("/api/trades", async(req,res)=>{
  try{
    const col = getTrades();
    if(!col) return res.json([]);
    const trades = await col.find({}).sort({createdAt:-1}).toArray();
    res.json(trades.map(t=>({...t, id:t._id.toString()})));
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/trades", async(req,res)=>{
  try{
    const col = getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    const trade = {...req.body, createdAt:new Date()};
    delete trade.id;
    const result = await col.insertOne(trade);
    res.json({...trade, id:result.insertedId.toString(), _id:result.insertedId});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.put("/api/trades/:id", async(req,res)=>{
  try{
    const col = getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    const update = {...req.body};
    delete update._id; delete update.id;
    await col.updateOne({_id:new ObjectId(req.params.id)},{$set:update});
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.delete("/api/trades/:id", async(req,res)=>{
  try{
    const col = getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    await col.deleteOne({_id:new ObjectId(req.params.id)});
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ─── Routes ───────────────────────────────────────────────────────
app.get("/briefing/test", (req,res)=>{
  res.json({message:"Briefing en cours..."});
  sendMorningBriefing();
});

app.get("/health", async(req,res)=>{
  const col = getTrades();
  const count = col ? await col.countDocuments() : 0;
  res.json({status:"ok", trades:count, nextBriefing:"08:30 Paris", db:db?"connecte":"deconnecte"});
});

// ─── Démarrage ────────────────────────────────────────────────────
const PORT = process.env.PORT||3000;
app.listen(PORT, async()=>{
  console.log("Serveur demarre sur le port "+PORT);
  await connectMongo();
  scheduleBriefing();
});
