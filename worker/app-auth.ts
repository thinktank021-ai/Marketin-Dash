import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

type Statement = { bind(...values: unknown[]): Statement; first<T = Record<string, unknown>>(): Promise<T | null>; run(): Promise<unknown> };
export type AppAuthEnv = {
  DB: { prepare(sql: string): Statement };
  DASHBOARD_ADMIN_USER?: string;
  DASHBOARD_ADMIN_PASSWORD_HASH?: string;
};
const COOKIE = "__Host-dashboard_session";
const WINDOW_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 20 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const resolveEnv = (env?: AppAuthEnv): AppAuthEnv => {
  if (env?.DB) return env;
  const globalEnv = (globalThis as unknown as { __CLOUDFLARE_ENV?: AppAuthEnv }).__CLOUDFLARE_ENV;
  return globalEnv || env || ({} as AppAuthEnv);
};
const database = (env: AppAuthEnv) => resolveEnv(env).DB;
const noStore = { "cache-control": "no-store, private", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...noStore, ...extra } });

/** N=16384,r=8,p=5 provides a memory-bounded scrypt password verifier on Workers. */
export function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [format, salt, hex] = encoded.split(":");
  if (format !== "scrypt-v1" || !/^[a-f0-9]{32}$/.test(salt || "") || !/^[a-f0-9]{64}$/.test(hex || "")) return false;
  return timingSafeEqual(await derivePassword(password, salt), Buffer.from(hex, "hex"));
}
function cookieToken(request: Request) {
  const pairs = (request.headers.get("cookie") || "").split(";").map(value => value.trim());
  const matches = pairs.filter(value => value.startsWith(`${COOKIE}=`));
  const token = matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : "";
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function credentialVersion(env: AppAuthEnv) {
  const e = resolveEnv(env);
  return digest(`${e.DASHBOARD_ADMIN_USER || "Admin"}:${e.DASHBOARD_ADMIN_PASSWORD_HASH || ""}`);
}
export async function isAppAuthenticated(request: Request, env: AppAuthEnv, now = Date.now()) {
  env = resolveEnv(env);
  if (!env.DASHBOARD_ADMIN_PASSWORD_HASH) return false;
  const token = cookieToken(request);
  if (!token) return false;
  const row = await database(env).prepare("SELECT credential_version, expires_at FROM dashboard_login_sessions WHERE token_hash = ?").bind(digest(token)).first<{ credential_version: string; expires_at: number }>();
  return Boolean(row && row.expires_at > now && row.credential_version === credentialVersion(env));
}
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const requestUrl = new URL(request.url);
  if (origin === requestUrl.origin) return true;
  try {
    const originUrl = new URL(origin);
    const effectiveHost = request.headers.get("x-forwarded-host") || request.headers.get("host") || requestUrl.host;
    if (originUrl.host.toLowerCase() === effectiveHost.toLowerCase()) return true;
  } catch {
    return false;
  }
  return false;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** This second gate never replaces Sites' private-access policy. Every application API is protected. */
export async function guardAppRequest(request: Request, env: AppAuthEnv): Promise<Response | null> {
  env = resolveEnv(env);
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/login" || path === "/login/" || path.startsWith("/assets/") || path === "/favicon.ico") return null;
  try {
    if (path === "/api/auth/login") {
      if (request.method !== "POST") return json({ error: "روش درخواست مجاز نیست." }, 405);
      if (!sameOrigin(request)) return json({ error: "درخواست ورود معتبر نیست." }, 403);
      if (!env.DASHBOARD_ADMIN_PASSWORD_HASH || !/^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{64}$/.test(env.DASHBOARD_ADMIN_PASSWORD_HASH)) return json({ error: "ورود آزمایشی هنوز پیکربندی نشده است؛ با مسئول سامانه تماس بگیرید." }, 503);
      if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "درخواست ورود معتبر نیست." }, 415);
      if (Number(request.headers.get("content-length") || 0) > 4096) return json({ error: "درخواست بیش از حد بزرگ است." }, 413);
      const raw = await request.text();
      if (raw.length > 4096) return json({ error: "درخواست بیش از حد بزرگ است." }, 413);
      let body: { username?: unknown; password?: unknown; remember?: unknown };
      try { body = JSON.parse(raw); } catch { return json({ error: "درخواست ورود معتبر نیست." }, 400); }
      if (!body || typeof body.username !== "string" || typeof body.password !== "string" || body.username.length > 100 || body.password.length > 256) return json({ error: "نام کاربری یا رمز عبور صحیح نیست." }, 400);
      const now = Date.now();
      // A global single-account bucket prevents bypass by changing username or IP.
      const bucket = `admin:${Math.floor(now / WINDOW_MS)}`;
      const result = await database(env).prepare("INSERT INTO dashboard_login_attempts (bucket, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts").bind(bucket, now + WINDOW_MS).first<{ attempts: number }>();
      if (!result || result.attempts > 10) return json({ error: "تعداد تلاش‌ها زیاد است؛ حداکثر ۱۵ دقیقه دیگر دوباره امتحان کنید." }, 429, { "retry-after": String(Math.ceil((WINDOW_MS - now % WINDOW_MS) / 1000)) });
      const valid = await verifyPassword(body.password, env.DASHBOARD_ADMIN_PASSWORD_HASH);
      if (!valid || body.username.trim() !== (env.DASHBOARD_ADMIN_USER || "Admin")) return json({ error: "نام کاربری یا رمز عبور صحیح نیست." }, 401);
      const token = randomBytes(32).toString("hex");
      // Twenty minutes of inactivity. Only explicit user activity can renew it.
      const expiresAt = Date.now() + SESSION_TTL_MS;
      const previous = cookieToken(request);
      if (previous) await database(env).prepare("DELETE FROM dashboard_login_sessions WHERE token_hash = ?").bind(digest(previous)).run();
      await database(env).prepare("INSERT INTO dashboard_login_sessions (token_hash, credential_version, expires_at) VALUES (?, ?, ?)").bind(digest(token), credentialVersion(env), expiresAt).run();
      await database(env).prepare("DELETE FROM dashboard_login_sessions WHERE expires_at <= ?").bind(now).run();
      await database(env).prepare("DELETE FROM dashboard_login_attempts WHERE expires_at <= ? OR bucket = ?").bind(now, bucket).run();
      return json({ authenticated: true, expiresAt, serverNow: Date.now() }, 200, { "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1200` });
    }
    if (path === "/api/auth/logout") {
      if (request.method !== "POST") return json({ error: "روش درخواست مجاز نیست." }, 405);
      if (!sameOrigin(request)) return json({ error: "درخواست خروج معتبر نیست." }, 403);
      const token = cookieToken(request);
      if (token) await database(env).prepare("DELETE FROM dashboard_login_sessions WHERE token_hash = ?").bind(digest(token)).run();
      return json({ signedOut: true }, 200, { "set-cookie": clearCookie });
    }
    if (path === "/api/auth/activity") {
      if (request.method !== "POST") return json({ error: "روش درخواست مجاز نیست." }, 405);
      if (!sameOrigin(request)) return json({ error: "مبدأ درخواست معتبر نیست." }, 403);
      const token = cookieToken(request);
      const now = Date.now();
      // Atomic renewal cannot resurrect an expired/revoked session. Ordinary API
      // requests and session checks deliberately never write the expiry.
      const row = token && env.DASHBOARD_ADMIN_PASSWORD_HASH ? await database(env).prepare("UPDATE dashboard_login_sessions SET expires_at = MAX(expires_at, ?) WHERE token_hash = ? AND credential_version = ? AND expires_at > ? RETURNING expires_at")
        .bind(now + SESSION_TTL_MS, digest(token), credentialVersion(env), now).first<{ expires_at: number }>() : null;
      if (!row) return json({ authenticated: false }, 401, { "set-cookie": clearCookie });
      return json({ authenticated: true, expiresAt: row.expires_at, serverNow: Date.now() }, 200, { "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1200` });
    }
    // The external Apps Script scheduler has no dashboard session cookie. The
    // route performs its own encrypted-secret check before dispatching data.
    if (path === "/api/telegram-bot" && request.method === "POST" && request.headers.has("x-telegram-scheduler-secret")) {
      // Only the authenticated scheduler action can bypass dashboard login.
      // The API verifies the secret; every other action still requires a session.
      if (request.headers.get("content-type")?.includes("application/json")) {
        const declaredSize = Number(request.headers.get("content-length") || 0);
        if (declaredSize <= 2048) {
          const raw = await request.clone().text();
          if (raw.length <= 2048) {
            let payload: unknown = null;
            try { payload = JSON.parse(raw); } catch { /* Invalid input is not a scheduler request. */ }
            if (payload && typeof payload === "object" && !Array.isArray(payload) &&
              (payload as { action?: unknown }).action === "scheduler") return null;
          }
        }
      }
    }
    const authenticated = await isAppAuthenticated(request, env);
    if (path === "/api/auth/session") {
      const token = cookieToken(request);
      const row = authenticated && token ? await database(env).prepare("SELECT expires_at FROM dashboard_login_sessions WHERE token_hash = ?").bind(digest(token)).first<{ expires_at: number }>() : null;
      return json({ authenticated, expiresAt: row?.expires_at, serverNow: Date.now() }, authenticated ? 200 : 401);
    }
    if (!authenticated) {
      if (path.startsWith("/api/") || request.headers.get("rsc")) return json({ error: "نشست ورود پایان یافته است؛ دوباره وارد شوید.", code: "APP_LOGIN_REQUIRED" }, 401, { "x-dashboard-auth-required": "1" });
      return new Response(null, { status: 303, headers: { ...noStore, location: "/login", "set-cookie": clearCookie } });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !sameOrigin(request)) return json({ error: "مبدأ درخواست معتبر نیست." }, 403);
    return null;
  } catch {
    // Fail closed without logging submitted credentials, session tokens, or DB contents.
    return json({ error: "بررسی ورود موقتاً ممکن نیست؛ دوباره تلاش کنید." }, 503);
  }
}
