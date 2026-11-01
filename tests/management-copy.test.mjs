import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("management insight copy stays direct and avoids metaphorical wording", async () => {
  const source = await readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
  for (const phrase of ["جان گرفته", "جان گرفت", "نبض", "شتاب", "ریتم", "جریان ورودی", "جهش قوی", "رو به جلو", "یک گام بهتر"]) {
    assert.equal(source.includes(phrase), false, `forbidden management phrase remains: ${phrase}`);
  }
  assert.match(source, /افزایش قابل‌توجه ورودی ثبت شده/);
  assert.match(source, /تعداد ورودی‌ها تقریباً ثابت است/);
});
