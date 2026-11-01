import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DASHBOARD_RULES } from "../app/dashboard-rules.ts";
import { resolveGoogleAdsLeadChannels, resolveSheetMonthRequests } from "../app/google-ads-leads.ts";

test("Google Ads lead attribution always uses the three stable source IDs, independent of cost selectors", () => {
  const channels = DEFAULT_DASHBOARD_RULES.channels.map(channel => ({
    ...channel,
    costMode: channel.id === "whatsapp" || channel.id === "site_form" ? "none" : channel.costMode,
  }));
  assert.deepEqual(resolveGoogleAdsLeadChannels(channels), ["گوگل ادز", "واتساپ", "فرم سایت"]);
});

test("Google Ads lead labels follow brand renames but unrelated paid channels never enter the fixed group", () => {
  const channels = DEFAULT_DASHBOARD_RULES.channels.map(channel => channel.id === "site_form" ? { ...channel, name: "فرم وب‌سایت" } : channel)
    .concat({ id: "telegram", name: "تلگرام", aliases: ["تلگرام"], costMode: "google_ads", contractorEnabled: false, color: "blue", icon: "T", enabled: true });
  assert.deepEqual(resolveGoogleAdsLeadChannels(channels), ["گوگل ادز", "واتساپ", "فرم وب‌سایت"]);
});

test("a newly published range month is fetched by label when registry discovery is stale", () => {
  const requests = resolveSheetMonthRequests([
    { value: "1405/05", label: "مرداد 1405" },
    { value: "1405/06", label: "شهریور 1405" },
  ], [{ value: "1405/05", label: "مرداد 1405", gid: "41", sheetName: "مرداد 1405" }]);
  assert.deepEqual(requests, [
    { value: "1405/05", label: "مرداد 1405", gid: "41", sheetName: "مرداد 1405" },
    { value: "1405/06", label: "شهریور 1405", gid: "" },
  ]);
});

test("every month in a multi-month range remains present exactly once", () => {
  const requested = ["1405/04", "1405/05", "1405/06"].map((value, index) => ({ value, label: `ماه ${index + 1}` }));
  const result = resolveSheetMonthRequests(requested, [{ ...requested[1], gid: "52" }]);
  assert.deepEqual(result.map(month => month.value), requested.map(month => month.value));
  assert.equal(result[0].gid, "");
  assert.equal(result[1].gid, "52");
  assert.equal(result[2].gid, "");
});
