const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());



app.listen(3000, () => {
  console.log("Serveur lancé sur [localhost](http://localhost:3000)");
});
