export type NormalizedPhone = {
  valid: boolean;
  normalized: string;
  kind: "iran" | "international" | "invalid";
  reason?: "empty" | "invalid_iran" | "missing_country_code" | "invalid_length";
};

/** Converts Persian and Arabic numerals without changing the original Sheet value. */
export function toEnglishPhoneDigits(value: string) {
  return value
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function normalizePersianDate(value: string) {
  const normalized = toEnglishPhoneDigits(value).replace(/[.-]/g, "/").trim();
  const match = normalized.match(/^(1\d{3})\/(\d{1,2})\/(\d{1,2})$/);
  return match ? `${match[1]}/${match[2].padStart(2, "0")}/${match[3].padStart(2, "0")}` : "";
}

/** Chooses a valid initial extraction range and never defaults beyond today. */
export function resolveExtractionDateRange(defaultStart: string, defaultEnd: string, today: string, availableMonths: string[]) {
  const normalizedToday = normalizePersianDate(today);
  const todayMonth = normalizedToday.slice(0, 7);
  const normalizedStart = normalizePersianDate(defaultStart);
  const normalizedEnd = normalizePersianDate(defaultEnd);
  const eligibleMonths = [...new Set(availableMonths)].filter(month => month <= todayMonth).sort((a, b) => b.localeCompare(a));
  const requestedMonth = normalizedStart.slice(0, 7);
  const initialMonth = eligibleMonths.includes(requestedMonth) ? requestedMonth : eligibleMonths[0] || todayMonth;
  const startDate = requestedMonth === initialMonth ? normalizedStart : `${initialMonth}/01`;
  let endDate = normalizedEnd && normalizedEnd <= normalizedToday ? normalizedEnd : normalizedToday;
  if (endDate < startDate) {
    const monthNumber = Number(initialMonth.slice(5, 7));
    const lastDay = monthNumber <= 6 ? "31" : monthNumber <= 11 ? "30" : "29";
    endDate = [`${initialMonth}/${lastDay}`, normalizedToday].sort()[0];
  }
  return { startDate, endDate };
}

/** Normalizes Iranian mobiles and structurally valid international E.164-style numbers. */
export function normalizePhoneNumber(rawValue: string): NormalizedPhone {
  let raw = toEnglishPhoneDigits(String(rawValue || "")).trim();
  if (!raw) return { valid: false, normalized: "", kind: "invalid", reason: "empty" };

  // Google Sheets may export a numeric phone cell in scientific notation.
  if (/^\d(?:\.\d+)?e\+?\d+$/i.test(raw)) {
    const expanded = Number(raw);
    if (Number.isSafeInteger(expanded)) raw = expanded.toFixed(0);
  }

  const hasPlus = raw.startsWith("+");
  const hasInternationalPrefix = raw.startsWith("00");
  const compact = raw.replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(compact)) return { valid: false, normalized: "", kind: "invalid", reason: "invalid_length" };

  const digits = compact.replace(/^\+/, "");
  if (/^09\d{9}$/.test(digits)) return { valid: true, normalized: `+98${digits.slice(1)}`, kind: "iran" };
  // Sheets often removes the leading zero when a mobile cell is stored as a number.
  if (/^9\d{9}$/.test(digits)) return { valid: true, normalized: `+98${digits}`, kind: "iran" };
  if (/^989\d{9}$/.test(digits)) return { valid: true, normalized: `+${digits}`, kind: "iran" };
  if (/^00989\d{9}$/.test(digits)) return { valid: true, normalized: `+${digits.slice(2)}`, kind: "iran" };
  if (digits.startsWith("09") || digits.startsWith("989") || digits.startsWith("0098")) {
    return { valid: false, normalized: "", kind: "invalid", reason: "invalid_iran" };
  }

  const internationalDigits = hasInternationalPrefix ? digits.slice(2) : digits;
  if (!hasPlus && !hasInternationalPrefix) {
    return { valid: false, normalized: "", kind: "invalid", reason: "missing_country_code" };
  }
  if (!/^[1-9]\d{7,14}$/.test(internationalDigits)) {
    return { valid: false, normalized: "", kind: "invalid", reason: "invalid_length" };
  }
  return { valid: true, normalized: `+${internationalDigits}`, kind: "international" };
}

