// Ye script server.js mein Expo native push ka code jodta hai. Safe hai, baaki kuch nahi badalta.
const fs = require("fs");
const p = "server.js";
let s = fs.readFileSync(p, "utf8");

if (s.includes("sendExpoPush")) { console.log("Already added!"); process.exit(0); }

// 1) sendExpoPush helper -> sendPush function ke baad daalo
const marker1 = 'app.use(express.static("public"));';
const expoHelper = `// ---------- EXPO PUSH (native app notifications) ----------
async function sendExpoPush(userId, payload) {
  try {
    const subs = await db.query("SELECT expo_token FROM push_subs WHERE user_id = $1 AND expo_token IS NOT NULL", [userId]);
    const messages = subs.rows
      .filter(s => s.expo_token && String(s.expo_token).startsWith("ExponentPushToken"))
      .map(s => ({ to: s.expo_token, sound: "default", title: payload.title, body: payload.body, data: { url: payload.url || "/" } }));
    if (!messages.length) return;
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });
  } catch (err) { console.error("sendExpoPush:", err); }
}

`;
s = s.replace(marker1, expoHelper + marker1);

// 2) /api/push-token route -> push/key ke aas paas daalo
const marker2 = 'app.get("/api/push/key"';
const tokenRoute = `app.post("/api/push-token", authCheck, async (req, res) => {
  const t = String(req.body.expo_token || "").trim();
  if (!t) return res.status(400).json({ error: "No token" });
  try {
    await db.query(
      \`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, expo_token)
       VALUES ($1, $2, 'expo', 'expo', $3)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, expo_token = EXCLUDED.expo_token\`,
      [req.user.id, "expo:" + t, t]
    );
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not save token" }); }
});

`;
s = s.replace(marker2, tokenRoute + marker2);

// 3) send_message mein sendExpoPush call -> sendPush ke baad
const marker3 = `      sendPush(to_user, {
        title: socket.user.name || "New message",
        body: text.slice(0, 120),
        url: "/"
      });`;
const bothPush = marker3 + `
      sendExpoPush(to_user, {
        title: socket.user.name || "New message",
        body: (text || "Photo").slice(0, 120),
        url: "/"
      });`;
s = s.replace(marker3, bothPush);

// 4) expo_token column -> push_subs table ke baad ALTER
const marker4 = `    CREATE TABLE IF NOT EXISTS push_subs (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );`;
const withExpoCol = marker4 + `
    ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS expo_token TEXT;`;
s = s.replace(marker4, withExpoCol);

fs.writeFileSync(p, s);
console.log("Expo push added to server.js!");
console.log("sendExpoPush:", s.includes("sendExpoPush"));
console.log("push-token route:", s.includes("/api/push-token"));
console.log("expo_token column:", s.includes("expo_token TEXT"));
