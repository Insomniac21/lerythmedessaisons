import { ARTICLE_SLUG } from "../../../ecrire/generer.js";

// Vues privées du journal : /api/stats seulement, après une session.
// Les pages publiques ne lisent pas ce module.

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_KEY = "stats:articles:v1";
const CACHE_TTL_SECONDS = 600;
const DAY_MS = 24 * 60 * 60 * 1000;
const TARGET_WINDOW_MS = 90 * DAY_MS;
const FALLBACK_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const WINDOW_MARGIN_MS = 60 * 1000;

// rumPageloadEventsAdaptiveGroups : maxDuration souvent 93 jours
// (8 035 200 s). On demande 90 jours, puis on serre à la limite du compte.
function viewsQuery(withPath, withVisits) {
  const pathLine = withPath ? "\n          requestPath_like: \"/articles/%\"" : "";
  const visitsBlock = withVisits ? "\n        sum {\n          visits\n        }" : "";
  const name = `ArticleViews${withPath ? "" : "AllPaths"}${withVisits ? "" : "Count"}`;
  return `query ${name}($accountTag: String!, $siteTag: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rumPageloadEventsAdaptiveGroups(
        limit: 1000
        filter: {
          siteTag: $siteTag
          datetime_geq: $since
          datetime_leq: $until${pathLine}
        }
        orderBy: [count_DESC]
      ) {
        count${visitsBlock}
        dimensions {
          requestPath
        }
      }
    }
  }
}`;
}

export const ARTICLE_VIEWS_QUERY = viewsQuery(true, true);
export const ARTICLE_VIEWS_ALL_PATHS_QUERY = viewsQuery(false, true);
const ARTICLE_VIEWS_COUNT_QUERY = viewsQuery(true, false);

const RUM_SETTINGS_QUERY = `query RumSettings($accountTag: String!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      settings {
        rumPageloadEventsAdaptiveGroups {
          maxDuration
        }
      }
    }
  }
}`;

export function chooseWindow(now, maxDurationSeconds) {
  let ms = TARGET_WINDOW_MS;
  const capSeconds = Number(maxDurationSeconds);
  if (Number.isFinite(capSeconds) && capSeconds > 0 && capSeconds * 1000 < TARGET_WINDOW_MS) {
    ms = Math.max(WINDOW_MARGIN_MS, capSeconds * 1000 - WINDOW_MARGIN_MS);
  }
  const until = new Date(now.getTime());
  const since = new Date(until.getTime() - ms);
  return {
    since,
    until,
    windowDays: Math.max(1, Math.round(ms / DAY_MS)),
  };
}

export function slugFromArticlePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 300) return null;
  const pathname = path.split("?")[0].split("#")[0];
  const match = pathname.match(/^\/articles\/([^/]+?)(?:\.html)?\/?$/);
  if (!match) return null;
  return ARTICLE_SLUG.test(match[1]) ? match[1] : null;
}

export function aggregateArticleStats(groups) {
  const totals = new Map();
  for (const group of groups || []) {
    const slug = slugFromArticlePath(group?.dimensions?.requestPath);
    if (!slug) continue;
    const views = Number(group?.count);
    const visits = Number(group?.sum?.visits);
    const row = totals.get(slug) || { views: 0, visits: 0 };
    if (Number.isFinite(views)) row.views += views;
    if (Number.isFinite(visits)) row.visits += visits;
    totals.set(slug, row);
  }
  const articles = {};
  for (const [slug, row] of totals) {
    articles[slug] = {
      views: Math.max(0, Math.round(row.views)),
      visits: Math.max(0, Math.round(row.visits)),
    };
  }
  return articles;
}

function unavailable(windowDays = 90) {
  return { ok: false, windowDays, articles: {} };
}

function cleanId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[A-Za-z0-9]{8,64}$/.test(trimmed) ? trimmed : "";
}

function cleanSecret(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length < 10 || /[\u0000\r\n]/.test(trimmed)) return "";
  return trimmed;
}

function errorText(payload) {
  if (!payload?.errors) return "";
  return JSON.stringify(payload.errors).toLowerCase();
}

