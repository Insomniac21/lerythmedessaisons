import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import {
  ARTICLE_VIEWS_ALL_PATHS_QUERY,
  ARTICLE_VIEWS_QUERY,
  aggregateArticleStats,
  chooseWindow,
  aggregateCarnetStats,
  CARNET_VIEWS_QUERY,
  sectionFromPath,
  slugFromArticlePath,
} from "./worker/src/stats.js";

const ORIGIN = "https://lerythmedessaisons.ca";
const SECRET = "les cailles de zackary";
const BEACON = `<script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "6b90ef3797f9465cb8a06733ff3b28a1"}'></script>`;

function read(path) {
  return readFileSync(path, "utf8");
}

function htmlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(path));
    else if (entry.name.endsWith(".html")) found.push(path);
  }
  return found;
}

function beaconCount(html) {
  return html.split(BEACON).length - 1;
}

function withoutBeacon(html) {
  return html.replaceAll(`${BEACON}\n`, "").replaceAll(BEACON, "");
}

function assertBeaconOnce(html, label = "page") {
  assert.equal(beaconCount(html), 1, label);
  const escaped = BEACON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(html, new RegExp(`${escaped}\\n</body>`), label);
}

function assertBeaconOptional(html, label = "page") {
  const count = beaconCount(html);
  assert.ok(count <= 1, label);
  if (count === 1) assertBeaconOnce(html, label);
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
  assert.equal(data.role, "zackary");
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
  const journal = JSON.parse(read("articles/journal.json"));
  for (const html of [article, list, renderListPage([])]) {
    assert.match(html, /lang="fr-CA"/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /Le journal/);
    assert.doesNotMatch(html, /Saint-Jean|école|ecole|adresse|nom de famille/i);
    assert.doesNotMatch(html, /\/api\/stats|👀|editor-vues|total-vues/);
    assertBeaconOnce(html);
  }
  assert.doesNotMatch(read("ecrire/generer.js"), /\/api\/stats|👀|total-vues|editor-vues/);
  assert.match(article, /Écrit par Zackary/);
  assert.match(article, /src="\.\.\/assets\/articles\/2026-11-21-les-cailles\.jpg"/);
  assert.ok(list.indexOf("Plus tard") < list.indexOf("Plus tôt"));
  assert.equal(read("articles/index.html"), renderListPage(journal.articles));
  assert.match(renderListPage([]), /Pas encore d'histoire ici/);
  const articlePages = new Set(journal.articles.map((entry) => join("articles", `${entry.slug}.html`)));
  const writingPage = join("ecrire", "index.html");
  for (const entry of journal.articles) {
    const data = JSON.parse(read(`articles/data/${entry.slug}.json`));
    const file = read(`articles/${entry.slug}.html`);
    const rendered = renderArticlePage({ ...entry, ...data, slug: entry.slug });
    // Le Worker actuel réécrit l'article sans le snippet tant qu'il n'est pas redéployé.
    // Le reste de la page doit quand même coller au modèle, sans snippet en double.
    assert.equal(withoutBeacon(file), withoutBeacon(rendered), entry.slug);
    assert.equal(withoutBeacon(withoutBeacon(rendered)), withoutBeacon(rendered), entry.slug);
    assert.doesNotMatch(file, /\/api\/stats|👀|editor-vues|total-vues/, entry.slug);
    assert.doesNotMatch(rendered, /\/api\/stats|👀|editor-vues|total-vues/, entry.slug);
    assertBeaconOptional(file, entry.slug);
    assertBeaconOptional(withoutBeacon(file), `${entry.slug} sans snippet`);
  }
  const pages = htmlFiles(".");
  assert.ok(pages.length >= 10);
  for (const file of pages) {
    const html = read(file);
    assert.doesNotMatch(html, /\/api\/stats|👀|editor-vues/, file);
    if (file !== writingPage) assert.doesNotMatch(html, /total-vues/, file);
    if (articlePages.has(file)) continue;
    assertBeaconOnce(html, file);
  }
});

