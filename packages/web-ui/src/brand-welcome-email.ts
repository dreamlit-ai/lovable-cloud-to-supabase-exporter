// Standalone port of the Dreamlit webapp's brand-style welcome email preview
// renderer (the BAREBONE_TEXT_ONLY "neutral" template path). The helper
// functions below are copied from the webapp so the generated HTML stays
// byte-identical to what the Dreamlit brand style editor shows; field names
// intentionally mirror the webapp's BrandStyleFormData (firecrawl* fields map
// 1:1 to the /brand-style/extract payload). Byte-equivalence is verified in
// src/__tests__/brand-welcome-email.test.ts against fixtures rendered by the
// webapp itself.
import {
  AFTER_LOGO,
  AFTER_PREHEADER,
  BODY_OPEN,
  FOOTER_BAND_OPEN,
  FOOTER_BAND_TO_CONTENT,
  H1_CLOSE_TO_PARAGRAPHS,
  HEAD_CLOSE,
  HEAD_META,
  HEAD_START,
  HEADER_BAND,
  INNER_TO_H1,
  LOGO_PLACEHOLDER,
  PREHEADER_FILLER,
  PREHEADER_OPEN,
  TAIL,
  TD_FONT_PREFIX,
} from "./brand-welcome-email-chunks";

export type BrandWelcomeEmailCopy = {
  subject: string | null;
  preheader: string | null;
  headline: string | null;
  bodyParagraphs: string[];
};

export type BrandWelcomeEmailSocialLink = {
  label: string;
  url: string;
};

export type BrandWelcomeEmailData = {
  name: string;
  brandName: string;
  website: string;
  foregroundColor: string;
  accentColor: string;
  headingFontFamily: string;
  bodyFontFamily: string;
  buttonBorderRadiusPx: number;
  brandSubtext: string;
  footerAddress: string;
  logoUrl: string | null;
  logoDataUrl?: string | null;
  socialLinks: BrandWelcomeEmailSocialLink[];
  firecrawlSourceUrl: string;
  firecrawlPulledAt?: unknown;
  firecrawlBrandName: string;
  firecrawlHomepageSummary: string;
  firecrawlAudience: string;
  firecrawlValueProps: string[];
  firecrawlHeroHeadline: string;
  firecrawlHeroSubheadline: string;
  firecrawlPrimaryCtaText: string;
  firecrawlWelcomeEmailCopy: BrandWelcomeEmailCopy;
  firecrawlHeadingFontFamily: string;
  firecrawlHeadingFallbackFontFamily: string;
  firecrawlBodyFontFamily: string;
  firecrawlBodyFallbackFontFamily: string;
  firecrawlPrimaryColor: string;
  firecrawlSecondaryColor: string;
  firecrawlAccentColor: string;
  firecrawlBackgroundColor: string;
  firecrawlTextColor: string;
  firecrawlLinkColor: string;
  firecrawlThemePreference: string;
  firecrawlCtaBackgroundColor: string;
  firecrawlCtaTextColor: string;
  firecrawlCtaBorderColor: string;
  firecrawlCtaBorderRadius: string;
  firecrawlLogoUrl: string;
  firecrawlScreenshotCdnUrl: string;
  firecrawlImages: unknown[];
};

export type BrandWelcomeEmailThemeMode = "light" | "dark";

export const DEFAULT_BRAND_WELCOME_EMAIL_DATA: BrandWelcomeEmailData = {
  name: "",
  brandName: "",
  website: "",
  foregroundColor: "#211F26",
  accentColor: "#211F26",
  headingFontFamily: "Arial",
  bodyFontFamily: "Arial",
  buttonBorderRadiusPx: 8,
  brandSubtext: "",
  footerAddress: "",
  logoUrl: null,
  logoDataUrl: undefined,
  socialLinks: [],
  firecrawlSourceUrl: "",
  firecrawlPulledAt: null,
  firecrawlBrandName: "",
  firecrawlHomepageSummary: "",
  firecrawlAudience: "",
  firecrawlValueProps: [],
  firecrawlHeroHeadline: "",
  firecrawlHeroSubheadline: "",
  firecrawlPrimaryCtaText: "",
  firecrawlWelcomeEmailCopy: {
    subject: null,
    preheader: null,
    headline: null,
    bodyParagraphs: [],
  },
  firecrawlHeadingFontFamily: "",
  firecrawlHeadingFallbackFontFamily: "",
  firecrawlBodyFontFamily: "",
  firecrawlBodyFallbackFontFamily: "",
  firecrawlPrimaryColor: "",
  firecrawlSecondaryColor: "",
  firecrawlAccentColor: "",
  firecrawlBackgroundColor: "",
  firecrawlTextColor: "",
  firecrawlLinkColor: "",
  firecrawlThemePreference: "",
  firecrawlCtaBackgroundColor: "",
  firecrawlCtaTextColor: "",
  firecrawlCtaBorderColor: "",
  firecrawlCtaBorderRadius: "",
  firecrawlLogoUrl: "",
  firecrawlScreenshotCdnUrl: "",
  firecrawlImages: [],
};

// ---------------------------------------------------------------------------
// Color math (ported from webapp packages/email-templates/src/brand-style-colors.ts)
// ---------------------------------------------------------------------------

const BRAND_STYLE_DARK_PREVIEW_TEXT_COLOR = "#FAFAFA";
const BRAND_STYLE_DARK_PREVIEW_FALLBACK_BACKGROUND_COLOR = "#0A0A0B";
const BRAND_STYLE_DARK_PREVIEW_MIN_TEXT_CONTRAST = 20;
const BRAND_STYLE_PREVIEW_OUTER_BACKGROUND_COLOR = "#F3F4F6";

type RgbChannels = { r: number; g: number; b: number };

const normalizeColorValue = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, "");

