import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAND_WELCOME_EMAIL_DATA,
  getPreviewFromAddress,
  getWelcomeEmailPreviewText,
  getWelcomeEmailSubject,
  renderBrandWelcomeEmailHtml,
  type BrandWelcomeEmailData,
  type BrandWelcomeEmailThemeMode,
} from "../brand-welcome-email";

// The fixtures in fixtures/brand-welcome-email/ were rendered by the Dreamlit
// webapp's own brand style preview pipeline (renderBrandStyleNeutralTemplateHtml
// with the BAREBONE_TEXT_ONLY template) for the inputs recorded in cases.json.
// These tests assert our standalone renderer reproduces that output
// byte-for-byte, so the exporter preview matches the webapp's editor exactly.
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/brand-welcome-email",
);

type FixtureCase = {
  name: string;
  mode: BrandWelcomeEmailThemeMode;
  overrides: Partial<BrandWelcomeEmailData>;
};

const cases = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, "cases.json"), "utf8"),
) as FixtureCase[];

const buildData = (overrides: Partial<BrandWelcomeEmailData>): BrandWelcomeEmailData => ({
  ...DEFAULT_BRAND_WELCOME_EMAIL_DATA,
  ...overrides,
});

describe("renderBrandWelcomeEmailHtml", () => {
  it("covers every fixture file with a case", () => {
    const htmlFiles = readdirSync(FIXTURES_DIR).filter((file) => file.endsWith(".html"));
    expect(new Set(cases.map((fixture) => `${fixture.name}.html`))).toEqual(new Set(htmlFiles));
  });

  for (const fixture of cases) {
    it(`matches the webapp render byte-for-byte: ${fixture.name}`, () => {
      const expected = readFileSync(path.join(FIXTURES_DIR, `${fixture.name}.html`), "utf8");
      const actual = renderBrandWelcomeEmailHtml(buildData(fixture.overrides), {
        themeMode: fixture.mode,
        projectName: "Preview",
      });
      expect(actual).toBe(expected);
    });
  }
});

describe("welcome email header copy", () => {
  it("uses the extracted welcome copy when present", () => {
    const data = buildData({
      brandName: "Cape Coast Co.",
      website: "https://capecoast.co",
      firecrawlSourceUrl: "https://capecoast.co",
      firecrawlWelcomeEmailCopy: {
        subject: "Welcome to Cape Coast Co.!",
        preheader: "Experience premium coffee like never before.",
        headline: "Enjoy the Best in Coffee, Delivered to You.",
        bodyParagraphs: ["Thanks for joining."],
      },
    });
    expect(getWelcomeEmailSubject(data)).toBe("Welcome to Cape Coast Co.!");
    expect(getWelcomeEmailPreviewText(data)).toBe("Experience premium coffee like never before.");
    expect(getPreviewFromAddress(data)).toBe("no-reply@mail.capecoast.co");
  });

  it("falls back to brand-derived copy without extraction data", () => {
    const data = buildData({});
    expect(getWelcomeEmailSubject(data)).toBe("Welcome aboard");
    expect(getWelcomeEmailPreviewText(data)).toBe("A quick welcome note for new signups.");
    expect(getPreviewFromAddress(data)).toBe("no-reply@mail.yoursite.com");
  });

  it("keeps an existing mail. prefix in the sender domain", () => {
    const data = buildData({ website: "https://mail.example.org" });
    expect(getPreviewFromAddress(data)).toBe("no-reply@mail.example.org");
  });
});
