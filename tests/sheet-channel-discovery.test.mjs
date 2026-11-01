import assert from "node:assert/strict";
import test from "node:test";

import { discoverChannelCounts } from "../app/sheet-channel-discovery.ts";

test("discovers and counts new channel names from Sheet CSV without exposing other fields", () => {
  const csv = [
    "تاریخ,منبع فایل,شماره تماس,کارشناس",
    "1405/06/01,تلگرام,09120000000,الف",
    "1405/06/02,Telegram,09121111111,ب",
    "1405/06/03,تلگرام,09122222222,الف",
    "1405/06/04,,09123333333,ج",
  ].join("\n");
  assert.deepEqual(discoverChannelCounts(csv, "منبع فایل"), { "تلگرام": 2, Telegram: 1 });
  assert.deepEqual(discoverChannelCounts(csv, "کانال ناموجود"), {});
});
