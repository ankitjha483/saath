// saath-v11-photo
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

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

// ---------- CLOUDINARY (photo storage) ----------
const photosEnabled = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (photosEnabled) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}
// Photo memory mein lo, max 5 MB, sirf images
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPG, PNG or WEBP images are allowed"));
  }
});

app.use(express.static("public"));

// ---------- EMAIL BHEJNA (Brevo) ----------
async function sendOtpEmail(to, code) {
  // Laptop par Brevo key na ho to code terminal mein dikha do (sirf testing ke liye)
  if (!process.env.BREVO_API_KEY) {
    console.log(`OTP for ${to}: ${code}`);
    return;
  }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      sender: { name: "Saath", email: process.env.EMAIL_FROM },
      to: [{ email: to }],
      subject: `Saath verification code: ${code}`,
      htmlContent: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #D5EBE6;border-radius:16px">
        <h2 style="color:#0F5E57;margin:0 0 8px">Saath</h2>
        <p style="color:#0B2B28">Aapka verification code:</p>
        <p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#0F5E57;margin:8px 0">${code}</p>
        <p style="color:#4E6E6A;font-size:14px">Ye code 10 minute mein expire ho jayega. Ise kisi ke saath share mat karna.</p>
        <p style="color:#4E6E6A;font-size:13px">Agar aapne Saath par sign up nahi kiya, to is email ko ignore karo.</p>
      </div>`
    })
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error("Brevo error: " + detail);
  }
}

// ---------- OTP BHEJO ----------
app.post("/api/send-otp", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Sahi email daalo" });
  }
  try {
    const exists = await db.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (exists.rowCount > 0) {
      return res.status(409).json({ error: "Is email se account pehle se bana hua hai. Login karo." });
    }
    const recent = await db.query(
      "SELECT 1 FROM email_otps WHERE email = $1 AND created_at > NOW() - INTERVAL '60 seconds'",
      [email]
    );
    if (recent.rowCount > 0) {
      return res.status(429).json({ error: "Code abhi bheja hai. 1 minute baad dobara try karo." });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = await bcrypt.hash(code, 10);
    await db.query(
      `INSERT INTO email_otps (email, code_hash, expires_at, attempts, created_at)
       VALUES ($1, $2, NOW() + INTERVAL '10 minutes', 0, NOW())
       ON CONFLICT (email) DO UPDATE
       SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = NOW()`,
      [email, codeHash]
    );
    await sendOtpEmail(email, code);
    res.json({ message: "Code bhej diya. Email check karo (Spam folder bhi)." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Code nahi bhej paaye, thodi der baad try karo" });
  }
});

// ---------- SIGN UP (OTP ke saath) ----------
app.post("/api/signup", async (req, res) => {
  const { name, password, age, gender, city, otp } = req.body;
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!name || !email || !password || !age) {
    return res.status(400).json({ error: "Naam, email, password aur umar zaroori hai" });
  }
  if (!otp) {
    return res.status(400).json({ error: "Email par aaya code daalo" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password kam se kam 8 characters ka hona chahiye" });
  }
  if (age < 18) {
    return res.status(400).json({ error: "Saath sirf 18+ logon ke liye hai" });
  }
  try {
    // OTP check
    const o = await db.query("SELECT code_hash, expires_at, attempts FROM email_otps WHERE email = $1", [email]);
    const row = o.rows[0];
    if (!row || new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: "Code expire ho gaya. Naya code mangao." });
    }
    if (row.attempts >= 5) {
      return res.status(429).json({ error: "Bahut baar galat code daala. Naya code mangao." });
    }
    const codeSahi = await bcrypt.compare(String(otp).trim(), row.code_hash);
    if (!codeSahi) {
      await db.query("UPDATE email_otps SET attempts = attempts + 1 WHERE email = $1", [email]);
      return res.status(400).json({ error: "Code galat hai, dobara check karo" });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      "INSERT INTO users (name, email, password_hash, age, gender, city) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email",
      [name, email, hash, age, gender, city]
    );
    await db.query("DELETE FROM email_otps WHERE email = $1", [email]);
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

// ---------- MERI PROFILE ----------
app.get("/api/me", authCheck, async (req, res) => {
  try {
    const r = await db.query(
      "SELECT id, name, email, age, gender, city, job, languages, intent, prompt_question, prompt_answer, photo_url FROM users WHERE id = $1",
      [req.user.id]
    );
    res.json(r.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load your profile" });
  }
});

// ---------- PHOTO UPLOAD ----------
app.post("/api/photo", authCheck, (req, res) => {
  if (!photosEnabled) {
    return res.status(503).json({ error: "Photo upload is not set up on the server yet" });
  }
  upload.single("photo")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No photo received" });
    try {
      const dataUri = "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");
      const result = await cloudinary.uploader.upload(dataUri, {
        folder: "saath",
        transformation: [{ width: 800, height: 800, crop: "fill", gravity: "face" }, { quality: "auto" }]
      });
      await db.query("UPDATE users SET photo_url = $1 WHERE id = $2", [result.secure_url, req.user.id]);
      res.json({ photo_url: result.secure_url });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Photo upload failed, please try again" });
    }
  });
});

// ---------- PROFILES ----------
app.get("/api/profiles", authCheck, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, age, city, job, languages, intent, prompt_question, prompt_answer, photo_url
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
      `SELECT u.id, u.name, u.age, u.city, u.photo_url
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

  // ---------- VOICE CALL (WebRTC signaling) ----------
  // Awaaz seedha dono phones ke beech jaati hai. Server sirf "milane" ka kaam karta hai.
  socket.on("call:offer", async ({ to_user, sdp } = {}, reply = () => {}) => {
    try {
      if (!(await isMatch(socket.user.id, to_user))) {
        return reply({ error: "Sirf match ko call kar sakte ho" });
      }
      if (await isDemoUser(to_user)) {
        return reply({ error: "Ye demo profile hai, call nahi utha sakti. Kisi asli match ko call karo." });
      }
      const online = await io.in("user:" + to_user).fetchSockets();
      if (!online.length) {
        return reply({ error: "Ye abhi online nahi hain, baad mein try karo" });
      }
      io.to("user:" + to_user).emit("call:incoming", {
        from_user: socket.user.id,
        from_name: socket.user.name,
        sdp
      });
      reply({ ok: true });
    } catch (err) {
      console.error(err);
      reply({ error: "Call nahi lag paayi, dobara try karo" });
    }
  });

  // Baaki call messages: sirf match ke beech aage bhejo
  function relay(inEvent, outEvent) {
    socket.on(inEvent, async (data = {}) => {
      try {
        if (!(await isMatch(socket.user.id, data.to_user))) return;
        io.to("user:" + data.to_user).emit(outEvent, { ...data, from_user: socket.user.id });
      } catch (err) {
        console.error(err);
      }
    });
  }
  relay("call:answer", "call:answered");
  relay("call:ice", "call:ice");
  relay("call:end", "call:ended");
  relay("call:decline", "call:declined");

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

// ---------- TABLES KHUD BANAO (migration) ----------
// Server chalu hote hi check karta hai. Jo table pehle se hai use chhedta nahi.
async function setupDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      age INT CHECK (age >= 18),
      gender VARCHAR(10),
      city VARCHAR(50),
      job VARCHAR(100),
      languages TEXT,
      intent VARCHAR(50),
      prompt_question TEXT,
      prompt_answer TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS swipes (
      id SERIAL PRIMARY KEY,
      from_user INT REFERENCES users(id) ON DELETE CASCADE,
      to_user INT REFERENCES users(id) ON DELETE CASCADE,
      action VARCHAR(10) CHECK (action IN ('like', 'pass')),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (from_user, to_user)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_user INT REFERENCES users(id) ON DELETE CASCADE,
      to_user INT REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS blocks (
      id SERIAL PRIMARY KEY,
      blocker INT REFERENCES users(id) ON DELETE CASCADE,
      blocked INT REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (blocker, blocked)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      reporter INT REFERENCES users(id) ON DELETE CASCADE,
      reported INT REFERENCES users(id) ON DELETE CASCADE,
      reason VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS email_otps (
      email VARCHAR(100) PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      attempts INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Purane likes jo demo profiles ko diye the, unka match bhi bana do
  await db.query(`
    INSERT INTO swipes (from_user, to_user, action)
    SELECT s.to_user, s.from_user, 'like'
    FROM swipes s
    JOIN users u ON u.id = s.to_user
    WHERE s.action = 'like' AND u.email LIKE '%@demo.com'
    ON CONFLICT (from_user, to_user) DO NOTHING;
  `);
  console.log("Database tables ready");
}

const PORT = process.env.PORT || 3000;
setupDatabase()
  .catch(err => console.error("Database setup mein dikkat:", err))
  .finally(() => {
    server.listen(PORT, () => console.log("Server started on port " + PORT));
  });
