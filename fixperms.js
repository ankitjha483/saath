const fs = require("fs");
const p = "android/app/src/main/AndroidManifest.xml";
let m = fs.readFileSync(p, "utf8");

const oldLine = '    <uses-permission android:name="android.permission.INTERNET" />';
const newLines = `    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.VIBRATE" />`;

if (m.includes("POST_NOTIFICATIONS")) {
  console.log("already added!");
} else {
  m = m.replace(oldLine, newLines);
  fs.writeFileSync(p, m);
  console.log("permissions added!");
}
