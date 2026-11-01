// saath-v42-terms
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
const webpush = require("web-push");

const app = express();
app.use(express.json({ limit: "12mb" }));
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
// Cloudinary 2 tareeke se set ho sakta hai: ek CLOUDINARY_URL se, ya teen alag keys se.
const hasCloudinaryUrl = !!process.env.CLOUDINARY_URL;
const hasCloudinaryKeys = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
const photosEnabled = hasCloudinaryUrl || hasCloudinaryKeys;
if (hasCloudinaryUrl) {
  // CLOUDINARY_URL ko cloudinary library khud padh leti hai, bas secure on kar do
  cloudinary.config({ secure: true });
} else if (hasCloudinaryKeys) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
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

// ---------- PUSH NOTIFICATIONS (web-push) ----------
const pushEnabled = !!(process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE);
if (pushEnabled) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:example@example.com",
    process.env.VAPID_PUBLIC,
    process.env.VAPID_PRIVATE
  );
}

// kisi user ke saare devices par push bhejo
async function sendPush(userId, payload) {
  if (!pushEnabled) return;
  try {
    const subs = await db.query("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = $1", [userId]);
    for (const s of subs.rows) {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
      } catch (err) {
        // 404/410 matlab subscription purana ho gaya, hata do
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.query("DELETE FROM push_subs WHERE endpoint = $1", [s.endpoint]);
        }
      }
    }
  } catch (err) { console.error("sendPush:", err); }
}

// ---------- EXPO PUSH (native app notifications) ----------
// SAATHLY_CALL_DATA_PUSH: bina title ka "data" notification, taaki app khud call screen dikhaye
async function sendExpoData(userId, data, ttl) {
  try {
    const subs = await db.query("SELECT expo_token FROM push_subs WHERE user_id = $1 AND expo_token IS NOT NULL", [userId]);
    const messages = subs.rows
      .filter(s => s.expo_token && String(s.expo_token).startsWith("ExponentPushToken"))
      .map(s => ({ to: s.expo_token, priority: "high", ttl: ttl || 40, data }));
    if (!messages.length) return;
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });
  } catch (err) { console.error("sendExpoData:", err); }
}

async function sendExpoPush(userId, payload) {
  try {
    const subs = await db.query("SELECT expo_token FROM push_subs WHERE user_id = $1 AND expo_token IS NOT NULL", [userId]);
    const messages = subs.rows
      .filter(s => s.expo_token && String(s.expo_token).startsWith("ExponentPushToken"))
      .map(s => ({ to: s.expo_token, sound: "default", priority: "high", channelId: "default", ttl: payload.ttl, title: payload.title, body: payload.body, data: Object.assign({ url: payload.url || "/" }, payload.data || {}) }));
    if (!messages.length) return;
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });
  } catch (err) { console.error("sendExpoPush:", err); }
}

// SAATHLY_ROUTES: "/" = main website, "/app" = Saathly web app
app.get("/", (req, res) => res.sendFile(require("path").join(__dirname, "public", "landing.html")));
app.get("/app", (req, res) => {
  if (req.path.endsWith("/")) return res.redirect(301, "/app");
  res.sendFile(require("path").join(__dirname, "public", "index.html"));
});
app.use(express.static("public"));

// /download ko download.html par bhejo (saaf link ke liye)
const path = require("path");
// SAATHLY_GET_APP: invite link -> app installed ho to khulo, warna naya APK download
const APP_APK_URL = process.env.APP_APK_URL || "https://github.com/ankitjha483/saath/releases/latest/download/saathly.apk";
app.get("/get-app", (req, res) => {
  const apk = APP_APK_URL;
  const intent = "intent://open#Intent;scheme=saathlyapp;package=com.jhaankitt.saathlyapp;S.browser_fallback_url=" + encodeURIComponent(apk) + ";end";
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send('<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Saathly app</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#C23A64;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center}' +
    '.c{max-width:380px;padding:28px;text-align:center}h1{font-size:40px;margin:0 0 6px}p{opacity:.9;line-height:1.5}' +
    'a.b{display:block;margin:14px 0;padding:15px;border-radius:14px;font-weight:700;text-decoration:none;font-size:17px}' +
    '.w{background:#fff;color:#C23A64}.o{border:2px solid #fff;color:#fff}ol{text-align:left;opacity:.9;line-height:1.6;padding-left:20px}</style></head><body><div class="c">' +
    '<h1>saathly<span style="color:#F5A02A">.</span></h1><p>Milo. Baat karo. Judo. 💗</p>' +
    '<a class="b w" id="open" href="' + intent + '">📱 Saathly app kholo</a>' +
    '<a class="b o" href="' + apk + '">⬇️ App download karo (APK)</a>' +
    '<ol><li>Download hone ke baad file par tap karo</li><li>Puchhe to "Install unknown apps" ko Allow karo</li><li>Install dabao, aur Saathly kholo</li></ol>' +
    '</div><script>if(/android/i.test(navigator.userAgent)){setTimeout(function(){location.href=document.getElementById("open").href},400)}</script></body></html>');
});

app.get("/download", (req, res) => res.sendFile(path.join(__dirname, "public", "landing.html")));
app.get("/terms", (req, res) => res.sendFile(path.join(__dirname, "public", "terms.html")));

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

// ---------- FORGOT PASSWORD: send reset code ----------
app.post("/api/forgot-password", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email" });
  }
  try {
    const exists = await db.query("SELECT 1 FROM users WHERE email = $1", [email]);
    // Security: chahe email ho ya na ho, same message. Taaki koi email guess na kar sake.
    if (exists.rowCount === 0) {
      return res.json({ message: "If that email is registered, a reset code has been sent." });
    }
    const recent = await db.query(
      "SELECT 1 FROM email_otps WHERE email = $1 AND created_at > NOW() - INTERVAL '60 seconds'",
      [email]
    );
    if (recent.rowCount > 0) {
      return res.status(429).json({ error: "Code already sent. Try again in a minute." });
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
    res.json({ message: "If that email is registered, a reset code has been sent." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send reset code, try again later" });
  }
});

// ---------- FORGOT PASSWORD: verify code and set new password ----------
app.post("/api/reset-password", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const { otp, password } = req.body;
  if (!email || !otp || !password) {
    return res.status(400).json({ error: "Email, code and new password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  try {
    const o = await db.query("SELECT code_hash, expires_at, attempts FROM email_otps WHERE email = $1", [email]);
    const row = o.rows[0];
    if (!row || new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: "Code expired. Please request a new one." });
    }
    if (row.attempts >= 5) {
      return res.status(429).json({ error: "Too many wrong attempts. Request a new code." });
    }
    const ok = await bcrypt.compare(String(otp).trim(), row.code_hash);
    if (!ok) {
      await db.query("UPDATE email_otps SET attempts = attempts + 1 WHERE email = $1", [email]);
      return res.status(400).json({ error: "Wrong code, please check again" });
    }
    const hash = await bcrypt.hash(password, 10);
    const upd = await db.query("UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id, name", [hash, email]);
    if (upd.rowCount === 0) return res.status(404).json({ error: "Account not found" });
    await db.query("DELETE FROM email_otps WHERE email = $1", [email]);
    const user = upd.rows[0];
    const token = jwt.sign({ id: user.id, name: user.name }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ message: "Password changed!", token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not reset password, try again" });
  }
});

// ---------- PUSH: public key, subscribe, unsubscribe ----------
// ---------- SELF-PING (keeps free server awake, no email, no account) ----------
// Render deta hai RENDER_EXTERNAL_URL. Har 14 min server khud ko chhuta hai taaki na soye.
app.get("/healthz", (req, res) => res.send("ok"));
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL + "/healthz").catch(() => {});
  }, 14 * 60 * 1000);
  console.log("Self-ping enabled:", SELF_URL);
}

