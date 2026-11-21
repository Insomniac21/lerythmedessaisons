import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARTICLE_SLUG,
  assertWritable,
  escapeHtml,
  excerpt,
  labelFromIso,
  makeSlug,
  quebecDateParts,
  renderArticlePage,
  renderListPage,
  slugifyTitle,
  textToParagraphs,
} from "../ecrire/generer.js";
import { createHandler } from "./worker/src/handler.js";
import { createGitHubClient } from "./worker/src/github.js";
import { decodeBase64, encodeBase64, stripJpegMetadata } from "./worker/src/jpeg.js";
import { createMemoryGitHub, createMemoryKv } from "./worker/src/memory.js";

const ORIGIN = "https://lerythmedessaisons.ca";
const SECRET = "les cailles de zackary";

function read(path) {
  return readFileSync(path, "utf8");
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function request(path, { method = "GET", origin = ORIGIN, json, token, ip = "203.0.113.8" } = {}) {
  const headers = new Headers({ Origin: origin, "CF-Connecting-IP": ip });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    headers.set("Content-Type", "application/json");
  }
  return new Request(`https://journal.test${path}`, { method, headers, body });
}

function testEnv(kv, extra = {}) {
  return {
    GITHUB_TOKEN: "token-de-test",
    GITHUB_OWNER: "Insomniac21",
    GITHUB_REPO: "lerythmedessaisons",
    GITHUB_BRANCH: "master",
    AUTH_SECRET_ZACKARY: `  ${SECRET}  `,
    AUTH_SECRET_PARENT: "le mot de papa seulement",
    ALLOWED_ORIGINS: ORIGIN,
    SESSIONS: kv,
    ...extra,
  };
}

