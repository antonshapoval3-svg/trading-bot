require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const SECRET = process.env.JWT_SECRET || "anton_trading_secret_2026";

// MongoDB
let db;
async function connectMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("trading-bot");
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    console.log("MongoDB connecte !");
  } catch (e) { console.error("MongoDB erreur:", e.message); }
}
const col = (name) => db ? db.collection(name) : null;

// Auth helpers
const hash = (pwd) => crypto.createHmac("sha256", SECRET).update(pwd).digest("hex");
const makeToken = (id, email) => {
  const p = JSON.stringify({ id, email, ts: Date.now() });
  const s = crypto.createHmac("sha256", SECRET).update(p).digest("hex");
  return Buffer.from(p).toString("base64") + "." + s;
};
const verifyToken = (token) => {
  try {
    const [b64, sig] = token.split(".");
    const p = Buffer.from(b64, "base64").toString();
    if (crypto.createHmac("sha256", SECRET).update(p).digest("hex") !== sig) return null;
    return JSON.parse(p);
  } catch { return null; }
};
const auth = (req, res, next) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: "Non connecte" });
  req.userId = decoded.id;
  next();
};

// Telegram
async function sendTelegram(text) {
  if (!text || !text.trim()) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { chat_id: TG_CHAT, text: text.trim() });
  } catch (e) { console.error("Telegram:", e.message); }
}

// Extract Claude text
function extractText(data) {
  if (!Array.isArray(data)) return "";
  return data
    .filter(b => b.type === "text" && b.text && b.text.trim().length > 20)
    .map(b => b.text.trim())
    .join("\n\n")
    .split("\n")
    .filter(l => !/^(I.ll search|Let me|Voici toutes|---$)/i.test(l.trim()))
    .join("\n")
    .replace(/^\n+/, "")
    .trim();
}

// ── AUTH ──
app.post("/auth/register", async (req, res) => {
  try {
    const { nom, email, password } = req.body;
    if (!nom || !email || !password) return res.status(400).json({ error: "Champs manquants" });
    if (password.length < 6) return res.status(400).json({ error: "Mot de passe trop court" });
    const result = await col("users").insertOne({
      nom, email: email.toLowerCase(), password: hash(password), createdAt: new Date()
    });
    const token = makeToken(result.insertedId.toString(), email.toLowerCase());
    res.json({ token, nom, email: email.toLowerCase() });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ error: "Email deja utilise" });
    res.status(500).json({ error: e.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Champs manquants" });
    const user = await col("users").findOne({ email: email.toLowerCase() });
    if (!user || user.password !== hash(password))
      return res.status(401).json({ error: "Email ou mot de passe incorrect" });
    const token = makeToken(user._id.toString(), user.email);
    res.json({ token, nom: user.nom, email: user.email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TRADES ──
app.get("/api/trades", auth, async (req, res) => {
  try {
    const trades = await col("trades").find({ userId: req.userId }).sort({ createdAt: -1 }).toArray();
    res.json(trades.map(t => ({ ...t, id: t._id.toString() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/trades", auth, async (req, res) => {
  try {
    const trade = { ...req.body, userId: req.userId, createdAt: new Date() };
    delete trade.id;
    const result = await col("trades").insertOne(trade);
    res.json({ ...trade, id: result.insertedId.toString(), _id: result.insertedId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/trades/:id", auth, async (req, res) => {
  try {
    const update = { ...req.body };
    delete update._id; delete update.id; delete update.userId;
    await col("trades").updateOne({ _id: new ObjectId(req.params.id), userId: req.userId }, { $set: update });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/trades/:id", auth, async (req, res) => {
  try {
    await col("trades").deleteOne({ _id: new ObjectId(req.params.id), userId: req.userId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BRIEFING ──
async function sendMorningBriefing() {
  const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  console.log("Briefing du " + today + "...");
  try {
    const prompt = "Recherche le prix du GOLD et DAX et le calendrier economique du " + today + ". Reponds en francais. Commence DIRECTEMENT par le briefing sans introduction. Format:\n\n📊 BRIEFING " + today.toUpperCase() + "\n\n━━━━━━━━━━━━━━━━━\n🥇 GOLD (XAU/USD)\n━━━━━━━━━━━━━━━━━\n💰 Prix : [prix reel]\n📈 Tendance : [HAUSSIER/BAISSIER/NEUTRE]\n🛡 Support : [niveau] | 🎯 Resistance : [niveau]\n⚡ Signal : [LONG/SHORT/NEUTRE]\n\n━━━━━━━━━━━━━━━━━\n🇩🇪 DAX (GER40)\n━━━━━━━━━━━━━━━━━\n💰 Prix : [prix reel]\n📈 Tendance : [HAUSSIER/BAISSIER/NEUTRE]\n🛡 Support : [niveau] | 🎯 Resistance : [niveau]\n⚡ Signal : [LONG/SHORT/NEUTRE]\n\n━━━━━━━━━━━━━━━━━\n📅 ANNONCES DU JOUR\n━━━━━━━━━━━━━━━━━\n[chaque annonce: 🔴/🟠/🟡 heure nom]\n⚡ Court terme : [impact]\n📆 Long terme : [impact]\n\n━━━━━━━━━━━━━━━━━\n📰 NEWS CLES\n━━━━━━━━━━━━━━━━━\n• [news 1]\n• [news 2]\n• [news 3]\n\n━━━━━━━━━━━━━━━━━\n🧠 STRATEGIE DU JOUR\n━━━━━━━━━━━━━━━━━\n[2 phrases]\n\n🤖 Anton Trading Bot";
    const res = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-6", max_tokens: 2048,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }]
    }, { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } });
    const txt = extractText(res.data.content);
    if (!txt || txt.length < 20) { await sendTelegram("Erreur briefing: contenu vide"); return; }
    if (txt.length > 3800) {
      let rem = txt;
      while (rem.length > 0) {
        let cut = rem.lastIndexOf("\n", 3800);
        if (cut <= 0) cut = 3800;
        await sendTelegram(rem.substring(0, cut));
        rem = rem.substring(cut).trim();
        await new Promise(r => setTimeout(r, 500));
      }
    } else { await sendTelegram(txt); }
    console.log("Briefing envoye !");
  } catch (e) { await sendTelegram("Erreur briefing: " + e.message); }
}

function scheduleBriefing() {
  const now = new Date(), next = new Date();
  next.setUTCHours(6, 30, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);
  const delay = next - now;
  console.log("Prochain briefing dans " + Math.round(delay / 60000) + " minutes");
  setTimeout(() => { sendMorningBriefing(); setInterval(sendMorningBriefing, 24 * 60 * 60 * 1000); }, delay);
}

// ── ROUTES ──
app.get("/briefing/test", (req, res) => { res.json({ message: "Briefing en cours..." }); sendMorningBriefing(); });
app.get("/health", async (req, res) => {
  const count = col("trades") ? await col("trades").countDocuments() : 0;
  const users = col("users") ? await col("users").countDocuments() : 0;
  res.json({ status: "ok", trades: count, users, db: db ? "connecte" : "deconnecte" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Serveur port " + PORT);
  await connectMongo();
  scheduleBriefing();
});
