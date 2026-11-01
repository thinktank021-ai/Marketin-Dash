import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile picker is viewport-contained and cannot be clipped by RTL cards", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.datePicker \.persianCalendar,[\s\S]*position:fixed!important/);
  assert.match(css, /\.selectedDateSection \.persianCalendar,[\s\S]*left:12px!important/);
  assert.match(css, /max-height:calc\(100svh - 24px\)!important/);
  assert.match(css, /\.adsWorkspace \.persianCalendar\{right:8px!important;left:8px!important/);
});

test("mobile navigation reserves the trigger and removes overlap while open", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.mobileMenuTrigger\{position:fixed[\s\S]*right:14px;left:auto/);
  assert.match(css, /\.topbar\{padding-right:62px\}/);
  assert.match(css, /\.dashboard\.mobileMenuOpen \.mobileMenuTrigger\{opacity:0;visibility:hidden;pointer-events:none/);
});

test("desktop canvas can use the extra reading width without changing card internals", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media\(min-width:1200px\)\{[\s\S]*\.dashboardWrap\{width:min\(1440px,calc\(100% - 28px\)\)\}/);
  assert.match(css, /\.selectedDateSection\.glass\{background:linear-gradient\(135deg,var\(--panel-strong\),var\(--panel\)\)\}/);
});

test("light theme uses a darker semantic teal for green metrics", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.dashboard\.light\{[\s\S]*--teal:#0d756c/);
  assert.match(css, /\.dashboard\.light \.searchConsoleKpiCard\.ctr\{--metric-color:#0d756c\}/);
});
