import type { MergeRule } from "./dashboard-rules";

const normalize = (value: string) => value.normalize("NFKC").replace(/ي|ى/g, "ی").replace(/ك/g, "ک").replace(/[\s\u200c\u200d_\-/،,+–—]+/g, "");
const georgiaOnly = (value: string) => /^(?:گرجستان|تفلیس|باتومی)(?:و?(?:گرجستان|تفلیس|باتومی))*$/.test(value);

/** Shared approved rule, including old records and brands with older settings.
 * Full-string matching never absorbs unrelated routes such as Dubai–Tbilisi. */
export function canonicalRoute(value: string, rules: MergeRule[] = []): string {
  const route = value.trim();
  if (!route) return "مسیر ثبت نشده";
  const key = normalize(route);
  if (georgiaOnly(key)) return "گرجستان";
  const rule = rules.find(item => [item.target, ...item.aliases].some(alias => normalize(alias) === key));
  const target = rule?.target.trim() || route;
  return georgiaOnly(normalize(target)) ? "گرجستان" : target;
}
