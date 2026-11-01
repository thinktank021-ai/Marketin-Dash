/** A health-check failure is not a revoked source approval. Editing the source
 * returns the brand to draft; an active brand may retry or use same-source cache. */
export function canReadBrandSource(brand: { configStatus: string; sheetCsvUrl: string }) {
  return brand.configStatus === "active" && Boolean(brand.sheetCsvUrl);
}
