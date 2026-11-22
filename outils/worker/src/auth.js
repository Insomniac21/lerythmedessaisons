const SESSION_TTL_SECONDS = 60 * 60 * 12;
const FAIL_TTL_SECONDS = 60 * 30;
const MAX_FAILURES = 8;
const PUBLISH_TTL_SECONDS = 60 * 60;
const MAX_PUBLISHES = 30;

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "local";
}

export function configuredSecrets(env) {
  return [env.AUTH_SECRET_ZACKARY, env.AUTH_SECRET_PARENT]
    .map((secret) => (typeof secret === "string" ? secret.trim() : ""))
    .filter((secret) => secret.length >= 10);
}

export function publishingReady(env) {
  return configuredSecrets(env).length > 0 && typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim().length > 0;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function passphraseMatches(passphrase, secrets) {
  const given = await sha256(passphrase);
  let ok = false;
  for (const secret of secrets) {
    const digest = await sha256(secret);
    if (safeEqual(given, digest)) ok = true;
  }
  return ok;
}

function usableSecret(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length >= 10 ? trimmed : "";
}

export async function matchRole(passphrase, env) {
  const zackary = usableSecret(env?.AUTH_SECRET_ZACKARY);
  const parent = usableSecret(env?.AUTH_SECRET_PARENT);
  const given = await sha256(passphrase);
  const parentDigest = await sha256(parent || passphrase);
  const zackaryDigest = await sha256(zackary || passphrase);
  const parentOk = Boolean(parent) && safeEqual(given, parentDigest);
  const zackaryOk = Boolean(zackary) && safeEqual(given, zackaryDigest);
  if (parentOk && zackaryOk && parent === zackary) return "parent";
  if (parentOk && !zackaryOk) return "parent";
  if (zackaryOk && !parentOk) return "zackary";
  return null;
}

export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assertNotLocked(kv, ip) {
  const count = Number(await kv.get(`fail:${ip}`) || 0);
  if (count >= MAX_FAILURES) {
    const error = new Error("trop-dessais");
    error.code = "trop-dessais";
    throw error;
  }
}

export async function recordFailure(kv, ip) {
  const count = Number(await kv.get(`fail:${ip}`) || 0) + 1;
  await kv.put(`fail:${ip}`, String(count), { expirationTtl: FAIL_TTL_SECONDS });
}

export async function clearFailures(kv, ip) {
  await kv.delete(`fail:${ip}`);
}

export async function createSession(kv, role) {
  const token = randomToken();
  const stored = role === "parent" ? "parent" : "zackary";
  await kv.put(`sess:${token}`, stored, { expirationTtl: SESSION_TTL_SECONDS });
  return { token, expiresIn: SESSION_TTL_SECONDS, role: stored };
}

export async function readSession(kv, request) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const found = await kv.get(`sess:${token}`);
  if (found !== "zackary" && found !== "parent") return null;
  return { token, role: found };
}

export async function deleteSession(kv, token) {
  if (token) await kv.delete(`sess:${token}`);
}

export async function assertPublishBudget(kv, ip) {
  const count = Number(await kv.get(`post:${ip}`) || 0);
  if (count >= MAX_PUBLISHES) {
    const error = new Error("trop-vite");
    error.code = "trop-vite";
    throw error;
  }
}

export async function recordPublish(kv, ip) {
  const count = Number(await kv.get(`post:${ip}`) || 0) + 1;
  await kv.put(`post:${ip}`, String(count), { expirationTtl: PUBLISH_TTL_SECONDS });
}
