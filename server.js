require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const crypto  = require("crypto");
const path    = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json({limit:'10mb'}));
app.use(express.static(__dirname));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT       = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI     = process.env.MONGO_URI;
const JWT_SECRET    = process.env.JWT_SECRET || "anton_trading_secret_2026";

// MongoDB
let db;
async function connectMongo(){
  try{
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("trading-bot");
    // Index unique sur email
    await db.collection("users").createIndex({email:1},{unique:true});
    console.log("MongoDB connecte !");
  }catch(e){ console.error("MongoDB erreur:", e.message); }
}
function getUsers(){ return db ? db.collection("users") : null; }
function getTrades(){ return db ? db.collection("trades") : null; }

// Hash password simple
function hashPassword(pwd){
  return crypto.createHmac("sha256", JWT_SECRET).update(pwd).digest("hex");
}

// Génère token simple
function generateToken(userId, email){
  const payload = JSON.stringify({userId, email, ts:Date.now()});
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("hex");
  return Buffer.from(payload).toString("base64") + "." + sig;
}

// Vérifie token
function verifyToken(token){
  try{
    const parts = token.split(".");
    if(parts.length !== 2) return null;
    const payload = Buffer.from(parts[0], "base64").toString();
    const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("hex");
    if(sig !== parts[1]) return null;
    return JSON.parse(payload);
  }catch(e){ return null; }
}

// Middleware auth
function auth(req, res, next){
  const token = req.headers.authorization?.replace("Bearer ","");
  if(!token) return res.status(401).json({error:"Non connecte"});
  const decoded = verifyToken(token);
  if(!decoded) return res.status(401).json({error:"Token invalide"});
  req.userId = decoded.userId;
  req.userEmail = decoded.email;
  next();
}

// Telegram
async function sendTelegram(text){
  if(!text||!text.trim()) return;
  try{
    await axios.post("https://api.telegram.org/bot"+TG_TOKEN+"/sendMessage",
      {chat_id:TG_CHAT, text:text.trim()});
  }catch(e){ console.error("Telegram error:", e.message); }
}

