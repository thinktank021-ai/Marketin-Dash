import DashboardClient from "./dashboard-client";
import { DashboardRuntimeBoundary } from "./dashboard-runtime-boundary";
import { getD1 } from "../db";

/** Reads only the non-sensitive Telegram visibility flag before the dashboard client renders. */
async function readInitialTelegramVisibility() {
  try {
    const row = await getD1().prepare("SELECT enabled FROM telegram_bot_settings WHERE id = 1").first<{ enabled: number }>();
    return row?.enabled === 1;
  } catch {
    // A missing or unavailable settings table must never block the dashboard itself.
    return false;
  }
}

export default async function Page() {
  const initialTelegramVisible = await readInitialTelegramVisibility();
  return <DashboardRuntimeBoundary><DashboardClient initialTelegramVisible={initialTelegramVisible}/></DashboardRuntimeBoundary>;
}
