require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());

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

// ---------- SIGN UP ----------
app.post("/api/signup", async (req, res) => {
  const { name, email, password, age, gender, city } = req.body;

  if (!name || !email || !password || !age) {
    return res.status(400).json({ error: "Naam, email, password aur umar zaroori hai" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password kam se kam 8 characters ka hona chahiye" });
  }
  if (age < 18) {
    return res.status(400).json({ error: "Saath sirf 18+ logon ke liye hai" });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      "INSERT INTO users (name, email, password_hash, age, gender, city) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email",
      [name, email.toLowerCase(), hash, age, gender, city]
    );
    res.status(201).json({ message: "Account ban gaya!", user: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Is email se account pehle se bana hua hai" });
    }
    console.error(err);
    res.status(500).json({ error: "Kuch gadbad ho gayi, dobara try karo" });
  }
});

// ---------- LOGIN ----------
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email aur password dono daalo" });
  }

  try {
    const result = await db.query(
      "SELECT id, name, password_hash FROM users WHERE email = $1",
      [email.toLowerCase()]
    );
    const user = result.rows[0];
    const sahi = user && (await bcrypt.compare(password, user.password_hash));

    if (!sahi) {
      return res.status(401).json({ error: "Email ya password galat hai" });
    }

    const token = jwt.sign({ id: user.id, name: user.name }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ message: `Welcome ${user.name}!`, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Kuch gadbad ho gayi, dobara try karo" });
  }
});

// ---------- PROFILES ----------
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