// Extraction texte Claude
function extractText(data){
  if(!data||!Array.isArray(data)) return "";
  const parts = data
    .filter(b => b.type==="text" && b.text && b.text.trim().length>20)
    .map(b => b.text.trim());
  let result = parts.join("\n\n");
  result = result.split("\n").filter(l => {
    const t = l.trim();
    if(/^I.ll search/i.test(t)) return false;
    if(/^Let me/i.test(t)) return false;
    if(/^Voici toutes les/i.test(t)) return false;
    if(t === "---") return false;
    return true;
  }).join("\n").replace(/^\n+/, "");
  return result.trim();
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────

// Register
app.post("/auth/register", async(req,res)=>{
  try{
    const {nom, email, password} = req.body;
    if(!email||!password||!nom) return res.status(400).json({error:"Champs manquants"});
    if(password.length < 6) return res.status(400).json({error:"Mot de passe trop court (min 6)"});
    const users = getUsers();
    if(!users) return res.status(500).json({error:"DB non connectee"});
    const existing = await users.findOne({email:email.toLowerCase()});
    if(existing) return res.status(400).json({error:"Email déjà utilisé"});
    const result = await users.insertOne({
      nom, email:email.toLowerCase(),
      password:hashPassword(password),
      createdAt:new Date()
    });
    const token = generateToken(result.insertedId.toString(), email.toLowerCase());
    res.json({token, nom, email:email.toLowerCase(), id:result.insertedId.toString()});
  }catch(e){
    if(e.code===11000) return res.status(400).json({error:"Email déjà utilisé"});
    res.status(500).json({error:e.message});
  }
});

// Login
app.post("/auth/login", async(req,res)=>{
  try{
    const {email, password} = req.body;
    if(!email||!password) return res.status(400).json({error:"Champs manquants"});
    const users = getUsers();
    if(!users) return res.status(500).json({error:"DB non connectee"});
    const user = await users.findOne({email:email.toLowerCase()});
    if(!user) return res.status(401).json({error:"Email ou mot de passe incorrect"});
    if(user.password !== hashPassword(password)) return res.status(401).json({error:"Email ou mot de passe incorrect"});
    const token = generateToken(user._id.toString(), user.email);
    res.json({token, nom:user.nom, email:user.email, id:user._id.toString()});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ─── TRADES API (protégée) ────────────────────────────────────────

app.get("/api/trades", auth, async(req,res)=>{
  try{
    const col = getTrades();
    if(!col) return res.json([]);
    const trades = await col.find({userId:req.userId}).sort({createdAt:-1}).toArray();
    res.json(trades.map(t=>({...t, id:t._id.toString()})));
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/trades", auth, async(req,res)=>{
  try{
    const col = getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    const trade = {...req.body, userId:req.userId, createdAt:new Date()};
    delete trade.id;
    const result = await col.insertOne(trade);
    res.json({...trade, id:result.insertedId.toString(), _id:result.insertedId});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.put("/api/trades/:id", auth, async(req,res)=>{
  try{
    const col = getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    const update = {...req.body};
    delete update._id; delete update.id; delete update.userId;
    await col.updateOne({_id:new ObjectId(req.params.id), userId:req.userId},{$set:update});
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.delete("/api/trades/:id", auth, async(req,res)=>{
  try{
    const col = getTrades();
    if(!col) return res.status(500).json({error:"DB non connectee"});
    await col.deleteOne({_id:new ObjectId(req.params.id), userId:req.userId});
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ─── BRIEFING ─────────────────────────────────────────────────────
async function sendMorningBriefing(){
  const today = new Date().toLocaleDateString("fr-FR",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
  console.log("Briefing du "+today+"...");
  try{
    const prompt = "Recherche le prix du GOLD et DAX et le calendrier economique du "+today+". Reponds en francais. Commence DIRECTEMENT par le briefing sans introduction. Format:\n\n📊 BRIEFING "+today.toUpperCase()+"\n\n━━━━━━━━━━━━━━━━━\n🥇 GOLD (XAU/USD)\n━━━━━━━━━━━━━━━━━\n💰 Prix : [prix reel]\n📈 Tendance : [HAUSSIER/BAISSIER/NEUTRE]\n🛡 Support : [niveau] | 🎯 Resistance : [niveau]\n⚡ Signal : [LONG/SHORT/NEUTRE]\n\n━━━━━━━━━━━━━━━━━\n🇩🇪 DAX (GER40)\n━━━━━━━━━━━━━━━━━\n💰 Prix : [prix reel]\n📈 Tendance : [HAUSSIER/BAISSIER/NEUTRE]\n🛡 Support : [niveau] | 🎯 Resistance : [niveau]\n⚡ Signal : [LONG/SHORT/NEUTRE]\n\n━━━━━━━━━━━━━━━━━\n📅 ANNONCES DU JOUR\n━━━━━━━━━━━━━━━━━\n[chaque annonce: 🔴/🟠/🟡 heure nom]\n⚡ Court terme : [impact]\n📆 Long terme : [impact]\n\n━━━━━━━━━━━━━━━━━\n📰 NEWS CLES\n━━━━━━━━━━━━━━━━━\n• [news 1]\n• [news 2]\n• [news 3]\n\n━━━━━━━━━━━━━━━━━\n🧠 STRATEGIE DU JOUR\n━━━━━━━━━━━━━━━━━\n[2 phrases]\n\n🤖 Anton Trading Bot";
    const res = await axios.post("https://api.anthropic.com/v1/messages",{
      model:"claude-sonnet-4-6", max_tokens:2048,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      messages:[{role:"user",content:prompt}]
    },{headers:{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}});
    const txt = extractText(res.data.content);
    if(!txt||txt.length<20){ await sendTelegram("Erreur briefing: contenu vide"); return; }
    if(txt.length>3800){
      let rem=txt;
      while(rem.length>0){
        let cut=rem.lastIndexOf("\n",3800); if(cut<=0)cut=3800;
        await sendTelegram(rem.substring(0,cut)); rem=rem.substring(cut).trim();
        await new Promise(r=>setTimeout(r,500));
      }
    } else { await sendTelegram(txt); }
    console.log("Briefing envoye !");
  }catch(e){ await sendTelegram("Erreur briefing: "+e.message); }
}

function scheduleBriefing(){
  const now=new Date(), next=new Date();
  next.setUTCHours(6,30,0,0);
  if(now>=next) next.setDate(next.getDate()+1);
  const delay=next-now;
  console.log("Prochain briefing dans "+Math.round(delay/60000)+" minutes");
  setTimeout(()=>{ sendMorningBriefing(); setInterval(sendMorningBriefing,24*60*60*1000); },delay);
}

// Webhook
app.post("/webhook",async(req,res)=>{
  res.sendStatus(200);
  const {symbol,action,price,score,trend_4h,trend_30m} = req.body;
  const col = getTrades();
  if(col){
    await col.insertOne({
      symbol:(symbol||"UNKNOWN").toUpperCase(), side:action==="BUY"?"BUY":"SELL",
      date:new Date().toISOString().split("T")[0],
      entry:parseFloat(price)||0, sl:0, tp:0, tp2:0, size:1,
      status:"open", pnl:0, netPnl:0, strategy:"Signal Bot",
      userId:"bot", createdAt:new Date()
    });
  }
});

app.get("/briefing/test",(req,res)=>{
  res.json({message:"Briefing en cours..."});
  sendMorningBriefing();
});

app.get("/health",async(req,res)=>{
  const col=getTrades();
  const count=col?await col.countDocuments():0;
  const users=getUsers();
  const userCount=users?await users.countDocuments():0;
  res.json({status:"ok",trades:count,users:userCount,nextBriefing:"08:30 Paris",db:db?"connecte":"deconnecte"});
});

const PORT=process.env.PORT||3000;
app.listen(PORT,async()=>{
  console.log("Serveur demarre sur le port "+PORT);
  await connectMongo();
  scheduleBriefing();
});