/** Locates the phone cell even when a brand uses an unconfigured or unexpected column title. */
export function findPhoneCellValue(row: Record<string, string>, preferredHeaders: string[] = []) {
  const normalizeHeader = (value: string) => value.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[\s‌_-]+/g, "").trim();
  const entries = Object.entries(row).filter(([header, value]) => !header.startsWith("__") && Boolean(value?.trim()));
  const preferred = ["شماره تماس", "شماره موبایل", "موبایل", "تلفن همراه", "شماره تلفن", "تلفن", "شماره", ...preferredHeaders].map(normalizeHeader);
  const titled = entries.find(([header]) => {
    const normalized = normalizeHeader(header);
    return preferred.includes(normalized) || /(?:شماره.*(?:تماس|موبایل|همراه|تلفن)|(?:موبایل|تلفن|همراه).*)/.test(normalized);
  });
  if (titled?.[1]) return titled[1].trim();
  return entries.find(([, value]) => extractPhoneNumbers(value).length > 0)?.[1].trim() || "";
}

export type ExtractedPhone = NormalizedPhone & { raw: string };

/** Finds every valid phone in one Sheet cell, including slash/comma/newline-separated values. */
export function extractPhoneNumbers(rawValue: string): ExtractedPhone[] {
  const raw = toEnglishPhoneDigits(String(rawValue || "")).trim();
  if (!raw) return [];
  const direct = normalizePhoneNumber(raw);
  if (direct.valid) return [{ ...direct, raw }];

  const candidates: string[] = [];
  const segments = raw.split(/[\n\r,،;؛/|\\]+/).map(value => value.trim()).filter(Boolean);
  const iranianPattern = /(?:\+98|0098|98|0)9(?:[\s().-]*\d){9}/g;
  const internationalPattern = /(?:\+|00)[1-9](?:[\s().-]*\d){7,14}/g;
  segments.forEach(segment => {
    const normalizedSegment = normalizePhoneNumber(segment);
    if (normalizedSegment.valid) candidates.push(segment);
    else {
      candidates.push(...(segment.match(iranianPattern) || []));
      candidates.push(...(segment.match(internationalPattern) || []));
    }
  });

  const seen = new Set<string>();
  return candidates.flatMap(candidate => {
    const phone = normalizePhoneNumber(candidate);
    if (!phone.valid || seen.has(phone.normalized)) return [];
    seen.add(phone.normalized);
    return [{ ...phone, raw: candidate.trim() }];
  });
}

export type PhoneFilterableRecord = {
  channel: string;
  route: string;
  expert: string;
  outcome: string;
  contractStatus: "قرارداد شده" | "قرارداد نشده";
  phoneKind: "iran" | "international" | "invalid";
};

/** Applies every multi-select and single-select extraction filter with AND between groups. */
export function matchesPhoneFilters(record: PhoneFilterableRecord, filters: {
  channels: string[];
  routes: string[];
  experts: string[];
  outcomes: string[];
  contract: "all" | "contracted" | "not-contracted";
  phoneKind: "all" | "iran" | "international";
}) {
  return (!filters.channels.length || filters.channels.includes(record.channel)) &&
    (!filters.routes.length || filters.routes.includes(record.route)) &&
    (!filters.experts.length || filters.experts.includes(record.expert)) &&
    (!filters.outcomes.length || filters.outcomes.includes(record.outcome)) &&
    (filters.contract === "all" || (filters.contract === "contracted") === (record.contractStatus === "قرارداد شده")) &&
    (filters.phoneKind === "all" || record.phoneKind === filters.phoneKind);
}

/** Quotes every CSV value and neutralizes spreadsheet formulas while preserving phone prefixes. */
export function csvCell(value: unknown) {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildCsv(headers: string[], rows: Array<Record<string, unknown>>) {
  return `\uFEFF${[headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n")}`;
}