app.post("/api/push-token", authCheck, async (req, res) => {
  const t = String(req.body.expo_token || "").trim();
  if (!t) return res.status(400).json({ error: "No token" });
  try {
    await db.query(
      `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, expo_token)
       VALUES ($1, $2, 'expo', 'expo', $3)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, expo_token = EXCLUDED.expo_token`,
      [req.user.id, "expo:" + t, t]
    );
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not save token" }); }
});

// Notification ke "Decline" button se call kaatna (app band ho tab bhi)
app.post("/api/call/decline", authCheck, async (req, res) => {
  try {
    const from = req.body.from_user;
    if (!from || !(await isMatch(req.user.id, from))) return res.status(400).json({ error: "Invalid call" });
    const pc = pendingCalls.get(String(req.user.id));
    if (pc && String(pc.from_user) === String(from)) pendingCalls.delete(String(req.user.id));
    io.to("user:" + from).emit("call:declined", { from_user: req.user.id, to_user: from });
    await logCall(from, req.user.id, "declined", 0);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not decline" }); }
});

// SAATHLY_PROFILE_FIELDS: naye profile columns (pehle se hon to kuch nahi hota)
const PROFILE_OPTIONS = {
  gender: ["Male", "Female", "Non-binary", "Prefer not to say"],
  interested_in: ["Men", "Women", "Everyone"],
  occupation: ["Job", "Business", "Student", "Freelancer", "Homemaker", "Looking for work"],
  education: ["School", "Graduate", "Post-graduate", "PhD", "Other"],
};
async function ensureProfileColumns() {
  try {
    await db.query(`ALTER TABLE users
      ADD COLUMN IF NOT EXISTS occupation TEXT,
      ADD COLUMN IF NOT EXISTS education TEXT,
      ADD COLUMN IF NOT EXISTS interested_in TEXT,
      ADD COLUMN IF NOT EXISTS interests TEXT,
      ADD COLUMN IF NOT EXISTS bio TEXT`);
    console.log("Profile columns ready");
  } catch (err) { console.error("ensureProfileColumns:", err.message); setTimeout(ensureProfileColumns, 5000); }
}
setTimeout(ensureProfileColumns, 2000);

// Kisi match ki profile dekhna (email kabhi nahi dikhta)
app.get("/api/users/:id", authCheck, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Galat user" });
  try {
    if (id !== req.user.id && !(await isMatch(req.user.id, id))) return res.status(403).json({ error: "Sirf apne match ki profile dekh sakte ho" });
    const r = await db.query(
      "SELECT id, name, age, gender, city, job, languages, intent, prompt_question, prompt_answer, photo_url, last_seen, occupation, education, interested_in, interests, bio FROM users WHERE id = $1",
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Ye user exist nahi karta" });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: "Profile nahi mili" }); }
});

// SAATHLY_VIDEO_STORY: phone seedha Cloudinary par video bhejta hai, server sirf signature deta hai
async function ensureStatusVideo() {
  try { await db.query("ALTER TABLE statuses ADD COLUMN IF NOT EXISTS video_url TEXT"); console.log("Status video column ready"); }
  catch (err) { console.error("ensureStatusVideo:", err.message); setTimeout(ensureStatusVideo, 5000); }
}
setTimeout(ensureStatusVideo, 2500);

app.get("/api/video-sign", authCheck, (req, res) => {
  if (!photosEnabled) return res.status(503).json({ error: "Video upload is not set up on the server yet" });
  try {
    const cfg = cloudinary.config();
    const timestamp = Math.round(Date.now() / 1000);
    const folder = "saath/status";
    const signature = cloudinary.utils.api_sign_request({ folder, timestamp }, cfg.api_secret);
    res.json({ cloud_name: cfg.cloud_name, api_key: cfg.api_key, timestamp, folder, signature });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not prepare video upload" }); }
});

// SAATHLY_DISTANCE: shahar ke beech ke point se andaazan doori. Kisi ki asli location kabhi nahi li jaati.
const CITY_COORDS = {
  "Agra":[27.18,78.01],"Ahmedabad":[23.02,72.57],"Ajmer":[26.45,74.64],"Aligarh":[27.88,78.08],"Amritsar":[31.63,74.87],
  "Asansol":[23.68,86.98],"Aurangabad":[19.88,75.34],"Bareilly":[28.37,79.43],"Belagavi":[15.85,74.50],"Bengaluru":[12.97,77.59],
  "Bhagalpur":[25.25,86.99],"Bhopal":[23.26,77.41],"Bhubaneswar":[20.30,85.82],"Bikaner":[28.02,73.31],"Chandigarh":[30.73,76.78],
  "Chennai":[13.08,80.27],"Coimbatore":[11.02,76.96],"Darbhanga":[26.15,85.90],"Dehradun":[30.32,78.03],"Delhi":[28.61,77.21],
  "Dhanbad":[23.80,86.43],"Durgapur":[23.52,87.31],"Faridabad":[28.41,77.32],"Gaya":[24.79,85.00],"Ghaziabad":[28.67,77.45],
  "Goa":[15.49,73.83],"Gorakhpur":[26.76,83.37],"Gurugram":[28.46,77.03],"Guwahati":[26.14,91.74],"Gwalior":[26.22,78.18],
  "Haridwar":[29.95,78.16],"Hisar":[29.15,75.72],"Hubballi":[15.36,75.12],"Hyderabad":[17.39,78.49],"Indore":[22.72,75.86],
  "Jabalpur":[23.18,79.99],"Jaipur":[26.91,75.79],"Jalandhar":[31.33,75.58],"Jammu":[32.73,74.86],"Jamshedpur":[22.80,86.20],
  "Jodhpur":[26.24,73.02],"Kanpur":[26.45,80.33],"Karnal":[29.69,76.99],"Kochi":[9.93,76.27],"Kolkata":[22.57,88.36],
  "Kota":[25.21,75.86],"Lucknow":[26.85,80.95],"Ludhiana":[30.90,75.86],"Madurai":[9.93,78.12],"Mangaluru":[12.91,74.86],
  "Meerut":[28.98,77.71],"Moradabad":[28.84,78.77],"Mumbai":[19.08,72.88],"Muzaffarpur":[26.12,85.39],"Mysuru":[12.30,76.64],
  "Nagpur":[21.15,79.09],"Nashik":[20.00,73.79],"Navi Mumbai":[19.03,73.03],"Noida":[28.54,77.39],"Panipat":[29.39,76.97],
  "Patna":[25.59,85.14],"Prayagraj":[25.44,81.85],"Puducherry":[11.94,79.81],"Pune":[18.52,73.86],"Raipur":[21.25,81.63],
  "Rajkot":[22.30,70.80],"Ranchi":[23.34,85.31],"Rishikesh":[30.09,78.27],"Rohtak":[28.90,76.61],"Shimla":[31.10,77.17],
  "Siliguri":[26.73,88.40],"Sohna":[28.25,77.07],"Solapur":[17.66,75.91],"Sonipat":[28.99,77.02],"Srinagar":[34.08,74.80],
  "Surat":[21.17,72.83],"Thane":[19.22,72.98],"Thiruvananthapuram":[8.52,76.94],"Tiruchirappalli":[10.79,78.70],"Udaipur":[24.59,73.71],
  "Vadodara":[22.31,73.18],"Varanasi":[25.32,82.97],"Vijayawada":[16.51,80.65],"Visakhapatnam":[17.69,83.22]
};
function cityCoords(name) {
  if (!name) return null;
  const key = Object.keys(CITY_COORDS).find(k => k.toLowerCase() === String(name).trim().toLowerCase());
  return key ? CITY_COORDS[key] : null;
}
async function ensureDistanceColumns() {
  try {
    await db.query(`ALTER TABLE users
      ADD COLUMN IF NOT EXISTS fav_destination TEXT,
      ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`);
    // purane users: unke shahar se point bhar do
    const r = await db.query("SELECT id, city FROM users WHERE lat IS NULL AND city IS NOT NULL AND city <> ''");
    for (const u of r.rows) { const c = cityCoords(u.city); if (c) await db.query("UPDATE users SET lat=$1, lng=$2 WHERE id=$3", [c[0], c[1], u.id]); }
    console.log("Distance columns ready");
  } catch (err) { console.error("ensureDistanceColumns:", err.message); setTimeout(ensureDistanceColumns, 5000); }
}
setTimeout(ensureDistanceColumns, 3000);
app.get("/api/cities", (req, res) => res.json(Object.keys(CITY_COORDS)));

// SAATHLY_LIKES: jinhone mujhe like kiya, aur maine abhi tak jawab nahi diya
app.get("/api/likes-me", authCheck, async (req, res) => {
  try {
    const me = (await db.query("SELECT lat, lng, loc_source FROM users WHERE id = $1", [req.user.id])).rows[0] || {};
    const r = await db.query(
      `SELECT u.id, u.name, u.age, u.gender, u.city, u.photo_url, u.occupation, u.education, u.interests, u.bio, u.fav_destination, u.intent,
              (u.loc_source = 'gps' AND $4::text = 'gps') AS dist_gps,
              CASE WHEN $2::float8 IS NULL OR u.lat IS NULL OR u.hide_distance IS TRUE THEN NULL
                   ELSE ROUND((6371 * acos(LEAST(1, GREATEST(-1,
                        cos(radians($2::float8)) * cos(radians(u.lat)) * cos(radians(u.lng) - radians($3::float8)) +
                        sin(radians($2::float8)) * sin(radians(u.lat))))))::numeric, 0) END AS distance_km
       FROM swipes s
       JOIN users u ON u.id = s.from_user
       WHERE s.to_user = $1 AND s.action = 'like'
         AND NOT EXISTS (SELECT 1 FROM swipes mine WHERE mine.from_user = $1 AND mine.to_user = s.from_user)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker = $1 AND b.blocked = u.id) OR (b.blocker = u.id AND b.blocked = $1))
       ORDER BY u.id DESC
       LIMIT 100`,
      [req.user.id, me.lat == null ? null : me.lat, me.lng == null ? null : me.lng, me.loc_source || null]
    );
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not load likes" }); }
});

// SAATHLY_GEO: phone ki approximate location, ~1 km grid par gol karke. Exact point kabhi save nahi hota,
// aur kisi doosre user ko coordinates kabhi nahi bheje jaate (sirf doori).
async function ensureGeoColumns() {
  try {
    await db.query(`ALTER TABLE users
      ADD COLUMN IF NOT EXISTS loc_source TEXT,
      ADD COLUMN IF NOT EXISTS loc_updated_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS hide_distance BOOLEAN DEFAULT FALSE`);
    console.log("Geo columns ready");
  } catch (err) { console.error("ensureGeoColumns:", err.message); setTimeout(ensureGeoColumns, 5000); }
}
setTimeout(ensureGeoColumns, 3500);
app.post("/api/location", authCheck, async (req, res) => {
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: "Invalid location" });
  const r2 = (x) => Math.round(x * 100) / 100; // ~1.1 km grid
  try {
    await db.query("UPDATE users SET lat=$1, lng=$2, loc_source='gps', loc_updated_at=NOW() WHERE id=$3", [r2(lat), r2(lng), req.user.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not save location" }); }
});

// SAATHLY_TURN: call ke liye ICE servers. Cloudflare TURN key sirf server par rehti hai;
// app/web ko sirf kuch ghante chalne wale credentials milte hain. Key na ho to sirf STUN.
const FALLBACK_ICE = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
app.get("/api/ice", authCheck, async (req, res) => {
  const kid = process.env.CLOUDFLARE_TURN_KEY_ID, tok = process.env.CLOUDFLARE_TURN_KEY_TOKEN;
  if (!kid || !tok) return res.json({ iceServers: FALLBACK_ICE, turn: false });
  try {
    const r = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + kid + "/credentials/generate", {
      method: "POST",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 4 * 3600 }),
    });
    const d = await r.json();
    let list = Array.isArray(d.iceServers) ? d.iceServers : d.iceServers ? [d.iceServers] : [];
    // port 53 browsers block karte hain, use hata do
    list = list.map(s => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => !/:53(\?|$)/.test(u)) })).filter(s => s.urls.length);
    if (!r.ok || !list.length) throw new Error("bad turn response " + r.status);
    res.json({ iceServers: list, turn: true });
  } catch (err) { console.error("TURN:", err.message); res.json({ iceServers: FALLBACK_ICE, turn: false }); }
});

