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
    question: "How do I move my Lovable Cloud database to Supabase?",
    answer:
      "Use this free, open-source exporter. Deploy a temporary edge function to your Lovable Cloud project, point it at an empty Supabase project, and the exporter copies your tables, users, and storage files in a single pass. Small projects often finish in a few minutes; larger databases or storage-heavy projects take longer.",
  },
  {
    question: "Does the exporter require users to reset their passwords?",
    answer:
      "No. The exporter migrates user accounts with their password hashes intact, so existing users do not need to reset their passwords or re-verify their email addresses.",
  },
  {
    question: "Will my users have to log in again after migration?",
    answer:
      "They may need to log in again after you cut over to the new Supabase project. The important part is that password hashes and auth records are preserved, so users can keep using their existing credentials without a forced password reset or email re-verification.",
  },
  {
    question: "What does the exporter move from Lovable Cloud?",
    answer:
      "It moves your database tables, user accounts (with passwords intact), and storage files into your own Supabase project. Row-level security policies on tables come across automatically.",
  },
  {
    question: "Is migrating off Lovable Cloud reversible?",
    answer:
      "Yes. The exporter is non-destructive — it reads from Lovable Cloud and writes into a new Supabase project, so your original data stays intact until you choose to retire it. You can keep both running side by side while you cut over.",
  },
  {
    question: "What is the difference between Lovable Cloud and connecting your own Supabase?",
    answer:
      "Lovable Cloud is a managed backend that Lovable provisions for you — convenient for prototyping but billed per usage and tied to Lovable. Connecting your own Supabase project means you own the database, storage, and secrets directly, which can lower ongoing cost and lets you connect external tools like Dreamlit, Claude Code, or Cursor.",
  },
  {
    question: "How long does a Lovable Cloud export take?",
    answer:
      "Small projects often finish in a few minutes. Time scales with the size of your database and storage, so large databases or media-heavy projects can take much longer. If storage copy fails after the database clone succeeds, you can retry storage without rerunning the database clone.",
  },
  {
    question: "Does the exporter copy storage files and bucket policies?",
    answer:
      "Storage files are copied bucket-by-bucket into your new Supabase project, and public/private bucket configuration carries over. Row-level security policies on database tables come across automatically. Bucket-level policies configured in the Lovable Cloud UI need to be re-applied in Supabase Studio after the migration.",
  },
  {
    question:
      "Can I run the Lovable Cloud exporter without uploading my credentials to a third party?",
    answer:
      "Yes. The tool is open source and ships with both a CLI and a self-hosted web UI. When you run it locally, your Lovable Cloud and Supabase credentials stay on your machine, and migration data only passes through your local runtime.",
  },
  {
    question: "Is the Lovable Cloud to Supabase Exporter free?",
    answer:
      "Yes. The tool is free and open source under the MIT license. You can use the hosted version on dreamlit.ai or run the CLI locally from GitHub.",
  },
  {
    question: "Lovable Cloud cost is climbing — what are my options?",
    answer:
      "You have three: stay on Lovable Cloud and optimize (cache more, reduce AI message usage); move only the backend to your own Supabase project (this tool handles the data move while you keep building in Lovable); or leave Lovable entirely for a tool like Claude Code or Cursor. The exporter is the fastest path to either of the last two without losing users or data.",
  },
  {
    question: "Can I keep using Lovable after exporting my data?",
    answer:
      "Yes. Once your data is in your own Supabase project, you can connect that project to a new Lovable app and keep building on top of infrastructure you control.",
  },
  {
    question: "Why move off Lovable Cloud?",
    answer:
      "Lovable Cloud is great for prototyping but you may outgrow it as costs rise or as you need direct ownership of your database, storage, and secrets. Moving to your own Supabase also makes it easier to connect external services or your own tooling without being tied to a single platform.",
  },
  {
    question: "What is the exporter doing exactly?",
    answer:
      "You deploy a temporary edge function to your Lovable Cloud project. The exporter uses it to read your tables, users, and storage files, then writes everything into your own Supabase project. Once the migration is done, you remove the edge function.",
  },
  {
    question: "What does the exporter not cover?",
    answer:
      "API keys, secrets, and third-party service credentials. Login provider settings like OAuth configuration or redirect URLs. App deployment, DNS, hosting, or the broader app setup. You re-configure these in your new environment.",
  },
  {
    question: "Is the exporter open source?",
    answer:
      "Yes, fully open source under the MIT license. You can inspect the code, run the CLI yourself, or self-host the entire tool from the GitHub repository.",
  },
  {
    question: "Does Dreamlit store my data during the export?",
    answer:
      "Hosted transfer jobs are processed transiently by Dreamlit's exporter runtime, and migration data is not kept after the job. You can also self-host the tool or run the CLI locally if you do not want credentials or data to pass through Dreamlit infrastructure.",
  },
  {
    question: "Is there an equivalent exporter for Replit, Bolt, or other vibe coding platforms?",
    answer:
      "Not yet. The current exporter is built around Lovable Cloud. Let Dreamlit know on X (@DreamlitAI) or in r/dreamlitai which platform you want next.",
  },
  {
    question: "How do I migrate my email setup from Lovable Cloud Custom Emails?",
    answer:
      "Custom Email is tied to Lovable Cloud and there is no documented path to keep using it on your own infrastructure. After migration, swap in another email solution such as Dreamlit or Resend.",
  },
];

const HOW_TO_STEPS = [
  {
    name: "Add the migrate helper",
    text: "Deploy a temporary helper edge function to your Lovable Cloud project. The exporter uses it to read your tables, users, and storage files.",
  },
  {
    name: "Choose how to export",
    text: "Pick the transfer mode: copy directly into an empty Supabase project you own, or download a ZIP archive of your data for offline use.",
  },
  {
    name: "Run the export",
    text: "Start the transfer. Tables, user accounts (with passwords intact), and storage files copy from Lovable Cloud into your Supabase project.",
  },
  {
    name: "Transfer configs",
    text: "Point your app at the new Supabase project. Re-add any API keys, OAuth providers, or third-party credentials that did not migrate automatically.",
  },
  {
    name: "Clean up",
    text: "Remove the temporary edge function from Lovable Cloud and rotate any keys you used during the migration.",
  },
];

const BREADCRUMB_ITEMS = [
  { name: "Dreamlit", path: "" },
  { name: "Tools", path: "/tools" },
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
  const siteUrl = normalizeSiteUrl(process.env.VITE_PUBLIC_SITE_URL || process.env.VITE_SITE_URL);
  const breadcrumbItems = [
    ...BREADCRUMB_ITEMS.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${siteUrl}${item.path}`,
    })),
    {
      "@type": "ListItem",
      position: BREADCRUMB_ITEMS.length + 1,
      name: "Lovable Cloud to Supabase Exporter",
      item: canonicalUrl,
    },
  ];

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
      {
        "@type": "HowTo",
        name: "How to migrate from Lovable Cloud to Supabase",
        description:
          "Move your Lovable Cloud database tables, user accounts, and storage files into your own Supabase project without password resets or manual CSV work.",
        tool: [
          { "@type": "HowToTool", name: "Lovable Cloud project" },
          { "@type": "HowToTool", name: "Empty Supabase project" },
        ],
        step: HOW_TO_STEPS.map((item, index) => ({
          "@type": "HowToStep",
          position: index + 1,
          name: item.name,
          text: item.text,
        })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: breadcrumbItems,
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
