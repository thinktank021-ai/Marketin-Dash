import { ensureBrandStorage } from "../storage";

/** Persists the selected active brand in a secure same-origin cookie before a full data reload. */
export async function POST(request: Request) {
  try {
    const payload = await request.json() as { id?: unknown };
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!/^[a-z][a-z0-9-]{2,40}$/.test(id)) return Response.json({ error: "شناسه برند معتبر نیست." }, { status: 400 });
    const d1 = await ensureBrandStorage();
    const row = await d1.prepare("SELECT config_status AS configStatus FROM dashboard_brands WHERE id = ?").bind(id).first<{ configStatus: string }>();
    if (!row || row.configStatus !== "active") return Response.json({ error: "این برند هنوز فعال نشده است." }, { status: 409 });
    return Response.json({ selected: true }, {
      headers: { "set-cookie": `dashboard_brand=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`, "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "انتخاب برند انجام نشد." }, { status: 500 });
  }
}
