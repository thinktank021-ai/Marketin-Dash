import { getBrand } from "../../brands/storage";
import { getD1 } from "../../../../db";
import { getPublicGoogleAdsSettings, saveGoogleAdsServiceAccount } from "../service-account";
import { adsSetupError } from "../../../google-ads-setup";

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") || "";
    const brand = await getBrand(id);
    if (brand.id !== id) return Response.json({ error: "برند پیدا نشد." }, { status: 404 });
    return Response.json({ ...await getPublicGoogleAdsSettings(id), customerId: brand.googleAdsCustomerId, loginCustomerId: brand.googleAdsLoginCustomerId });
  } catch {
    return Response.json({ error: "تنظیمات Google Ads دریافت نشد." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const id = typeof payload.id === "string" ? payload.id : "";
    const brand = await getBrand(id);
    if (brand.id !== id) return Response.json({ error: "برند پیدا نشد." }, { status: 404 });
    await saveGoogleAdsServiceAccount(id, { serviceAccountJson: typeof payload.serviceAccountJson === "string" ? payload.serviceAccountJson.trim() : "", developerToken: typeof payload.developerToken === "string" ? payload.developerToken.trim() : "" });
    await getD1().prepare("UPDATE dashboard_brands SET google_ads_status = 'pending', google_ads_message = 'Service Account ذخیره شد؛ اتصال را آزمایش کنید.', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return Response.json({ saved: true, settings: await getPublicGoogleAdsSettings(id) });
  } catch (error) {
    const message = adsSetupError(error instanceof Error ? error.message : "");
    return Response.json({ error: message }, { status: 400 });
  }
}