function jpegWithLocation() {
  const text = new TextEncoder();
  const app = text.encode("Exif\0GPSLatitude 45.1234 -73.5000");
  const appLength = app.length + 2;
  const sosPayload = Uint8Array.of(0x00, 0x01);
  const sosLength = sosPayload.length + 2;
  const scan = text.encode("KEEP-SCAN plus assez doctets pour une photo");
  const parts = [
    Uint8Array.of(0xff, 0xd8),
    Uint8Array.of(0xff, 0xe1, (appLength >> 8) & 255, appLength & 255),
    app,
    Uint8Array.of(0xff, 0xda, (sosLength >> 8) & 255, sosLength & 255),
    sosPayload,
    scan,
    Uint8Array.of(0xff, 0xd9),
  ];
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function login(handle, env, ip = "203.0.113.8") {
  const responseLogin = await handle(request("/api/login", {
    method: "POST",
    json: { passphrase: SECRET },
    ip,
  }), env);
  assert.equal(responseLogin.status, 200);
  const data = await responseLogin.json();
  assert.match(data.token, /^[0-9a-f]{64}$/);
  return data.token;
}

test("le français, les liens et le titre deviennent un nom de fichier sûr", () => {
  assert.equal(labelFromIso("2026-11-21"), "21 novembre 2026");
  assert.equal(slugifyTitle("L'œuf de la caille !"), "l-oeuf-de-la-caille");
  assert.equal(slugifyTitle("Ça, c'est l'été"), "ca-c-est-l-ete");
  assert.equal(makeSlug("Bonjour", "2026-11-21", []), "2026-11-21-bonjour");
  assert.equal(makeSlug("Bonjour", "2026-11-21", ["2026-11-21-bonjour"]), "2026-11-21-bonjour-2");
  assert.equal(excerpt("mot ".repeat(80), 40).endsWith("…"), true);
  assert.equal(quebecDateParts(new Date("2026-11-21T15:00:00Z")).iso, "2026-11-21");
  assert.match(textToParagraphs("un\n\n<script>"), /<p>un<\/p>\n<p>&lt;script&gt;<\/p>/);
  assert.equal(escapeHtml(`"'<>&`), "&quot;&#39;&lt;&gt;&amp;");
});

test("les pages publiques ne demandent ni nom de famille, ni école, ni endroit", () => {
  const article = renderArticlePage({
    slug: "2026-11-21-les-cailles",
    title: "Les cailles",
    body: "Ron court dans le foin.",
    date: "2026-11-21",
    image: "assets/articles/2026-11-21-les-cailles.jpg",
  });
  const list = renderListPage([
    {
      slug: "2026-11-21-plus-tard",
      title: "Plus tard",
      date: "2026-11-21",
      publishedAt: "2026-11-21T16:00:00.000Z",
      excerpt: "deuxième",
      image: null,
    },
    {
      slug: "2026-11-21-plus-tot",
      title: "Plus tôt",
      date: "2026-11-21",
      publishedAt: "2026-11-21T15:00:00.000Z",
      excerpt: "premier",
      image: null,
    },
  ]);
  for (const html of [article, list]) {
    assert.match(html, /lang="fr-CA"/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /Le journal/);
    assert.doesNotMatch(html, /Saint-Jean|école|ecole|adresse|nom de famille/i);
  }
  assert.match(article, /Écrit par Zackary/);
  assert.match(article, /src="\.\.\/assets\/articles\/2026-11-21-les-cailles\.jpg"/);
  assert.ok(list.indexOf("Plus tard") < list.indexOf("Plus tôt"));
  assert.equal(read("articles/index.html"), renderListPage([]));
  assert.match(read("articles/index.html"), /Pas encore d'histoire ici/);
});

test("la page d'accueil, le menu et le coin d'écriture sont branchés", () => {
  const home = read("index.html");
  const section = home.slice(home.indexOf('id="journal"'), home.indexOf("<!-- 3. NOS ANIMAUX"));
  assert.match(section, /Lire le journal/);
  assert.match(section, /articles\/index\.html/);
  assert.doesNotMatch(section, /Saint-Jean|école|ecole|adresse/i);
  assert.match(home, /href="articles\/index\.html">Le journal<\/a>/);
  assert.match(home, /href="articles\/index\.html">Zackary<\/a>/);
  for (const file of ["cailles/index.html", "cailles/mathilda.html", "cailles/jannie.html", "cailles/ron.html"]) {
    assert.match(read(file), /href="\.\.\/articles\/index\.html">Le journal<\/a>/);
  }
  const editor = read("ecrire/index.html");
  assert.match(editor, /noindex/);
  assert.match(editor, /N'écris pas ton nom de famille, le nom de ton école, ni l'endroit où tu habites/);
  assert.match(editor, /id="titre"/);
  assert.match(editor, /id="texte"/);
  assert.match(editor, /id="photo"/);
  assert.match(editor, /Publier mon article/);
  assert.doesNotMatch(editor, /name="(?:ecole|adresse|famille|ville|nom)"/);
  assert.match(read("ecrire/config.js"), /brokerUrl:\s*"https:\/\/journal-zackary\.lerythmedessaisons\.workers\.dev"/);
  assert.equal(ARTICLE_SLUG.test("2026-11-21-bonjour"), true);
  assert.equal(ARTICLE_SLUG.test("../index"), false);
  assert.throws(() => assertWritable("index.html"), /chemin/);
  assert.throws(() => assertWritable("articles/../index.html"), /chemin/);
  assert.doesNotThrow(() => assertWritable("articles/2026-11-21-bonjour.html"));
});

test("une photo JPEG perd l'endroit caché dans le fichier", () => {
  const source = jpegWithLocation();
  const clean = stripJpegMetadata(source);
  const sourceText = new TextDecoder().decode(source);
  const cleanText = new TextDecoder().decode(clean);
  assert.match(sourceText, /GPSLatitude 45\.1234/);
  assert.doesNotMatch(cleanText, /GPSLatitude|45\.1234|Saint-Jean/);
  assert.match(cleanText, /KEEP-SCAN/);
  assert.equal(clean[0], 0xff);
  assert.equal(clean[1], 0xd8);
  assert.equal(clean.at(-2), 0xff);
  assert.equal(clean.at(-1), 0xd9);
  assert.throws(() => stripJpegMetadata(Uint8Array.of(1, 2, 3, 4)), /photo/);
  const bulky = new Uint8Array(5000);
  bulky[0] = 255;
  assert.deepEqual(decodeBase64(encodeBase64(bulky)), bulky);
});

test("sans le mot secret, personne ne publie", async () => {
  const kv = createMemoryKv();
  const github = createMemoryGitHub();
  const handle = createHandler({ github, now: () => new Date("2026-11-21T15:00:00Z") });
  const env = testEnv(kv);
  const denied = await handle(request("/api/publish", {
    method: "POST",
    json: { title: "Piraté", body: "non" },
  }), env);
  assert.equal(denied.status, 401);
  assert.equal(github.commits.length, 0);

  const outsider = await handle(request("/api/login", {
    method: "POST",
    origin: "https://exemple.test",
    json: { passphrase: SECRET },
  }), env);
  assert.equal(outsider.status, 403);

  const wrong = await handle(request("/api/login", {
    method: "POST",
    json: { passphrase: "ce n'est pas ça" },
    ip: "203.0.113.9",
  }), env);
  assert.equal(wrong.status, 401);

  const off = await handle(request("/api/login", {
    method: "POST",
    json: { passphrase: SECRET },
  }), testEnv(kv, { AUTH_SECRET_ZACKARY: "court", AUTH_SECRET_PARENT: "", GITHUB_TOKEN: "" }));
  assert.equal(off.status, 503);
});

test("huit mauvais mots, puis il faut attendre", async () => {
  const kv = createMemoryKv();
  const handle = createHandler({ github: createMemoryGitHub() });
  const env = testEnv(kv);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await handle(request("/api/login", {
      method: "POST",
      json: { passphrase: "mauvais mot secret" },
      ip: "198.51.100.4",
    }), env);
    assert.equal(result.status, 401);
  }
  const locked = await handle(request("/api/login", {
    method: "POST",
    json: { passphrase: SECRET },
    ip: "198.51.100.4",
  }), env);
  assert.equal(locked.status, 429);
});

test("publier, corriger et retirer un article", async () => {
  const kv = createMemoryKv();
  const github = createMemoryGitHub({ "articles/journal.json": '{"articles":[]}\n' });
  let tick = Date.parse("2026-11-21T15:00:00Z");
  const handle = createHandler({
    github,
    now: () => new Date(tick),
  });
  const env = testEnv(kv);
  const token = await login(handle, env);
  const photo = encodeBase64(jpegWithLocation());

  const first = await handle(request("/api/publish", {
    method: "POST",
    token,
    json: { title: "Bonjour <script>", body: "une ligne\n\n<img src=x onerror=alert(1)>", imageBase64: photo },
  }), env);
  assert.equal(first.status, 200);
  const created = await first.json();
  assert.equal(created.slug, "2026-11-21-bonjour-script");

  tick += 60 * 60 * 1000;
  const second = await handle(request("/api/publish", {
    method: "POST",
    token,
    json: { title: "Le foin", body: "Les cochons d'Inde mangent." },
  }), env);
  assert.equal(second.status, 200);

  const index = github.files.get("articles/index.html");
  const page = github.files.get("articles/2026-11-21-bonjour-script.html");
  const image = github.files.get("assets/articles/2026-11-21-bonjour-script.jpg");
  assert.ok(index.indexOf("Le foin") < index.indexOf("Bonjour"));
  assert.match(page, /&lt;script&gt;/);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(page, /<script>alert|<img src=x/);
  assert.doesNotMatch(new TextDecoder().decode(image), /GPSLatitude|45\.1234/);
  assert.match(page, /name="viewport"/);

  const edited = await handle(request("/api/publish", {
    method: "POST",
    token,
    json: { slug: created.slug, title: "Bonjour Ron", body: "Texte corrigé." },
  }), env);
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).slug, created.slug);
  assert.match(github.files.get(`articles/${created.slug}.html`), /Bonjour Ron/);
  assert.match(github.files.get(`articles/${created.slug}.html`), /21 novembre 2026/);
  assert.match(github.files.get(`articles/${created.slug}.html`), /assets\/articles\/2026-11-21-bonjour-script\.jpg/);
  assert.ok(github.files.has("assets/articles/2026-11-21-bonjour-script.jpg"));
  assert.match(github.files.get("articles/index.html"), /Le foin/);

  const badSlug = await handle(request("/api/publish", {
    method: "POST",
    token,
    json: { slug: "../index.html", title: "Non", body: "Non." },
  }), env);
  assert.equal(badSlug.status, 400);
  const badPhoto = await handle(request("/api/publish", {
    method: "POST",
    token,
    json: { title: "Photo", body: "Photo.", imageBase64: encodeBase64(Uint8Array.of(1, 2, 3, 4)) },
  }), env);
  assert.equal(badPhoto.status, 400);

  const removed = await handle(request("/api/delete", {
    method: "POST",
    token,
    json: { slug: "2026-11-21-le-foin" },
  }), env);
  assert.equal(removed.status, 200);
  assert.equal(github.files.has("articles/2026-11-21-le-foin.html"), false);
  assert.doesNotMatch(github.files.get("articles/index.html"), /Le foin/);
  assert.match(github.files.get("articles/index.html"), /Bonjour Ron/);

  const journal = await handle(request("/api/journal", { token }), env);
  const articles = (await journal.json()).articles;
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, "Bonjour Ron");
  const loaded = await handle(request(`/api/article?slug=${created.slug}`, { token }), env);
  assert.equal((await loaded.json()).body, "Texte corrigé.");
});

