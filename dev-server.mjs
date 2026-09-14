// dev-server.mjs — server statico per l'anteprima locale del restyling.
// Avvio:  bun run dev   (oppure:  PORT=3000 bun run dev)
// Zero dipendenze: usa solo il runtime di Bun, funziona anche offline.
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Percorso robusto su Windows/macOS/Linux (niente .pathname, che su Windows
// darebbe "/C:/..." e romperebbe join()).
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "web");
const PORT = Number(process.env.PORT) || 5173;

Bun.serve({
  port: PORT,
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path === "/" || path === "") path = "/index.html";
    // niente path traversal fuori da web/
    const safe = join(ROOT, path).startsWith(ROOT) ? join(ROOT, path) : join(ROOT, "index.html");
    const file = Bun.file(safe);
    if (await file.exists()) {
      return new Response(file, { headers: { "cache-control": "no-cache" } });
    }
    // fallback: torna alla index
    return new Response(Bun.file(join(ROOT, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  },
});

console.log(`\n  🂡  Sali e Scendi — anteprima restyling`);
console.log(`  ▶  http://localhost:${PORT}\n`);
