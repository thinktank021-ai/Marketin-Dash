import assert from "node:assert/strict";
import test from "node:test";
import { nextTableSort, sortTableRows } from "../app/table-sort.ts";

test("a new column starts ascending and repeated clicks toggle direction", () => {
  const first = nextTableSort(null, "cost");
  assert.deepEqual(first, { key: "cost", direction: "asc" });
  assert.deepEqual(nextTableSort(first, "cost"), { key: "cost", direction: "desc" });
  assert.deepEqual(nextTableSort({ key: "clicks", direction: "desc" }, "cost"), { key: "cost", direction: "asc" });
});

test("numeric rows sort stably in both directions", () => {
  const rows = [{ id: "a", cost: 20 }, { id: "b", cost: 5 }, { id: "c", cost: 20 }];
  assert.deepEqual(sortTableRows(rows, { key: "cost", direction: "asc" }, (row, key) => row[key]).map(row => row.id), ["b", "a", "c"]);
  assert.deepEqual(sortTableRows(rows, { key: "cost", direction: "desc" }, (row, key) => row[key]).map(row => row.id), ["a", "c", "b"]);
});

test("Persian and numeric names sort naturally", () => {
  const rows = [{ name: "کمپین 10" }, { name: "کمپین 2" }, { name: "استانبول" }];
  const sorted = sortTableRows(rows, { key: "name", direction: "asc" }, (row, key) => row[key]);
  assert.deepEqual(sorted.map(row => row.name), ["استانبول", "کمپین 2", "کمپین 10"]);
});

test("missing calculated metrics remain at the end in both directions", () => {
  const rows = [{ id: "missing", cpl: null }, { id: "high", cpl: 30 }, { id: "low", cpl: 10 }];
  assert.deepEqual(sortTableRows(rows, { key: "cpl", direction: "asc" }, (row, key) => row[key]).map(row => row.id), ["low", "high", "missing"]);
  assert.deepEqual(sortTableRows(rows, { key: "cpl", direction: "desc" }, (row, key) => row[key]).map(row => row.id), ["high", "low", "missing"]);
});

test("no selected header preserves the established campaign order", () => {
  const rows = [{ id: "enabled" }, { id: "paused" }];
  assert.deepEqual(sortTableRows(rows, null, row => row.id), rows);
});
