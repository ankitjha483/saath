// saath service worker - minimal, makes the app installable
const CACHE = "saath-v1";
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => { self.clients.claim(); });
self.addEventListener("fetch", e => {
  // Network-first; just pass through. (Keeps app always fresh.)
  return;
});
