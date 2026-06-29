require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const data = req.body;

  console.log("Signal reçu :", data);

  const message = `🚨 SIGNAL

Actif: ${data.symbol}
Prix: ${data.price}
Action: ${data.action}`;

  await axios.post(
    `[api.telegram.org](https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage)`,
    {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message
    }
  );

  res.send("OK");
});

app.listen(3000, () => {
  console.log("Serveur lancé sur [localhost](http://localhost:3000)");
});