app.get("/api/push/key", (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC || "", enabled: pushEnabled });
});

app.post("/api/push/subscribe", authCheck, async (req, res) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: "Invalid subscription" });
  try {
    await db.query(
      `INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save subscription" });
  }
});

// ---------- PUSH TEST (apne aap ko ek push bhejo, debugging ke liye) ----------
app.post("/api/push/test", authCheck, async (req, res) => {
  if (!pushEnabled) return res.json({ ok: false, reason: "pushEnabled is false (VAPID keys missing on server)" });
  try {
    const subs = await db.query("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = $1", [req.user.id]);
    if (subs.rowCount === 0) return res.json({ ok: false, reason: "No subscription saved for your user id " + req.user.id });
    const results = [];
    for (const srow of subs.rows) {
      const sub = { endpoint: srow.endpoint, keys: { p256dh: srow.p256dh, auth: srow.auth } };
      try {
        await webpush.sendNotification(sub, JSON.stringify({ title: "Saath test", body: "If you see this, push works!", url: "/" }));
        results.push({ endpoint: srow.endpoint.slice(0, 40), status: "SENT" });
      } catch (err) {
        results.push({ endpoint: srow.endpoint.slice(0, 40), status: "FAILED", code: err.statusCode, message: String(err.message || err).slice(0, 200) });
      }
    }
    res.json({ ok: true, count: subs.rowCount, results });
  } catch (err) {
    res.json({ ok: false, reason: String(err.message || err).slice(0, 200) });
  }
});

// ---------- MERI PROFILE ----------
app.get("/api/me", authCheck, async (req, res) => {
  try {
    const r = await db.query(
      "SELECT id, name, email, age, gender, city, job, languages, intent, prompt_question, prompt_answer, photo_url, occupation, education, interested_in, interests, bio, fav_destination, hide_distance, loc_source FROM users WHERE id = $1",
      [req.user.id]
    );
    res.json(r.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load your profile" });
  }
});

// ---------- UPDATE MY PROFILE ----------
app.put("/api/me", authCheck, async (req, res) => {
  const { name, city, job, languages, intent, prompt_question, prompt_answer } = req.body;
  if (name !== undefined && (!name.trim() || name.trim().length > 50)) {
    return res.status(400).json({ error: "Name must be 1 to 50 characters" });
  }
  const allowedIntents = ["Long-term relationship", "Marriage", "Friendship", "Figuring it out"];
  if (intent !== undefined && intent && !allowedIntents.includes(intent)) {
    return res.status(400).json({ error: "Please choose a valid option for what you're looking for" });
  }
  try {
    // naye profile fields (dropdown wale sirf list me se)
    {
      const b = req.body;
      for (const k of ["gender", "interested_in", "occupation", "education"]) {
        if (b[k] !== undefined && b[k] !== "" && b[k] !== null && !PROFILE_OPTIONS[k].includes(b[k])) {
          return res.status(400).json({ error: "Galat option: " + k });
        }
      }
      const clip = (v, n) => (v === undefined || v === null ? null : String(v).trim().slice(0, n));
      await db.query(
        `UPDATE users SET gender = COALESCE($1, gender), interested_in = COALESCE($2, interested_in), occupation = COALESCE($3, occupation),
           education = COALESCE($4, education), interests = COALESCE($5, interests), bio = COALESCE($6, bio) WHERE id = $7`,
        [clip(b.gender, 30), clip(b.interested_in, 30), clip(b.occupation, 40), clip(b.education, 40), clip(b.interests, 200), clip(b.bio, 300), req.user.id]
      );
      if (b.fav_destination !== undefined) await db.query("UPDATE users SET fav_destination=$1 WHERE id=$2", [clip(b.fav_destination, 60), req.user.id]);
      if (b.city !== undefined) { const c = cityCoords(b.city); await db.query("UPDATE users SET lat=$1, lng=$2 WHERE id=$3 AND (loc_source IS NULL OR loc_source <> 'gps')", [c ? c[0] : null, c ? c[1] : null, req.user.id]); }
      if (b.hide_distance !== undefined) await db.query("UPDATE users SET hide_distance=$1 WHERE id=$2", [!!b.hide_distance, req.user.id]);
    }
    const r = await db.query(
      `UPDATE users SET
         name = COALESCE($1, name),
         city = COALESCE($2, city),
         job = COALESCE($3, job),
         languages = COALESCE($4, languages),
         intent = COALESCE($5, intent),
         prompt_question = COALESCE($6, prompt_question),
         prompt_answer = COALESCE($7, prompt_answer)
       WHERE id = $8
       RETURNING id, name, email, age, gender, city, job, languages, intent, prompt_question, prompt_answer, photo_url`,
      [
        name !== undefined ? name.trim() : null,
        city !== undefined ? city.trim() : null,
        job !== undefined ? job.trim() : null,
        languages !== undefined ? languages.trim() : null,
        intent !== undefined ? (intent || null) : null,
        prompt_question !== undefined ? prompt_question.trim() : null,
        prompt_answer !== undefined ? prompt_answer.trim() : null,
        req.user.id
      ]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save your profile, please try again" });
  }
});

// ---------- DELETE MY ACCOUNT ----------
// ON DELETE CASCADE ki wajah se iske saath hi swipes, messages, blocks, reports, calls bhi hat jayenge.
app.delete("/api/me", authCheck, async (req, res) => {
  try {
    await db.query("DELETE FROM users WHERE id = $1", [req.user.id]);
    res.json({ message: "Your account and all your data have been deleted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete your account, please try again" });
  }
});

// ---------- CHAT IMAGE UPLOAD ----------
// SAATHLY_B64_UPLOAD: app photo ko base64 me bhejta hai (JSON), use file jaisa bana do
function b64File(req) {
  try {
    if (req.file || !req.body || !req.body.photo_base64) return;
    const b64 = String(req.body.photo_base64).replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(b64, "base64");
    if (!buffer.length || buffer.length > 10 * 1024 * 1024) return;
    req.file = { mimetype: String(req.body.photo_mime || "image/jpeg"), buffer, size: buffer.length };
  } catch (e) {}
}

app.post("/api/chat-image", authCheck, (req, res) => {
  if (!photosEnabled) return res.status(503).json({ error: "Image upload is not set up on the server yet" });
  upload.single("photo")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message }); b64File(req);
    if (!req.file) return res.status(400).json({ error: "No image received" });
    try {
      const dataUri = "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");
      const result = await cloudinary.uploader.upload(dataUri, {
        folder: "saath/chat",
        transformation: [{ width: 1200, crop: "limit" }, { quality: "auto" }]
      });
      res.json({ image_url: result.secure_url });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Image upload failed, please try again" });
    }
  });
});

// ---------- PHOTO UPLOAD ----------
app.post("/api/photo", authCheck, (req, res) => {
  if (!photosEnabled) {
    return res.status(503).json({ error: "Photo upload is not set up on the server yet" });
  }
  upload.single("photo")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message }); b64File(req);
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

// ---------- STATUS / STORY ----------
// Apna status daalo (text ya photo). Photo ke liye Cloudinary wahi reuse.
app.post("/api/status", authCheck, (req, res) => {
  upload.single("photo")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message }); b64File(req);
    const text = (req.body.text || "").trim();
    let videoUrl = null;
    try {
      const cn = cloudinary.config().cloud_name;
      const v = typeof req.body.video_url === "string" ? req.body.video_url : "";
      if (v && cn && v.startsWith("https://res.cloudinary.com/" + cn + "/video/")) videoUrl = v;
    } catch (e) {}
    if (!text && !req.file && !videoUrl) return res.status(400).json({ error: "Add some text or a photo" });
    if (text.length > 300) return res.status(400).json({ error: "Status text is too long" });
    try {
      let photoUrl = null;
      if (req.file) {
        if (!photosEnabled) return res.status(503).json({ error: "Photo status is not set up on the server yet" });
        const dataUri = "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");
        const up = await cloudinary.uploader.upload(dataUri, { folder: "saath/status", transformation: [{ width: 1080, crop: "limit" }, { quality: "auto" }] });
        photoUrl = up.secure_url;
      }
      const r = await db.query(
        "INSERT INTO statuses (user_id, text, photo_url, video_url) VALUES ($1, $2, $3, $4) RETURNING id, text, photo_url, video_url, created_at",
        [req.user.id, text || null, photoUrl, videoUrl]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Could not post your status, please try again" });
    }
  });
});

// Apne aur matches ke status dekho (sirf pichhle 24 ghante ke)
app.get("/api/status", authCheck, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT s.id, s.user_id, s.text, s.photo_url, s.video_url, s.created_at,
              u.name, u.photo_url AS user_photo,
              (s.user_id = $1) AS mine,
              CASE WHEN s.user_id = $1
                   THEN (SELECT COUNT(*) FROM status_views v WHERE v.status_id = s.id)
                   ELSE 0 END AS view_count
       FROM statuses s
       JOIN users u ON u.id = s.user_id
       WHERE s.created_at > NOW() - INTERVAL '24 hours'
         AND (
           s.user_id = $1
           OR s.user_id IN (
             SELECT a.to_user FROM swipes a
             JOIN swipes b ON a.from_user = b.to_user AND a.to_user = b.from_user
             WHERE a.from_user = $1 AND a.action='like' AND b.action='like'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM blocks
           WHERE (blocker=$1 AND blocked=s.user_id) OR (blocker=s.user_id AND blocked=$1)
         )
       ORDER BY mine DESC, s.created_at DESC`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load statuses" });
  }
});