async function graphql(fetchImpl, token, query, variables) {
  const response = await fetchImpl(GRAPHQL_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") throw new Error("graphql");
  if (!response.ok && !payload.errors && !payload.data) throw new Error("graphql");
  return payload;
}

async function readMaxDuration(fetchImpl, token, accountTag) {
  try {
    const payload = await graphql(fetchImpl, token, RUM_SETTINGS_QUERY, { accountTag });
    const seconds = Number(payload?.data?.viewer?.accounts?.[0]?.settings?.rumPageloadEventsAdaptiveGroups?.maxDuration);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

function queryFor(withPath, withVisits) {
  if (withPath && withVisits) return ARTICLE_VIEWS_QUERY;
  if (!withPath && withVisits) return ARTICLE_VIEWS_ALL_PATHS_QUERY;
  if (withPath) return ARTICLE_VIEWS_COUNT_QUERY;
  return viewsQuery(false, false);
}

async function readGroups(fetchImpl, token, accountTag, siteTag, window, withPath, withVisits) {
  const payload = await graphql(fetchImpl, token, queryFor(withPath, withVisits), {
    accountTag,
    siteTag,
    since: window.since.toISOString(),
    until: window.until.toISOString(),
  });
  const text = errorText(payload);
  if (payload.errors?.length) {
    return {
      rangeError: /time range|wider than|maxduration|max duration/.test(text),
      pathError: withPath && /requestpath/.test(text),
      visitsError: withVisits && /visits/.test(text),
      groups: null,
    };
  }
  const groups = payload?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups;
  if (!Array.isArray(groups)) return { groups: null };
  return { groups };
}

async function queryArticleStats(fetchImpl, token, accountTag, siteTag, now) {
  const maxDuration = await readMaxDuration(fetchImpl, token, accountTag);
  let window = chooseWindow(now, maxDuration);
  let withPath = true;
  let withVisits = true;
  let found = await readGroups(fetchImpl, token, accountTag, siteTag, window, withPath, withVisits);
  if (found.rangeError) {
    const shorter = chooseWindow(now, Math.min(maxDuration || FALLBACK_WINDOW_SECONDS, FALLBACK_WINDOW_SECONDS));
    if (shorter.until - shorter.since < window.until - window.since - 1000) {
      window = shorter;
      found = await readGroups(fetchImpl, token, accountTag, siteTag, window, withPath, withVisits);
    }
  }
  if (found.pathError) {
    withPath = false;
    found = await readGroups(fetchImpl, token, accountTag, siteTag, window, withPath, withVisits);
  }
  if (found.visitsError) {
    withVisits = false;
    found = await readGroups(fetchImpl, token, accountTag, siteTag, window, withPath, withVisits);
  }
  if (!found.groups) return unavailable(window.windowDays);
  return {
    ok: true,
    windowDays: window.windowDays,
    articles: aggregateArticleStats(found.groups),
  };
}

async function readCache(kv) {
  if (!kv || typeof kv.get !== "function") return null;
  const raw = await kv.get(CACHE_KEY);
  if (!raw || raw.length > 100_000) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.ok !== "boolean" || typeof parsed.windowDays !== "number") return null;
  if (!parsed.articles || typeof parsed.articles !== "object" || Array.isArray(parsed.articles)) return null;
  return parsed;
}

async function writeCache(kv, value) {
  if (!kv || typeof kv.put !== "function") return;
  await kv.put(CACHE_KEY, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS });
}

export async function loadArticleStats(env, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => new Date());
  const token = cleanSecret(env?.CF_ANALYTICS_TOKEN);
  const accountTag = cleanId(env?.CF_ACCOUNT_ID);
  const siteTag = cleanId(env?.CF_RUM_SITE_TAG);
  if (!token || !accountTag || !siteTag) return unavailable();

  const kv = env.SESSIONS;
  try {
    const cached = await readCache(kv);
    if (cached) return cached;
  } catch {
    // Un cache illisible ne doit pas empêcher d'afficher la page d'écriture.
  }

  try {
    const result = await queryArticleStats(fetchImpl, token, accountTag, siteTag, now());
    try {
      await writeCache(kv, result);
    } catch {
      // La réponse reste utilisable même si le cache refuse l'écriture.
    }
    return result;
  } catch (error) {
    console.error("stats", String(error?.message || "erreur").slice(0, 200));
    const failed = unavailable();
    try {
      await writeCache(kv, failed);
    } catch {
      // Rien à faire : la page d'écriture reçoit un résultat vide.
    }
    return failed;
  }
}
