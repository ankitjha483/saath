require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// Database se connection
const db = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

app.get("/", (req, res) => {
  res.send("Saath backend chal raha hai!");
});

// Profiles ab database se aayengi
app.get("/api/profiles", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, name, age, city, job, languages, intent, prompt_question, prompt_answer FROM users ORDER BY id"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database se data nahi mila" });
  }
});

app.listen(3000, () => console.log("Server started: http://localhost:3000"));