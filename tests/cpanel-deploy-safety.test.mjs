import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const deploy = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

test("cPanel deploy restarts only the Passenger app without killing all Node workers", () => {
  assert.doesNotMatch(deploy, /pkill\s+-u/);
  assert.match(deploy, /touch tmp\/restart\.txt/);
});

test("deployment never hard-codes or rotates administrator login credentials", () => {
  assert.doesNotMatch(deploy, /node\s+scripts\/set-admin\.mjs/);
});
