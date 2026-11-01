import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("range analytics renders malformed runtime payloads without a client render exception", () => {
  const script = `
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { RangeAnalyticsDashboard } from "./app/range-analytics-dashboard.tsx";
    const props = {
      title: "آزمون",
      startDate: "1405/06/01",
      endDate: "1405/06/01",
      dailyCounts: [{ date: "1405/06/01", value: "3", contracts: undefined }],
      dailyChannelCounts: null,
      dailyChannelContracts: null,
      channels: [{ name: "کانال ناقص", color: undefined, keys: undefined }],
      costs: { "کانال ناقص": { costToman: "bad", leads: undefined, contracts: undefined, cpl: undefined, cac: undefined } },
      routes: [{ name: "مسیر ناقص", calls: "bad", contracts: undefined }],
      experts: [{ name: "کارشناس ناقص", calls: null, contracts: "bad", conversion: undefined }],
      selectedChannelFilter: null,
      selectedFilterLabel: null,
      formatDate: date => date,
      onChannelFilter: () => {},
      onBucketSelect: () => {},
      onResetSelection: () => {},
    };
    const html = renderToStaticMarkup(React.createElement(RangeAnalyticsDashboard, props));
    if (!html.includes("rangeAnalytics")) throw new Error("chart markup was not rendered");
    console.log("rendered");
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
    cwd: projectRoot,
    // The parent test runner uses the Cloudflare loader for worker modules;
    // keeping it out of this isolated SSR probe lets tsx expose the component
    // export normally instead of double-transforming the TSX module.
    env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8",
  });
  assert.match(output, /rendered/);
});
