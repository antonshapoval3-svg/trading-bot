require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // sert le journal.html

// ─── Config ──────────────────────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT        = process.env.TELEGRAM_CHAT_ID;
const TRADES_FILE    = path.join(__dirname, "trades.json");

// ─── Helpers fichier JSON ─────────────────────────────────────────
function loadTrades() {
  try {
    if (fs.existsSync(TRADES_FILE)) {
      return JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
    }
  } catch (e) { console.error("Erreur lecture trades:", e.message); }
  return [];
}

function saveTrades(trades) {
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  } catch (e) { console.error("Erreur sauvegarde trades:", e.message); }
}

// ─── Route : reçoit l'alerte TradingView ─────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("📩 Alerte reçue :", req.body);
  res.sendStatus(200);

  const { symbol, action, price, timeframe, high, low, volume, vwap, poc } = req.body;
  const now = new Date();
  const date = now.toISOString().split("T")[0];

  // ── 1. Enregistre le trade dans trades.json ───────────────────
  const trades = loadTrades();
  const newTrade = {
    id: Date.now(),
    symbol: (symbol || "UNKNOWN").toUpperCase(),
    side: action === "BUY" ? "BUY" : "SELL",
    date,
    entry: parseFloat(price) || 0,
    sl: 0,
    tp: 0,
    size: 1,
    status: "open",
    exit: 0,
    pnl: 0,
    netPnl: 0,
    strategy: "EMA + VWAP",
    emotion: "Neutre",
    notes: `Signal ${action} reçu via webhook TradingView — Timeframe: ${timeframe} | VWAP: ${vwap||"—"} | POC: ${poc||"—"}`,
    duration: "",
    timeframe: timeframe || "—",
    vwap: vwap || "—",
    poc: poc || "—",
    volume: volume || 0
  };

  trades.unshift(newTrade);
  saveTrades(trades);
  console.log(`✅ Trade enregistré : ${newTrade.symbol} ${newTrade.side} @ ${newTrade.entry}`);

  try {
    // ── 2. Appel Claude pour l'analyse ───────────────────────────
    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: `Signal de trading reçu :
- Actif      : ${symbol}
- Action     : ${action}
- Prix       : ${price}
- Timeframe  : ${timeframe}
- Haut/Bas   : ${high} / ${low}
- Volume     : ${volume}
- VWAP       : ${vwap || "—"}
- POC/TPO    : ${poc || "—"}

Réponds en français, format court pour Telegram :
🔔 SIGNAL ${action} — ${symbol}
💰 Prix : ${price}
📊 Contexte : [tendance actuelle]
🎯 Technique : [EMA, RSI, VWAP, POC — points clés]
💡 Recommandation : [ACHETER / VENDRE / ATTENDRE]
📉 Stop-loss : [prix] | Take-profit : [prix]
⚠️ Risques : [risques principaux]`
        }]
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );

    const analyse = claudeRes.data.content[0].text;
    console.log("🤖 Analyse Claude :", analyse);

    // ── 3. Envoie sur Telegram ────────────────────────────────────
    await axios.post(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT, text: analyse, parse_mode: "Markdown" }
    );
    console.log("✅ Message envoyé sur Telegram !");

  } catch (err) {
    console.error("❌ Erreur :", err.response?.data || err.message);
  }
});

// ─── Route : lire tous les trades (pour le journal) ──────────────
app.get("/api/trades", (req, res) => {
  res.json(loadTrades());
});

// ─── Route : mettre à jour un trade (fermer, ajouter PnL...) ─────
app.put("/api/trades/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const trades = loadTrades();
  const idx = trades.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: "Trade non trouvé" });
  trades[idx] = { ...trades[idx], ...req.body };
  saveTrades(trades);
  res.json(trades[idx]);
});

// ─── Route : supprimer un trade ───────────────────────────────────
app.delete("/api/trades/:id", (req, res) => {
  const id = parseInt(req.params.id);
  let trades = loadTrades();
  trades = trades.filter(t => t.id !== id);
  saveTrades(trades);
  res.json({ ok: true });
});

// ─── Route : ajouter un trade manuellement ────────────────────────
app.post("/api/trades", (req, res) => {
  const trades = loadTrades();
  const trade = { id: Date.now(), ...req.body };
  trades.unshift(trade);
  saveTrades(trades);
  res.json(trade);
});

// ─── Health check ─────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", trades: loadTrades().length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur démarré sur le port ${PORT}`));