test("la page de l'auteur est liée, sans détail privé", () => {
  function jpegSize(bytes) {
    const data = Buffer.from(bytes);
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      if (marker === 0xda || marker === 0xd9) break;
      const length = data.readUInt16BE(offset + 2);
      if (marker === 0xe1) {
        const header = data.subarray(offset + 4, offset + 10).toString("latin1");
        assert.equal(header.startsWith("Exif"), false);
      }
      offset += 2 + length;
    }
    throw new Error("jpeg");
  }

  const author = read("articles/auteur.html");
  assert.match(author, /<title>L'auteur : Zackary · Le journal de Zackary<\/title>/);
  assert.match(author, /<h1>L'auteur : Zackary<\/h1>/);
  assert.match(author, /J'ai 10 ans/);
  assert.doesNotMatch(author, /environ 10 ans/);
  assert.match(author, /Marc-André/);
  assert.match(author, /Quand ça me tente, j'aide papa avec les cailles/);
  assert.match(author, /Zackary met la main à la pâte quand le cœur lui en dit, et c'est lui qui raconte ses journées dans ce journal\. Je suis fier de lui\./);
  assert.doesNotMatch(author, /projet de famille|côte à côte/);
  assert.match(author, /— Marc-André/);
  assert.match(author, /src="\.\.\/assets\/zackary-avatar\.jpg" width="400" height="400" alt="Avatar illustré de Zackary"/);
  assert.equal(author.split('alt="Avatar illustré de Zackary"').length - 1, 1);
  assert.doesNotMatch(author, /Saint-Jean|école|ecole|adresse|nom de famille/i);
  assertBeaconOnce(author, "articles/auteur.html");

  const avatar = readFileSync("assets/zackary-avatar.jpg");
  assert.ok(avatar.length > 8000 && avatar.length < 150000);
  assert.equal(avatar[0], 0xff);
  assert.equal(avatar[1], 0xd8);
  assert.deepEqual(jpegSize(avatar), { width: 400, height: 400 });

  const byline = /<a href="auteur\.html"><img src="\.\.\/assets\/zackary-avatar\.jpg" alt="" width="40" height="40"><span>Écrit par Zackary<\/span><\/a>/;
  assert.match(renderListPage([]), /href="auteur\.html">L'auteur : Zackary<\/a>/);
  assert.match(read("articles/index.html"), /href="auteur\.html">L'auteur : Zackary<\/a>/);
  assert.match(renderArticlePage({
    slug: "2099-01-02-histoire-future",
    title: "Histoire future",
    body: "Une histoire qui n'existe pas encore.",
    date: "2099-01-02",
  }), byline);

  const journal = JSON.parse(read("articles/journal.json"));
  assert.ok(Array.isArray(journal.articles));
  for (const entry of journal.articles) {
    assert.match(read(`articles/${entry.slug}.html`), byline, entry.slug);
  }
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
  assert.match(editor, /id="total-vues"/);
  assert.doesNotMatch(editor, /👀|\/api\/stats/);
  const writing = read("ecrire/editeur.js");
  assert.match(writing, /\/api\/stats/);
  assert.match(writing, /👀 \$\{phraseVues\(views\)\}/);
  assert.match(writing, /dans les \$\{n\} derniers jours/);
  assert.match(writing, /En tout, \$\{phraseVues\(total\)\}/);
  const toml = read("outils/worker/wrangler.toml");
  assert.match(toml, /CF_ACCOUNT_ID = "e0b51723527d602ec0487bae0dbe0874"/);
  assert.match(toml, /CF_RUM_SITE_TAG = "071761b46ae2499f935fa16a040565b2"/);
  assert.doesNotMatch(toml, /CF_ANALYTICS_TOKEN\s*=/);
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
  assertBeaconOnce(page, "article publié");
  assertBeaconOnce(index, "journal publié");

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

function statsEnv(kv, extra = {}) {
  return testEnv(kv, {
    CF_ACCOUNT_ID: "e0b51723527d602ec0487bae0dbe0874",
    CF_RUM_SITE_TAG: "071761b46ae2499f935fa16a040565b2",
    CF_ANALYTICS_TOKEN: "token-analytics-de-test",
    ...extra,
  });
}

function groupsPayload(groups) {
  return {
    data: {
      viewer: {
        accounts: [{ rumPageloadEventsAdaptiveGroups: groups }],
      },
    },
  };
}

test("un chemin d'article devient un slug, le reste est ignoré", () => {
  assert.equal(slugFromArticlePath("/articles/2026-11-21-bonjour-script.html"), "2026-11-21-bonjour-script");
  assert.equal(slugFromArticlePath("/articles/2026-11-21-bonjour-script"), "2026-11-21-bonjour-script");
  assert.equal(slugFromArticlePath("/articles/2026-11-21-bonjour-script.html/"), "2026-11-21-bonjour-script");
  assert.equal(slugFromArticlePath("/articles/2026-11-21-le-foin.html?utm=papa"), "2026-11-21-le-foin");
  assert.equal(slugFromArticlePath("/articles/"), null);
  assert.equal(slugFromArticlePath("/articles/index.html"), null);
  assert.equal(slugFromArticlePath("/articles/data/2026-11-21-bonjour.json"), null);
  assert.equal(slugFromArticlePath("/cailles/ron.html"), null);
  assert.equal(slugFromArticlePath("/carnet/2026-11-21-bonjour.html"), null);
  assert.deepEqual(sectionFromPath("/carnet/2026-11-21-bonjour.html"), { section: "carnet", slug: "2026-11-21-bonjour" });
  assert.equal(sectionFromPath("/carnet/auteur.html"), null);
  assert.equal(sectionFromPath("/carnet/index.html"), null);
  assert.match(CARNET_VIEWS_QUERY, /requestPath_like: "\/carnet\/%"/);
  const now = new Date("2026-11-21T15:00:00Z");
  const wide = chooseWindow(now, 8035200);
  assert.equal(wide.windowDays, 90);
  assert.equal(wide.until - wide.since, 90 * 24 * 60 * 60 * 1000);
  const narrow = chooseWindow(now, 30 * 24 * 60 * 60);
  assert.equal(narrow.windowDays, 30);
  assert.equal(narrow.until - narrow.since, 30 * 24 * 60 * 60 * 1000 - 60 * 1000);
  assert.match(ARTICLE_VIEWS_QUERY, /rumPageloadEventsAdaptiveGroups/);
  assert.match(ARTICLE_VIEWS_QUERY, /requestPath_like: "\/articles\/%"/);
  assert.match(ARTICLE_VIEWS_QUERY, /sum \{\s*visits\s*\}/);
  assert.doesNotMatch(ARTICLE_VIEWS_ALL_PATHS_QUERY, /requestPath_like/);
});

test("les vues restent derrière le mot secret et ne cassent pas la page", async () => {
  const kv = createMemoryKv();
  const now = new Date("2026-11-21T15:00:00Z");
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, authorization: options.headers.Authorization });
    if (body.query.includes("RumSettings")) {
      return response({
        data: {
          viewer: {
            accounts: [{ settings: { rumPageloadEventsAdaptiveGroups: { maxDuration: 8035200 } } }],
          },
        },
      });
    }
    if (body.query.includes("/carnet/")) {
      return response(groupsPayload([
        { count: 3, sum: { visits: 1 }, dimensions: { requestPath: "/carnet/2026-11-21-le-foin.html" } },
      ]));
    }
    assert.equal(body.query, ARTICLE_VIEWS_QUERY);
    return response(groupsPayload([
      { count: 4, sum: { visits: 3 }, dimensions: { requestPath: "/articles/2026-11-21-bonjour-script.html" } },
      { count: 2, sum: { visits: 1.2 }, dimensions: { requestPath: "/articles/2026-11-21-bonjour-script" } },
      { count: 9, sum: { visits: 4 }, dimensions: { requestPath: "/articles/index.html" } },
      { count: 1, sum: { visits: 1 }, dimensions: { requestPath: "/articles/" } },
      { count: 7, sum: { visits: 5 }, dimensions: { requestPath: "/cailles/ron.html" } },
      { count: 3, sum: { visits: 2 }, dimensions: { requestPath: "/articles/2026-11-21-le-foin.html?utm=x" } },
    ]));
  };
  const handle = createHandler({ github: createMemoryGitHub(), fetchImpl, now: () => now });
  const env = statsEnv(kv);

  const denied = await handle(request("/api/stats"), env);
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);

  const outsider = await handle(request("/api/stats", { origin: "https://exemple.test" }), env);
  assert.equal(outsider.status, 403);
  assert.equal(calls.length, 0);

  const missing = await handle(request("/api/stats"), testEnv(kv));
  assert.equal(missing.status, 401);

  const token = await login(handle, env);
  const absent = await handle(request("/api/stats", { token }), testEnv(kv));
  assert.equal(absent.status, 200);
  assert.deepEqual(await absent.json(), { ok: false, windowDays: 90, articles: {}, carnet: {} });
  assert.equal(calls.length, 0);

  const first = await handle(request("/api/stats", { token }), env);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const stats = await first.json();
  assert.equal(stats.ok, true);
  assert.equal(stats.windowDays, 90);
  assert.deepEqual(stats.articles, {
    "2026-11-21-bonjour-script": { views: 6, visits: 4 },
    "2026-11-21-le-foin": { views: 3, visits: 2 },
  });
  assert.deepEqual(stats.carnet, { "2026-11-21-le-foin": { views: 3, visits: 1 } });
  assert.deepEqual(aggregateArticleStats([
    { count: 4, sum: { visits: 3 }, dimensions: { requestPath: "/articles/2026-11-21-bonjour-script.html" } },
    { count: 2, sum: { visits: 1.2 }, dimensions: { requestPath: "/articles/2026-11-21-bonjour-script" } },
  ]), { "2026-11-21-bonjour-script": { views: 6, visits: 4 } });
  const window = chooseWindow(now, 8035200);
  const viewsCall = calls.find((call) => call.body.query === ARTICLE_VIEWS_QUERY);
  assert.equal(viewsCall.url, "https://api.cloudflare.com/client/v4/graphql");
  assert.equal(viewsCall.authorization, "Bearer token-analytics-de-test");
  assert.equal(viewsCall.body.variables.accountTag, "e0b51723527d602ec0487bae0dbe0874");
  assert.equal(viewsCall.body.variables.siteTag, "071761b46ae2499f935fa16a040565b2");
  assert.equal(viewsCall.body.variables.since, window.since.toISOString());
  assert.equal(viewsCall.body.variables.until, window.until.toISOString());
  assert.equal(calls.length, 3);

  calls.length = 0;
  const cached = await handle(request("/api/stats", { token }), env);
  assert.deepEqual(await cached.json(), stats);
  assert.equal(calls.length, 0);
});

test("une fenêtre trop large retombe sur 30 jours, une erreur reste vide", async () => {
  const kv = createMemoryKv();
  const now = new Date("2026-11-21T15:00:00Z");
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.query.includes("RumSettings")) {
      return response({
        data: {
          viewer: {
            accounts: [{ settings: { rumPageloadEventsAdaptiveGroups: { maxDuration: 8035200 } } }],
          },
        },
      });
    }
    const span = Date.parse(body.variables.until) - Date.parse(body.variables.since);
    if (span > 40 * 24 * 60 * 60 * 1000) {
      return response({
        errors: [{ message: 'cannot request a time range wider than 13w2d, but your query time range spans 12w6d' }],
      });
    }
    if (body.query.includes("/carnet/")) return response(groupsPayload([]));
    assert.equal(body.query, ARTICLE_VIEWS_QUERY);
    return response(groupsPayload([
      { count: 2, sum: { visits: 1 }, dimensions: { requestPath: "/articles/2026-11-21-bonjour.html" } },
    ]));
  };
  const handle = createHandler({ github: createMemoryGitHub(), fetchImpl, now: () => now });
  const env = statsEnv(kv);
  const token = await login(handle, env, "203.0.113.21");
  const result = await handle(request("/api/stats", { token }), env);
  const stats = await result.json();
  assert.equal(result.status, 200);
  assert.equal(stats.ok, true);
  assert.equal(stats.windowDays, 30);
  assert.deepEqual(stats.articles, { "2026-11-21-bonjour": { views: 2, visits: 1 } });
  const limited = chooseWindow(now, 30 * 24 * 60 * 60);
  const retry = calls.filter((call) => call.query === ARTICLE_VIEWS_QUERY);
  assert.equal(retry.length, 2);
  assert.equal(retry[1].variables.since, limited.since.toISOString());

  const brokenKv = createMemoryKv();
  let attempts = 0;
  const broken = createHandler({
    github: createMemoryGitHub(),
    now: () => now,
    fetchImpl: async () => {
      attempts += 1;
      return response({ errors: [{ message: "jeton refusé" }] }, 401);
    },
  });
  const brokenEnv = statsEnv(brokenKv);
  const brokenToken = await login(broken, brokenEnv, "203.0.113.22");
  const first = await broken(request("/api/stats", { token: brokenToken }), brokenEnv);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: false, windowDays: 90, articles: {}, carnet: {} });
  const second = await broken(request("/api/stats", { token: brokenToken }), brokenEnv);
  assert.deepEqual(await second.json(), { ok: false, windowDays: 90, articles: {}, carnet: {} });
  assert.equal(attempts, 2);
});

