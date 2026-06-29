require("dotenv").config();
const axios = require("axios");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT       = process.env.TELEGRAM_CHAT_ID;

// ─── Envoie un message Telegram ──────────────────────────────────
async function sendTelegram(text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT, text, parse_mode: "Markdown" }
    );
    console.log("✅ Message Telegram envoyé");
  } catch (e) {
    console.error("❌ Erreur Telegram:", e.response?.data || e.message);
  }
}

// ─── Briefing principal ───────────────────────────────────────────
async function sendMorningBriefing() {
  const today = new Date().toLocaleDateString("fr-FR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });

  console.log(`🌅 Génération du briefing du ${today}...`);

  try {
    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `Tu es un analyste de trading professionnel. Aujourd'hui c'est le ${today}.

Effectue des recherches web sur :
1. Les dernières nouvelles du GOLD (XAU/USD) et du DAX aujourd'hui
2. Les annonces économiques importantes prévues aujourd'hui (calendrier économique)
3. L'analyse technique actuelle du GOLD et DAX
4. Le sentiment des traders et analystes sur ces deux actifs
5. Les niveaux clés (support/résistance) du jour

Ensuite génère un briefing matinal complet en français pour Telegram, avec ce format EXACT :

🌅 *BRIEFING MATINAL — ${today}*

━━━━━━━━━━━━━━━━━━━━
🥇 *GOLD (XAU/USD)*
━━━━━━━━━━━━━━━━━━━━
📍 *Prix actuel :* [prix]
📈 *Tendance :* [haussière/baissière/neutre]

🎯 *Zones clés :*
• Résistances : [niveaux]
• Supports : [niveaux]

💡 *Sens du trade :* [LONG/SHORT/NEUTRE]
📊 *Confluence :* [raisons techniques]
⚠️ *Risques :* [risques du jour]

━━━━━━━━━━━━━━━━━━━━
📈 *DAX (GER40)*
━━━━━━━━━━━━━━━━━━━━
📍 *Prix actuel :* [prix]
📈 *Tendance :* [haussière/baissière/neutre]

🎯 *Zones clés :*
• Résistances : [niveaux]
• Supports : [niveaux]

💡 *Sens du trade :* [LONG/SHORT/NEUTRE]
📊 *Confluence :* [raisons techniques]
⚠️ *Risques :* [risques du jour]

━━━━━━━━━━━━━━━━━━━━
📅 *AGENDA ÉCONOMIQUE DU JOUR*
━━━━━━━━━━━━━━━━━━━━
[liste des annonces importantes avec heure et impact]

━━━━━━━━━━━━━━━━━━━━
📰 *NEWS IMPORTANTES*
━━━━━━━━━━━━━━━━━━━━
[2-3 news clés qui impactent GOLD et DAX aujourd'hui]

━━━━━━━━━━━━━━━━━━━━
🧠 *RÉSUMÉ STRATÉGIQUE*
━━━━━━━━━━━━━━━━━━━━
[1 paragraphe de synthèse avec la stratégie globale du jour]

_Briefing généré automatiquement par Claude AI_`
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

    // Extrait le texte de la réponse
    const content = claudeRes.data.content;
    const textBlock = content.find(b => b.type === "text");
    const briefing = textBlock ? textBlock.text : "Erreur : pas de contenu généré";

    console.log("🤖 Briefing généré !");

    // Découpe si trop long pour Telegram (max 4096 chars)
    if (briefing.length > 4000) {
      const mid = briefing.lastIndexOf("\n", 4000);
      await sendTelegram(briefing.substring(0, mid));
      await sendTelegram(briefing.substring(mid));
    } else {
      await sendTelegram(briefing);
    }

  } catch (e) {
    console.error("❌ Erreur Claude:", e.response?.data || e.message);
    await sendTelegram("⚠️ Erreur lors de la génération du briefing matinal.");
  }
}

// Lance immédiatement si appelé directement
sendMorningBriefing();
