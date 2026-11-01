import { getD1 } from "../../../db";

/** Update only the approved source actually read by this request. Never activate
 * drafts or write over a source edited while the request was in flight. */
export async function recordSheetHealth(brandId: string, sourceUrl: string, status: "connected" | "warning", message: string) {
  await getD1().prepare(`UPDATE dashboard_brands SET sheet_status = ?, sheet_message = ?
    WHERE id = ? AND sheet_csv_url = ? AND config_status = 'active'
    AND (sheet_status != ? OR sheet_message != ?)`)
    .bind(status, message, brandId, sourceUrl, status, message).run();
}