test("sans filtre de chemin, on ne compte quand même que les articles", async () => {
  const kv = createMemoryKv();
  const calls = [];
  const fetchImpl = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push(body.query);
    if (body.query.includes("RumSettings")) {
      return response({ errors: [{ message: "settings indisponible" }] });
    }
    if (body.query === ARTICLE_VIEWS_QUERY) {
      return response({ errors: [{ message: 'unknown field "requestPath_like" on type RumFilter' }] });
    }
    assert.equal(body.query, ARTICLE_VIEWS_ALL_PATHS_QUERY);
    return response(groupsPayload([
      { count: 5, sum: { visits: 2 }, dimensions: { requestPath: "/articles/2026-11-21-les-cailles.html" } },
      { count: 8, sum: { visits: 3 }, dimensions: { requestPath: "/" } },
    ]));
  };
  const handle = createHandler({
    github: createMemoryGitHub(),
    fetchImpl,
    now: () => new Date("2026-11-21T15:00:00Z"),
  });
  const env = statsEnv(kv);
  const token = await login(handle, env, "203.0.113.23");
  const result = await handle(request("/api/stats", { token }), env);
  const stats = await result.json();
  assert.equal(stats.ok, true);
  assert.equal(stats.windowDays, 90);
  assert.deepEqual(stats.articles, { "2026-11-21-les-cailles": { views: 5, visits: 2 } });
  assert.ok(calls.includes(ARTICLE_VIEWS_ALL_PATHS_QUERY));
});

