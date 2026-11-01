export function normalizeSearchConsoleProperty(value: string) {
  const property = value.trim();
  if (/^sc-domain:[a-z0-9.-]+$/i.test(property)) return property.toLowerCase();
  try {
    const url = new URL(property);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString();
  } catch { throw new Error("search_console_property_invalid"); }
}
