function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[‌\s_-]+/g, "").trim().toLowerCase();
}

function parseCsvTable(input: string, rowLimit = 50000) {
  const table: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let index = 0; index < input.length && table.length < rowLimit; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); table.push(row); row = []; field = ""; }
    else field += char;
  }
  if (table.length < rowLimit && (field.length || row.length)) { row.push(field.replace(/\r$/, "")); table.push(row); }
  return table;
}

/** Counts only channel labels; passenger fields never leave the server-side Sheet test. */
export function discoverChannelCounts(csv: string, sourceHeader: string) {
  const table = parseCsvTable(csv);
  const sourceIndex = (table[0] || []).findIndex(header => normalizeHeader(header) === normalizeHeader(sourceHeader));
  if (sourceIndex < 0) return {} as Record<string, number>;
  return table.slice(1).reduce<Record<string, number>>((counts, row) => {
    const source = (row[sourceIndex] || "").trim().replace(/ي/g, "ی").replace(/ك/g, "ک");
    if (source) counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
}
