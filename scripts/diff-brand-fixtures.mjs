// Dev helper: pinpoint the first byte difference between the standalone
// welcome-email renderer and each webapp-rendered fixture.
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = "packages/web-ui/src/__tests__/fixtures/brand-welcome-email";
const { DEFAULT_BRAND_WELCOME_EMAIL_DATA, renderBrandWelcomeEmailHtml } =
  await import("../packages/web-ui/src/brand-welcome-email.ts");

const cases = JSON.parse(readFileSync(path.join(dir, "cases.json"), "utf8"));
for (const { name, mode, overrides } of cases) {
  const expected = readFileSync(path.join(dir, `${name}.html`), "utf8");
  const actual = renderBrandWelcomeEmailHtml(
    { ...DEFAULT_BRAND_WELCOME_EMAIL_DATA, ...overrides },
    { themeMode: mode, projectName: "Preview" },
  );
  if (actual === expected) {
    console.log(`OK   ${name}`);
    continue;
  }
  let i = 0;
  while (i < Math.min(actual.length, expected.length) && actual[i] === expected[i]) i += 1;
  console.log(
    `DIFF ${name} at ${i} (expected len ${expected.length}, actual len ${actual.length})`,
  );
  console.log(`  expected: ...${JSON.stringify(expected.slice(Math.max(0, i - 80), i + 120))}`);
  console.log(`  actual:   ...${JSON.stringify(actual.slice(Math.max(0, i - 80), i + 120))}`);
}
