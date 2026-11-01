import assert from "node:assert/strict";
import test from "node:test";

import { buildExpertAllocationDiagnostic } from "../app/financial-diagnostics.ts";

test("explains which channel and lead rows caused an expert allocation mismatch", () => {
  const result = buildExpertAllocationDiagnostic({
    scope: "بازه 1 مرداد تا 31 مرداد",
    channel: "پیامک",
    channelCost: 69_000_000,
    allocatedCost: 68_687_783,
    channelLeads: 221,
    expertLeads: 220,
    balanced: false,
  });
  assert.match(result.title, /پیامک/);
  assert.match(result.diagnosis, /221/);
  assert.match(result.diagnosis, /220/);
  assert.match(result.diagnosis, /1 ردیف کمتر/);
  assert.match(result.resolution, /سلامت داده/);
  assert.match(result.resolution, /بروزرسانی دستی/);
});

test("distinguishes cost-without-leads from an internal calculation mismatch", () => {
  const noLeads = buildExpertAllocationDiagnostic({ scope: "امروز", channel: "اینستاگرام", channelCost: 1_000_000, allocatedCost: 0, channelLeads: 0, expertLeads: 0, balanced: false });
  assert.match(noLeads.diagnosis, /هیچ لیدی وجود ندارد/);
  assert.match(noLeads.resolution, /ثبت بودجه تبلیغات/);

  const internal = buildExpertAllocationDiagnostic({ scope: "امروز", channel: "گوگل ادز", channelCost: 1_000_000, allocatedCost: 999_000, channelLeads: 10, expertLeads: 10, balanced: false });
  assert.match(internal.diagnosis, /اختلاف محاسباتی/);
  assert.match(internal.resolution, /بودجه یا اطلاعات Google Sheets را صرفاً برای برابرکردن عدد تغییر ندهید/);
});
