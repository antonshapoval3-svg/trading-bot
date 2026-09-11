require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const SECRET = process.env.JWT_SECRET || "anton_trading_secret_2026";
const CONCEPTS_FILE = "./concepts_history.json";

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

async function sendTelegram(text) {
  if (!text || !text.trim()) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT,
      text: text.trim(),
      parse_mode: "Markdown"
    });
  } catch (e) { console.error("Telegram:", e.message); }
}

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

// ── MEMOIRE CONCEPTS FICHIER LOCAL ────────────────────────────────────────────
function saveConceptUsed(concept, date) {
  try {
    let history = [];
    if (fs.existsSync(CONCEPTS_FILE)) {
      history = JSON.parse(fs.readFileSync(CONCEPTS_FILE, "utf8"));
    }
    history.unshift({ concept, date, createdAt: new Date() });
    if (history.length > 30) history = history.slice(0, 30);
    fs.writeFileSync(CONCEPTS_FILE, JSON.stringify(history, null, 2));
    console.log("Concept sauvegarde : " + concept);
  } catch (e) { console.error("Erreur save concept:", e.message); }
}

function getLastConcepts(limit = 20) {
  try {
    if (!fs.existsSync(CONCEPTS_FILE)) return [];
    const history = JSON.parse(fs.readFileSync(CONCEPTS_FILE, "utf8"));
    return history.slice(0, limit).map(d => d.concept);
  } catch (e) { return []; }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
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

// ── TRADES ────────────────────────────────────────────────────────────────────
app.get("/api/trades", auth, async (req, res) => {
  try {
    const query = { userId: req.userId };
    if (req.query.account) query.account = req.query.account;
    const trades = await col("trades").find(query).sort({ createdAt: -1 }).toArray();
    res.json(trades.map(t => ({ ...t, id: t._id.toString() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/trades/bulk", auth, async (req, res) => {
  try {
    const trades = req.body;
    if (!Array.isArray(trades)) return res.status(400).json({ error: "Array required" });
    const docs = trades.map(t => ({ ...t, userId: req.userId, createdAt: new Date() }));
    const result = await db.collection("trades").insertMany(docs);
    res.json({ inserted: result.insertedCount });
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
    await col("trades").updateOne(
      { _id: new ObjectId(req.params.id), userId: req.userId },
      { $set: update }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/trades", auth, async (req, res) => {
  try {
    const query = { userId: req.userId };
    if (req.query.account) query.account = req.query.account;
    const result = await db.collection("trades").deleteMany(query);
    res.json({ deleted: result.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/trades/:id", auth, async (req, res) => {
  try {
    await col("trades").deleteOne({ _id: new ObjectId(req.params.id), userId: req.userId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ACCOUNTS ──────────────────────────────────────────────────────────────────
app.get("/api/accounts", auth, async (req, res) => {
  try {
    const accounts = await col("accounts").find({ userId: req.userId }).toArray();
    res.json(accounts.map(a => ({ ...a, id: a._id.toString() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/accounts", auth, async (req, res) => {
  try {
    const account = { ...req.body, userId: req.userId, createdAt: new Date() };
    const result = await col("accounts").insertOne(account);
    res.json({ ...account, id: result.insertedId.toString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BRIEFING ──────────────────────────────────────────────────────────────────
async function sendMorningBriefing(force) {
  const now = new Date();
  const day = now.getDay();
  if (!force && (day === 0 || day === 6)) { console.log("Week-end — pas de briefing."); return; }

  const today = new Date().toLocaleDateString("fr-FR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Europe/Paris"
  });

  console.log("Briefing du " + today + "...");

  try {
    // 1. BRIEFING MARCHE
    const prompt = `Recherche le prix du GOLD et DAX et le calendrier economique du ${today}. Reponds en francais. Commence DIRECTEMENT par le briefing sans introduction. Format exact:

📅 BRIEFING ${today.toUpperCase()}

═══════════════════════════
🥇 GOLD (XAU/USD)
═══════════════════════════
💲 Prix : [prix reel]
📊 Tendance : [HAUSSIER/BAISSIER/NEUTRE]
🌀 Support : [niveau] | 🎯 Resistance : [niveau]
⚡ Signal : [LONG/SHORT/NEUTRE]

═══════════════════════════
🇩🇪 DAX (GER40)
═══════════════════════════
💲 Prix : [prix reel]
📊 Tendance : [HAUSSIER/BAISSIER/NEUTRE]
🌀 Support : [niveau] | 🎯 Resistance : [niveau]
⚡ Signal : [LONG/SHORT/NEUTRE]

═══════════════════════════
📰 ANNONCES DU JOUR
═══════════════════════════
[chaque annonce: 🔴/🟡/🟢 heure nom]
⚡ Court terme : [impact]
📈 Long terme : [impact]

═══════════════════════════
📰 NEWS CLES
═══════════════════════════
- [news 1]
- [news 2]
- [news 3]

═══════════════════════════
🎯 STRATEGIE DU JOUR
═══════════════════════════
[2 phrases]`;

    const res = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-6", max_tokens: 2048,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }]
    }, { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } });

    const txt = extractText(res.data.content);
    if (!txt || txt.length < 100) {
      await sendTelegram("Erreur briefing: contenu insuffisant");
      return;
    }

    // 2. CONCEPT DU JOUR AVEC MEMOIRE FICHIER
    const lastConcepts = getLastConcepts(20);
    const exclusionList = lastConcepts.length > 0
      ? "\n\nCONCEPTS DEJA UTILISES — NE PAS REPETER :\n" + lastConcepts.map((c, i) => (i + 1) + ". " + c).join("\n")
      : "";

    const conceptPrompt = `Tu es un formateur en trading et finance. Aujourd'hui c'est le ${today}.

Choisis UN concept DIFFERENT de ceux deja utilises et explique-le en francais.${exclusionList}

Sujets possibles : inflation, taux d'interet, PIB, NFP, VIX, correlations, fibonacci, RSI, MACD, bougies japonaises, order flow, carry trade, yield curve, QE, risk/reward, money management, psychologie du trading, sessions de marche, spread, levier, or, obligations, banques centrales, volumes, supports/resistances, ichimoku, bollinger, stochastique, ATR, options, swap, liquidite, market maker, smart money, imbalance, FVG, order block, BOS, CHoCH, scalping, swing trading, COT report, intermarkets, saisonnalite, delta, gamma, PMI, CPI, PPI, NFP, FOMC, BCE, Fed, dollar index, carry trade, corrélations or/dollar, etc.

Si une annonce importante sort aujourd'hui, explique ce concept en priorite.

Reponds UNIQUEMENT avec ce format :

📚 CONCEPT DU JOUR — [NOM EN MAJUSCULES]

[Explication simple en 2-3 phrases]

🔑 Points cles :
- [point 1]
- [point 2]
- [point 3]

📈 Impact trading :
- [impact 1]
- [impact 2]

💡 Retiens : "[phrase memorable]"`;

    let conceptTxt = "";
    let conceptName = "";

    try {
      const conceptRes = await axios.post("https://api.anthropic.com/v1/messages", {
        model: "claude-sonnet-4-6", max_tokens: 700,
        messages: [{ role: "user", content: conceptPrompt }]
      }, { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } });

      conceptTxt = conceptRes.data.content
        .filter(b => b.type === "text")
        .map(b => b.text.trim())
        .join("\n")
        .trim();

      const match = conceptTxt.match(/CONCEPT DU JOUR\s*[—-]\s*(.+)/i);
      if (match) {
        conceptName = match[1].trim();
        saveConceptUsed(conceptName, today);
        console.log("Concept du jour : " + conceptName);
      }

    } catch (ce) {
      console.error("Erreur concept:", ce.message);
    }

    // 3. ENVOI SEPARE
    await sendTelegram(txt);

    if (conceptTxt && conceptTxt.length > 20) {
      await sendTelegram(conceptTxt);
    }

    console.log("Briefing envoye !");

  } catch (e) {
    console.error("Erreur briefing:", e.message);
    await sendTelegram("Erreur briefing: " + e.message);
  }
}

function scheduleBriefing() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(6, 30, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);
  const delay = next - now;
  console.log("Prochain briefing dans " + Math.round(delay / 60000) + " minutes");
  setTimeout(() => {
    sendMorningBriefing();
    setInterval(sendMorningBriefing, 24 * 60 * 60 * 1000);
  }, delay);
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/briefing/test", (req, res) => {
  res.json({ message: "Briefing en cours..." });
  sendMorningBriefing(true);
});

app.get("/concepts/history", (req, res) => {
  try {
    if (!fs.existsSync(CONCEPTS_FILE)) return res.json([]);
    const history = JSON.parse(fs.readFileSync(CONCEPTS_FILE, "utf8"));
    res.json(history);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", async (req, res) => {
  const count = col("trades") ? await col("trades").countDocuments() : 0;
  const users = col("users") ? await col("users").countDocuments() : 0;
  let concepts = 0;
  if (fs.existsSync(CONCEPTS_FILE)) {
    concepts = JSON.parse(fs.readFileSync(CONCEPTS_FILE, "utf8")).length;
  }
  res.json({ status: "ok", trades: count, users, concepts, db: db ? "connecte" : "deconnecte" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Serveur port " + PORT);
  await connectMongo();
  scheduleBriefing();
});