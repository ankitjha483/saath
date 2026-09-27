// saath-v5-demo
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server);

// Online ho to DATABASE_URL, laptop par ho to .env wali details
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

// ---------- SECURITY GUARD ----------
function authCheck(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Pehle login karo" });
  }
}

// ---------- KYA DONO KA MATCH HAI? ----------
async function isMatch(userA, userB) {
  const result = await db.query(
    `SELECT 1 FROM swipes a
     JOIN swipes b ON a.from_user = b.to_user AND a.to_user = b.from_user
     WHERE a.from_user = $1 AND a.to_user = $2 AND a.action = 'like' AND b.action = 'like'
       AND NOT EXISTS (
         SELECT 1 FROM blocks
         WHERE (blocker = $1 AND blocked = $2) OR (blocker = $2 AND blocked = $1)
       )`,
    [userA, userB]
  );
  return result.rowCount > 0;
}

// ---------- DEMO PROFILES (portfolio ke liye) ----------
// @demo.com wale profiles asli log nahi hain. Ye wapas like karte hain aur chat mein auto-reply dete hain,
// taaki link kholne wala har insaan match aur chat try kar sake.
async function isDemoUser(userId) {
  const r = await db.query("SELECT 1 FROM users WHERE id = $1 AND email LIKE '%@demo.com'", [userId]);
  return r.rowCount > 0;
}

const DEMO_REPLIES = [
  "Hi! Kaise ho? 😊",
  "Haha, achha laga tumse match hokar!",
  "Waise weekend pe kya karna pasand hai?",
  "Chai ya coffee? Soch samajh ke jawab dena 😄",
  "Ek baat batao jo profile mein nahi likhi!"
];

app.use(express.static("public"));

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
app.get("/api/profiles", authCheck, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, age, city, job, languages, intent, prompt_question, prompt_answer
       FROM users
       WHERE id <> $1
         AND id NOT IN (SELECT to_user FROM swipes WHERE from_user = $1)
         AND id NOT IN (SELECT blocked FROM blocks WHERE blocker = $1)
         AND id NOT IN (SELECT blocker FROM blocks WHERE blocked = $1)
       ORDER BY id`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database se data nahi mila" });
  }
});

// ---------- SWIPE ----------
app.post("/api/swipe", authCheck, async (req, res) => {
  const { to_user, action } = req.body;
  if (!["like", "pass"].includes(action)) {
    return res.status(400).json({ error: "Action sirf 'like' ya 'pass' ho sakta hai" });
  }
  if (to_user === req.user.id) {
    return res.status(400).json({ error: "Khud ko swipe nahi kar sakte" });
  }
  try {
    await db.query(
      `INSERT INTO swipes (from_user, to_user, action) VALUES ($1, $2, $3)
       ON CONFLICT (from_user, to_user) DO UPDATE SET action = EXCLUDED.action`,
      [req.user.id, to_user, action]
    );
    if (action === "like" && (await isDemoUser(to_user))) {
      await db.query(
        `INSERT INTO swipes (from_user, to_user, action) VALUES ($1, $2, 'like')
         ON CONFLICT (from_user, to_user) DO NOTHING`,
        [to_user, req.user.id]
      );
    }
    const match = action === "like" && (await isMatch(req.user.id, to_user));
    res.json({ message: match ? "It's a match! 🎉" : "Swipe save ho gaya", match });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(404).json({ error: "Ye user exist nahi karta" });
    }
    console.error(err);
    res.status(500).json({ error: "Kuch gadbad ho gayi, dobara try karo" });
  }
});

// ---------- MATCHES ----------
app.get("/api/matches", authCheck, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.age, u.city
       FROM swipes a
       JOIN swipes b ON a.from_user = b.to_user AND a.to_user = b.from_user
       JOIN users u ON u.id = a.to_user
       WHERE a.from_user = $1 AND a.action = 'like' AND b.action = 'like'
         AND NOT EXISTS (
           SELECT 1 FROM blocks
           WHERE (blocker = $1 AND blocked = u.id) OR (blocker = u.id AND blocked = $1)
         )`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Kuch gadbad ho gayi, dobara try karo" });
  }
});

