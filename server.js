require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const app     = express();
app.use(express.json());
const path = require("path");
app.use(express.static(__dirname));

// ─── Clés depuis le fichier .env ─────────────────────────────
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID;

// ─── Route principale : reçoit l'alerte TradingView ──────────
app.post("/webhook", async (req, res) => {
  console.log("📩 Alerte reçue :", req.body);
  res.sendStatus(200);

  const { symbol, action, price, timeframe, high, low, volume } = req.body;

  try {
    // ── 1. Appel Claude pour l'analyse ─────────────────────
    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: `Signal de trading reçu :
- Actif     : ${symbol}
- Action    : ${action}
- Prix      : ${price}
- Timeframe : ${timeframe}
- Haut/Bas  : ${high} / ${low}
- Volume    : ${volume}

Réponds en français, format court pour Telegram :
🔔 SIGNAL ${action} — ${symbol}
💰 Prix : ${price}
📊 Contexte : [tendance actuelle]
🎯 Technique : [EMA, RSI, points clés]
💡 Recommandation : [ACHETER/VENDRE/ATTENDRE]
📉 Stop-loss : [prix] | Take-profit : [prix]
⚠️ Risques : [risques principaux]`
        }]
      },
      { headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
      }}
    );

    const analyse = claudeRes.data.content[0].text;
    console.log("🤖 Analyse Claude :", analyse);

    // ── 2. Envoie sur Telegram ──────────────────────────────
    await axios.post(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT, text: analyse, parse_mode: "Markdown" }
    );
    console.log("✅ Message envoyé sur Telegram !");

  } catch (err) {
    console.error("❌ Erreur :", err.response?.data || err.message);
  }
});

// ─── Health check ────────────────────────────────────────────
app.get("/", (req, res) => res.send("✅ Serveur actif."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur démarré sur le port ${PORT}`));