test("si les visites ne sont pas offertes, les vues restent là", async () => {
  const kv = createMemoryKv();
  const queries = [];
  const fetchImpl = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    queries.push(body.query);
    if (body.query.includes("RumSettings")) {
      return response({
        data: { viewer: { accounts: [{ settings: { rumPageloadEventsAdaptiveGroups: { maxDuration: 8035200 } } }] } },
      });
    }
    if (body.query.includes("visits")) {
      return response({ errors: [{ message: 'unknown field "visits"' }] });
    }
    if (body.query.includes("/carnet/")) {
      return response(groupsPayload([
        { count: 2, dimensions: { requestPath: "/carnet/2026-11-21-bonjour.html" } },
      ]));
    }
    assert.match(body.query, /requestPath_like: "\/articles\/%"/);
    return response(groupsPayload([
      { count: 4, dimensions: { requestPath: "/articles/2026-11-21-bonjour.html" } },
    ]));
  };
  const handle = createHandler({
    github: createMemoryGitHub(),
    fetchImpl,
    now: () => new Date("2026-11-21T15:00:00Z"),
  });
  const env = statsEnv(kv);
  const token = await login(handle, env, "203.0.113.24");
  const stats = await (await handle(request("/api/stats", { token }), env)).json();
  assert.equal(stats.ok, true);
  assert.deepEqual(stats.articles, { "2026-11-21-bonjour": { views: 4, visits: 0 } });
  assert.deepEqual(stats.carnet, { "2026-11-21-bonjour": { views: 2, visits: 0 } });
  assert.ok(queries.some((query) => query.includes("visits")));
  assert.ok(queries.some((query) => !query.includes("visits") && !query.includes("RumSettings")));
});

