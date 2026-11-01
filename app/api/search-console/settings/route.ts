import { getBrand } from "../../brands/storage";
import { getPublicSearchConsoleSettings, saveSearchConsoleServiceAccount } from "../service-account";

function settingsError(code: string) {
  if (code === "search_console_property_missing") return "آدرس Property سرچ کنسول وارد نشده است.";
  if (code === "search_console_property_invalid") return "آدرس Property معتبر نیست؛ همان مقدار دقیق نمایش‌داده‌شده در Search Console را وارد کنید.";
  if (code === "search_console_credentials_incomplete") return "فایل JSON حساب سرویس این دفتر هنوز ذخیره نشده است.";
  if (code.includes("json_invalid") || code.includes("key_invalid")) return "فایل JSON معتبر نیست؛ فایل اصلی دانلودشده برای Service Account را وارد کنید.";
  if (code === "search_console_encryption_not_configured") return "ذخیره امن اعتبارنامه در دسترس نیست؛ هیچ اطلاعاتی ذخیره نشد.";
  return "تنظیمات Search Console ذخیره نشد.";
}

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") || "";
    const brand = await getBrand(id);
    if (brand.id !== id) return Response.json({ error: "برند پیدا نشد." }, { status: 404 });
    return Response.json(await getPublicSearchConsoleSettings(id), { headers: { "cache-control": "no-store" } });
  } catch { return Response.json({ error: "تنظیمات Search Console دریافت نشد." }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const id = typeof payload.id === "string" ? payload.id : "";
    const brand = await getBrand(id);
    if (brand.id !== id) return Response.json({ error: "برند پیدا نشد." }, { status: 404 });
    await saveSearchConsoleServiceAccount(id, { propertyUrl: typeof payload.propertyUrl === "string" ? payload.propertyUrl : "", serviceAccountJson: typeof payload.serviceAccountJson === "string" ? payload.serviceAccountJson : "" });
    return Response.json({ saved: true, settings: await getPublicSearchConsoleSettings(id) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return Response.json({ error: settingsError(code) }, { status: 400 });
  }
}
