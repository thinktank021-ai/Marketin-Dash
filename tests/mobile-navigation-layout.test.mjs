import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile navigation is hidden until opened and uses one semantic icon system", async () => {
  const client = await readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const icon of ["dashboard", "ads", "search", "contracts", "phone", "budget", "settings"]) {
    assert.match(client, new RegExp(`NavigationIcon name=\\"${icon}\\"`), icon);
  }
  assert.match(client, /className="mobileMenuTrigger"/);
  assert.match(client, /mobileMenuOpen/);
  assert.match(client, /const \[sideMenuOpen, setSideMenuOpen\] = useState\(false\)/);
  assert.match(css, /\.dashboard\.mobileMenuOpen \.sideMenu\.open\{transform:translateX\(0\)/);
  assert.match(css, /\.dashboard,\.dashboard\.sidebarCollapsed,\.dashboard\.sidebarOpen\{--sidebar-space:0;padding-right:0\}/);
  assert.match(css, /\.dashboard\{--sidebar-space:216px;padding-right:var\(--sidebar-space\)\}/);
  assert.match(css, /\.sideMenu\.collapsed\{width:68px;padding-inline:8px\}/);
  assert.match(css, /\.conversionFunnelStage\{min-height:100px!important;padding:35px 18px 19px!important/);
});
