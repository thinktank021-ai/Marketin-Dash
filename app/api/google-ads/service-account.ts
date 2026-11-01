import { env } from "cloudflare:workers";
import { getD1 } from "../../../db";

type RuntimeEnv = { GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY?: string };
type ServiceAccountRow = {
  serviceAccountEmail: string;
  projectId: string | null;
  privateKeyEncrypted: string;
  developerTokenEncrypted: string | null;
};
const API_VERSION = "v25";

function bytesToBase64(bytes: Uint8Array) { let binary = ""; bytes.forEach(byte => { binary += String.fromCharCode(byte); }); return btoa(binary); }
function base64ToBytes(value: string) { const binary = atob(value); return Uint8Array.from(binary, character => character.charCodeAt(0)); }

async function encryptionKey() {
  const raw = (env as unknown as RuntimeEnv).GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) throw new Error("google_ads_encryption_not_configured");
  return crypto.subtle.importKey("raw", base64ToBytes(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), new TextEncoder().encode(value));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string) {
  const [iv, payload] = value.split(".");
  if (!iv || !payload) throw new Error("google_ads_secret_invalid");
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, await encryptionKey(), base64ToBytes(payload));
  return new TextDecoder().decode(decrypted);
}

async function getServiceAccountRow(brandId: string) {
  return getD1().prepare(`SELECT service_account_email AS serviceAccountEmail, project_id AS projectId,
    private_key_encrypted AS privateKeyEncrypted, developer_token_encrypted AS developerTokenEncrypted
    FROM brand_google_ads_service_accounts WHERE brand_id = ?`).bind(brandId).first<ServiceAccountRow>();
}

export async function getPublicGoogleAdsSettings(brandId: string) {
  const row = await getServiceAccountRow(brandId);
  return {
    hasDeveloperToken: Boolean(row?.developerTokenEncrypted),
    hasServiceAccount: Boolean(row?.privateKeyEncrypted && row.serviceAccountEmail),
    serviceAccountEmail: row?.serviceAccountEmail || "",
    serviceAccountProjectId: row?.projectId || "",
  };
}

function decodePem(value: string) {
  const body = value.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return base64ToBytes(body).buffer;
}

function b64url(value: ArrayBuffer | Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function saveGoogleAdsServiceAccount(brandId: string, values: { serviceAccountJson?: string; developerToken?: string }) {
  const current = await getServiceAccountRow(brandId);
  let email = current?.serviceAccountEmail || "";
  let projectId = current?.projectId || "";
  let privateKeyEncrypted = current?.privateKeyEncrypted || "";
  if (values.serviceAccountJson?.trim()) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(values.serviceAccountJson) as Record<string, unknown>; } catch { throw new Error("google_ads_service_account_json_invalid"); }
    email = typeof parsed.client_email === "string" ? parsed.client_email.trim() : "";
    const privateKey = typeof parsed.private_key === "string" ? parsed.private_key.trim() : "";
    projectId = typeof parsed.project_id === "string" ? parsed.project_id.trim() : "";
    if (parsed.type !== "service_account" || !email.endsWith(".iam.gserviceaccount.com") || !privateKey.includes("BEGIN PRIVATE KEY")) throw new Error("google_ads_service_account_json_invalid");
    try { await crypto.subtle.importKey("pkcs8", decodePem(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]); } catch { throw new Error("google_ads_service_account_key_invalid"); }
    privateKeyEncrypted = await encryptSecret(privateKey);
  }
  const developerTokenEncrypted = values.developerToken?.trim() ? await encryptSecret(values.developerToken.trim()) : current?.developerTokenEncrypted || "";
  if (!email || !privateKeyEncrypted || !developerTokenEncrypted) throw new Error("google_ads_credentials_incomplete");
  await getD1().prepare(`INSERT INTO brand_google_ads_service_accounts
    (brand_id, service_account_email, project_id, private_key_encrypted, developer_token_encrypted, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(brand_id) DO UPDATE SET service_account_email = excluded.service_account_email,
      project_id = excluded.project_id, private_key_encrypted = excluded.private_key_encrypted,
      developer_token_encrypted = excluded.developer_token_encrypted, updated_at = CURRENT_TIMESTAMP`)
    .bind(brandId, email, projectId || null, privateKeyEncrypted, developerTokenEncrypted).run();
}

async function serviceAccountAccessToken(brandId: string) {
  const row = await getServiceAccountRow(brandId);
  if (!row?.developerTokenEncrypted) throw new Error("google_ads_service_account_missing");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: row.serviceAccountEmail, scope: "https://www.googleapis.com/auth/adwords", aud: "https://oauth2.googleapis.com/token", iat: now - 30, exp: now + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", decodePem(await decryptSecret(row.privateKeyEncrypted)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${b64url(signature)}` }), signal: AbortSignal.timeout(15000) });
  const payload = await response.json() as { access_token?: string; error?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.error || "google_ads_service_account_token_failed");
  return { token: payload.access_token, developerToken: await decryptSecret(row.developerTokenEncrypted) };
}

export async function queryGoogleAds(brandId: string, customerId: string, loginCustomerId: string, query: string) {
  const auth = await serviceAccountAccessToken(brandId);
  const response = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.token}`, "developer-token": auth.developerToken, ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}), "content-type": "application/json" },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json() as Array<{ results?: Array<Record<string, unknown>> }> | { error?: { message?: string } };
  if (!response.ok || !Array.isArray(payload)) throw new Error(!Array.isArray(payload) ? payload.error?.message || `google_ads_api_${response.status}` : `google_ads_api_${response.status}`);
  return payload.flatMap(batch => batch.results || []);
}