test("le carnet de Marc-André est à part, et Zackary n'y touche pas", async () => {
  const kv = createMemoryKv();
  const github = createMemoryGitHub({ "articles/journal.json": '{"articles":[]}\n', "carnet/journal.json": '{"articles":[]}\n' });
  const handle = createHandler({ github, now: () => new Date("2026-11-22T15:00:00Z") });
  const env = testEnv(kv);
  const parentLogin = await handle(request("/api/login", {
    method: "POST",
    json: { passphrase: "le mot de papa seulement" },
    ip: "203.0.113.40",
  }), env);
  assert.equal(parentLogin.status, 200);
  const parent = await parentLogin.json();
  assert.equal(parent.role, "parent");

  const mine = await handle(request("/api/publish", {
    method: "POST",
    token: parent.token,
    json: { title: "Le foin du matin", body: "Les cailles ont pondu." },
  }), env);
  assert.equal(mine.status, 200);
  const created = await mine.json();
  assert.equal(created.section, "carnet");
  assert.match(created.url, /^\/carnet\//);
  const page = github.files.get(`carnet/${created.slug}.html`);
  assert.match(page, /<a href="auteur\.html"><img src="\.\.\/assets\/marc-andre-avatar\.jpg" alt="" width="40" height="40"><span>Écrit par Marc-André<\/span><\/a>/);
  assert.match(page, /Le carnet du fermier/);
  assert.doesNotMatch(page, /Saint-Jean|école|ecole|adresse|nom de famille/i);
  assertBeaconOnce(page, "carnet publié");
  assert.match(github.files.get("carnet/index.html"), /L'auteur : Marc-André/);
  assert.equal(github.files.has(`articles/${created.slug}.html`), false);

  const zackary = await login(handle, env, "203.0.113.41");
  const blocked = await handle(request("/api/publish", {
    method: "POST",
    token: zackary,
    json: { title: "Pas ici", body: "Non.", section: "carnet" },
  }), env);
  assert.equal(blocked.status, 403);
  const journal = await handle(request("/api/journal", { token: zackary }), env);
  const listed = await journal.json();
  assert.equal(listed.role, "zackary");
  assert.deepEqual(listed.carnet, []);
  assert.equal(listed.articles.some((item) => item.slug === created.slug), false);

  const removed = await handle(request("/api/delete", {
    method: "POST",
    token: zackary,
    json: { slug: created.slug, section: "carnet" },
  }), env);
  assert.equal(removed.status, 403);
  assert.equal(github.files.has(`carnet/${created.slug}.html`), true);

  const forSon = await handle(request("/api/publish", {
    method: "POST",
    token: parent.token,
    json: { title: "Une note pour Zackary", body: "Papa a réparé la cage.", section: "zackary" },
  }), env);
  assert.equal(forSon.status, 200);
  const son = await forSon.json();
  assert.equal(son.section, "zackary");
  assert.match(github.files.get(`articles/${son.slug}.html`), /Écrit par Zackary/);

  const parentList = await handle(request("/api/journal", { token: parent.token }), env);
  const both = await parentList.json();
  assert.equal(both.role, "parent");
  assert.equal(both.section, "carnet");
  assert.equal(both.carnet.length, 1);
  assert.equal(both.articles.length, 1);

  const parentReadsSon = await handle(request(`/api/article?slug=${son.slug}`, { token: parent.token }), env);
  assert.equal(parentReadsSon.status, 200);
  assert.equal((await parentReadsSon.json()).section, "zackary");
  const parentRemovesSon = await handle(request("/api/delete", {
    method: "POST",
    token: parent.token,
    json: { slug: son.slug },
  }), env);
  assert.equal(parentRemovesSon.status, 200);
  assert.equal(github.files.has(`articles/${son.slug}.html`), false);
  assert.match(github.files.get("carnet/index.html"), /Le foin du matin/);

  assert.equal(read("carnet/index.html"), renderListPage([], "carnet"));
  assert.match(read("carnet/index.html"), /Le carnet du fermier/);
  assert.match(read("carnet/auteur.html"), /<h1>L'auteur : Marc-André<\/h1>/);
  assert.match(read("carnet/auteur.html"), /alt="Avatar illustré de Marc-André"/);
  assert.match(read("carnet/auteur.html"), /Le Rythme des Saisons, c'est ma fermette/);
  assert.match(read("carnet/auteur.html"), /quand le cœur lui en dit/);
  assert.doesNotMatch(read("carnet/auteur.html"), /projet de famille|côte à côte|avec lui, à la fermette/);
  assert.doesNotMatch(read("carnet/auteur.html"), /Saint-Jean|école|ecole|adresse|nom de famille/i);
  assertBeaconOnce(read("carnet/auteur.html"), "carnet/auteur.html");
  const sample = renderArticlePage({
    slug: "2099-03-01-note-future",
    title: "Note future",
    body: "Une note qui n'existe pas encore.",
    date: "2099-03-01",
  }, "carnet");
  assert.match(sample, /Écrit par Marc-André/);
  assert.match(sample, /href="\.\.\/carnet\/index\.html">Le carnet<\/a>|href="index\.html" aria-current="page">Le carnet<\/a>/);
  assertBeaconOnce(sample, "modèle du carnet");
  for (const file of ["index.html", "cailles/index.html", "cailles/mathilda.html", "cailles/jannie.html", "cailles/ron.html", "ecrire/index.html", "articles/index.html", "articles/auteur.html", "carnet/index.html", "carnet/auteur.html"]) {
    assert.match(read(file), /Le carnet<\/a>/, file);
  }
  assert.doesNotThrow(() => assertWritable("carnet/2026-11-22-bonjour.html"));
  assert.doesNotThrow(() => assertWritable("carnet/journal.json"));
  assert.doesNotThrow(() => assertWritable("assets/carnet/2026-11-22-bonjour.jpg"));
  assert.throws(() => assertWritable("carnet/auteur.html"), /chemin/);
  assert.throws(() => assertWritable("assets/marc-andre-avatar.jpg"), /chemin/);
  assert.deepEqual(aggregateCarnetStats([
    { count: 2, sum: { visits: 1 }, dimensions: { requestPath: "/carnet/2026-11-22-le-foin.html" } },
    { count: 9, sum: { visits: 4 }, dimensions: { requestPath: "/articles/2026-11-22-le-foin.html" } },
  ]), { "2026-11-22-le-foin": { views: 2, visits: 1 } });
  const editor = read("ecrire/index.html");
  assert.match(editor, /Mon carnet/);
  assert.match(editor, /Journal de Zackary/);
  assert.match(read("ecrire/editeur.js"), /section: currentSection\(\)/);
});