test("le client GitHub prépare un commit sur master, sans forcer", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || "GET", body });
    const path = new URL(url).pathname;
    if (path.endsWith("/contents/articles/journal.json")) return response({ message: "Not Found" }, 404);
    if (path.endsWith("/git/ref/heads/master") && (options.method || "GET") === "GET") return response({ object: { sha: "parent" } });
    if (path.endsWith("/git/commits/parent")) return response({ tree: { sha: "tree0" } });
    if (path.endsWith("/git/blobs")) return response({ sha: "blob1" });
    if (path.endsWith("/git/trees")) return response({ sha: "tree1" });
    if (path.endsWith("/git/commits") && options.method === "POST") return response({ sha: "commit1" });
    if (path.endsWith("/git/refs/heads/master") && options.method === "PATCH") return response({ ref: "ok" });
    return response({ message: `inattendu ${path}` }, 500);
  };
  const client = createGitHubClient({
    GITHUB_TOKEN: " secret \n",
    GITHUB_OWNER: "Insomniac21",
    GITHUB_REPO: "lerythmedessaisons",
    GITHUB_BRANCH: "master",
  }, fetchImpl);
  assert.equal(await client.readText("articles/journal.json"), null);
  await client.commit({
    message: "Journal de Zackary : Bonjour",
    files: { "articles/index.html": { text: "<p>bonjour</p>" } },
    deletes: ["assets/articles/2026-11-21-bonjour.jpg"],
  });
  const tree = calls.find((call) => call.url.endsWith("/git/trees"));
  assert.equal(tree.body.base_tree, "tree0");
  assert.deepEqual(tree.body.tree[0], { path: "articles/index.html", mode: "100644", type: "blob", sha: "blob1" });
  assert.equal(tree.body.tree[1].path, "assets/articles/2026-11-21-bonjour.jpg");
  assert.equal(tree.body.tree[1].sha, null);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal(patch.body.force, false);
  assert.equal(patch.body.sha, "commit1");
  assert.match(calls[0].url, /\/repos\/Insomniac21\/lerythmedessaisons\/contents\//);
  await assert.rejects(() => client.commit({
    message: "non",
    files: { "index.html": { text: "piraté" } },
    deletes: [],
  }), /chemin/);
});
