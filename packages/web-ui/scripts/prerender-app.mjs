import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(__dirname);
const clientOutDir = join(packageDir, "app-dist");
const ssrOutDir = join(clientOutDir, ".ssr");
const indexHtmlPath = join(clientOutDir, "index.html");

const APP_TITLE = "Free Lovable Cloud to Supabase Exporter | Dreamlit";
const APP_DESCRIPTION =
  "Free, open-source Lovable Cloud to Supabase Exporter. Migrate database tables, auth users, and storage files into your own Supabase project without password resets.";
const APP_OG_IMAGE =
  "https://dreamlit.ai/blog/lovable-cloud-exporter/lovable-cloud-functions-poster.webp";
const DEFAULT_PUBLIC_SITE_URL = "https://dreamlit.ai";
const DEFAULT_CANONICAL_PATH = "/tools/lovable-cloud-to-supabase-exporter/";

const FAQ_ITEMS = [
  {
    question: "Does the exporter require users to reset their passwords?",
    answer:
      "No. The exporter migrates user accounts with authentication intact so users do not need to reset their passwords or re-verify their email addresses.",
  },
  {
    question: "What does the exporter move from Lovable Cloud?",
    answer:
      "It moves your database tables, user accounts, and storage files into your own Supabase project.",
  },
  {
    question: "Is the Lovable Cloud to Supabase Exporter free?",
    answer:
      "Yes. The tool is free and open source, and you can use the hosted version on dreamlit.ai or run it locally from GitHub.",
  },
  {
    question: "Can I keep using Lovable after exporting my data?",
    answer:
      "Yes. Once your data is in your own Supabase project, you can connect that project to a new Lovable app and keep building on top of infrastructure you control.",
  },
];

function normalizeBasePath(value) {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_CANONICAL_PATH;
  if (trimmed === "." || trimmed === "./") return DEFAULT_CANONICAL_PATH;
  if (trimmed === "/") return DEFAULT_CANONICAL_PATH;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function normalizeSiteUrl(value) {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_PUBLIC_SITE_URL;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function buildCanonicalUrl() {
  const siteUrl = normalizeSiteUrl(process.env.VITE_PUBLIC_SITE_URL || process.env.VITE_SITE_URL);
  const explicitCanonical = process.env.VITE_CANONICAL_URL?.trim();

  if (explicitCanonical) {
    return explicitCanonical;
  }

  const appBasePath = normalizeBasePath(process.env.VITE_APP_BASE_PATH);
  return new URL(appBasePath, `${siteUrl}/`).toString().replace(/\/$/, "");
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildSeoHead(canonicalUrl) {
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: "Lovable Cloud to Supabase Exporter",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        isAccessibleForFree: true,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
        description: APP_DESCRIPTION,
        url: canonicalUrl,
        publisher: {
          "@type": "Organization",
          name: "Dreamlit AI",
          url: "https://dreamlit.ai",
        },
      },
      {
        "@type": "FAQPage",
        mainEntity: FAQ_ITEMS.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: item.answer,
          },
        })),
      },
    ],
  };

  const escapedTitle = escapeAttribute(APP_TITLE);
  const escapedDescription = escapeAttribute(APP_DESCRIPTION);
  const escapedCanonical = escapeAttribute(canonicalUrl);
  const escapedImage = escapeAttribute(APP_OG_IMAGE);

  return [
    `<meta name="robots" content="index, follow" />`,
    `<meta name="googlebot" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />`,
    `<link rel="canonical" href="${escapedCanonical}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapedTitle}" />`,
    `<meta property="og:description" content="${escapedDescription}" />`,
    `<meta property="og:url" content="${escapedCanonical}" />`,
    `<meta property="og:image" content="${escapedImage}" />`,
    `<meta property="og:image:alt" content="${escapedTitle}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapedTitle}" />`,
    `<meta name="twitter:description" content="${escapedDescription}" />`,
    `<meta name="twitter:image" content="${escapedImage}" />`,
    `<script type="application/ld+json">${JSON.stringify(schema)}</script>`,
  ].join("\n    ");
}

async function loadSsrRender() {
  const ssrEntries = await readdir(ssrOutDir, { withFileTypes: true });
  const entryFile = ssrEntries.find((entry) => entry.isFile() && entry.name.endsWith(".js"));

  if (!entryFile) {
    throw new Error(`Could not find the SSR bundle in ${ssrOutDir}.`);
  }

  const serverModuleUrl = pathToFileURL(join(ssrOutDir, entryFile.name)).href;
  const serverModule = await import(serverModuleUrl);

  if (typeof serverModule.render !== "function") {
    throw new Error("The SSR bundle did not export a render() function.");
  }

  return serverModule.render;
}

async function main() {
  const render = await loadSsrRender();
  const appHtml = render();
  const canonicalUrl = buildCanonicalUrl();
  const template = await readFile(indexHtmlPath, "utf8");

  const withRenderedApp = template.replace(
    `<div id="root"></div>`,
    `<div id="root">${appHtml}</div>`,
  );

  const finalHtml = withRenderedApp.replace(`<!-- prerender-head -->`, buildSeoHead(canonicalUrl));

  await writeFile(indexHtmlPath, finalHtml, "utf8");
  await rm(ssrOutDir, { recursive: true, force: true });
}

await main();