const getHexColorChannels = (value: string): RgbChannels | null => {
  const normalized = value.trim().replace(/^#/, "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((channel) => `${channel}${channel}`)
          .join("")
      : normalized;

  if (!/^[0-9a-f]{6}$/i.test(expanded)) return null;

  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
};

const hexToRgbToken = (hex: string): string | null => {
  const channels = getHexColorChannels(hex);
  if (!channels) return null;
  return `rgb(${channels.r},${channels.g},${channels.b})`;
};

const getHexColorLuminance = (value: string): number | null => {
  const channels = getHexColorChannels(value);
  if (!channels) return null;

  const toLinear = (channel: number) => {
    const normalizedChannel = channel / 255;
    return normalizedChannel <= 0.03928
      ? normalizedChannel / 12.92
      : ((normalizedChannel + 0.055) / 1.055) ** 2.4;
  };

  return (
    0.2126 * toLinear(channels.r) + 0.7152 * toLinear(channels.g) + 0.0722 * toLinear(channels.b)
  );
};

const getColorContrastRatio = (firstColor: string, secondColor: string): number => {
  const firstLuminance = getHexColorLuminance(firstColor);
  const secondLuminance = getHexColorLuminance(secondColor);
  if (firstLuminance == null || secondLuminance == null) return 0;

  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
};

const mixHexColor = (color: string, targetColor: string, amount: number): string | null => {
  const source = getHexColorChannels(color);
  const target = getHexColorChannels(targetColor);
  if (!source || !target) return null;

  const boundedAmount = Math.min(Math.max(amount, 0), 1);
  const mixChannel = (sourceValue: number, targetValue: number) =>
    Math.round(sourceValue + (targetValue - sourceValue) * boundedAmount);

  const toHex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${toHex(mixChannel(source.r, target.r))}${toHex(
    mixChannel(source.g, target.g),
  )}${toHex(mixChannel(source.b, target.b))}`.toUpperCase();
};

const isDarkColor = (color: string): boolean => (getHexColorLuminance(color) ?? 1) < 0.38;

const isWhiteColor = (value: string): boolean => {
  const normalized = normalizeColorValue(value);
  return (
    normalized === "#fff" ||
    normalized === "#ffffff" ||
    normalized === "rgb(255,255,255)" ||
    normalized === "rgba(255,255,255,1)"
  );
};

const isTransparentColor = (value: string): boolean => {
  const normalized = normalizeColorValue(value);
  return (
    normalized === "transparent" ||
    normalized === "rgba(0,0,0,0)" ||
    /^rgba\(\d{1,3},\d{1,3},\d{1,3},0(?:\.0+)?\)$/.test(normalized)
  );
};

const getReadableSurfaceTextColor = (
  backgroundColor: string,
  preferredTextColor: string,
  minContrast = 4.5,
): string => {
  const preferred = preferredTextColor.trim();
  if (
    preferred &&
    getHexColorChannels(preferred) &&
    getColorContrastRatio(backgroundColor, preferred) >= minContrast
  ) {
    return preferred;
  }

  const fallback = isDarkColor(backgroundColor) ? "#FAFAFA" : "#18181B";
  return getColorContrastRatio(backgroundColor, fallback) >= minContrast
    ? fallback
    : isDarkColor(backgroundColor)
      ? "#FFFFFF"
      : "#000000";
};

const getSurfaceHeadingTextColor = (
  backgroundColor: string,
  bodyTextColor: string,
  minContrast = 4.5,
): string => {
  const mixed =
    mixHexColor(bodyTextColor, isDarkColor(backgroundColor) ? "#FFFFFF" : "#000000", 0.22) ??
    bodyTextColor;
  return getColorContrastRatio(backgroundColor, mixed) >= minContrast
    ? mixed
    : getReadableSurfaceTextColor(backgroundColor, mixed, minContrast);
};

const getMutedSurfaceTextColor = (backgroundColor: string, bodyTextColor: string): string => {
  if (isDarkColor(backgroundColor)) {
    const mixed =
      mixHexColor(bodyTextColor, backgroundColor, 0.55) ??
      mixHexColor("#FAFAFA", backgroundColor, 0.55);

    return mixed && getColorContrastRatio(backgroundColor, mixed) >= 2.4 ? mixed : "#8A8A90";
  }

  const mixed = mixHexColor(bodyTextColor, "#8E8C99", 0.45) ?? bodyTextColor;
  return getColorContrastRatio(backgroundColor, mixed) >= 3 ? mixed : "#8E8C99";
};

const getReadablePreviewLinkColor = (
  backgroundColor: string,
  preferredLinkColor: string,
  fallbackTextColor: string,
): string => {
  const preferred = preferredLinkColor.trim();
  if (
    preferred &&
    getHexColorChannels(preferred) &&
    getColorContrastRatio(backgroundColor, preferred) >= 4.5
  ) {
    return preferred;
  }

  return fallbackTextColor;
};

const getContrastingBrandStyleBorderColor = ({
  backgroundColor,
  candidates,
  fallback,
  mixAmount = 0.35,
  minContrast = 3,
}: {
  backgroundColor: string;
  candidates: Array<string | null | undefined>;
  fallback: string;
  mixAmount?: number;
  minContrast?: number;
}): string => {
  const seen = new Set<string>();
  const readableBackground = getHexColorChannels(backgroundColor)
    ? backgroundColor
    : BRAND_STYLE_DARK_PREVIEW_FALLBACK_BACKGROUND_COLOR;
  const toBorderColor = (candidate: string) =>
    mixHexColor(candidate, readableBackground, mixAmount) ?? candidate;

  for (const candidate of [...candidates, fallback]) {
    const trimmed = candidate?.trim();
    if (!trimmed || seen.has(normalizeColorValue(trimmed))) continue;
    seen.add(normalizeColorValue(trimmed));
    if (!getHexColorChannels(trimmed)) continue;

    const borderColor = toBorderColor(trimmed);
    if (getColorContrastRatio(readableBackground, borderColor) >= minContrast) {
      return borderColor;
    }
  }

  return getReadableSurfaceTextColor(readableBackground, fallback, minContrast);
};

const darkenBackgroundUntilTextContrast = ({
  backgroundColor,
  textColor = BRAND_STYLE_DARK_PREVIEW_TEXT_COLOR,
  minContrast = BRAND_STYLE_DARK_PREVIEW_MIN_TEXT_CONTRAST,
  fallback = BRAND_STYLE_DARK_PREVIEW_FALLBACK_BACKGROUND_COLOR,
}: {
  backgroundColor: string;
  textColor?: string;
  minContrast?: number;
  fallback?: string;
}): string => {
  if (!getHexColorChannels(backgroundColor)) return fallback;

  if (getColorContrastRatio(backgroundColor, textColor) >= minContrast) {
    return backgroundColor;
  }

  for (let amount = 0.08; amount <= 1; amount += 0.08) {
    const candidate = mixHexColor(backgroundColor, "#000000", amount);
    if (candidate && getColorContrastRatio(candidate, textColor) >= minContrast) {
      return candidate;
    }
  }

  return getColorContrastRatio(fallback, textColor) >= minContrast ? fallback : "#000000";
};

const isWarmSaturatedButtonColor = (value: string): boolean => {
  const channels = getHexColorChannels(value);
  if (!channels) return false;

  const r = channels.r / 255;
  const g = channels.g / 255;
  const b = channels.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  let hue = 0;
  if (delta !== 0) {
    if (max === r) {
      hue = ((g - b) / delta) % 6;
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }
  }
  const normalizedHue = (hue * 60 + 360) % 360;

  return (
    normalizedHue >= 15 &&
    normalizedHue <= 55 &&
    saturation >= 0.55 &&
    lightness >= 0.45 &&
    lightness <= 0.76
  );
};

const shouldShowButtonBorderColor = (backgroundColor: string): boolean =>
  !backgroundColor.trim() || isWhiteColor(backgroundColor) || isTransparentColor(backgroundColor);

const getBestButtonTextColor = (backgroundColor: string): string => {
  if (shouldShowButtonBorderColor(backgroundColor)) return "#211F26";
  if (isWarmSaturatedButtonColor(backgroundColor)) return "#FFFFFF";

  const darkText = "#211F26";
  const lightText = "#FFFFFF";
  return getColorContrastRatio(backgroundColor, darkText) >=
    getColorContrastRatio(backgroundColor, lightText)
    ? darkText
    : lightText;
};

const getReadableButtonTextColor = ({
  backgroundColor,
  requestedTextColor,
}: {
  backgroundColor: string;
  requestedTextColor: string;
}): string => {
  const trimmedTextColor = requestedTextColor.trim();
  if (!trimmedTextColor) return getBestButtonTextColor(backgroundColor);

  const contrastBackground = shouldShowButtonBorderColor(backgroundColor)
    ? "#FFFFFF"
    : backgroundColor;
  if (getColorContrastRatio(contrastBackground, trimmedTextColor) >= 4.5) {
    return trimmedTextColor;
  }

  return getBestButtonTextColor(backgroundColor);
};

const getBrandStyleButtonTextColor = ({
  backgroundColor,
  requestedTextColor,
  hasDirectBackground,
}: {
  backgroundColor: string;
  requestedTextColor: string;
  hasDirectBackground: boolean;
}): string => {
  const trimmedTextColor = requestedTextColor.trim();
  if (
    hasDirectBackground &&
    trimmedTextColor &&
    getHexColorChannels(trimmedTextColor) &&
    !shouldShowButtonBorderColor(backgroundColor)
  ) {
    return trimmedTextColor;
  }

  return getReadableButtonTextColor({ backgroundColor, requestedTextColor });
};

// ---------------------------------------------------------------------------
// Fonts (ported from webapp packages/utils/src/brand-style-fonts.ts)
// ---------------------------------------------------------------------------

const BRAND_STYLE_GOOGLE_FONT_OPTIONS = [
  "Inter",
  "Geist",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Source Sans Pro",
  "Nunito",
  "Work Sans",
  "Fira Sans",
  "PT Sans",
  "Raleway",
  "Ubuntu",
  "Noto Sans",
  "Barlow",
  "DM Sans",
  "Plus Jakarta Sans",
  "Manrope",
  "Space Grotesk",
  "Public Sans",
  "IBM Plex Sans",
  "Red Hat Display",
  "Outfit",
  "Lexend",
  "Epilogue",
  "JetBrains Mono",
  "Karla",
  "Rubik",
  "Quicksand",
  "Mukta",
  "Oxygen",
  "Dosis",
  "Cabin",
  "Varela Round",
  "Comfortaa",
  "Exo",
  "Archivo",
  "Mulish",
  "Fraunces",
  "Instrument Serif",
  "Playfair Display",
  "Lora",
  "Merriweather",
  "Source Serif Pro",
  "Crimson Text",
  "EB Garamond",
  "Libre Baskerville",
  "Cormorant Garamond",
  "Vollkorn",
  "Bitter",
  "Domine",
  "Arvo",
  "Rokkitt",
  "Alegreya",
  "Spectral",
  "IBM Plex Serif",
  "PT Serif",
  "Noto Serif",
  "Old Standard TT",
  "Crimson Pro",
  "Oswald",
  "Bebas Neue",
  "Anton",
  "Fjalla One",
  "Righteous",
  "Russo One",
  "Bangers",
  "Fredoka One",
  "Pacifico",
  "Dancing Script",
  "Great Vibes",
  "Amatic SC",
  "Lobster",
  "Permanent Marker",
  "Kaushan Script",
  "Shadows Into Light",
  "Caveat",
  "Satisfy",
  "Indie Flower",
  "Gloria Hallelujah",
  "Droid Sans",
  "Droid Serif",
] as const;

const BRAND_STYLE_EMAIL_SAFE_FALLBACK_FONT_OPTIONS = [
  "Arial",
  "Arial Black",
  "Comic Sans MS",
  "Courier New",
  "Georgia",
  "Helvetica",
  "Impact",
  "Lucida Sans",
  "Palatino Linotype",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
] as const;

type BrandStyleGoogleFont = (typeof BRAND_STYLE_GOOGLE_FONT_OPTIONS)[number];
type BrandStyleEmailSafeFallbackFont =
  (typeof BRAND_STYLE_EMAIL_SAFE_FALLBACK_FONT_OPTIONS)[number];
type BrandStyleFontOption = BrandStyleGoogleFont | BrandStyleEmailSafeFallbackFont;
type BrandStyleFontRole = "heading" | "body";

const normalizeFontKey = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

const FONT_OPTION_BY_KEY = new Map<string, BrandStyleFontOption>(
  [...BRAND_STYLE_GOOGLE_FONT_OPTIONS, ...BRAND_STYLE_EMAIL_SAFE_FALLBACK_FONT_OPTIONS].map(
    (font) => [normalizeFontKey(font), font],
  ),
);

const EMAIL_SAFE_FALLBACK_BY_KEY = new Map<string, BrandStyleEmailSafeFallbackFont>(
  BRAND_STYLE_EMAIL_SAFE_FALLBACK_FONT_OPTIONS.map((font) => [normalizeFontKey(font), font]),
);

const GOOGLE_FONT_BY_KEY = new Map<string, BrandStyleGoogleFont>(
  BRAND_STYLE_GOOGLE_FONT_OPTIONS.map((font) => [normalizeFontKey(font), font]),
);

const normalizeBrandStyleFontCandidate = (value: string | null | undefined): string | null =>
  value
    ?.replace(/['"]/g, "")
    .replace(/!important/gi, "")
    .trim()
    .replace(/\s+/g, " ") || null;

const getPrimaryBrandStyleFontFamily = (fontFamily: string): string | null => {
  const primaryFamily = normalizeBrandStyleFontCandidate(fontFamily.split(",")[0]);
  if (!primaryFamily) return null;

  const normalizedFamily = normalizeFontKey(primaryFamily);
  if (normalizedFamily === "unknown" || normalizedFamily.startsWith("var(")) {
    return null;
  }

  return primaryFamily;
};

const getBrandStyleFontCandidates = (fontFamily: string) =>
  fontFamily
    .split(",")
    .map(normalizeBrandStyleFontCandidate)
    .filter((candidate): candidate is string => Boolean(candidate));

const findExactFontOption = (fontFamily: string): BrandStyleFontOption | null =>
  FONT_OPTION_BY_KEY.get(normalizeFontKey(fontFamily)) ?? null;

const isBrandStyleGoogleFont = (fontFamily: string): fontFamily is BrandStyleGoogleFont =>
  GOOGLE_FONT_BY_KEY.has(normalizeFontKey(fontFamily));

const isBrandStyleEmailSafeFallbackFont = (
  fontFamily: string | null | undefined,
): fontFamily is BrandStyleEmailSafeFallbackFont =>
  Boolean(fontFamily && EMAIL_SAFE_FALLBACK_BY_KEY.has(normalizeFontKey(fontFamily)));

const FONT_STACK_BY_EMAIL_SAFE_FONT: Record<BrandStyleEmailSafeFallbackFont, string> = {
  Arial: "Arial,Helvetica,sans-serif",
  "Arial Black": `"Arial Black",Arial,Helvetica,sans-serif`,
  "Comic Sans MS": `"Comic Sans MS",cursive`,
  "Courier New": `"Courier New",Courier,monospace`,
  Georgia: "Georgia,serif",
  Helvetica: "Helvetica,Arial,sans-serif",
  Impact: "Impact,Arial,sans-serif",
  "Lucida Sans": `"Lucida Sans",Arial,sans-serif`,
  "Palatino Linotype": `"Palatino Linotype",Palatino,serif`,
  Tahoma: "Tahoma,Arial,sans-serif",
  "Times New Roman": `"Times New Roman",Times,serif`,
  "Trebuchet MS": `"Trebuchet MS",Arial,sans-serif`,
  Verdana: "Verdana,Arial,sans-serif",
};

const quoteCssFontFamily = (fontFamily: string): string =>
  `'${fontFamily.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

const getBrandStyleEmailSafeFontStack = (fontFamily: BrandStyleEmailSafeFallbackFont): string =>
  FONT_STACK_BY_EMAIL_SAFE_FONT[fontFamily];

const getEmailSafeFallbackForBrandStyleFont = (
  value: string | null | undefined,
  role: BrandStyleFontRole = "body",
): BrandStyleEmailSafeFallbackFont => {
  const candidates = getBrandStyleFontCandidates(value ?? "");

  for (const candidate of candidates) {
    const fallback = EMAIL_SAFE_FALLBACK_BY_KEY.get(normalizeFontKey(candidate));
    if (fallback) return fallback;
  }

  const normalized = normalizeFontKey(value ?? "");
  if (/\b(mono|code|console|courier|jetbrains|plex mono)\b/.test(normalized)) {
    return "Courier New";
  }
  if (
    role === "heading" &&
    /\b(anton|bebas|display|headline|heavy|impact|poster|russo|condensed|narrow|fjalla|oswald)\b/.test(
      normalized,
    )
  ) {
    return /\b(anton|impact|heavy|russo|poster)\b/.test(normalized) ? "Arial Black" : "Impact";
  }
  if (
    role === "heading" &&
    /\b(script|hand|cursive|brush|marker|signature|caveat|pacifico|dancing|lobster|satisfy|flower|gloria|amatic)\b/.test(
      normalized,
    )
  ) {
    return "Comic Sans MS";
  }
  if (/\b(verdana|round|rounded|soft|nunito|quicksand|comfortaa|varela)\b/.test(normalized)) {
    return "Verdana";
  }
  if (
    /\b(trebuchet|humanist|work sans|lato|open sans|source sans|fira sans|pt sans)\b/.test(
      normalized,
    )
  ) {
    return "Trebuchet MS";
  }
  if (/\b(tahoma|ubuntu|mukta|oxygen|cabin)\b/.test(normalized)) {
    return "Tahoma";
  }
  if (/\b(helvetica)\b/.test(normalized)) return "Helvetica";
  if (/\b(palatino|old standard|garamond|cormorant|crimson|alegreya|spectral)\b/.test(normalized)) {
    return "Palatino Linotype";
  }
  if (
    /\b(times|serif|fraunces|instrument|playfair|lora|merriweather|baskerville|vollkorn|bitter|domine|arvo|rokkitt|noto serif|droid serif)\b/.test(
      normalized,
    )
  ) {
    return "Georgia";
  }
  if (
    /\b(grotesk|grotesque|geometric|montserrat|poppins|manrope|satoshi|space grotesk|outfit|lexend|epilogue|rubik|archivo|mulish|geist|inter|roboto)\b/.test(
      normalized,
    )
  ) {
    return "Helvetica";
  }
  return "Arial";
};

const getPersistedBrandStyleFallbackFontFamily = ({
  primaryFontFamily,
  fallbackFontFamily,
  role,
}: {
  primaryFontFamily: string | null | undefined;
  fallbackFontFamily?: string | null | undefined;
  role: BrandStyleFontRole;
}): BrandStyleEmailSafeFallbackFont | null => {
  if (!primaryFontFamily) return null;
  if (isBrandStyleEmailSafeFallbackFont(primaryFontFamily)) return null;
  if (isBrandStyleEmailSafeFallbackFont(fallbackFontFamily)) {
    return EMAIL_SAFE_FALLBACK_BY_KEY.get(normalizeFontKey(fallbackFontFamily))!;
  }
  return getEmailSafeFallbackForBrandStyleFont(primaryFontFamily, role);
};

const getBrandStyleEmailFontStack = ({
  primaryFontFamily,
  fallbackFontFamily,
  role,
}: {
  primaryFontFamily: string | null | undefined;
  fallbackFontFamily?: string | null | undefined;
  role: BrandStyleFontRole;
}): string => {
  const primaryFamily = getPrimaryBrandStyleFontFamily(primaryFontFamily ?? "");
  const fallbackFamily =
    getPersistedBrandStyleFallbackFontFamily({
      primaryFontFamily: primaryFamily,
      fallbackFontFamily,
      role,
    }) ?? getEmailSafeFallbackForBrandStyleFont(primaryFamily, role);

  if (!primaryFamily || primaryFamily === fallbackFamily) {
    return getBrandStyleEmailSafeFontStack(fallbackFamily);
  }

  return `${quoteCssFontFamily(primaryFamily)},${getBrandStyleEmailSafeFontStack(fallbackFamily)}`;
};

const getBrandStyleGoogleFontsStylesheetHref = (fontFamilies: string[]): string | null => {
  const families = Array.from(
    new Set(
      fontFamilies
        .map((family) => findExactFontOption(family))
        .filter((family): family is BrandStyleGoogleFont =>
          Boolean(family && isBrandStyleGoogleFont(family)),
        ),
    ),
  );

  if (families.length === 0) return null;

  const params = new URLSearchParams();
  families.forEach((family) => params.append("family", family));
  params.set("display", "swap");

  return `https://fonts.googleapis.com/css2?${params.toString()}`;
};

const FONT_STACKS: Record<string, string> = {
  "Instrument Serif": "'Instrument Serif',Georgia,serif",
  "IBM Plex Serif": "'IBM Plex Serif',Georgia,serif",
  Arial: "Arial,Helvetica,sans-serif",
};

const getStaticTemplateFontStack = (fontFamily: string): string =>
  FONT_STACKS[fontFamily] ?? `${fontFamily},Arial,sans-serif`;

// ---------------------------------------------------------------------------
// Social links (ported from webapp apps/web/src/lib/brand-kit-social-links.ts)
// ---------------------------------------------------------------------------

const BRAND_KIT_SOCIAL_LINK_OPTIONS = [
  {
    label: "X",
    aliases: ["twitter"],
    hosts: ["x.com", "twitter.com"],
    handleUrl: "https://x.com/",
    iconSlug: "x",
  },
  {
    label: "LinkedIn",
    aliases: ["linkedin"],
    hosts: ["linkedin.com"],
    handleUrl: "https://www.linkedin.com/company/",
    iconSlug: "linkedin",
  },
  {
    label: "Instagram",
    aliases: ["ig"],
    hosts: ["instagram.com"],
    handleUrl: "https://www.instagram.com/",
    iconSlug: "instagram",
  },
  {
    label: "Facebook",
    aliases: ["meta"],
    hosts: ["facebook.com", "fb.com"],
    handleUrl: "https://www.facebook.com/",
    iconSlug: "facebook",
  },
  {
    label: "YouTube",
    aliases: ["youtube", "yt"],
    hosts: ["youtube.com", "youtu.be"],
    handleUrl: "https://www.youtube.com/@",
    iconSlug: "youtube",
  },
  {
    label: "GitHub",
    aliases: ["github"],
    hosts: ["github.com"],
    handleUrl: "https://github.com/",
    iconSlug: "github",
  },
  {
    label: "TikTok",
    aliases: ["tiktok", "tik tok"],
    hosts: ["tiktok.com"],
    handleUrl: "https://www.tiktok.com/@",
    iconSlug: "tiktok",
  },
  {
    label: "Threads",
    aliases: ["threads"],
    hosts: ["threads.net"],
    handleUrl: "https://www.threads.net/@",
    iconSlug: "threads",
  },
  {
    label: "Website",
    aliases: ["site", "web"],
    hosts: [],
    handleUrl: "https://",
    iconSlug: "website",
  },
] as const;

type BrandKitSocialLinkLabel = (typeof BRAND_KIT_SOCIAL_LINK_OPTIONS)[number]["label"];

const normalizeLabelText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const getBrandKitSocialLinkOption = (label: string | null | undefined) => {
  const normalized = normalizeLabelText(label ?? "");
  if (!normalized) return null;

  return (
    BRAND_KIT_SOCIAL_LINK_OPTIONS.find((option) => {
      if (normalizeLabelText(option.label) === normalized) return true;
      return option.aliases.some((alias) => normalizeLabelText(alias) === normalized);
    }) ?? null
  );
};

const inferBrandKitSocialLabelFromUrl = (
  rawUrl: string | null | undefined,
): BrandKitSocialLinkLabel | null => {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;

  try {
    const hasProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed);
    const url = new URL(hasProtocol ? trimmed : `https://${trimmed}`);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const match = BRAND_KIT_SOCIAL_LINK_OPTIONS.find((option) =>
      option.hosts.some((knownHost) => host === knownHost || host.endsWith(`.${knownHost}`)),
    );
    return match?.label ?? "Website";
  } catch {
    return null;
  }
};

const normalizeBrandKitSocialLabel = (
  label: string | null | undefined,
  url?: string | null,
): BrandKitSocialLinkLabel => {
  const option = getBrandKitSocialLinkOption(label);
  if (option && option.label !== "Website") return option.label;

  return inferBrandKitSocialLabelFromUrl(url) ?? option?.label ?? "Website";
};

const stripHandlePrefix = (value: string): string =>
  value.trim().replace(/^@+/, "").replace(/^\/+/, "");

const normalizeBrandKitSocialUrl = (label: string, rawUrl: string): string => {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";

  const option =
    getBrandKitSocialLinkOption(label) ??
    BRAND_KIT_SOCIAL_LINK_OPTIONS.find((item) => item.label === "Website")!;

  if (!trimmed.includes(".") && !trimmed.includes("/") && !trimmed.includes(":")) {
    return `${option.handleUrl}${stripHandlePrefix(trimmed)}`;
  }

  try {
    const hasProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed);
    const url = new URL(hasProtocol ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString();
  } catch {
    return trimmed;
  }
};

const BRAND_KIT_SOCIAL_ICON_BASE =
  "https://pub-268f0dca14a74018a2c570a1ff36667c.r2.dev/brandkit_email_assets/social";

const SOCIAL_ICON_SLUG_BY_LABEL: Partial<Record<BrandKitSocialLinkLabel, string>> = {
  X: "x",
  LinkedIn: "linkedin",
  Instagram: "instagram",
  Facebook: "facebook",
  YouTube: "youtube",
  GitHub: "github",
  TikTok: "tiktok",
  Threads: "threads",
  Website: "website",
};

const isLightIconColor = (hexColor: string): boolean => {
  const normalized = hexColor.trim().replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return false;

  const r = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const g = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const b = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.6;
};

const getBrandKitSocialIconUrl = (label: string, colorHex = "#211F26"): string => {
  const option = getBrandKitSocialLinkOption(label);
  const slug = (option?.label && SOCIAL_ICON_SLUG_BY_LABEL[option.label]) || "website";
  return `${BRAND_KIT_SOCIAL_ICON_BASE}/${slug}-${isLightIconColor(colorHex) ? "light" : "dark"}.png`;
};

type FooterSocialLink = { label: string; url: string };

const getFilledFooterSocialLinks = (links: FooterSocialLink[]): FooterSocialLink[] =>
  links
    .map((link) => ({
      label: normalizeBrandKitSocialLabel(link.label, link.url),
      url: normalizeBrandKitSocialUrl(link.label, link.url),
    }))
    .filter((link) => link.label && link.url)
    .slice(0, 6);

// ---------------------------------------------------------------------------
// Derived brand fields + welcome copy (ported from webapp BrandStyleBuilder.tsx)
// ---------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const cleanPreviewSentence = (value: string): string => value.replace(/\s+/g, " ").trim();

const getBrandStylePreviewInnerBackgroundColor = (backgroundColor: string) =>
  isWhiteColor(backgroundColor) ? BRAND_STYLE_PREVIEW_OUTER_BACKGROUND_COLOR : backgroundColor;

const mapExtractedFontToEmailSafeFont = (value: string, role: BrandStyleFontRole): string =>
  getEmailSafeFallbackForBrandStyleFont(value, role);

const getBrandStyleFormFallbackFont = ({
  primaryFontFamily,
  fallbackFontFamily,
  role,
}: {
  primaryFontFamily: string;
  fallbackFontFamily: string;
  role: BrandStyleFontRole;
}) =>
  getPersistedBrandStyleFallbackFontFamily({
    primaryFontFamily,
    fallbackFontFamily,
    role,
  });

const getDerivedBrandStyleFields = (formData: BrandWelcomeEmailData) => {
  const colorScheme: "light" | "dark" = formData.firecrawlThemePreference
    .toLowerCase()
    .includes("dark")
    ? "dark"
    : "light";
  const backgroundColor =
    formData.firecrawlBackgroundColor || (colorScheme === "dark" ? "#111111" : "#FDFCFD");
  const foregroundColor =
    formData.firecrawlTextColor ||
    getReadableSurfaceTextColor(backgroundColor, formData.foregroundColor);
  const accentColor =
    formData.firecrawlPrimaryColor ||
    formData.firecrawlAccentColor ||
    formData.firecrawlLinkColor ||
    formData.accentColor;
  const buttonBackgroundColor = formData.firecrawlCtaBackgroundColor || accentColor;
  const buttonTextColor = getBrandStyleButtonTextColor({
    backgroundColor: buttonBackgroundColor,
    requestedTextColor: formData.firecrawlCtaTextColor,
    hasDirectBackground: Boolean(formData.firecrawlCtaBackgroundColor.trim()),
  });
  const buttonBorderColor =
    formData.firecrawlCtaBorderColor ||
    (shouldShowButtonBorderColor(buttonBackgroundColor) ? buttonTextColor : null);
  const buttonBorderRadiusPx =
    Number.parseInt(formData.firecrawlCtaBorderRadius, 10) || formData.buttonBorderRadiusPx;

  return {
    colorScheme,
    backgroundColor,
    foregroundColor,
    accentColor,
    bodyFontFamily: mapExtractedFontToEmailSafeFont(
      formData.firecrawlBodyFontFamily || formData.bodyFontFamily,
      "body",
    ),
    buttonBackgroundColor,
    buttonTextColor,
    buttonBorderColor,
    buttonBorderRadiusPx,
  };
};

const getButtonBackgroundColor = (formData: BrandWelcomeEmailData): string =>
  getDerivedBrandStyleFields(formData).buttonBackgroundColor.trim() || "transparent";

const getButtonBorderColor = (formData: BrandWelcomeEmailData): string => {
  const derived = getDerivedBrandStyleFields(formData);
  return shouldShowButtonBorderColor(derived.buttonBackgroundColor)
    ? derived.buttonBorderColor || derived.foregroundColor || derived.accentColor
    : derived.buttonBorderColor || derived.buttonBackgroundColor || derived.accentColor;
};

const isPlaceholderBrandStyleName = (value: string): boolean => {
  const normalized = cleanPreviewSentence(value).toLowerCase();
  return normalized === "brand style" || normalized === "new brand style";
};

const hasPreviewSourceData = (formData: BrandWelcomeEmailData): boolean =>
  Boolean(
    formData.firecrawlPulledAt ||
    formData.firecrawlSourceUrl.trim() ||
    formData.firecrawlBrandName.trim() ||
    formData.firecrawlHomepageSummary.trim() ||
    formData.firecrawlHeroHeadline.trim() ||
    formData.firecrawlWelcomeEmailCopy.subject?.trim() ||
    formData.firecrawlWelcomeEmailCopy.headline?.trim() ||
    formData.firecrawlWelcomeEmailCopy.bodyParagraphs.length > 0,
  );

export const getBrandStyleDisplayName = (formData: BrandWelcomeEmailData): string => {
  const brandName = cleanPreviewSentence(formData.brandName) || cleanPreviewSentence(formData.name);

  if (brandName && !isPlaceholderBrandStyleName(brandName)) {
    return brandName;
  }

  if (hasPreviewSourceData(formData) && brandName) {
    return brandName;
  }

  return "Your site";
};

export const getWelcomeEmailSubject = (formData: BrandWelcomeEmailData): string =>
  cleanPreviewSentence(formData.firecrawlWelcomeEmailCopy.subject ?? "") ||
  cleanPreviewSentence(formData.firecrawlHeroHeadline) ||
  (hasPreviewSourceData(formData)
    ? `Welcome to ${getBrandStyleDisplayName(formData)}`
    : "Welcome aboard");

export const getWelcomeEmailPreviewText = (formData: BrandWelcomeEmailData): string =>
  cleanPreviewSentence(formData.firecrawlWelcomeEmailCopy.preheader ?? "") ||
  cleanPreviewSentence(formData.firecrawlHeroSubheadline) ||
  cleanPreviewSentence(formData.firecrawlHomepageSummary) ||
  (hasPreviewSourceData(formData)
    ? `Thanks for connecting with ${getBrandStyleDisplayName(formData)}.`
    : "A quick welcome note for new signups.");

const getWelcomeEmailHeadline = (formData: BrandWelcomeEmailData): string =>
  cleanPreviewSentence(formData.firecrawlWelcomeEmailCopy.headline ?? "") ||
  cleanPreviewSentence(formData.firecrawlHeroHeadline) ||
  (hasPreviewSourceData(formData)
    ? `Welcome to ${getBrandStyleDisplayName(formData)}`
    : "Welcome aboard");

const getWelcomeEmailBodyParagraphs = (formData: BrandWelcomeEmailData): string[] => {
  const generatedParagraphs = formData.firecrawlWelcomeEmailCopy.bodyParagraphs
    .map(cleanPreviewSentence)
    .filter(Boolean)
    .slice(0, 3);

  if (generatedParagraphs.length > 0) {
    return generatedParagraphs;
  }

  if (!hasPreviewSourceData(formData)) {
    return [
      "Thanks for signing up. We're glad you're here.",
      "We'll send practical updates, product notes, and resources to help new subscribers get started.",
    ];
  }

  const brandName = getBrandStyleDisplayName(formData);
  const summary =
    cleanPreviewSentence(formData.firecrawlHeroSubheadline) ||
    cleanPreviewSentence(formData.firecrawlHomepageSummary) ||
    `Thanks for connecting with ${brandName}. We're glad you're here.`;
  const valueProps = formData.firecrawlValueProps
    .map(cleanPreviewSentence)
    .filter(Boolean)
    .slice(0, 2);
  const audience = cleanPreviewSentence(formData.firecrawlAudience);
  const secondParagraph =
    valueProps.length > 0
      ? `We'll send practical updates about ${valueProps.join(" and ")}.`
      : audience
        ? `We'll send practical updates built for ${audience}.`
        : `We'll send practical updates, product notes, and resources that help you get more from ${brandName}.`;

  return [summary, secondParagraph];
};

const getPreviewSenderDomain = (formData: BrandWelcomeEmailData): string => {
  const rawWebsite = formData.website.trim() || formData.firecrawlSourceUrl.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`);
    const hostname = url.hostname.replace(/^www\./i, "");
    return hostname.startsWith("mail.") ? hostname : `mail.${hostname}`;
  } catch {
    return "mail.yoursite.com";
  }
};

export const getPreviewFromAddress = (formData: BrandWelcomeEmailData): string =>
  `no-reply@${getPreviewSenderDomain(formData)}`;

const getPreviewHeaderTextColor = (formData: BrandWelcomeEmailData, amount = 0.16): string => {
  const derived = getDerivedBrandStyleFields(formData);
  const targetColor = derived.colorScheme === "dark" ? "#FFFFFF" : "#000000";
  return mixHexColor(derived.foregroundColor, targetColor, amount) ?? derived.foregroundColor;
};

// ---------------------------------------------------------------------------
// Preview surface colors (light card / dark mode), ported from BrandStyleBuilder
// ---------------------------------------------------------------------------

type BrandStylePreviewSurfaceColors = {
  outerBackgroundColor: string;
  containerBackgroundColor: string;
  innerBackgroundColor: string;
  containerBorderColor: string | null;
  containerBorderRadiusPx: number | null;
  innerBorderColor: string | null;
  innerBorderRadiusPx: number | null;
  bodyTextColor: string;
  headingTextColor: string;
  mutedTextColor: string;
  linkColor: string;
};

const buildBrandStylePreviewSurfaceColors = ({
  innerBackgroundColor,
  outerBackgroundColor,
  containerBackgroundColor,
  containerBorderColor = null,
  containerBorderRadiusPx = null,
  innerBorderColor = null,
  innerBorderRadiusPx = null,
  preferredBodyTextColor,
  preferredLinkColor,
}: {
  innerBackgroundColor: string;
  outerBackgroundColor: string;
  containerBackgroundColor: string;
  containerBorderColor?: string | null;
  containerBorderRadiusPx?: number | null;
  innerBorderColor?: string | null;
  innerBorderRadiusPx?: number | null;
  preferredBodyTextColor: string;
  preferredLinkColor: string;
}): BrandStylePreviewSurfaceColors => {
  const bodyTextColor = getReadableSurfaceTextColor(innerBackgroundColor, preferredBodyTextColor);
  const headingTextColor = getSurfaceHeadingTextColor(innerBackgroundColor, bodyTextColor);
  const mutedTextColor = getMutedSurfaceTextColor(innerBackgroundColor, bodyTextColor);
  const linkColor = getReadablePreviewLinkColor(
    innerBackgroundColor,
    preferredLinkColor,
    bodyTextColor,
  );

  return {
    outerBackgroundColor,
    containerBackgroundColor,
    innerBackgroundColor,
    containerBorderColor,
    containerBorderRadiusPx,
    innerBorderColor,
    innerBorderRadiusPx,
    bodyTextColor,
    headingTextColor,
    mutedTextColor,
    linkColor,
  };
};

const getBrandStyleDarkPreviewSurfaceColors = (
  formData: BrandWelcomeEmailData,
): BrandStylePreviewSurfaceColors => {
  const derived = getDerivedBrandStyleFields(formData);
  const rawBrandBackground = getBrandStylePreviewInnerBackgroundColor(derived.backgroundColor);
  const selectedBrandBackground =
    getHexColorChannels(rawBrandBackground) && isDarkColor(rawBrandBackground)
      ? rawBrandBackground
      : getHexColorChannels(derived.foregroundColor) && isDarkColor(derived.foregroundColor)
        ? derived.foregroundColor
        : "#0A0A0B";
  const brandBackground = darkenBackgroundUntilTextContrast({
    backgroundColor: selectedBrandBackground,
    textColor: BRAND_STYLE_DARK_PREVIEW_TEXT_COLOR,
  });
  const preferredDarkPreviewText =
    getHexColorChannels(derived.foregroundColor) && !isDarkColor(derived.foregroundColor)
      ? derived.foregroundColor
      : BRAND_STYLE_DARK_PREVIEW_TEXT_COLOR;
  const preferredLightText = getReadableSurfaceTextColor(
    brandBackground,
    preferredDarkPreviewText,
    BRAND_STYLE_DARK_PREVIEW_MIN_TEXT_CONTRAST,
  );
  const innerBorderColor = getContrastingBrandStyleBorderColor({
    backgroundColor: brandBackground,
    candidates: [
      formData.firecrawlPrimaryColor,
      formData.firecrawlAccentColor,
      formData.firecrawlSecondaryColor,
    ],
    fallback: derived.backgroundColor,
  });

  return buildBrandStylePreviewSurfaceColors({
    outerBackgroundColor: brandBackground,
    containerBackgroundColor: brandBackground,
    innerBackgroundColor: brandBackground,
    innerBorderColor,
    innerBorderRadiusPx: 16,
    preferredBodyTextColor: preferredLightText,
    preferredLinkColor: formData.firecrawlLinkColor || derived.accentColor,
  });
};

const getBrandStyleLightCardPreviewSurfaceColors = (
  formData: BrandWelcomeEmailData,
): BrandStylePreviewSurfaceColors | null => {
  const derived = getDerivedBrandStyleFields(formData);
  const rawBrandBackground = getBrandStylePreviewInnerBackgroundColor(derived.backgroundColor);
  if (!getHexColorChannels(rawBrandBackground) || !isDarkColor(rawBrandBackground)) {
    return null;
  }

  const lightBackgroundCandidate =
    getHexColorChannels(derived.foregroundColor) && !isDarkColor(derived.foregroundColor)
      ? derived.foregroundColor
      : "#FAFAFA";
  const preferredLightBackground =
    getBrandStylePreviewInnerBackgroundColor(lightBackgroundCandidate);

  return buildBrandStylePreviewSurfaceColors({
    outerBackgroundColor: BRAND_STYLE_PREVIEW_OUTER_BACKGROUND_COLOR,
    containerBackgroundColor: "#FFFFFF",
    innerBackgroundColor: preferredLightBackground,
    preferredBodyTextColor: rawBrandBackground,
    preferredLinkColor: derived.accentColor || rawBrandBackground,
  });
};

const getBrandStylePreviewSurfaceColors = (
  formData: BrandWelcomeEmailData,
  themeMode: BrandWelcomeEmailThemeMode,
): BrandStylePreviewSurfaceColors | null =>
  themeMode === "dark"
    ? getBrandStyleDarkPreviewSurfaceColors(formData)
    : getBrandStyleLightCardPreviewSurfaceColors(formData);

// ---------------------------------------------------------------------------
// Inline style helpers (ported; used to reproduce the webapp's declaration
// reordering when surface borders/backgrounds are applied)
// ---------------------------------------------------------------------------

const splitInlineStyleDeclarations = (style: string): string[] => style.split(";");

const setInlineStyleDeclaration = (style: string, property: string, value: string): string => {
  const normalizedProperty = property.trim().toLowerCase();
  const declarations = splitInlineStyleDeclarations(style)
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const declarationProperty = declaration
        .slice(0, declaration.indexOf(":"))
        .trim()
        .toLowerCase();
      return declarationProperty !== normalizedProperty;
    });

  declarations.push(`${property}:${value}`);
  return declarations.join(";");
};

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const BASE_INNER_CARD_STYLE =
  "border-radius:8px;padding-right:40px;padding-left:40px;padding-bottom:5rem;padding-top:5rem;text-align:left";

const rgbOr = (color: string): string => hexToRgbToken(color) ?? color;

export type BrandWelcomeEmailRenderOptions = {
  themeMode?: BrandWelcomeEmailThemeMode;
  projectName?: string;
};

// ---------------------------------------------------------------------------
// Extraction payload adapter
// ---------------------------------------------------------------------------

const payloadString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const payloadStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

const payloadFirst = (...values: unknown[]): string => {
  for (const value of values) {
    const text = payloadString(value);
    if (text) return text;
  }
  return "";
};

/**
 * Maps a brand style extraction payload (the `brand_style` object returned by
 * the Dreamlit /brand-style/extract endpoint, also stored as the profile's
 * brand_style) onto the renderer input. Field names follow the webapp's
 * PulledBrandStyleResult, with snake_case fallbacks for stored variants.
 */
export const normalizeBrandWelcomeEmailData = (
  style: Record<string, unknown>,
  fallback: { websiteUrl?: string; brandName?: string } = {},
): BrandWelcomeEmailData => {
  const copyRecord =
    (style.firecrawlWelcomeEmailCopy as Record<string, unknown> | undefined) ??
    (style.firecrawl_welcome_email_copy as Record<string, unknown> | undefined);
  const welcomeCopy: BrandWelcomeEmailCopy =
    copyRecord && typeof copyRecord === "object"
      ? {
          subject: payloadString(copyRecord.subject) || null,
          preheader: payloadString(copyRecord.preheader) || null,
          headline: payloadString(copyRecord.headline) || null,
          bodyParagraphs: payloadStringArray(
            copyRecord.bodyParagraphs ?? copyRecord.body_paragraphs,
          ),
        }
      : { ...DEFAULT_BRAND_WELCOME_EMAIL_DATA.firecrawlWelcomeEmailCopy };

  const rawSocialLinks =
    (Array.isArray(style.socialLinks) && style.socialLinks) ||
    (Array.isArray(style.social_links) && style.social_links) ||
    (Array.isArray(style.firecrawlSocialLinks) && style.firecrawlSocialLinks) ||
    [];
  const socialLinks: BrandWelcomeEmailSocialLink[] = rawSocialLinks
    .map((item): BrandWelcomeEmailSocialLink | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const url = payloadFirst(record.url, record.href, record.firecrawlUrl);
      if (!url) return null;
      return { label: payloadFirst(record.label, record.type, record.firecrawlLabel), url };
    })
    .filter((item): item is BrandWelcomeEmailSocialLink => item !== null);

  const buttonBorderRadiusPx =
    typeof style.buttonBorderRadiusPx === "number" && Number.isFinite(style.buttonBorderRadiusPx)
      ? style.buttonBorderRadiusPx
      : DEFAULT_BRAND_WELCOME_EMAIL_DATA.buttonBorderRadiusPx;

  return {
    ...DEFAULT_BRAND_WELCOME_EMAIL_DATA,
    name: payloadFirst(style.name),
    brandName: payloadFirst(
      style.brandName,
      style.brand_name,
      style.firecrawlBrandName,
      fallback.brandName,
    ),
    website: payloadFirst(
      style.website,
      style.websiteUrl,
      style.website_url,
      style.firecrawlSourceUrl,
      style.firecrawl_source_url,
      fallback.websiteUrl,
    ),
    foregroundColor:
      payloadFirst(style.foregroundColor, style.foreground_color) ||
      DEFAULT_BRAND_WELCOME_EMAIL_DATA.foregroundColor,
    accentColor:
      payloadFirst(style.accentColor, style.accent_color) ||
      DEFAULT_BRAND_WELCOME_EMAIL_DATA.accentColor,
    headingFontFamily:
      payloadFirst(style.headingFontFamily, style.heading_font_family) ||
      DEFAULT_BRAND_WELCOME_EMAIL_DATA.headingFontFamily,
    bodyFontFamily:
      payloadFirst(style.bodyFontFamily, style.body_font_family) ||
      DEFAULT_BRAND_WELCOME_EMAIL_DATA.bodyFontFamily,
    buttonBorderRadiusPx,
    brandSubtext: payloadFirst(
      style.brandSubtext,
      style.brand_subtext,
      style.firecrawlBrandSubtext,
    ),
    footerAddress: payloadFirst(style.footerAddress, style.footer_address),
    logoUrl:
      payloadFirst(
        style.logoCdnUrl,
        style.logo_cdn_url,
        style.logoUrl,
        style.logo_url,
        style.firecrawlLogoUrl,
      ) || null,
    socialLinks,
    firecrawlSourceUrl: payloadFirst(
      style.firecrawlSourceUrl,
      style.firecrawl_source_url,
      style.website,
      fallback.websiteUrl,
    ),
    firecrawlPulledAt: style.firecrawlPulledAt ?? style.firecrawl_pulled_at ?? null,
    firecrawlBrandName: payloadFirst(style.firecrawlBrandName, style.firecrawl_brand_name),
    firecrawlHomepageSummary: payloadFirst(
      style.firecrawlHomepageSummary,
      style.firecrawl_homepage_summary,
    ),
    firecrawlAudience: payloadFirst(style.firecrawlAudience, style.firecrawl_audience),
    firecrawlValueProps: payloadStringArray(
      style.firecrawlValueProps ?? style.firecrawl_value_props,
    ),
    firecrawlHeroHeadline: payloadFirst(style.firecrawlHeroHeadline, style.firecrawl_hero_headline),
    firecrawlHeroSubheadline: payloadFirst(
      style.firecrawlHeroSubheadline,
      style.firecrawl_hero_subheadline,
    ),
    firecrawlPrimaryCtaText: payloadFirst(
      style.firecrawlPrimaryCtaText,
      style.firecrawl_primary_cta_text,
    ),
    firecrawlWelcomeEmailCopy: welcomeCopy,
    firecrawlHeadingFontFamily: payloadFirst(
      style.firecrawlHeadingFontFamily,
      style.firecrawl_heading_font_family,
    ),
    firecrawlHeadingFallbackFontFamily: payloadFirst(
      style.firecrawlHeadingFallbackFontFamily,
      style.firecrawl_heading_fallback_font_family,
    ),
    firecrawlBodyFontFamily: payloadFirst(
      style.firecrawlBodyFontFamily,
      style.firecrawl_body_font_family,
    ),
    firecrawlBodyFallbackFontFamily: payloadFirst(
      style.firecrawlBodyFallbackFontFamily,
      style.firecrawl_body_fallback_font_family,
    ),
    firecrawlPrimaryColor: payloadFirst(style.firecrawlPrimaryColor, style.firecrawl_primary_color),
    firecrawlSecondaryColor: payloadFirst(
      style.firecrawlSecondaryColor,
      style.firecrawl_secondary_color,
    ),
    firecrawlAccentColor: payloadFirst(style.firecrawlAccentColor, style.firecrawl_accent_color),
    firecrawlBackgroundColor: payloadFirst(
      style.firecrawlBackgroundColor,
      style.firecrawl_background_color,
    ),
    firecrawlTextColor: payloadFirst(style.firecrawlTextColor, style.firecrawl_text_color),
    firecrawlLinkColor: payloadFirst(style.firecrawlLinkColor, style.firecrawl_link_color),
    firecrawlThemePreference: payloadFirst(
      style.firecrawlThemePreference,
      style.firecrawl_theme_preference,
      style.colorScheme,
      style.color_scheme,
    ),
    firecrawlCtaBackgroundColor: payloadFirst(
      style.firecrawlCtaBackgroundColor,
      style.firecrawl_cta_background_color,
    ),
    firecrawlCtaTextColor: payloadFirst(
      style.firecrawlCtaTextColor,
      style.firecrawl_cta_text_color,
    ),
    firecrawlCtaBorderColor: payloadFirst(
      style.firecrawlCtaBorderColor,
      style.firecrawl_cta_border_color,
    ),
    firecrawlCtaBorderRadius: payloadFirst(
      style.firecrawlCtaBorderRadius,
      style.firecrawl_cta_border_radius,
    ),
    firecrawlLogoUrl: payloadFirst(style.firecrawlLogoUrl, style.firecrawl_logo_url),
    firecrawlScreenshotCdnUrl: payloadFirst(
      style.firecrawlScreenshotCdnUrl,
      style.firecrawl_screenshot_cdn_url,
    ),
    firecrawlImages: Array.isArray(style.firecrawlImages)
      ? style.firecrawlImages
      : Array.isArray(style.firecrawl_images)
        ? style.firecrawl_images
        : [],
  };
};

export const getBrandWelcomeEmailRecommendedWorkflows = (
  style: Record<string, unknown>,
): string[] =>
  payloadStringArray(
    style.firecrawlRecommendedEmailWorkflows ??
      style.firecrawl_recommended_email_workflows ??
      style.recommendedEmailWorkflows ??
      style.recommended_email_workflows,
  ).slice(0, 5);

export const renderBrandWelcomeEmailHtml = (
  formData: BrandWelcomeEmailData,
  { themeMode = "light", projectName = "Preview" }: BrandWelcomeEmailRenderOptions = {},
): string => {
  const derived = getDerivedBrandStyleFields(formData);
  const surface = getBrandStylePreviewSurfaceColors(formData, themeMode);

  const innerBackgroundColor =
    surface?.innerBackgroundColor ??
    getBrandStylePreviewInnerBackgroundColor(derived.backgroundColor);
  const outerBackgroundColor =
    surface?.outerBackgroundColor ?? BRAND_STYLE_PREVIEW_OUTER_BACKGROUND_COLOR;
  const containerBackgroundColor = surface?.containerBackgroundColor ?? "#FFFFFF";
  const bodyTextColor = surface?.bodyTextColor ?? derived.foregroundColor;
  const headingTextColor = surface?.headingTextColor ?? getPreviewHeaderTextColor(formData);
  const mutedTextColor =
    surface?.mutedTextColor ??
    getMutedSurfaceTextColor(innerBackgroundColor, derived.foregroundColor);
  const linkColor =
    surface?.linkColor ??
    getReadablePreviewLinkColor(
      innerBackgroundColor,
      formData.firecrawlLinkColor || derived.accentColor,
      bodyTextColor,
    );

  const bodyRgb = hexToRgbToken(bodyTextColor) ?? "rgb(67,69,75)";
  const titleRgb = hexToRgbToken(headingTextColor) ?? "rgb(20,23,30)";
  const mutedRgb = hexToRgbToken(mutedTextColor) ?? "rgb(123,125,129)";
  const linkRgb = hexToRgbToken(linkColor) ?? "#067df7";

  const headingFontFamily = formData.firecrawlHeadingFontFamily || formData.headingFontFamily;
  const bodyFontFamily = formData.firecrawlBodyFontFamily || formData.bodyFontFamily;
  const headingStack = getBrandStyleEmailFontStack({
    primaryFontFamily: headingFontFamily,
    fallbackFontFamily: getBrandStyleFormFallbackFont({
      primaryFontFamily: headingFontFamily,
      fallbackFontFamily: formData.firecrawlHeadingFallbackFontFamily,
      role: "heading",
    }),
    role: "heading",
  });
  const bodyStack = getBrandStyleEmailFontStack({
    primaryFontFamily: bodyFontFamily,
    fallbackFontFamily: getBrandStyleFormFallbackFont({
      primaryFontFamily: bodyFontFamily,
      fallbackFontFamily: formData.firecrawlBodyFallbackFontFamily,
      role: "body",
    }),
    role: "body",
  });

  const neutralFontFamily =
    getPrimaryBrandStyleFontFamily(bodyFontFamily) ?? derived.bodyFontFamily;
  const replacesStaticFont = neutralFontFamily !== "Inter";
  const staticStack = getStaticTemplateFontStack(neutralFontFamily);
  const headMeta = replacesStaticFont
    ? HEAD_META.replace(
        /font-family:(?:(?:&quot;.*?&quot;)|(?:&#39;.*?&#39;)|[^;"])+/g,
        `font-family:${staticStack}`,
      )
    : HEAD_META;
  const outerTdFontFamily = replacesStaticFont ? staticStack : "Inter,system-ui,Arial,sans-serif";

  const googleFontsHref = getBrandStyleGoogleFontsStylesheetHref([
    headingFontFamily,
    bodyFontFamily,
  ]);

  const logoPreviewUrl = formData.logoDataUrl ?? formData.logoUrl;
  const logoPreload = logoPreviewUrl
    ? `<link rel="preload" as="image" href="${logoPreviewUrl}"/>`
    : "";
  const logoRegion = logoPreviewUrl
    ? `<img height="24" alt="" src="${logoPreviewUrl}" style="display:block;outline:none;border:none;text-decoration:none;height:24px;width:auto;max-width:96px;object-fit:contain"/>`
    : LOGO_PLACEHOLDER;

  let innerCardStyle = setInlineStyleDeclaration(
    BASE_INNER_CARD_STYLE,
    "background-color",
    rgbOr(innerBackgroundColor),
  );
  if (surface?.innerBorderColor) {
    innerCardStyle = setInlineStyleDeclaration(
      innerCardStyle,
      "border",
      `1px solid ${rgbOr(surface.innerBorderColor)}`,
    );
    innerCardStyle = setInlineStyleDeclaration(innerCardStyle, "border-collapse", "separate");
  }
  if (surface?.innerBorderRadiusPx != null) {
    innerCardStyle = setInlineStyleDeclaration(
      innerCardStyle,
      "border-radius",
      `${surface.innerBorderRadiusPx}px`,
    );
  }

  const previewText = getWelcomeEmailPreviewText(formData);
  const headline = getWelcomeEmailHeadline(formData);
  const bodyParagraphs = getWelcomeEmailBodyParagraphs(formData);
  const sampleBrandName = formData.brandName.trim() || projectName;

  const paragraphsHtml = bodyParagraphs
    .map(
      (paragraph) =>
        `<p class="last_mb-0" style="font-size:16px;line-height:1.5;font-weight:420;letter-spacing:-0.048px;color:${bodyRgb};margin-top:0rem;margin-bottom:1.5rem;max-width:420px;text-align:left;font-family:${bodyStack}">${escapeHtml(paragraph)}</p>`,
    )
    .join("");

  const ctaText = formData.firecrawlPrimaryCtaText.trim() || "Get started";
  const buttonBackgroundColor = getButtonBackgroundColor(formData);
  const buttonBorderColor = getButtonBorderColor(formData);
  const ctaHtml = `<p style="font-size:16px;line-height:1.5;font-weight:420;letter-spacing:-0.048px;color:${bodyRgb};margin-top:0rem;margin-bottom:1.5rem;max-width:420px;text-align:left;font-family:${bodyStack}"><a href="https://example.com/" style="background-color:${rgbOr(buttonBackgroundColor)};border-color:${rgbOr(buttonBorderColor)};border-style:solid;border-width:1px;border-radius:${derived.buttonBorderRadiusPx}px;color:${rgbOr(derived.buttonTextColor)};display:inline-block;font-weight:600;line-height:1.5;padding:0.75rem 1.125rem;text-decoration-line:none;font-family:${bodyStack}" target="_blank">${escapeHtml(ctaText)}</a></p>`;

  const signoffHtml = `<p style="font-size:13px;line-height:1.5;font-weight:420;letter-spacing:-0.039px;color:${bodyRgb};margin-top:2rem;margin-bottom:0rem;text-align:left;font-family:${bodyStack}">Thanks,<br/>The ${escapeHtml(sampleBrandName)} Team</p>`;

  const brandSubtext = cleanPreviewSentence(formData.brandSubtext);
  const footerAddress = cleanPreviewSentence(formData.footerAddress);
  const subtextHtml = brandSubtext
    ? `<p style="font-size:13px;line-height:1.5;font-weight:420;letter-spacing:-0.039px;color:${mutedRgb};margin-right:auto;margin-left:auto;margin-top:0rem;margin-bottom:0rem;max-width:280px;text-align:center;font-family:${bodyStack}">${escapeHtml(brandSubtext)}</p>`
    : "";

  const allowedSocialLabels = new Set<string>(
    BRAND_KIT_SOCIAL_LINK_OPTIONS.map((option) => option.label),
  );
  const coercedSocialLinks = formData.socialLinks.map((link) => ({
    label: allowedSocialLabels.has(link.label) ? link.label : "Website",
    url: link.url,
  }));
  const filledSocialLinks = getFilledFooterSocialLinks(coercedSocialLinks);
  const socialAnchors = filledSocialLinks
    .map((link) => {
      const iconUrl = getBrandKitSocialIconUrl(link.label, bodyTextColor);
      return `<a href="${escapeHtml(link.url)}" style="color:${linkRgb};text-decoration-line:none;display:inline-block;padding-right:0.5rem;padding-left:0.5rem;vertical-align:middle;font-family:${bodyStack}" target="_blank"><img alt="${escapeHtml(link.label)}" src="${escapeHtml(iconUrl)}" style="display:block;outline:none;border:none;text-decoration:none" width="18"/></a>`;
    })
    .join("");
  const socialHtml = socialAnchors
    ? `<table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="margin-top:2rem;margin-bottom:0rem"><tbody><tr><td>${socialAnchors}</td></tr></tbody></table>`
    : "";

  const addressHtml = footerAddress
    ? `<p style="font-size:11px;line-height:1.5;font-weight:420;letter-spacing:-0.033px;color:${mutedRgb};margin-top:2rem;margin-bottom:0rem;text-align:center;font-family:${bodyStack}">${escapeHtml(footerAddress)}</p>`
    : "";

  const unsubscribeMarginTop = footerAddress ? "1.25rem" : "2rem";
  const unsubscribeHtml = `<p style="font-size:11px;line-height:1.5;font-weight:420;letter-spacing:-0.033px;color:${mutedRgb};margin:0rem;text-align:center;margin-top:${unsubscribeMarginTop};margin-bottom:0rem;margin-left:0rem;margin-right:0rem;font-family:${bodyStack}"><a href="https://example.com/" style="color:${mutedRgb};text-decoration-line:none;font-family:${bodyStack}" target="_blank">Unsubscribe</a> <!-- -->from <!-- -->${escapeHtml(sampleBrandName)}<!-- -->`;

  const outerRgb = rgbOr(outerBackgroundColor);
  const containerRgb = rgbOr(containerBackgroundColor);

  return (
    HEAD_START +
    logoPreload +
    headMeta +
    (googleFontsHref ? `<link rel="stylesheet" href="${googleFontsHref}"/>` : "") +
    HEAD_CLOSE +
    outerRgb +
    BODY_OPEN +
    outerRgb +
    TD_FONT_PREFIX +
    outerTdFontFamily +
    PREHEADER_OPEN +
    escapeHtml(previewText) +
    "<div>" +
    PREHEADER_FILLER +
    "</div></div>" +
    AFTER_PREHEADER +
    containerRgb +
    HEADER_BAND +
    logoRegion +
    "</td>" +
    AFTER_LOGO +
    innerCardStyle +
    INNER_TO_H1 +
    `font-size:28px;font-weight:600;letter-spacing:-0.084px;line-height:1.3;color:${titleRgb};margin:0rem;text-align:left;font-family:${headingStack}">` +
    escapeHtml(headline) +
    H1_CLOSE_TO_PARAGRAPHS +
    paragraphsHtml +
    ctaHtml +
    signoffHtml +
    "</td></tr></tbody></table>" +
    FOOTER_BAND_OPEN +
    containerRgb +
    FOOTER_BAND_TO_CONTENT +
    subtextHtml +
    socialHtml +
    addressHtml +
    unsubscribeHtml +
    TAIL
  );
};
