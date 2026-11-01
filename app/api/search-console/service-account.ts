import { env } from "cloudflare:workers";
import { getD1 } from "../../../db";
import { normalizeSearchConsoleProperty } from "../../search-console-setup";

type RuntimeEnv = { GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY?: string };
type SearchConsoleRow = {
  propertyUrl: string;
  serviceAccountEmail: string;
  projectId: string | null;
  privateKeyEncrypted: string;
};

function bytesToBase64(bytes: Uint8Array) { let binary = ""; bytes.forEach(byte => { binary += String.fromCharCode(byte); }); return btoa(binary); }
function base64ToBytes(value: string) { const binary = atob(value); return Uint8Array.from(binary, character => character.charCodeAt(0)); }

async function encryptionKey() {
  const raw = (env as unknown as RuntimeEnv).GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) throw new Error("search_console_encryption_not_configured");
  return crypto.subtle.importKey("raw", base64ToBytes(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), new TextEncoder().encode(value));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function decryptSecret(value: string) {
  const [iv, payload] = value.split(".");
  if (!iv || !payload) throw new Error("search_console_secret_invalid");
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, await encryptionKey(), base64ToBytes(payload));
  return new TextDecoder().decode(decrypted);
}

function decodePem(value: string) {
  const body = value.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return base64ToBytes(body).buffer;
}

function b64url(value: ArrayBuffer | Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function getSearchConsoleRow(brandId: string) {
  return getD1().prepare(`SELECT property_url AS propertyUrl, service_account_email AS serviceAccountEmail,
    project_id AS projectId, private_key_encrypted AS privateKeyEncrypted
    FROM brand_search_console_service_accounts WHERE brand_id = ?`).bind(brandId).first<SearchConsoleRow>();
}

export async function getPublicSearchConsoleSettings(brandId: string) {
  const row = await getSearchConsoleRow(brandId);
  return {
    propertyUrl: row?.propertyUrl || "",
    hasServiceAccount: Boolean(row?.serviceAccountEmail && row.privateKeyEncrypted),
    serviceAccountEmail: row?.serviceAccountEmail || "",
    serviceAccountProjectId: row?.projectId || "",
  };
}

export async function saveSearchConsoleServiceAccount(brandId: string, values: { propertyUrl?: string; serviceAccountJson?: string }) {
  const current = await getSearchConsoleRow(brandId);
  const propertyUrl = values.propertyUrl?.trim() ? normalizeSearchConsoleProperty(values.propertyUrl) : current?.propertyUrl || "";
  let email = current?.serviceAccountEmail || "";
  let projectId = current?.projectId || "";
  let privateKeyEncrypted = current?.privateKeyEncrypted || "";
  if (values.serviceAccountJson?.trim()) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(values.serviceAccountJson) as Record<string, unknown>; } catch { throw new Error("search_console_service_account_json_invalid"); }
    email = typeof parsed.client_email === "string" ? parsed.client_email.trim() : "";
    projectId = typeof parsed.project_id === "string" ? parsed.project_id.trim() : "";
    const privateKey = typeof parsed.private_key === "string" ? parsed.private_key.trim() : "";
    if (parsed.type !== "service_account" || !email.endsWith(".iam.gserviceaccount.com") || !privateKey.includes("BEGIN PRIVATE KEY")) throw new Error("search_console_service_account_json_invalid");
    try { await crypto.subtle.importKey("pkcs8", decodePem(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]); } catch { throw new Error("search_console_service_account_key_invalid"); }
    privateKeyEncrypted = await encryptSecret(privateKey);
  }
  if (!propertyUrl) throw new Error("search_console_property_missing");
  if (!email || !privateKeyEncrypted) throw new Error("search_console_credentials_incomplete");
  await getD1().prepare(`INSERT INTO brand_search_console_service_accounts
    (brand_id, property_url, service_account_email, project_id, private_key_encrypted, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(brand_id) DO UPDATE SET property_url = excluded.property_url,
      service_account_email = excluded.service_account_email, project_id = excluded.project_id,
      private_key_encrypted = excluded.private_key_encrypted, updated_at = CURRENT_TIMESTAMP`)
    .bind(brandId, propertyUrl, email, projectId || null, privateKeyEncrypted).run();
}

async function accessToken(brandId: string) {
  const row = await getSearchConsoleRow(brandId);
  if (!row?.privateKeyEncrypted) throw new Error("search_console_service_account_missing");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: row.serviceAccountEmail, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: "https://oauth2.googleapis.com/token", iat: now - 30, exp: now + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", decodePem(await decryptSecret(row.privateKeyEncrypted)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${b64url(signature)}` }), signal: AbortSignal.timeout(15000) });
  const payload = await response.json() as { access_token?: string; error?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.error || "search_console_token_failed");
  return { token: payload.access_token, propertyUrl: row.propertyUrl };
}

export async function getSearchConsoleProperty(brandId: string) {
  const auth = await accessToken(brandId);
  const response = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(auth.propertyUrl)}`, { headers: { authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(15000) });
  const payload = await response.json() as { siteUrl?: string; permissionLevel?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `search_console_api_${response.status}`);
  return payload;
}

export async function querySearchConsole(brandId: string, body: Record<string, unknown>) {
  const auth = await accessToken(brandId);
  const response = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(auth.propertyUrl)}/searchAnalytics/query`, {
    method: "POST", headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json() as { rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>; metadata?: Record<string, unknown>; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `search_console_api_${response.status}`);
  return payload;
}