// ---------- BLOCK ----------
app.post("/api/block", authCheck, async (req, res) => {
  const userId = Number(req.body.user_id);
  if (!userId || userId === req.user.id) {
    return res.status(400).json({ error: "Galat user" });
  }
  try {
    await db.query(
      "INSERT INTO blocks (blocker, blocked) VALUES ($1, $2) ON CONFLICT (blocker, blocked) DO NOTHING",
      [req.user.id, userId]
    );
    io.to("user:" + userId).emit("match_removed", { user_id: req.user.id });
    res.json({ message: "Block kar diya. Ab ye aapko nahi dikhenge." });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(404).json({ error: "Ye user exist nahi karta" });
    }
    console.error(err);
    res.status(500).json({ error: "Kuch gadbad ho gayi, dobara try karo" });
  }
});

// ---------- REPORT (report ke saath block bhi) ----------
const REPORT_REASONS = ["Badtameezi", "Fake profile", "Spam ya scam", "Kuch aur"];

app.post("/api/report", authCheck, async (req, res) => {
  const userId = Number(req.body.user_id);
  const { reason } = req.body;
  if (!userId || userId === req.user.id) {
    return res.status(400).json({ error: "Galat user" });
  }
  if (!REPORT_REASONS.includes(reason)) {
    return res.status(400).json({ error: "Report ki wajah chuno" });
  }
  try {
    await db.query(
      "INSERT INTO reports (reporter, reported, reason) VALUES ($1, $2, $3)",
      [req.user.id, userId, reason]
    );
    await db.query(
      "INSERT INTO blocks (blocker, blocked) VALUES ($1, $2) ON CONFLICT (blocker, blocked) DO NOTHING",
      [req.user.id, userId]
    );
    io.to("user:" + userId).emit("match_removed", { user_id: req.user.id });
    res.json({ message: "Report mil gayi. Humne is user ko aapke liye block bhi kar diya." });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(404).json({ error: "Ye user exist nahi karta" });
    }
    console.error(err);
    res.status(500).json({ error: "Kuch gadbad ho gayi, dobara try karo" });
  }
});

// ---------- PURANE MESSAGES ----------
app.get("/api/messages/:otherId", authCheck, async (req, res) => {
  const otherId = Number(req.params.otherId);
  try {
    if (!(await isMatch(req.user.id, otherId))) {
      return res.status(403).json({ error: "Sirf match ke saath chat kar sakte ho" });
    }
    const result = await db.query(
      `SELECT id, from_user, to_user, text, created_at FROM messages
       WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
       ORDER BY created_at`,
      [req.user.id, otherId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Messages nahi mile" });
  }
});

// ---------- LIVE CHAT (Socket.io) ----------
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error("Pehle login karo"));
  }
});

io.on("connection", (socket) => {
  // Har user ka apna "kamra", taaki message sirf usi tak jaye
  socket.join("user:" + socket.user.id);

  socket.on("send_message", async ({ to_user, text }, reply) => {
    text = String(text || "").trim();
    if (!text || text.length > 1000) {
      return reply({ error: "Message khaali ya bahut lamba hai" });
    }
    try {
      if (!(await isMatch(socket.user.id, to_user))) {
        return reply({ error: "Sirf match ke saath chat kar sakte ho" });
      }
      const result = await db.query(
        "INSERT INTO messages (from_user, to_user, text) VALUES ($1, $2, $3) RETURNING id, from_user, to_user, text, created_at",
        [socket.user.id, to_user, text]
      );
      const msg = result.rows[0];
      io.to("user:" + to_user).emit("new_message", msg);
      reply({ ok: true, message: msg });

      // Demo profile ho to 1.5 second baad auto-reply
      if (await isDemoUser(to_user)) {
        const sender = socket.user.id;
        setTimeout(async () => {
          try {
            const text = DEMO_REPLIES[Math.floor(Math.random() * DEMO_REPLIES.length)];
            const r = await db.query(
              "INSERT INTO messages (from_user, to_user, text) VALUES ($1, $2, $3) RETURNING id, from_user, to_user, text, created_at",
              [to_user, sender, text]
            );
            io.to("user:" + sender).emit("new_message", r.rows[0]);
          } catch (e) {
            console.error(e);
          }
        }, 1500);
      }
    } catch (err) {
      console.error(err);
      reply({ error: "Message nahi gaya, dobara try karo" });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server started on port " + PORT));