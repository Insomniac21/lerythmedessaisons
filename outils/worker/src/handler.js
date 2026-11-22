import {
  assertNotLocked,
  assertPublishBudget,
  clearFailures,
  clientIp,
  createSession,
  deleteSession,
  matchRole,
  publishingReady,
  readSession,
  recordFailure,
  recordPublish,
} from "./auth.js";
import { createGitHubClient } from "./github.js";
import { deleteArticle, listArticles, publishArticle, readArticle } from "./publier.js";
import { loadArticleStats } from "./stats.js";
import { validatePublish, validateSection, validateSlug } from "./valider.js";

const BODY_MAX = 2_500_000;

function allowedOrigin(env, origin) {
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

function fail(name) {
  const error = new Error(name);
  error.code = name;
  throw error;
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > BODY_MAX) fail("trop-gros");
  const text = await request.text();
  if (text.length > BODY_MAX) fail("trop-gros");
  try {
    return JSON.parse(text);
  } catch {
    fail("json");
  }
}

const STATUS = {
  "mot-incorrect": 401,
  "trop-dessais": 429,
  "pas-active": 503,
  "non-autorise": 401,
  titre: 400,
  texte: 400,
  photo: 400,
  slug: 400,
  introuvable: 404,
  json: 400,
  "trop-gros": 413,
  origine: 403,
  "trop-vite": 429,
  journal: 500,
  chemin: 500,
  interdit: 403,
  section: 400,
};

function resolveSection(role, requested) {
  if (role === "zackary") {
    if (requested && requested !== "zackary") fail("interdit");
    return "zackary";
  }
  if (role !== "parent") fail("non-autorise");
  if (!requested || requested === "carnet") return "carnet";
  if (requested === "zackary") return "zackary";
  fail("interdit");
}

async function sectionFor(github, role, requested, slug) {
  if (requested || role !== "parent" || !slug) return resolveSection(role, requested);
  const carnet = await listArticles(github, "carnet");
  if (carnet.some((article) => article.slug === slug)) return "carnet";
  const articles = await listArticles(github, "zackary");
  if (articles.some((article) => article.slug === slug)) return "zackary";
  return "carnet";
}

function publicArticle(article, section) {
  return {
    slug: article.slug,
    title: article.title,
    date: article.date,
    excerpt: article.excerpt,
    image: article.image || null,
    section,
  };
}

export function createHandler(options = {}) {
  const githubFor = options.github
    ? () => options.github
    : (env) => createGitHubClient(env, options.fetchImpl);
  const now = options.now || (() => new Date());

  return async function handle(request, env) {
    const url = new URL(request.url);
    const originHeader = request.headers.get("Origin");
    const origin = allowedOrigin(env, originHeader);

    if (request.method === "OPTIONS") {
      if (originHeader && !origin) return json(403, { error: "origine" }, null);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json(200, { ok: true }, origin);
    }

    if (originHeader && !origin) return json(403, { error: "origine" }, null);

    try {
      if (url.pathname === "/api/login" && request.method === "POST") {
        if (!publishingReady(env)) fail("pas-active");
        const ip = clientIp(request);
        await assertNotLocked(env.SESSIONS, ip);
        const body = await readJson(request);
        const passphrase = typeof body.passphrase === "string" ? body.passphrase.trim() : "";
        if (!passphrase || passphrase.length > 200) fail("mot-incorrect");
        const role = await matchRole(passphrase, env);
        if (!role) {
          await recordFailure(env.SESSIONS, ip);
          fail("mot-incorrect");
        }
        await clearFailures(env.SESSIONS, ip);
        return json(200, await createSession(env.SESSIONS, role), origin);
      }

      const session = await readSession(env.SESSIONS, request);
      if (!session) fail("non-autorise");

      if (url.pathname === "/api/logout" && request.method === "POST") {
        await deleteSession(env.SESSIONS, session.token);
        return json(200, { ok: true }, origin);
      }

      if (url.pathname === "/api/stats" && request.method === "GET") {
        const stats = await loadArticleStats(env, { fetchImpl: options.fetchImpl, now });
        return json(200, stats, origin);
      }

      const github = githubFor(env);

      if (url.pathname === "/api/journal" && request.method === "GET") {
        const articles = await listArticles(github, "zackary");
        const carnet = session.role === "parent" ? await listArticles(github, "carnet") : [];
        return json(200, {
          role: session.role,
          section: session.role === "parent" ? "carnet" : "zackary",
          articles: articles.map((article) => publicArticle(article, "zackary")),
          carnet: carnet.map((article) => publicArticle(article, "carnet")),
        }, origin);
      }

      if (url.pathname === "/api/article" && request.method === "GET") {
        const slug = validateSlug(url.searchParams.get("slug"));
        const section = await sectionFor(github, session.role, validateSection(url.searchParams.get("section")), slug);
        return json(200, await readArticle(github, slug, section), origin);
      }

      if (url.pathname === "/api/publish" && request.method === "POST") {
        if (!publishingReady(env)) fail("pas-active");
        const ip = clientIp(request);
        await assertPublishBudget(env.SESSIONS, ip);
        const input = validatePublish(await readJson(request));
        const section = await sectionFor(github, session.role, input.section, input.slug);
        let result;
        try {
          result = await publishArticle(github, input, now(), section);
        } catch (error) {
          if (error.status !== 409 && error.status !== 422) throw error;
          result = await publishArticle(github, input, now(), section);
        }
        await recordPublish(env.SESSIONS, ip);
        return json(200, result, origin);
      }

      if (url.pathname === "/api/delete" && request.method === "POST") {
        if (!publishingReady(env)) fail("pas-active");
        const ip = clientIp(request);
        await assertPublishBudget(env.SESSIONS, ip);
        const body = await readJson(request);
        const slug = validateSlug(body?.slug);
        const section = await sectionFor(github, session.role, validateSection(body?.section), slug);
        try {
          await deleteArticle(github, slug, section);
        } catch (error) {
          if (error.status !== 409 && error.status !== 422) throw error;
          await deleteArticle(github, slug, section);
        }
        await recordPublish(env.SESSIONS, ip);
        return json(200, { ok: true }, origin);
      }

      return json(404, { error: "introuvable" }, origin);
    } catch (error) {
      if (!error.code) {
        console.error("journal", error.status || "", String(error.message || "erreur").slice(0, 300));
        return json(502, { error: "github" }, origin);
      }
      const status = STATUS[error.code] || 400;
      return json(status, { error: error.code }, origin);
    }
  };
}
