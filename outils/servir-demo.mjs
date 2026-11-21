import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "./worker/src/handler.js";
import { createMemoryGitHub, createMemoryKv } from "./worker/src/memory.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT || 8765);
const passphrase = "mot-secret-demo";
const github = createMemoryGitHub({
  "articles/journal.json": readFileSync(join(root, "articles/journal.json"), "utf8"),
});
const kv = createMemoryKv();
const handle = createHandler({ github });
const env = {
  GITHUB_TOKEN: "demo-local-seulement",
  GITHUB_OWNER: "Insomniac21",
  GITHUB_REPO: "lerythmedessaisons",
  GITHUB_BRANCH: "master",
  AUTH_SECRET_ZACKARY: passphrase,
  AUTH_SECRET_PARENT: "mot-secret-papa-demo",
  ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
  SESSIONS: kv,
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
};

function repoPath(urlPath) {
  let relative = decodeURIComponent(urlPath).replace(/^\/+/, "");
  if (relative === "" || relative.endsWith("/")) relative += "index.html";
  return relative;
}

function fileFromRepo(urlPath) {
  const relative = repoPath(urlPath);
  if (!github.files.has(relative)) return null;
  const value = github.files.get(relative);
  if (typeof value === "string") return { body: value, type: types[extname(relative)] || "text/plain; charset=utf-8" };
  if (value instanceof Uint8Array) return { body: value, type: types[extname(relative)] || "application/octet-stream" };
  return null;
}

function fileFromDisk(urlPath) {
  let relative = decodeURIComponent(urlPath).replace(/^\/+/, "");
  if (relative === "" || relative.endsWith("/")) relative += "index.html";
  const safe = normalize(relative);
  if (safe === ".." || safe.startsWith(`..${sep}`) || safe.includes(`${sep}..${sep}`)) return null;
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  let full = join(rootPrefix, safe);
  if (!full.startsWith(rootPrefix)) return null;
  try {
    if (statSync(full).isDirectory()) full = join(full, "index.html");
    return { body: readFileSync(full), type: types[extname(full)] || "application/octet-stream" };
  } catch {
    return null;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("CF-Connecting-IP", request.socket.remoteAddress || "127.0.0.1");
    const incoming = new Request(url, { method: request.method, headers, body: body.length ? body : undefined });
    const result = await handle(incoming, env);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
    return;
  }

  if (url.pathname === "/ecrire/config.js") {
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    response.end(`export const config = { brokerUrl: "http://127.0.0.1:${port}" };\n`);
    return;
  }

  const published = fileFromRepo(url.pathname);
  const file = published || fileFromDisk(url.pathname);
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Introuvable");
    return;
  }
  response.writeHead(200, { "Content-Type": file.type });
  response.end(file.body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Essai local : http://127.0.0.1:${port}/`);
  console.log("Rien n'est envoyé à GitHub. Mot secret de Zackary pour cet essai :");
  console.log(passphrase);
});
