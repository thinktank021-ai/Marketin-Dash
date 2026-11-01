import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesheets = ["globals.css", "enhancements.css"];

test("uses the dashboard Persian typeface consistently", async () => {
  const css = (
    await Promise.all(
      stylesheets.map((name) =>
        readFile(new URL(`../app/${name}`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");

  assert.doesNotMatch(css, /monospace/i);
  assert.match(
    css,
    /\.dynamicMonthlyCostGrid input::placeholder\{[^}]*font-family:"Vazirmatn Variable"[^}]*direction:rtl[^}]*text-align:right/,
  );
});