// Apna status hatao
app.delete("/api/status/:id", authCheck, async (req, res) => {
  try {
    await db.query("DELETE FROM statuses WHERE id = $1 AND user_id = $2", [Number(req.params.id), req.user.id]);
    res.json({ message: "Status removed" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not remove status" });
  }
});

// Status dekha: ek view record karo (apne hi status par view nahi ginte)
app.post("/api/status/:id/view", authCheck, async (req, res) => {
  const statusId = Number(req.params.id);
  try {
    const own = await db.query("SELECT 1 FROM statuses WHERE id = $1 AND user_id = $2", [statusId, req.user.id]);
    if (own.rowCount === 0) {
      await db.query(
        "INSERT INTO status_views (status_id, viewer) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [statusId, req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.json({ ok: false });
  }
});

// Mere status ko kisne dekha (sirf status ka maalik dekh sakta hai)
app.get("/api/status/:id/viewers", authCheck, async (req, res) => {
  const statusId = Number(req.params.id);
  try {
    const own = await db.query("SELECT 1 FROM statuses WHERE id = $1 AND user_id = $2", [statusId, req.user.id]);
    if (own.rowCount === 0) return res.status(403).json({ error: "Not your status" });
    const r = await db.query(
      `SELECT u.id, u.name, u.photo_url, v.created_at
       FROM status_views v JOIN users u ON u.id = v.viewer
       WHERE v.status_id = $1 ORDER BY v.created_at DESC`,
      [statusId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load viewers" });
  }
});

// ---------- PROFILES ----------
app.get("/api/profiles", authCheck, async (req, res) => {
  try {
    const meRow = (await db.query("SELECT lat, lng, interested_in, loc_source FROM users WHERE id = $1", [req.user.id])).rows[0] || {};
    const wantGender = meRow.interested_in === "Men" ? "Male" : meRow.interested_in === "Women" ? "Female" : null;
    const qi = (v) => { const n = parseInt(v, 10); return isFinite(n) && n > 0 ? n : null; };
    const fMin = qi(req.query.min_age), fMax = qi(req.query.max_age), fKm = qi(req.query.max_km);
    const fInt = req.query.interest ? String(req.query.interest).slice(0, 30) : null;
    const result = await db.query(
      `SELECT id, name, age, gender, city, job, languages, intent, prompt_question, prompt_answer, photo_url, occupation, education, interested_in, interests, bio, fav_destination,
              (loc_source = 'gps' AND $5::text = 'gps') AS dist_gps,
              CASE WHEN $2::float8 IS NULL OR lat IS NULL OR hide_distance IS TRUE THEN NULL
                   ELSE ROUND((6371 * acos(LEAST(1, GREATEST(-1,
                        cos(radians($2::float8)) * cos(radians(lat)) * cos(radians(lng) - radians($3::float8)) +
                        sin(radians($2::float8)) * sin(radians(lat))))))::numeric, 0) END AS distance_km
       FROM users
       WHERE id <> $1
         AND ($4::text IS NULL OR gender = $4::text OR gender IS NULL)
         AND ($6::int IS NULL OR age >= $6::int)
         AND ($7::int IS NULL OR age <= $7::int)
         AND ($8::text IS NULL OR interests ILIKE '%' || $8::text || '%')
         AND id NOT IN (SELECT to_user FROM swipes WHERE from_user = $1)
         AND id NOT IN (SELECT blocked FROM blocks WHERE blocker = $1)
         AND id NOT IN (SELECT blocker FROM blocks WHERE blocked = $1)
       ORDER BY distance_km ASC NULLS LAST, id`,
      [req.user.id, meRow.lat == null ? null : meRow.lat, meRow.lng == null ? null : meRow.lng, wantGender, meRow.loc_source || null, fMin, fMax, fInt]
    );
    res.json(fKm ? result.rows.filter(r => r.distance_km !== null && Number(r.distance_km) <= fKm) : result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database se data nahi mila" });
  }
});

// ---------- SEARCH PEOPLE ----------
// Sirf apne matches mein search karo (safe).
app.get("/api/search", authCheck, async (req, res) => {
  const q = String(req.query.q || "").trim();
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.age, u.city, u.photo_url
       FROM swipes a
       JOIN swipes b ON a.from_user = b.to_user AND a.to_user = b.from_user
       JOIN users u ON u.id = a.to_user
       WHERE a.from_user = $1 AND a.action='like' AND b.action='like'
         AND ($2 = '' OR u.name ILIKE '%' || $2 || '%' OR u.city ILIKE '%' || $2 || '%')
         AND NOT EXISTS (
           SELECT 1 FROM blocks
           WHERE (blocker=$1 AND blocked=u.id) OR (blocker=u.id AND blocked=$1)
         )
       ORDER BY u.name
       LIMIT 50`,
      [req.user.id, q]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not search" });
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

// ---------- PASSED LOGON KO WAPAS LAAO ----------
// Jinhe pass kiya tha, unke swipe hata do taaki wo Discover mein wapas aayein.
app.post("/api/undo-passes", authCheck, async (req, res) => {
  try {
    const r = await db.query("DELETE FROM swipes WHERE from_user = $1 AND action = 'pass'", [req.user.id]);
    res.json({ message: "Brought back " + r.rowCount + " people", count: r.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not bring back people" });
  }
});

// ---------- MATCHES ----------
app.get("/api/matches", authCheck, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.age, u.city, u.photo_url, u.last_seen,
              (SELECT MAX(created_at) FROM messages m
               WHERE (m.from_user = $1 AND m.to_user = u.id) OR (m.from_user = u.id AND m.to_user = $1)
              ) AS last_msg_at,
              -- SAATHLY_LAST_MSG: aakhri message ka text (photo ho to "📷 Photo") aur kisne bheja
              (SELECT COALESCE(NULLIF(m3.text, ''), CASE WHEN m3.image_url IS NOT NULL THEN '📷 Photo' END)
               FROM messages m3
               WHERE (m3.from_user = $1 AND m3.to_user = u.id) OR (m3.from_user = u.id AND m3.to_user = $1)
               ORDER BY m3.created_at DESC LIMIT 1
              ) AS last_msg,
              (SELECT m4.from_user FROM messages m4
               WHERE (m4.from_user = $1 AND m4.to_user = u.id) OR (m4.from_user = u.id AND m4.to_user = $1)
               ORDER BY m4.created_at DESC LIMIT 1
              ) AS last_msg_from,
              (SELECT COUNT(*) FROM messages m2
               WHERE m2.from_user = u.id AND m2.to_user = $1 AND m2.read_at IS NULL
              ) AS unread_count
       FROM swipes a
       JOIN swipes b ON a.from_user = b.to_user AND a.to_user = b.from_user
       JOIN users u ON u.id = a.to_user
       WHERE a.from_user = $1 AND a.action = 'like' AND b.action = 'like'
         AND NOT EXISTS (
           SELECT 1 FROM blocks
           WHERE (blocker = $1 AND blocked = u.id) OR (blocker = u.id AND blocked = $1)
         )
       ORDER BY last_msg_at DESC NULLS LAST, u.id DESC`,
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

// ---------- CALL HISTORY ----------
async function logCall(caller, callee, status, duration) {
  try {
    await db.query(
      "INSERT INTO calls (caller, callee, status, duration) VALUES ($1, $2, $3, $4)",
      [caller, callee, status, Math.max(0, Math.round(duration || 0))]
    );
    // Dono ko batao ki call list badli
    io.to("user:" + caller).emit("calls_updated");
    io.to("user:" + callee).emit("calls_updated");
  } catch (err) { console.error("logCall:", err); }
}

app.get("/api/calls", authCheck, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.caller, c.callee, c.status, c.duration, c.created_at,
              u.id AS other_id, u.name AS other_name, u.photo_url AS other_photo
       FROM calls c
       JOIN users u ON u.id = CASE WHEN c.caller = $1 THEN c.callee ELSE c.caller END
       WHERE c.caller = $1 OR c.callee = $1
       ORDER BY c.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    const rows = r.rows.map(x => ({
      id: x.id,
      direction: x.caller === req.user.id ? "out" : "in",
      status: x.status,
      duration: x.duration,
      created_at: x.created_at,
      other: { id: x.other_id, name: x.other_name, photo_url: x.other_photo }
    }));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load call history" });
  }
});

// ---------- GROUPS ----------
// member check helper
async function isGroupMember(groupId, userId) {
  const r = await db.query("SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
  return r.rowCount > 0;
}

// Create a group with some of my matches
app.post("/api/groups", authCheck, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const members = Array.isArray(req.body.members) ? req.body.members.map(Number).filter(Boolean) : [];
  if (!name || name.length > 80) return res.status(400).json({ error: "Group name is required (max 80 chars)" });
  try {
    // sirf apne matches ko add kar sakte ho
    const myMatches = await db.query(
      `SELECT a.to_user AS id FROM swipes a
       JOIN swipes b ON a.from_user=b.to_user AND a.to_user=b.from_user
       WHERE a.from_user=$1 AND a.action='like' AND b.action='like'`,
      [req.user.id]
    );
    const allowed = new Set(myMatches.rows.map(r => r.id));
    const validMembers = members.filter(id => allowed.has(id));

    const g = await db.query("INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id, name", [name, req.user.id]);
    const groupId = g.rows[0].id;
    // creator + valid members add karo
    const toAdd = [req.user.id, ...validMembers];
    for (const uid of toAdd) {
      await db.query("INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [groupId, uid]);
    }
    res.status(201).json({ id: groupId, name: g.rows[0].name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create group" });
  }
});

// My groups list
app.get("/api/groups", authCheck, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT g.id, g.name,
              (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) AS member_count,
              (SELECT text FROM group_messages gm WHERE gm.group_id=g.id ORDER BY created_at DESC LIMIT 1) AS last_text
       FROM groups g
       JOIN group_members gm ON gm.group_id=g.id
       WHERE gm.user_id=$1
       ORDER BY g.id DESC`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load groups" });
  }
});

// Group messages (history) + members
app.get("/api/groups/:id", authCheck, async (req, res) => {
  const groupId = Number(req.params.id);
  try {
    if (!(await isGroupMember(groupId, req.user.id))) return res.status(403).json({ error: "You are not in this group" });
    const g = await db.query("SELECT id, name FROM groups WHERE id=$1", [groupId]);
    const members = await db.query(
      "SELECT u.id, u.name, u.photo_url FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1",
      [groupId]
    );
    const msgs = await db.query(
      `SELECT gm.id, gm.from_user, gm.text, gm.created_at, u.name AS from_name, u.photo_url AS from_photo
       FROM group_messages gm JOIN users u ON u.id=gm.from_user
       WHERE gm.group_id=$1 ORDER BY gm.created_at`,
      [groupId]
    );
    res.json({ group: g.rows[0], members: members.rows, messages: msgs.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load group" });
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
      `SELECT id, from_user, to_user, text, image_url, created_at, delivered_at, read_at FROM messages
       WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
       ORDER BY created_at`,
      [req.user.id, otherId]
    );
    // Jo unhone bheje aur maine ab khole, unhe read maark karo
    const readIds = await db.query(
      `UPDATE messages SET read_at = NOW()
       WHERE to_user = $1 AND from_user = $2 AND read_at IS NULL
       RETURNING id`,
      [req.user.id, otherId]
    );
    if (readIds.rowCount > 0) {
      io.to("user:" + otherId).emit("messages_read", { by_user: req.user.id, ids: readIds.rows.map(r => r.id) });
    }
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

// Kisi user ke saare matches ko ek event bhejo (online/offline/typing)
async function notifyMatches(userId, event, payload) {
  try {
    const r = await db.query(
      `SELECT u.id FROM swipes a
       JOIN swipes b ON a.from_user = b.to_user AND a.to_user = b.from_user
       JOIN users u ON u.id = a.to_user
       WHERE a.from_user = $1 AND a.action='like' AND b.action='like'`,
      [userId]
    );
    r.rows.forEach(row => io.to("user:" + row.id).emit(event, payload));
  } catch (err) { console.error(err); }
}

// SAATHLY_PENDING_CALLS: jab callee ka app band ho, call 45 sec tak yaad rakho
const pendingCalls = new Map();

io.on("connection", async (socket) => {
  // Har user ka apna "kamra", taaki message sirf usi tak jaye
  socket.join("user:" + socket.user.id);

  // Is user ke liye koi call intezaar kar rahi thi? (notification dabakar app khola)
  {
    const pc = pendingCalls.get(String(socket.user.id));
    if (pc) {
      pendingCalls.delete(String(socket.user.id));
      if (Date.now() - pc.at < 45000) {
        setTimeout(() => {
          socket.emit("call:incoming", { from_user: pc.from_user, from_name: pc.from_name, sdp: pc.sdp, video: pc.video });
          pc.ice.forEach(c => socket.emit("call:ice", { from_user: pc.from_user, to_user: socket.user.id, candidate: c }));
        }, 800);
      }
    }
  }

  // Online ho gaye: apne matches ko batao
  notifyMatches(socket.user.id, "presence", { user_id: socket.user.id, online: true });

  socket.on("disconnect", async () => {
    // Agar isi user ki koi aur tab/phone abhi bhi khuli hai, to offline mat dikhao
    const still = await io.in("user:" + socket.user.id).fetchSockets();
    if (still.length > 0) return;
    const now = new Date();
    try { await db.query("UPDATE users SET last_seen = $1 WHERE id = $2", [now, socket.user.id]); } catch (e) {}
    notifyMatches(socket.user.id, "presence", { user_id: socket.user.id, online: false, last_seen: now });
  });

  // Doosra kaunse log abhi online hain, ye poochne ke liye
  socket.on("presence:check", async ({ user_id } = {}, reply = () => {}) => {
    try {
      const sockets = await io.in("user:" + user_id).fetchSockets();
      if (sockets.length > 0) return reply({ online: true });
      const r = await db.query("SELECT last_seen FROM users WHERE id = $1", [user_id]);
      reply({ online: false, last_seen: r.rows[0] ? r.rows[0].last_seen : null });
    } catch (e) { reply({ online: false }); }
  });

  // Typing indicator
  socket.on("typing", async ({ to_user, typing } = {}) => {
    try {
      if (!(await isMatch(socket.user.id, to_user))) return;
      io.to("user:" + to_user).emit("typing", { from_user: socket.user.id, typing: !!typing });
    } catch (e) {}
  });

  // ---------- VOICE CALL (WebRTC signaling) ----------
  // Awaaz seedha dono phones ke beech jaati hai. Server sirf "milane" ka kaam karta hai.
  socket.on("call:offer", async ({ to_user, sdp, video } = {}, reply = () => {}) => {
    try {
      if (!(await isMatch(socket.user.id, to_user))) {
        return reply({ error: "Sirf match ko call kar sakte ho" });
      }
      if (await isDemoUser(to_user)) {
        return reply({ error: "Ye demo profile hai, call nahi utha sakti. Kisi asli match ko call karo." });
      }
      const online = await io.in("user:" + to_user).fetchSockets();
      if (!online.length) {
        // App band/background: call yaad rakho aur notification bhejo
        pendingCalls.set(String(to_user), { from_user: socket.user.id, from_name: socket.user.name, sdp, video: !!video, ice: [], at: Date.now() });
        sendExpoData(to_user, { type: "call", from_user: socket.user.id, from_name: socket.user.name || "Saathly", video: !!video }, 40);
        return reply({ ok: true, pending: true });
      }
      io.to("user:" + to_user).emit("call:incoming", {
        from_user: socket.user.id,
        from_name: socket.user.name,
        sdp,
        video: !!video
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
        if (inEvent === "call:ice") {
          const pc = pendingCalls.get(String(data.to_user));
          if (pc && String(pc.from_user) === String(socket.user.id)) { pc.ice.push(data.candidate); return; }
        }
        io.to("user:" + data.to_user).emit(outEvent, { ...data, from_user: socket.user.id });
      } catch (err) {
        console.error(err);
      }
    });
  }
  relay("call:answer", "call:answered");
  relay("call:ice", "call:ice");

  // Call end: aage bhejo aur history mein likho (sirf caller ki taraf se, taaki ek hi entry bane)
  socket.on("call:end", async (data = {}) => {
    try {
      if (!(await isMatch(socket.user.id, data.to_user))) return;
      {
        const pc = pendingCalls.get(String(data.to_user));
        if (pc && String(pc.from_user) === String(socket.user.id)) {
          pendingCalls.delete(String(data.to_user));
          sendExpoPush(data.to_user, { title: "Missed call", body: (socket.user.name || "Someone") + " ne call kiya tha", data: { type: "missed_call" } });
        }
      }
      io.to("user:" + data.to_user).emit("call:ended", { ...data, from_user: socket.user.id });
      if (data.role === "caller") {
        const answered = data.answered ? "answered" : "missed";
        await logCall(socket.user.id, data.to_user, answered, data.duration);
      }
    } catch (err) { console.error(err); }
  });

  // Call decline: aage bhejo aur "declined" likho (caller ke naam se)
  socket.on("call:decline", async (data = {}) => {
    try {
      if (!(await isMatch(socket.user.id, data.to_user))) return;
      io.to("user:" + data.to_user).emit("call:declined", { ...data, from_user: socket.user.id });
      // socket.user ne decline kiya, matlab caller wo doosra hai
      await logCall(data.to_user, socket.user.id, "declined", 0);
    } catch (err) { console.error(err); }
  });

  // ---------- GROUP: join room + send ----------
  socket.on("group:join", async ({ group_id } = {}) => {
    try {
      const r = await db.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2", [group_id, socket.user.id]);
      if (r.rowCount > 0) socket.join("group:" + group_id);
    } catch (e) {}
  });
  socket.on("group:leave_room", ({ group_id } = {}) => { socket.leave("group:" + group_id); });
  socket.on("group:send", async ({ group_id, text } = {}, reply = () => {}) => {
    text = String(text || "").trim();
    if (!text || text.length > 1000) return reply({ error: "Message khaali ya bahut lamba hai" });
    try {
      const r = await db.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2", [group_id, socket.user.id]);
      if (r.rowCount === 0) return reply({ error: "You are not in this group" });
      const ins = await db.query(
        "INSERT INTO group_messages (group_id, from_user, text) VALUES ($1,$2,$3) RETURNING id, from_user, text, created_at",
        [group_id, socket.user.id, text]
      );
      const msg = { ...ins.rows[0], from_name: socket.user.name, group_id };
      io.to("group:" + group_id).emit("group:new_message", msg);
      reply({ ok: true, message: msg });
    } catch (err) {
      console.error(err);
      reply({ error: "Message not sent" });
    }
  });

  // Apna message delete karo (sirf bhejne wala, dono taraf se hat jaye)
  socket.on("delete_message", async ({ message_id } = {}, reply = () => {}) => {
    try {
      const r = await db.query(
        "SELECT from_user, to_user FROM messages WHERE id = $1",
        [message_id]
      );
      const m = r.rows[0];
      if (!m || m.from_user !== socket.user.id) return reply({ error: "Not allowed" });
      await db.query("UPDATE messages SET text = '', image_url = NULL WHERE id = $1", [message_id]);
      io.to("user:" + m.to_user).emit("message_deleted", { message_id });
      io.to("user:" + m.from_user).emit("message_deleted", { message_id });
      reply({ ok: true });
    } catch (err) {
      console.error(err);
      reply({ error: "Could not delete" });
    }
  });

  // Chat khuli ho aur naya message aaye to turant "read" batao
  socket.on("mark_read", async ({ from_user } = {}) => {
    try {
      const r = await db.query(
        `UPDATE messages SET read_at = NOW()
         WHERE to_user = $1 AND from_user = $2 AND read_at IS NULL
         RETURNING id`,
        [socket.user.id, from_user]
      );
      if (r.rowCount > 0) {
        io.to("user:" + from_user).emit("messages_read", { by_user: socket.user.id, ids: r.rows.map(x => x.id) });
      }
    } catch (err) { console.error(err); }
  });

  socket.on("send_message", async ({ to_user, text, image_url }, reply) => {
    text = String(text || "").trim();
    image_url = image_url ? String(image_url) : null;
    if (!text && !image_url) {
      return reply({ error: "Message khaali hai" });
    }
    if (text.length > 1000) {
      return reply({ error: "Message bahut lamba hai" });
    }
    try {
      if (!(await isMatch(socket.user.id, to_user))) {
        return reply({ error: "Sirf match ke saath chat kar sakte ho" });
      }
      const result = await db.query(
        "INSERT INTO messages (from_user, to_user, text, image_url) VALUES ($1, $2, $3, $4) RETURNING id, from_user, to_user, text, image_url, created_at",
        [socket.user.id, to_user, text, image_url]
      );
      const msg = result.rows[0];

      // Saamne wala online hai? To turant "delivered" maark karo
      const online = await io.in("user:" + to_user).fetchSockets();
      if (online.length > 0) {
        const d = await db.query("UPDATE messages SET delivered_at = NOW() WHERE id = $1 RETURNING delivered_at", [msg.id]);
        msg.delivered_at = d.rows[0].delivered_at;
      }

      io.to("user:" + to_user).emit("new_message", msg);
      reply({ ok: true, message: msg });

      // Push notification bhejo (app band ho to bhi aaye)
      sendPush(to_user, {
        title: socket.user.name || "New message",
        body: (text || "Photo").slice(0, 120),
        url: "/"
      });
      sendExpoPush(to_user, {
        title: socket.user.name || "New message",
        body: (text || "Photo").slice(0, 120),
        url: "/"
      });

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
    CREATE TABLE IF NOT EXISTS statuses (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      text TEXT,
      photo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS status_views (
      status_id INT REFERENCES statuses(id) ON DELETE CASCADE,
      viewer INT REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (status_id, viewer)
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url TEXT;
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      caller INT REFERENCES users(id) ON DELETE CASCADE,
      callee INT REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(12) NOT NULL,
      duration INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS push_subs (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS expo_token TEXT;
    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      created_by INT REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INT REFERENCES groups(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id SERIAL PRIMARY KEY,
      group_id INT REFERENCES groups(id) ON DELETE CASCADE,
      from_user INT REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
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
