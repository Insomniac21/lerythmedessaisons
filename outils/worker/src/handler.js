import {
  assertNotLocked,
  assertPublishBudget,
  clearFailures,
  clientIp,
  createSession,
  deleteSession,
  passphraseMatches,
  publishingReady,
  readSession,
  recordFailure,
  recordPublish,
  configuredSecrets,
} from "./auth.js";
import { createGitHubClient } from "./github.js";
import { deleteArticle, listArticles, publishArticle, readArticle } from "./publier.js";
import { loadArticleStats } from "./stats.js";
import { validatePublish, validateSlug } from "./valider.js";

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
};

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
        const ok = await passphraseMatches(passphrase, configuredSecrets(env));
        if (!ok) {
          await recordFailure(env.SESSIONS, ip);
          fail("mot-incorrect");
        }
        await clearFailures(env.SESSIONS, ip);
        return json(200, await createSession(env.SESSIONS), origin);
      }

      const session = await readSession(env.SESSIONS, request);
      if (!session) fail("non-autorise");

      if (url.pathname === "/api/logout" && request.method === "POST") {
        await deleteSession(env.SESSIONS, session);
        return json(200, { ok: true }, origin);
      }

      if (url.pathname === "/api/stats" && request.method === "GET") {
        const stats = await loadArticleStats(env, { fetchImpl: options.fetchImpl, now });
        return json(200, stats, origin);
      }

      const github = githubFor(env);

      if (url.pathname === "/api/journal" && request.method === "GET") {
        const articles = await listArticles(github);
        return json(200, {
          articles: articles.map((article) => ({
            slug: article.slug,
            title: article.title,
            date: article.date,
            excerpt: article.excerpt,
            image: article.image || null,
          })),
        }, origin);
      }

      if (url.pathname === "/api/article" && request.method === "GET") {
        return json(200, await readArticle(github, validateSlug(url.searchParams.get("slug"))), origin);
      }

      if (url.pathname === "/api/publish" && request.method === "POST") {
        if (!publishingReady(env)) fail("pas-active");
        const ip = clientIp(request);
        await assertPublishBudget(env.SESSIONS, ip);
        const input = validatePublish(await readJson(request));
        let result;
        try {
          result = await publishArticle(github, input, now());
        } catch (error) {
          if (error.status !== 409 && error.status !== 422) throw error;
          result = await publishArticle(github, input, now());
        }
        await recordPublish(env.SESSIONS, ip);
        return json(200, result, origin);
      }

      if (url.pathname === "/api/delete" && request.method === "POST") {
        if (!publishingReady(env)) fail("pas-active");
        const ip = clientIp(request);
        await assertPublishBudget(env.SESSIONS, ip);
        const body = await readJson(request);
        try {
          await deleteArticle(github, validateSlug(body.slug));
        } catch (error) {
          if (error.status !== 409 && error.status !== 422) throw error;
          await deleteArticle(github, validateSlug(body.slug));
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
