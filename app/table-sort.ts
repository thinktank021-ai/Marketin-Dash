export type SortDirection = "asc" | "desc";
export type TableSortState<Key extends string> = { key: Key; direction: SortDirection } | null;
export type SortableValue = string | number | null | undefined;

/** Keeps the original order until a header is selected and always places missing metrics last. */
export function sortTableRows<Row, Key extends string>(
  rows: Row[],
  sort: TableSortState<Key>,
  valueOf: (row: Row, key: Key) => SortableValue,
) {
  if (!sort) return [...rows];
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const a = valueOf(left.row, sort.key);
    const b = valueOf(right.row, sort.key);
    const aMissing = a === null || a === undefined || (typeof a === "number" && !Number.isFinite(a));
    const bMissing = b === null || b === undefined || (typeof b === "number" && !Number.isFinite(b));
    if (aMissing || bMissing) return aMissing === bMissing ? left.index - right.index : aMissing ? 1 : -1;
    const comparison = typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), "fa", { numeric: true, sensitivity: "base" });
    return (sort.direction === "asc" ? comparison : -comparison) || left.index - right.index;
  }).map(item => item.row);
}

export function nextTableSort<Key extends string>(current: TableSortState<Key>, key: Key): Exclude<TableSortState<Key>, null> {
  return current?.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
    : { key, direction: "asc" };
}
