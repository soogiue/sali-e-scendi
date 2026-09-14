// sw.js — service worker minimale per la PWA "Sali e Scendi".
// Obiettivi: rendere l'app installabile e far caricare la "shell" anche offline.
// Regole di sicurezza:
//   • intercetta SOLO richieste GET dello stesso dominio (mai Supabase/esm.sh);
//   • navigazioni HTML → network-first (così gli aggiornamenti arrivano subito);
//   • asset statici (carte, icone, css/js locali) → cache-first (veloci, offline).
const CACHE = "sali-e-scendi-v1";
const SHELL = [
  "./",
  "./index.html",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                       // solo GET
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // mai richieste cross-origin (Supabase ecc.)

  // Navigazioni/HTML: network-first, fallback alla cache (o alla index).
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith(
      fetch(req)
        .then((res) => { caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // Asset statici: cache-first, poi rete (e memorizza).
  e.respondWith(
    caches.match(req).then((cached) => cached ||
      fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached)
    )
  );
});
