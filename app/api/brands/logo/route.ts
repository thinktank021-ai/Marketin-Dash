import { env } from "cloudflare:workers";
import { ensureBrandStorage } from "../storage";

type LogoRuntime = { BUCKET?: R2Bucket };
const ALLOWED_TYPES = new Set(["image/png", "image/webp", "image/jpeg"]);

/** Serves a stored brand logo with immutable caching while keeping bucket keys private. */
export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") || "";
    const d1 = await ensureBrandStorage();
    const row = await d1.prepare("SELECT logo_key AS logoKey FROM dashboard_brands WHERE id = ?").bind(id).first<{ logoKey: string | null }>();
    if (!row?.logoKey) return new Response("Not found", { status: 404 });
    const object = await (env as unknown as LogoRuntime).BUCKET?.get(row.logoKey);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "image/png", "cache-control": "public, max-age=31536000, immutable" } });
  } catch { return new Response("Logo unavailable", { status: 500 }); }
}

/** Validates and persists one compact raster logo for the selected brand. */
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const id = String(form.get("id") || "");
    const file = form.get("logo");
    if (!/^[a-z][a-z0-9-]{2,40}$/.test(id) || !(file instanceof File) || !ALLOWED_TYPES.has(file.type) || file.size < 1 || file.size > 1_500_000) {
      return Response.json({ error: "لوگو باید PNG، WebP یا JPG و حداکثر 1.5MB باشد." }, { status: 400 });
    }
    const bucket = (env as unknown as LogoRuntime).BUCKET;
    if (!bucket) throw new Error("logo_storage_unavailable");
    const extension = file.type === "image/webp" ? "webp" : file.type === "image/jpeg" ? "jpg" : "png";
    const key = `brand-logos/${id}/${crypto.randomUUID()}.${extension}`;
    await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    const d1 = await ensureBrandStorage();
    const existing = await d1.prepare("SELECT logo_key AS logoKey FROM dashboard_brands WHERE id = ?").bind(id).first<{ logoKey: string | null }>();
    await d1.prepare("UPDATE dashboard_brands SET logo_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(key, id).run();
    if (existing?.logoKey) await bucket.delete(existing.logoKey);
    return Response.json({ saved: true, logoUrl: `/api/brands/logo?id=${encodeURIComponent(id)}&v=${Date.now()}` });
  } catch {
    return Response.json({ error: "ذخیره لوگو انجام نشد؛ دوباره تلاش کنید." }, { status: 500 });
  }
}
