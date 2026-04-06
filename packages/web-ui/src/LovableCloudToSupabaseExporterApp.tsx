"use client";

import { createClient } from "@supabase/supabase-js";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  Check,
  CircleHelp,
  Copy,
  Download,
  Eye,
  EyeOff,
  Info,
  LoaderCircle,
  LogOut,
  Minus,
  User,
  Play,
  Plus,
  Wrench,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { highlight } from "sugar-high";
import migrateHelperSourceTemplate from "../../../edge-function/index.ts?raw";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import { Checkbox } from "./components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import copyUrlPng from "./assets/copy-url.png";
import deployCloudFunctionPng from "./assets/deploy-cloud-function.png";
import lovableCloudFunctionsMp4 from "./assets/lovable-cloud-functions.mp4";
import lovableCloudFunctionsPosterPng from "./assets/lovable-cloud-functions-poster.png";
import supabaseConnectMp4 from "./assets/supabase-connect.mp4";
import supabaseConnectPosterPng from "./assets/supabase-connect-poster.png";
import supabaseSecretKeyPng from "./assets/supabase-secret-key.png";
import { IntercomMessenger, showIntercom } from "./intercom";
import { extractSupabaseProjectRefFromPostgresUrl, normalizePostgresUrl } from "./postgres-url";

import "./styles.css";

export type LovableCloudToSupabaseExporterAuthConfig = {
  url: string;
  anonKey: string;
  redirectUrl?: string;
  turnstileSiteKey?: string;
};

export type LovableCloudToSupabaseExporterAppProps = {
  assetBaseUrl?: string;
  promoVideoEmbedUrl?: string;
  dreamlitBaseUrl?: string;
  apiBaseUrl?: string;
  supportsZipExport?: boolean;
  authConfig?: LovableCloudToSupabaseExporterAuthConfig | null;
};

type SigninStep = "form" | "success";
type AuthGateStatus = "disabled" | "checking" | "required" | "authenticated";
type MigrationJobStatus = "idle" | "running" | "succeeded" | "failed";
type MigrationJobEvent = {
  at: string;
  level: "info" | "warn" | "error";
  phase: string;
  message: string;
  data?: Record<string, unknown>;
};
type MigrationJobRecord = {
  status: MigrationJobStatus;
  run_id?: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  events: MigrationJobEvent[];
  debug?: {
    failure_hint?: string | null;
    monitor_raw_error?: string | null;
  } | null;
};
type TransferRunStatus = "idle" | "starting" | "running" | "succeeded" | "failed";
type ExportAction = "transfer" | "download";
type TransferRunVariant = "full" | "storage-only";
type TransferRunState = {
  action: ExportAction | null;
  variant: TransferRunVariant | null;
  status: TransferRunStatus;
  errorMessage: string;
  jobId: string | null;
  record: MigrationJobRecord | null;
};
type TaskCardStatus = "idle" | "starting" | "running" | "succeeded" | "failed";
type JobProgressView = {
  status: TaskCardStatus;
  percent: number;
  headline: string;
  detail: string;
  context: string | null;
  updatedAt: string | null;
};

type PreviewMedia =
  | {
      kind: "image";
      src: string;
      alt: string;
      title: string;
    }
  | {
      kind: "video";
      src: string;
      posterSrc?: string;
      title: string;
    };

type ResolvedAuthConfig = {
  url: string;
  anonKey: string;
  redirectUrl: string;
  turnstileSiteKey?: string;
};

type TurnstileRenderOptions = {
  sitekey: string;
  theme?: "auto" | "light" | "dark";
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};

type FaqItem = {
  id: string;
  question: string;
  answer: ReactNode;
};

const DEFAULT_ASSET_BASE_URL = "https://dreamlit.ai";
const DEFAULT_DREAMLIT_BASE_URL = "https://dreamlit.ai";
const DEFAULT_PROMO_VIDEO_EMBED_URL =
  "https://player.vimeo.com/video/1123284342?badge=0&autopause=0&player_id=0&app_id=58479&autoplay=1";
const OPEN_SOURCE_REPO_URL = "https://github.com/dreamlit-ai/lovable-cloud-to-supabase-exporter";
const AFTER_MIGRATION_GUIDE_URL =
  "https://github.com/dreamlit-ai/lovable-cloud-to-supabase-exporter/blob/main/docs/choosing-how-you-build-and-host.md";
const PROMO_VIDEO_TITLE = "The Way of Email";
const LOVABLE_MIGRATION_DOCS_URL =
  "https://docs.lovable.dev/tips-tricks/external-deployment-hosting#what-migrates-and-how";
const SUPABASE_DASHBOARD_URL = "https://supabase.com/dashboard";
const SUPABASE_API_KEYS_DOCS_URL = "https://supabase.com/docs/guides/api/api-keys";
const SUPABASE_PASSWORDS_DOCS_URL = "https://supabase.com/docs/guides/database/managing-passwords";
const DEFAULT_EXPORTER_API_BASE_URL = "http://127.0.0.1:8799";
const JOB_POLL_INTERVAL_MS = 1200;
const TRANSFER_CARD_NOTE =
  "Running the exporter tool now. Do not refresh this page while the transfer is running.";
const EDGE_FUNCTION_DEFINITION =
  "A small server-side script that runs on Lovable Cloud. You\u2019ll create a temporary one to securely export your data.";
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let turnstileScriptPromise: Promise<void> | null = null;

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const HERO_MESH_STYLE: CSSProperties = {
  background:
    "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(249, 115, 22, 0.08), transparent 50%), radial-gradient(ellipse 60% 40% at 70% 80%, rgba(249, 115, 22, 0.04), transparent 50%), radial-gradient(ellipse 50% 30% at 20% 60%, rgba(108, 140, 231, 0.04), transparent 50%)",
};

const EDGE_FUNCTION_ACCESS_KEY_PATTERN =
  /const ACCESS_KEY = ["']replace-with-your-long-random-access-key["'];/;

const TEXT_LINK_CLASS =
  "font-medium text-zinc-700 underline decoration-stone-300 underline-offset-4 transition-colors hover:text-zinc-900";
const FAQ_LINK_CLASS =
  "underline decoration-neutral-400 underline-offset-4 transition-colors hover:text-neutral-700 hover:decoration-neutral-600";
const FOCUS_RING_CLASS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-50";
const NAVBAR_SECONDARY_ACTION_CLASS =
  "inline-flex items-center gap-1 rounded-full px-2 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:text-orange-500 sm:px-4 sm:py-2 sm:text-sm";
const NAVBAR_PRIMARY_ACTION_CLASS =
  "btn-shadow-static inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-orange-600 sm:gap-2 sm:px-4 sm:text-sm";
const PAGE_RAILS_CONTAINER_CLASS = "mx-auto h-full max-w-7xl px-4 sm:px-12 lg:px-16";
const PAGE_RAILS_CONTENT_CLASS = "relative mx-auto w-full max-w-7xl px-4 sm:px-12 lg:px-16";
const SECTION_DIVIDER_CLASS = "divider-gradient w-full";
const SECTION_TITLE_CLASS = "text-lg font-semibold tracking-tight text-zinc-900";
const PANEL_FRAME_CLASS = "rounded-2xl border border-stone-200/80 bg-[#f8f8f7] p-1";
const PANEL_CARD_CLASS = "rounded-lg border border-stone-100 bg-white";
const INPUT_CLASS =
  "h-10 w-full rounded-lg border border-stone-200/85 bg-white px-3.5 text-sm text-zinc-900 transition focus:border-orange-400/70 focus:shadow-[0_0_0_3px_rgba(251,146,60,0.18)] focus:outline-none placeholder:text-zinc-400 read-only:bg-white disabled:cursor-not-allowed disabled:border-stone-200/70 disabled:bg-stone-100/80 disabled:text-zinc-400";
const BUTTON_SHELL_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all";
const PREVIEW_VIDEO_MODAL_ANIMATION_MS = 220;

const FAQ_ITEMS: readonly FaqItem[] = [
  {
    id: "why-exists",
    question: "Why does this project exist?",
    answer: (
      <>
        <p>
          Lovable has{" "}
          <a
            href="https://docs.lovable.dev/tips-tricks/external-deployment-hosting#what-migrates-and-how"
            target="_blank"
            rel="noopener noreferrer"
            className={FAQ_LINK_CLASS}
          >
            documentation
            <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
          </a>{" "}
          for moving to your own Supabase, but the process is rough:
        </p>
        <ul className="space-y-2 text-base leading-6 text-neutral-600 sm:text-lg sm:leading-7">
          <li>
            Every user needs to reset their password. If you have real users, that's a non-starter.
          </li>
          <li>
            You're exporting and importing table data via CSV, one table at a time, in the right
            dependency order.
          </li>
          <li>Storage files need to be downloaded and re-uploaded individually.</li>
          <li>Miss a step or get the order wrong, and you're starting over.</li>
        </ul>
        <p>
          This tool handles all of it. Tables, users, and storage move to your Supabase backend
          without password resets or manual work.
        </p>
      </>
    ),
  },
  {
    id: "why-move-off",
    question: "Why move off Lovable Cloud?",
    answer: (
      <p>
        Lovable Cloud is great for prototyping, but you may outgrow it as costs rise or as you need
        direct ownership of your database, storage, and secrets. Moving to your own Supabase also
        makes it easier to connect external services like Dreamlit or your own tooling, without
        being tied to a single platform. You can still keep building in Lovable if you want.
      </p>
    ),
  },
  {
    id: "what-not-covered",
    question: "What doesn't this tool cover?",
    answer: (
      <ul className="space-y-2">
        <li>API keys, secrets, or third-party service credentials.</li>
        <li>Login provider settings like OAuth config or redirect URLs.</li>
        <li>App deployment, DNS, hosting, or the broader app setup.</li>
      </ul>
    ),
  },
  {
    id: "dreamlit",
    question: "What is Dreamlit?",
    answer: (
      <p>
        Dreamlit lets you add professional, branded emails to your app built on Supabase. Connect
        your database, describe what you want in plain English, and the Workflow Agent builds the
        entire workflow for you: triggers, templates, and delivery.
      </p>
    ),
  },
  {
    id: "custom-email",
    question: "How do I migrate my email if I'm using Custom Emails on Lovable Cloud?",
    answer: (
      <p>
        You'll need to remove the Custom Email implementation from your Lovable Cloud project and
        replace it with another email solution (such as Dreamlit or Resend). There's currently no
        documented way to use Lovable Custom Email on your own infrastructure.
      </p>
    ),
  },
  {
    id: "what-does-it-do",
    question: "What is this doing exactly?",
    answer: (
      <p>
        You'll deploy a temporary edge function to your Lovable Cloud project. The exporter uses it
        to read your tables, users, and storage files, then writes everything into your own Supabase
        project. Once it's done, you can remove the edge function.
      </p>
    ),
  },
  {
    id: "free",
    question: "Is this free? What's the catch?",
    answer: (
      <p>
        Completely free, no strings attached. Many of our customers at Dreamlit were stuck on
        Lovable Cloud and wanted to use Dreamlit but couldn't because they didn't have direct access
        to their database. We started helping them one by one and decided to turn it into a tool so
        anyone can take control of their data.
      </p>
    ),
  },
  {
    id: "platforms",
    question: "Do you have an equivalent tool for Replit or other vibe coding platforms?",
    answer: (
      <p>
        The current flow is built around Lovable Cloud, but let us know which other platforms you
        want next. Hit us up on{" "}
        <a
          href="https://x.com/DreamlitAI"
          target="_blank"
          rel="noopener noreferrer"
          className={FAQ_LINK_CLASS}
        >
          X
          <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
        </a>{" "}
        or on{" "}
        <a
          href="https://www.reddit.com/r/dreamlitai/"
          target="_blank"
          rel="noopener noreferrer"
          className={FAQ_LINK_CLASS}
        >
          r/dreamlitai
          <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
        </a>
        .
      </p>
    ),
  },
  {
    id: "open-source",
    question: "Is this open source?",
    answer: (
      <p>
        Fully open source under the MIT license. You can inspect the code, run the CLI yourself, or
        self-host the entire tool from{" "}
        <a
          href={OPEN_SOURCE_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={FAQ_LINK_CLASS}
        >
          GitHub
          <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
        </a>
        .
      </p>
    ),
  },
  {
    id: "data-storage",
    question: "Are you storing my data?",
    answer: (
      <p>
        No. Your data flows directly from Lovable Cloud to your Supabase project. Nothing is stored
        on our side. You can always{" "}
        <a
          href={OPEN_SOURCE_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={FAQ_LINK_CLASS}
        >
          self host the tool or run the commands yourself
          <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
        </a>{" "}
        if you'd like.
      </p>
    ),
  },
  {
    id: "support",
    question: "Running into issues?",
    answer: (
      <p>
        We're here to help. Use the chat widget in the bottom right to reach us directly, or send an
        email to{" "}
        <a href="mailto:support@dreamlit.ai" className={FAQ_LINK_CLASS}>
          support@dreamlit.ai
        </a>
        . We'll help you through it.
      </p>
    ),
  },
];

let hasAnimatedHeaderOnce = false;

export function LovableCloudToSupabaseExporterApp({
  assetBaseUrl = DEFAULT_ASSET_BASE_URL,
  promoVideoEmbedUrl = DEFAULT_PROMO_VIDEO_EMBED_URL,
  dreamlitBaseUrl = DEFAULT_DREAMLIT_BASE_URL,
  apiBaseUrl,
  supportsZipExport,
  authConfig,
}: LovableCloudToSupabaseExporterAppProps) {
  const [isSigninOpen, setIsSigninOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthGateStatus>(() =>
    hasAuthConfig(authConfig) ? "checking" : "disabled",
  );
  const [signedInEmail, setSignedInEmail] = useState("");
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    const resolvedAuthConfig = getOptionalAuthConfig(authConfig);
    if (!resolvedAuthConfig) {
      setAuthStatus("disabled");
      setIsSigninOpen(false);
      setIsSigningOut(false);
      setSignedInEmail("");
      return;
    }

    const supabase = createSupabaseAuthClient(resolvedAuthConfig);
    let isActive = true;

    const applySession = (session: { user?: { email?: string | null } } | null) => {
      if (!isActive) return;

      setIsSigningOut(false);

      if (session?.user) {
        setAuthStatus("authenticated");
        setIsSigninOpen(false);
        setSignedInEmail(session.user.email ?? "");
        return;
      }

      setAuthStatus("required");
      setIsSigninOpen(false);
      setSignedInEmail("");
    };

    void supabase.auth.getSession().then(({ data }) => {
      applySession(data.session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      applySession(session);
    });

    return () => {
      isActive = false;
      subscription.unsubscribe();
    };
  }, [authConfig]);

  const authIsConfigured = authStatus !== "disabled";
  const handleSignOut = async () => {
    if (isSigningOut) return;

    const resolvedAuthConfig = getAuthConfig(authConfig);
    if ("error" in resolvedAuthConfig) return;

    setIsSigningOut(true);

    try {
      const supabase = createSupabaseAuthClient(resolvedAuthConfig);
      const { error } = await supabase.auth.signOut();
      if (error) {
        throw error;
      }
    } catch (error) {
      console.error("Failed to sign out.", error);
      setIsSigningOut(false);
    }
  };

  return (
    <TooltipProvider delayDuration={100}>
      <div className="min-h-screen bg-stone-50 font-sans text-zinc-900 [text-rendering:optimizeLegibility]">
        <IntercomMessenger email={signedInEmail} />

        <ExporterNavbar
          assetBaseUrl={assetBaseUrl}
          dreamlitBaseUrl={dreamlitBaseUrl}
          authStatus={authStatus}
          signedInEmail={signedInEmail}
          isSigningOut={isSigningOut}
          onOpenSignin={() => setIsSigninOpen(true)}
          onSignOut={handleSignOut}
        />

        <main>
          <ExporterHero assetBaseUrl={assetBaseUrl} />
          <div className={SECTION_DIVIDER_CLASS} />
          <AfterMigrationGuideSection />
          <div className={SECTION_DIVIDER_CLASS} />

          <ExporterPanel
            migrateHelperSnippetTemplate={migrateHelperSourceTemplate}
            assetBaseUrl={assetBaseUrl}
            promoVideoEmbedUrl={promoVideoEmbedUrl}
            apiBaseUrl={apiBaseUrl}
            supportsZipExport={supportsZipExport}
            authStatus={authStatus}
            authConfig={authConfig}
            onOpenSignin={() => setIsSigninOpen(true)}
          />

          <SimpleFooter dreamlitBaseUrl={dreamlitBaseUrl} />
        </main>

        <SigninModal
          open={authIsConfigured && isSigninOpen}
          onOpenChange={setIsSigninOpen}
          dreamlitBaseUrl={dreamlitBaseUrl}
          dismissible={authStatus !== "checking"}
          authConfig={authConfig}
        />
      </div>
    </TooltipProvider>
  );
}

const HERO_WHY_POINTS = [
  "Send a password reset email to every user.",
  "Export and re-import tables manually, one CSV at a time, in the right dependency order.",
  "Download and re-upload storage files individually.",
] as const;

const HERO_REQUIREMENTS = [
  "Your Lovable project open in another tab",
  "A new Supabase project for the transfer",
  "~10-15 minutes",
] as const;

function ExporterHero({ assetBaseUrl }: { assetBaseUrl: string }) {
  return (
    <section
      className="relative overflow-hidden pb-12 pt-24 sm:pb-16 sm:pt-28"
      style={HERO_MESH_STYLE}
    >
      <div className={PAGE_RAILS_CONTENT_CLASS}>
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.96fr)_minmax(0,1.04fr)] lg:grid-rows-[auto_1fr] lg:gap-x-12 lg:gap-y-6">
            <div className="lg:col-start-1 lg:row-start-1">
              <HeroEyebrow />
            </div>

            <div className="max-w-lg lg:col-start-1 lg:row-start-2 lg:self-center">
              <HeroMainContent />
            </div>

            <HeroVisual
              assetBaseUrl={assetBaseUrl}
              className="lg:col-start-2 lg:row-start-2 lg:self-center"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function AfterMigrationGuideSection({
  children = (
    <>
      Not sure where to build and host?{" "}
      <a
        href={AFTER_MIGRATION_GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={TEXT_LINK_CLASS}
      >
        Check out your options
        <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
      </a>
      .
    </>
  ),
}: {
  children?: ReactNode;
}) {
  return (
    <section aria-labelledby="after-migration-guide-title" className="relative">
      <PageRails />
      <div className={cx(PAGE_RAILS_CONTENT_CLASS, "py-10 sm:py-12")}>
        <p
          id="after-migration-guide-title"
          className="mx-auto max-w-5xl px-6 text-center text-sm text-neutral-500 sm:px-0"
        >
          {children}
        </p>
      </div>
    </section>
  );
}

function PageRails() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className={PAGE_RAILS_CONTAINER_CLASS}>
        <div className="h-full border-x border-stone-200/80" />
      </div>
    </div>
  );
}

function HeroMainContent({ className }: { className?: string }) {
  return (
    <div className={cx("space-y-6", className)}>
      <HeroTitle />
      <HeroCopyStack>
        <p>
          Lovable is great for building. But when you want to take some part of your app off of
          Lovable, you need your data in your own Supabase database.
        </p>
        <p>
          This free,{" "}
          <a
            href={OPEN_SOURCE_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={TEXT_LINK_CLASS}
          >
            open-source
            <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
          </a>{" "}
          tool moves everything for you: database tables, user accounts, and storage files.
        </p>
        <p>
          Built by{" "}
          <a
            href="https://dreamlit.ai"
            target="_blank"
            rel="noopener noreferrer"
            className={TEXT_LINK_CLASS}
          >
            Dreamlit
            <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
          </a>{" "}
          after helping our own customers migrate off Lovable Cloud.
        </p>
      </HeroCopyStack>
      <HeroWhyThisMatters className="pt-1.5" />
    </div>
  );
}

function HeroWhyThisMatters({ className }: { className?: string }) {
  return (
    <div className={cx("space-y-3", className)}>
      <p className="text-sm font-semibold tracking-[-0.01em] text-zinc-700">
        Why not follow Lovable's migration guide?
      </p>
      <p className="text-sm text-zinc-600">
        The{" "}
        <a
          href={LOVABLE_MIGRATION_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={TEXT_LINK_CLASS}
        >
          guide
          <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
        </a>{" "}
        requires you to:
      </p>
      <HeroCheckList
        items={HERO_WHY_POINTS}
        className="space-y-2 text-sm leading-6 text-zinc-600"
      />
      <p className="text-sm leading-6 text-zinc-600">
        With real users, that's a dealbreaker. This tool handles the full migration automatically.
        No password resets, no manual work.
      </p>
    </div>
  );
}

function HeroEyebrow() {
  return (
    <SectionBadge label="Lovable Cloud Exporter" icon={<Wrench size={14} strokeWidth={2.25} />} />
  );
}

function HeroTitle({ className }: { className?: string }) {
  return (
    <h1
      className={cx(
        "font-sans text-3xl font-medium leading-tight tracking-tighter sm:text-5xl",
        className,
      )}
    >
      Free <span className="text-orange-500">Lovable Cloud</span> to Supabase Exporter
    </h1>
  );
}

function HeroCopyStack({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "space-y-3 text-base leading-relaxed text-zinc-600 sm:text-lg sm:leading-7",
        className,
      )}
    >
      {children}
    </div>
  );
}

function HeroCheckList({
  items,
  className,
  iconClassName,
}: {
  items: readonly string[];
  className?: string;
  iconClassName?: string;
}) {
  return (
    <ul className={className}>
      {items.map((item) => (
        <li key={item} className="flex items-start gap-3">
          <span
            className={cx(
              "mt-[0.62em] h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600",
              iconClassName,
            )}
            aria-hidden="true"
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function HeroVisual({ assetBaseUrl, className }: { assetBaseUrl: string; className?: string }) {
  return (
    <div className={cx("flex justify-center", className)}>
      <PlatformViz assetBaseUrl={assetBaseUrl} />
    </div>
  );
}

function GitHubMarkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function SectionBadge({
  label,
  icon,
  className,
}: {
  label: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 rounded-md border border-stone-200/80 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-[0_0_0_3px_#fafaf9]",
        className,
      )}
    >
      {icon ? (
        <span className="inline-flex h-4 w-4 items-center justify-center text-zinc-400">
          {icon}
        </span>
      ) : null}
      <span>{label}</span>
    </span>
  );
}

function ExporterNavbar({
  assetBaseUrl,
  dreamlitBaseUrl,
  authStatus,
  signedInEmail,
  isSigningOut,
  onOpenSignin,
  onSignOut,
}: {
  assetBaseUrl: string;
  dreamlitBaseUrl: string;
  authStatus: AuthGateStatus;
  signedInEmail: string;
  isSigningOut: boolean;
  onOpenSignin: () => void;
  onSignOut: () => Promise<void>;
}) {
  const [shouldAnimateOnMount] = useState(() => !hasAnimatedHeaderOnce);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const isAuthenticated = authStatus === "authenticated";

  useEffect(() => {
    hasAnimatedHeaderOnce = true;

    const syncScrollState = () => {
      setIsScrolled(window.scrollY > 24);
    };

    syncScrollState();
    window.addEventListener("scroll", syncScrollState);
    return () => window.removeEventListener("scroll", syncScrollState);
  }, []);

  useEffect(() => {
    if (isAuthenticated) return;
    setIsAccountMenuOpen(false);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !isAccountMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (accountMenuRef.current?.contains(event.target as Node)) return;
      setIsAccountMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsAccountMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAccountMenuOpen, isAuthenticated]);

  const showSigninControl = authStatus !== "disabled";
  const authButtonLabel = isAuthenticated ? signedInEmail || "Signed in" : "Sign in to access";

  return (
    <div className="fixed inset-x-0 top-0 z-50 py-0 sm:py-4">
      <nav
        className={cx(
          "mx-auto flex items-center justify-between gap-4 border border-transparent px-3 transition-all duration-300 sm:px-3",
          shouldAnimateOnMount && "motion-safe:animate-[smk-navbar-enter_0.3s_ease_both]",
          isScrolled
            ? "max-w-5xl rounded-lg bg-white/50 py-1.5 backdrop-blur"
            : "max-w-6xl bg-transparent py-1.5",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <img
              src={assetUrl(assetBaseUrl, "/lovable_colored.svg")}
              alt="Lovable logo"
              width={12}
              height={12}
              className="h-3 w-3 shrink-0"
            />
            <p className="truncate text-sm font-medium leading-5 tracking-[-0.02em] text-zinc-900">
              Lovable Cloud to Supabase Exporter
            </p>
          </div>

          <div className="mt-1 flex items-center gap-1.5 text-xs leading-4 text-zinc-500">
            <span className="shrink-0">presented by</span>
            <a
              href={normalizeUrl(dreamlitBaseUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(
                "inline-flex items-center gap-1.5 rounded-md transition-opacity hover:opacity-80",
                FOCUS_RING_CLASS,
              )}
              aria-label="Visit Dreamlit"
            >
              <img
                src={assetUrl(assetBaseUrl, "/logo.svg")}
                alt="Dreamlit AI logo"
                width={16}
                height={16}
                className="h-3.5 w-3.5 shrink-0 brightness-0"
              />
              <img
                src={assetUrl(assetBaseUrl, "/dreamlittext.svg")}
                alt="Dreamlit"
                width={64}
                height={10}
                className="h-2.5 w-auto shrink-0 brightness-0"
              />
            </a>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-3">
          {/* Desktop: full text links */}
          <div className="hidden sm:contents">
            <a
              href={OPEN_SOURCE_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cx("items-center gap-2", NAVBAR_SECONDARY_ACTION_CLASS, FOCUS_RING_CLASS)}
            >
              <GitHubMarkIcon className="h-4 w-4 shrink-0" />
              <span>GitHub</span>
              <ArrowUpRight className="-ml-1 h-3.5 w-3.5" />
            </a>

            <a
              href={normalizeUrl(dreamlitBaseUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(NAVBAR_SECONDARY_ACTION_CLASS, FOCUS_RING_CLASS)}
            >
              Visit Dreamlit
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          </div>

          {showSigninControl ? (
            <div ref={accountMenuRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  if (isAuthenticated) {
                    setIsAccountMenuOpen((open) => !open);
                    return;
                  }

                  onOpenSignin();
                }}
                disabled={authStatus === "checking" || isSigningOut}
                aria-haspopup={isAuthenticated ? "menu" : undefined}
                aria-expanded={isAuthenticated ? isAccountMenuOpen : undefined}
                className={cx(
                  "inline-flex items-center text-sm font-medium transition-all",
                  isAuthenticated
                    ? "h-10 gap-2 rounded-lg bg-zinc-900 text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)] hover:bg-zinc-800 px-2.5 sm:max-w-[16rem] sm:px-3.5"
                    : NAVBAR_PRIMARY_ACTION_CLASS,
                  authStatus === "checking" && "cursor-wait opacity-80",
                  isSigningOut && "cursor-wait opacity-80",
                  FOCUS_RING_CLASS,
                )}
              >
                {isAuthenticated ? (
                  <>
                    <User className="h-4 w-4 shrink-0 sm:hidden" />
                    <span className="hidden truncate sm:inline">{authButtonLabel}</span>
                    <ChevronDown
                      className={cx(
                        "h-3.5 w-3.5 shrink-0 text-zinc-300 transition-transform hidden sm:block",
                        isAccountMenuOpen && "rotate-180",
                      )}
                    />
                  </>
                ) : (
                  <>
                    <span className="sm:hidden">Sign in</span>
                    <span className="hidden sm:inline">{authButtonLabel}</span>
                  </>
                )}
              </button>

              {isAuthenticated && isAccountMenuOpen ? (
                <div
                  role="menu"
                  aria-label="Account"
                  className="absolute right-0 top-[calc(100%+0.6rem)] w-52 rounded-xl border border-stone-200/90 bg-white/95 p-1.5 text-zinc-900 shadow-[0_20px_40px_-28px_rgba(0,0,0,0.45)] backdrop-blur-xl"
                >
                  {signedInEmail ? (
                    <div className="truncate px-3 py-2 text-xs text-zinc-500 sm:hidden">
                      {signedInEmail}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsAccountMenuOpen(false);
                      void onSignOut();
                    }}
                    disabled={isSigningOut}
                    className={cx(
                      "inline-flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-zinc-700 transition-colors hover:bg-stone-100 hover:text-zinc-950",
                      isSigningOut && "cursor-wait opacity-70",
                      FOCUS_RING_CLASS,
                    )}
                  >
                    <LogOut className="h-4 w-4 shrink-0" />
                    {isSigningOut ? "Logging out..." : "Log out"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

function PlatformViz({ assetBaseUrl }: { assetBaseUrl: string }) {
  return (
    <div className="relative w-full max-w-[440px]">
      <div className="relative mx-auto flex h-[160px] max-w-[320px] items-center justify-center">
        <div className="pointer-events-none absolute -inset-6 -z-10 rounded-3xl bg-white/70 blur-2xl" />
        <div className="relative z-10 flex items-center gap-5">
          <EndpointTile
            src={assetUrl(assetBaseUrl, "/lovable_colored.svg")}
            alt="Lovable Cloud"
            label="Lovable Cloud"
          />
          <ConnectorLine />
          <EndpointTile
            src={assetUrl(assetBaseUrl, "/supabase_colored.svg")}
            alt="Supabase"
            label="Supabase"
          />
        </div>
      </div>

      <div className={cx(PANEL_FRAME_CLASS, "mt-4 w-full max-w-[440px]")}>
        <div className={cx(PANEL_CARD_CLASS, "px-4 py-3")}>
          <div className="flex flex-col items-center">
            <p className="text-sm font-medium text-zinc-700">What you&apos;ll need</p>
            <ul className="mt-2 w-full max-w-[400px] space-y-1 text-left text-sm leading-6 text-zinc-600">
              {HERO_REQUIREMENTS.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <Check className="mt-1 h-4 w-4 shrink-0 text-zinc-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function EndpointTile({ src, alt, label }: { src: string; alt: string; label: string }) {
  return (
    <div className="flex w-[4.75rem] flex-col items-center gap-2">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-stone-200/80 bg-white shadow-sm">
        <img src={src} alt={alt} width={28} height={28} className="h-7 w-7" />
      </div>
      <span className="flex min-h-[2.35rem] items-start justify-center text-center text-xs font-medium leading-[1.15] text-zinc-700">
        {label}
      </span>
    </div>
  );
}

function ConnectorLine() {
  return (
    <div className="relative -mt-6 h-16 w-36">
      <div className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-gradient-to-r from-pink-400/40 via-orange-400/40 to-emerald-400/40" />
      <div className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-stone-200/80 bg-white/90 text-zinc-700 shadow-sm">
        <ArrowRight className="h-4 w-4" />
      </div>
    </div>
  );
}

function ExporterPanel({
  migrateHelperSnippetTemplate,
  assetBaseUrl,
  promoVideoEmbedUrl,
  apiBaseUrl,
  supportsZipExport,
  authStatus,
  authConfig,
  onOpenSignin,
}: {
  migrateHelperSnippetTemplate: string;
  assetBaseUrl: string;
  promoVideoEmbedUrl: string;
  apiBaseUrl?: string;
  supportsZipExport?: boolean;
  authStatus: AuthGateStatus;
  authConfig?: LovableCloudToSupabaseExporterAuthConfig | null;
  onOpenSignin: () => void;
}) {
  const [deploymentUrl, setDeploymentUrl] = useState("");
  const [accessKeyDraft, setAccessKeyDraft] = useState("");
  const [targetDbUrlInput, setTargetDbUrlInput] = useState("");
  const [targetAdminKey, setTargetAdminKey] = useState("");
  const [targetBlankConfirmed, setTargetBlankConfirmed] = useState(false);
  const [isTargetAdminKeyVisible, setIsTargetAdminKeyVisible] = useState(false);
  const [transferRun, setTransferRun] = useState<TransferRunState>(createInitialTransferRunState);
  const [exportPath, setExportPath] = useState<ExportAction>("transfer");
  const transferRequestIdRef = useRef(0);

  const normalizedDeploymentUrl = deploymentUrl.trim();
  const normalizedAccessKey = accessKeyDraft.trim();
  const normalizedTargetDbUrlInput = targetDbUrlInput.trim();
  const normalizedTargetAdminKey = targetAdminKey.trim();
  const usesTargetDbUrlPasswordPlaceholder = containsDbPasswordPlaceholder(
    normalizedTargetDbUrlInput,
  );
  const canonicalTargetDbUrlInput = normalizePostgresUrl(normalizedTargetDbUrlInput);
  const resolvedTargetProjectRef = extractSupabaseProjectRefFromPostgresUrl(
    canonicalTargetDbUrlInput || normalizedTargetDbUrlInput,
  );
  const normalizedTargetDbUrl = canonicalTargetDbUrlInput;
  const targetProjectUrl = buildSupabaseProjectUrl(resolvedTargetProjectRef);
  const exporterApiBaseUrl = getExporterApiBaseUrl(apiBaseUrl);
  const zipExportSupported =
    supportsZipExport ?? supportsZipExportForApiBaseUrl(exporterApiBaseUrl);
  const authFieldsLocked = authStatus === "checking" || authStatus === "required";
  const hasFilledFormState =
    normalizedDeploymentUrl.length > 0 ||
    normalizedAccessKey.length > 0 ||
    normalizedTargetDbUrlInput.length > 0 ||
    normalizedTargetAdminKey.length > 0;
  const targetDbValidationError = getTargetDbValidationError({
    targetDbUrl: normalizedTargetDbUrl,
    targetDbUrlInput: normalizedTargetDbUrlInput,
    targetProjectUrl,
    usesTargetDbUrlPasswordPlaceholder,
  });
  const showTargetDbUrlError = !!targetDbValidationError;
  const sourceRequirements = [
    {
      label: "Lovable Cloud edge function URL added",
      done: normalizedDeploymentUrl.length > 0,
    },
    {
      label: "Lovable Cloud access key added",
      done: normalizedAccessKey.length > 0,
    },
  ];
  const transferRequirements = [
    ...sourceRequirements,
    {
      label: "Supabase DB URL added",
      done: normalizedTargetDbUrlInput.length > 0,
    },
    {
      label: "Supabase secret key added",
      done: normalizedTargetAdminKey.length > 0,
    },
    {
      label: "Supabase DB URL validated",
      done: !targetDbValidationError,
    },
    {
      label: "Supabase DB confirmed blank",
      done: targetBlankConfirmed,
    },
  ];
  const downloadRequirements = [...sourceRequirements];
  const storageRetryRequirements = [
    ...sourceRequirements,
    {
      label: "Supabase project detected",
      done: targetProjectUrl.length > 0,
    },
    {
      label: "Supabase secret key added",
      done: normalizedTargetAdminKey.length > 0,
    },
  ];
  const isTransferRunning = transferRun.status === "starting" || transferRun.status === "running";
  const isTransferCompleted =
    transferRun.status === "succeeded" && transferRun.action === "transfer";
  const canStartTransfer =
    transferRequirements.every((requirement) => requirement.done) &&
    !authFieldsLocked &&
    !isTransferRunning &&
    !isTransferCompleted;
  const canStartDownload =
    downloadRequirements.every((requirement) => requirement.done) &&
    !authFieldsLocked &&
    !isTransferRunning;
  const showDownloadBlockedTooltip = zipExportSupported && !canStartDownload && !isTransferRunning;
  const showTransferBlockedTooltip =
    !canStartTransfer && !isTransferRunning && !isTransferCompleted;
  const unmetTransferRequirements = transferRequirements.filter((requirement) => !requirement.done);
  const showRetryStorageOnly =
    transferRun.action === "transfer" &&
    transferRun.status === "failed" &&
    transferRun.record !== null &&
    hasTaskEvent(transferRun.record, "storage_copy.failed") &&
    !hasTaskEvent(transferRun.record, "target_validation.failed") &&
    (hasTaskEvent(transferRun.record, "db_clone.succeeded") ||
      transferRun.variant === "storage-only");
  const canRetryStorageOnly =
    storageRetryRequirements.every((requirement) => requirement.done) &&
    !authFieldsLocked &&
    !isTransferRunning &&
    showRetryStorageOnly;

  const migrateHelperSnippet = useMemo(() => {
    if (!normalizedAccessKey) return "";
    const accessKeyLiteral = JSON.stringify(normalizedAccessKey);
    return migrateHelperSnippetTemplate.replace(
      EDGE_FUNCTION_ACCESS_KEY_PATTERN,
      `const ACCESS_KEY = ${accessKeyLiteral};`,
    );
  }, [migrateHelperSnippetTemplate, normalizedAccessKey]);

  const migrateHelperSnippetHtml = useMemo(() => {
    if (!migrateHelperSnippet) return "";
    return highlight(migrateHelperSnippet);
  }, [migrateHelperSnippet]);

  useEffect(() => {
    if (!hasFilledFormState) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [hasFilledFormState]);

  const handleStartTransfer = async () => {
    if (!canStartTransfer) return;

    const requestId = transferRequestIdRef.current + 1;
    transferRequestIdRef.current = requestId;
    const jobId = buildJobId("export");

    const setTransferRunIfCurrent = (updater: (current: TransferRunState) => TransferRunState) => {
      if (transferRequestIdRef.current !== requestId) return;
      setTransferRun(updater);
    };

    setTransferRun({
      action: "transfer",
      variant: "full",
      status: "starting",
      errorMessage: "",
      jobId,
      record: null,
    });

    try {
      const sessionAccessToken = await getRequestAccessToken(authConfig);

      await startExportJob(
        exporterApiBaseUrl,
        jobId,
        {
          source_edge_function_url: normalizedDeploymentUrl,
          source_edge_function_access_key: normalizedAccessKey,
          target_db_url: normalizedTargetDbUrl,
          confirm_target_blank: targetBlankConfirmed,
          target_project_url: targetProjectUrl,
          target_admin_key: normalizedTargetAdminKey,
        },
        sessionAccessToken,
      );

      setTransferRunIfCurrent((current) => ({
        ...current,
        status: "running",
      }));

      const record = await pollForJobCompletion(
        exporterApiBaseUrl,
        jobId,
        (record) => {
          setTransferRunIfCurrent((current) => ({
            ...current,
            status: "running",
            record,
          }));
        },
        authConfig,
      );

      if (transferRequestIdRef.current !== requestId) return;

      setTransferRun((current) => ({
        ...current,
        status: record.status === "succeeded" ? "succeeded" : "failed",
        record,
        errorMessage: record.status === "succeeded" ? "" : getTransferFailureMessage(record),
      }));
    } catch (error) {
      if (transferRequestIdRef.current !== requestId) return;

      setTransferRun((current) => ({
        ...current,
        status: "failed",
        errorMessage: toRequestErrorMessage(
          error,
          "Migration request failed. Start the local API server and retry.",
        ),
      }));
    }
  };

  const handleRetryStorageOnly = async () => {
    if (!canRetryStorageOnly) return;

    const requestId = transferRequestIdRef.current + 1;
    transferRequestIdRef.current = requestId;
    const jobId = buildJobId("storage");

    const setTransferRunIfCurrent = (updater: (current: TransferRunState) => TransferRunState) => {
      if (transferRequestIdRef.current !== requestId) return;
      setTransferRun(updater);
    };

    setTransferRun({
      action: "transfer",
      variant: "storage-only",
      status: "starting",
      errorMessage: "",
      jobId,
      record: null,
    });

    try {
      const sessionAccessToken = await getRequestAccessToken(authConfig);

      await startStorageJob(
        exporterApiBaseUrl,
        jobId,
        {
          source_edge_function_url: normalizedDeploymentUrl,
          source_edge_function_access_key: normalizedAccessKey,
          target_project_url: targetProjectUrl,
          target_admin_key: normalizedTargetAdminKey,
          skip_existing_target_objects: true,
        },
        sessionAccessToken,
      );

      setTransferRunIfCurrent((current) => ({
        ...current,
        status: "running",
      }));

      const record = await pollForJobCompletion(
        exporterApiBaseUrl,
        jobId,
        (record) => {
          setTransferRunIfCurrent((current) => ({
            ...current,
            status: "running",
            record,
          }));
        },
        authConfig,
      );

      if (transferRequestIdRef.current !== requestId) return;

      setTransferRun((current) => ({
        ...current,
        status: record.status === "succeeded" ? "succeeded" : "failed",
        record,
        errorMessage: record.status === "succeeded" ? "" : getTransferFailureMessage(record),
      }));
    } catch (error) {
      if (transferRequestIdRef.current !== requestId) return;

      setTransferRun((current) => ({
        ...current,
        status: "failed",
        errorMessage: toRequestErrorMessage(
          error,
          "Storage retry request failed. Start the local API server and retry.",
        ),
      }));
    }
  };

  const handleStartDownload = async () => {
    if (!canStartDownload) return;

    const requestId = transferRequestIdRef.current + 1;
    transferRequestIdRef.current = requestId;
    const jobId = buildJobId("download");

    const setTransferRunIfCurrent = (updater: (current: TransferRunState) => TransferRunState) => {
      if (transferRequestIdRef.current !== requestId) return;
      setTransferRun(updater);
    };

    setTransferRun({
      action: "download",
      variant: "full",
      status: "starting",
      errorMessage: "",
      jobId,
      record: null,
    });

    try {
      const sessionAccessToken = await getRequestAccessToken(authConfig);

      await startDownloadJob(
        exporterApiBaseUrl,
        jobId,
        {
          source_edge_function_url: normalizedDeploymentUrl,
          source_edge_function_access_key: normalizedAccessKey,
        },
        sessionAccessToken,
      );

      setTransferRunIfCurrent((current) => ({
        ...current,
        status: "running",
      }));

      let artifactDownloadPromise: Promise<void> | null = null;
      let artifactDownloadError: unknown = null;
      const startArtifactDownload = () => {
        if (artifactDownloadPromise) return;
        artifactDownloadPromise = downloadJobArtifact(exporterApiBaseUrl, jobId, authConfig).catch(
          (error) => {
            artifactDownloadError = error;
          },
        );
      };

      const record = await pollForDownloadCompletion(
        exporterApiBaseUrl,
        jobId,
        (nextRecord) => {
          setTransferRunIfCurrent((current) => ({
            ...current,
            status: "running",
            record: nextRecord,
          }));
        },
        () => {
          startArtifactDownload();
        },
        authConfig,
      );

      if (transferRequestIdRef.current !== requestId) return;

      if (record.status === "succeeded") {
        startArtifactDownload();
        await artifactDownloadPromise;
        if (artifactDownloadError) {
          throw artifactDownloadError;
        }
      }

      setTransferRun((current) => ({
        ...current,
        status: record.status === "succeeded" ? "succeeded" : "failed",
        record,
        errorMessage: record.status === "succeeded" ? "" : getTransferFailureMessage(record),
      }));
    } catch (error) {
      if (transferRequestIdRef.current !== requestId) return;

      setTransferRun((current) => ({
        ...current,
        status: "failed",
        errorMessage: toRequestErrorMessage(
          error,
          "ZIP export request failed. Start the local API server and retry.",
        ),
      }));
    }
  };

  return (
    <section className={cx("relative", hasFilledFormState && "pb-28 sm:pb-32")}>
      <PageRails />
      <div className={PAGE_RAILS_CONTENT_CLASS}>
        <div className={cx(PANEL_FRAME_CLASS, "-mt-px")}>
          <div className={cx(PANEL_CARD_CLASS, "space-y-12 p-4 sm:p-10")}>
            <div className="space-y-12">
              <div>
                <h2 className={SECTION_TITLE_CLASS}>
                  Step 1: Add the migrate helper{" "}
                  <DefinedTerm definition={EDGE_FUNCTION_DEFINITION}>edge function</DefinedTerm>
                </h2>
                <p className="mt-2 text-sm text-zinc-600">
                  First, create a small, temporary endpoint to export your Lovable Cloud data.
                  We&apos;ll remove this endpoint after the export.
                </p>
              </div>

              <div className="grid items-start gap-10 md:grid-cols-2 md:gap-x-12">
                <div className="space-y-6">
                  <div className="flex items-start gap-3">
                    <StepNumber value={1} />
                    <div className="space-y-6">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-zinc-900">
                          Create an{" "}
                          <DefinedTerm definition={EDGE_FUNCTION_DEFINITION}>
                            edge function
                          </DefinedTerm>
                        </p>
                        <p className="text-sm text-zinc-600">
                          In your Lovable project, tell Lovable:
                        </p>
                      </div>
                      <PromptCard
                        text="Create an empty edge function called migrate-helper"
                        locked={authFieldsLocked}
                      />
                      {/* <p className="text-xs text-zinc-500">
                        We&apos;ll replace the empty function body with the
                        helper code in the next step.
                      </p> */}
                    </div>
                  </div>
                </div>

                <PreviewCard
                  label="Create edge function"
                  hint="Lovable UI"
                  imageSrc={assetUrl(assetBaseUrl, "/lovable-exporter/create-edge-function.png")}
                  imageAlt="Lovable edge functions UI showing how to create a migrate-helper function"
                />

                <div className="space-y-2">
                  <div className="flex items-start gap-3">
                    <StepNumber value={2} />
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-zinc-900">
                        Refresh the page to reload the latest code
                      </p>
                      <p className="text-sm text-zinc-600">
                        Sometimes Lovable won't show the new edge function until you refresh the
                        page.
                      </p>
                    </div>
                  </div>
                </div>

                <div aria-hidden="true" className="hidden md:block" />

                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <StepNumber value={3} />
                    <div className="min-w-0 space-y-4">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-zinc-900">
                          Copy and paste the helper function code
                        </p>
                        <p className="text-sm text-zinc-600">
                          First, enter an access key below. Then copy and paste the generated edge
                          function code into{" "}
                          <span className="font-semibold text-zinc-800">
                            Cloud &gt; Edge Functions &gt; migrate-helper &gt; View code
                          </span>
                          , then hit <span className="font-semibold text-zinc-800">Save</span> in
                          the upper right.
                        </p>
                      </div>

                      <AuthLockedPreview
                        active={authFieldsLocked}
                        authStatus={authStatus}
                        onUnlock={onOpenSignin}
                      >
                        <div className="space-y-4">
                          <div className="space-y-2 pb-2">
                            <div className="text-sm font-medium text-zinc-800">Access key</div>
                            <AccessRequiredTooltipWrapper
                              locked={authFieldsLocked}
                              triggerClassName="w-full"
                            >
                              <input
                                id="access-key-draft"
                                value={accessKeyDraft}
                                onChange={(event) => setAccessKeyDraft(event.target.value)}
                                placeholder=""
                                autoComplete="off"
                                disabled={authFieldsLocked}
                                className={INPUT_CLASS}
                              />
                            </AccessRequiredTooltipWrapper>
                            <p className="text-xs text-zinc-500">
                              Protects the temporary edge function so only you can trigger the
                              export. Not stored on Dreamlit servers.{" "}
                              <AccessRequiredTooltipWrapper
                                locked={authFieldsLocked}
                                triggerClassName="inline-flex"
                                inline
                              >
                                <button
                                  type="button"
                                  onClick={() => setAccessKeyDraft(generateAccessKey())}
                                  disabled={authFieldsLocked}
                                  className={cx(
                                    TEXT_LINK_CLASS,
                                    "disabled:cursor-not-allowed disabled:opacity-40",
                                  )}
                                >
                                  Generate a random string.
                                </button>
                              </AccessRequiredTooltipWrapper>
                            </p>
                          </div>

                          <div className="space-y-2">
                            <CodeCard
                              language="ts"
                              code={migrateHelperSnippet}
                              html={migrateHelperSnippetHtml}
                            />
                            <p className="text-xs text-zinc-500">
                              This code creates a secure, read-only endpoint on your Lovable Cloud
                              project. The exporter will use it to fetch your database schema,
                              tables, auth users, and storage files for the migration.
                            </p>
                          </div>
                        </div>
                      </AuthLockedPreview>
                    </div>
                  </div>
                </div>

                <PreviewCard
                  label="Paste code"
                  hint="Edge function editor"
                  imageSrc={lovableCloudFunctionsPosterPng}
                  imageAlt="Lovable Cloud edge function editor showing where to paste the migrate-helper code"
                  actionLabel="Watch video"
                  expandMedia={{
                    kind: "video",
                    src: lovableCloudFunctionsMp4,
                    posterSrc: lovableCloudFunctionsPosterPng,
                    title: "Paste code walkthrough",
                  }}
                />

                <div className="space-y-2">
                  <div className="flex items-start gap-3">
                    <StepNumber value={4} />
                    <div className="space-y-6">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-zinc-900">
                          Deploy the{" "}
                          <DefinedTerm definition={EDGE_FUNCTION_DEFINITION}>
                            edge function
                          </DefinedTerm>
                        </p>
                        <p className="text-sm text-zinc-600">Tell Lovable:</p>
                      </div>
                      <PromptCard
                        text="Deploy the edge function migrate-helper."
                        locked={authFieldsLocked}
                      />
                      {/* <p className="text-xs text-zinc-500">
                        You need to deploy by telling Lovable Chat. Saving the
                        function code alone doesn&apos;t automatically deploy
                        it.
                      </p> */}
                    </div>
                  </div>
                </div>

                <PreviewCard
                  label="Deploy function"
                  hint="Lovable deploy"
                  imageSrc={deployCloudFunctionPng}
                  imageAlt="Lovable Cloud interface showing how to deploy the migrate-helper edge function"
                />

                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <StepNumber value={5} />
                    <div className="min-w-0 space-y-4">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-zinc-900">
                          Enter your{" "}
                          <DefinedTerm definition={EDGE_FUNCTION_DEFINITION}>
                            edge function URL
                          </DefinedTerm>{" "}
                        </p>
                        <p className="text-sm text-zinc-600">
                          Get this from{" "}
                          <span className="font-semibold text-zinc-800">
                            Cloud &gt; Edge Functions &gt; migrate-helper &gt; Copy URL
                          </span>
                          .
                        </p>
                      </div>

                      <AuthLockedPreview
                        active={authFieldsLocked}
                        authStatus={authStatus}
                        onUnlock={onOpenSignin}
                      >
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-zinc-800">Edge function URL</div>
                          <AccessRequiredTooltipWrapper
                            locked={authFieldsLocked}
                            triggerClassName="w-full"
                          >
                            <input
                              id="source-edge-function-url"
                              value={deploymentUrl}
                              onChange={(event) => setDeploymentUrl(event.target.value)}
                              placeholder="https://.../functions/v1/migrate-helper"
                              autoComplete="off"
                              disabled={authFieldsLocked}
                              className={INPUT_CLASS}
                            />
                          </AccessRequiredTooltipWrapper>
                          <p className="text-xs text-zinc-500">
                            This applet will use the access key you entered above to connect to your
                            Lovable Cloud and initiate your export.
                          </p>
                        </div>
                      </AuthLockedPreview>
                    </div>
                  </div>
                </div>

                <PreviewCard
                  label="Copy URL"
                  hint="Edge function endpoint"
                  imageSrc={copyUrlPng}
                  imageAlt="Lovable Cloud interface showing where to copy the migrate-helper edge function URL"
                />
              </div>

              <div className={SECTION_DIVIDER_CLASS} />

              <div className="space-y-4">
                <h2 className={SECTION_TITLE_CLASS}>Step 2: Choose how to export</h2>

                {zipExportSupported ? (
                  <ExportPathToggle
                    value={exportPath}
                    onChange={setExportPath}
                    disabled={isTransferRunning}
                  />
                ) : (
                  <p className="text-sm text-zinc-600">
                    Connect your Supabase project to transfer directly.
                  </p>
                )}
              </div>

              {exportPath === "transfer" ? (
                <div className="grid items-start gap-10 md:grid-cols-2 md:gap-x-12">
                  <div className="space-y-3">
                    <div className="flex items-start gap-3">
                      <StepNumber value={1} />
                      <div className="min-w-0 space-y-3">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-zinc-900">
                            Paste your Supabase connection string
                          </p>
                          <p className="text-sm text-zinc-600">
                            In your Supabase dashboard, click{" "}
                            <span className="font-semibold text-zinc-800">Connect</span> in the top
                            bar. Then, under Connection String, copy andn paste the Direct
                            connection.
                          </p>
                        </div>

                        <AuthLockedPreview
                          active={authFieldsLocked}
                          authStatus={authStatus}
                          onUnlock={onOpenSignin}
                        >
                          <div className="space-y-2">
                            <div className="text-sm font-medium text-zinc-800">
                              Connection string
                            </div>
                            <AccessRequiredTooltipWrapper
                              locked={authFieldsLocked}
                              triggerClassName="w-full"
                            >
                              <input
                                id="target-db-url-input"
                                value={targetDbUrlInput}
                                onChange={(event) => setTargetDbUrlInput(event.target.value)}
                                placeholder="postgresql://postgres:...@db.<project-ref>.supabase.co:5432/postgres?sslmode=require"
                                autoComplete="off"
                                disabled={authFieldsLocked}
                                className={INPUT_CLASS}
                              />
                            </AccessRequiredTooltipWrapper>
                            {normalizedTargetDbUrlInput && showTargetDbUrlError ? (
                              <p className="text-xs text-red-700" role="alert">
                                {targetDbValidationError}
                              </p>
                            ) : null}
                          </div>
                        </AuthLockedPreview>

                        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                          <a
                            href={SUPABASE_DASHBOARD_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cx("inline-flex items-center gap-1", TEXT_LINK_CLASS)}
                          >
                            Supabase dashboard
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </a>
                          <a
                            href={"https://supabase.com/dashboard/project/_/database/settings"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cx("inline-flex items-center gap-1", TEXT_LINK_CLASS)}
                          >
                            Reset database password
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>

                  <PreviewCard
                    label="Open Connect"
                    hint="Supabase Postgres connection string"
                    imageSrc={supabaseConnectPosterPng}
                    imageAlt="Supabase dashboard showing how to open Connect and copy the Postgres connection string"
                    actionLabel="Watch video"
                    expandMedia={{
                      kind: "video",
                      src: supabaseConnectMp4,
                      posterSrc: supabaseConnectPosterPng,
                      title: "Supabase Connect walkthrough",
                    }}
                  />

                  <div className="space-y-3">
                    <div className="flex items-start gap-3">
                      <StepNumber value={2} />
                      <div className="min-w-0 space-y-4">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-zinc-900">
                            Paste the secret API key
                          </p>
                          <p className="text-sm text-zinc-600">
                            Go to{" "}
                            <span className="font-semibold text-zinc-800">
                              Project Settings &gt; API Keys &gt; Publishable and secret API Keys
                              &gt;
                            </span>
                            . Click "+ New secret key" to create a temporary secret key, then paste
                            it here.
                          </p>
                        </div>

                        <AuthLockedPreview
                          active={authFieldsLocked}
                          authStatus={authStatus}
                          onUnlock={onOpenSignin}
                        >
                          <div className="space-y-2">
                            <div className="text-sm font-medium text-zinc-800">Secret API key</div>
                            <AccessRequiredTooltipWrapper
                              locked={authFieldsLocked}
                              triggerClassName="w-full"
                            >
                              <div className="relative">
                                <input
                                  id="target-admin-key"
                                  type={isTargetAdminKeyVisible ? "text" : "password"}
                                  value={targetAdminKey}
                                  onChange={(event) => setTargetAdminKey(event.target.value)}
                                  placeholder="sb_secret_..."
                                  autoComplete="off"
                                  disabled={authFieldsLocked}
                                  className={cx(INPUT_CLASS, "pr-11")}
                                />
                                <button
                                  type="button"
                                  onClick={() => setIsTargetAdminKeyVisible((current) => !current)}
                                  disabled={authFieldsLocked}
                                  className={cx(
                                    "absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-stone-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50",
                                    FOCUS_RING_CLASS,
                                  )}
                                  aria-label={
                                    isTargetAdminKeyVisible
                                      ? "Hide Supabase secret key"
                                      : "Show Supabase secret key"
                                  }
                                >
                                  {isTargetAdminKeyVisible ? (
                                    <EyeOff className="h-4 w-4" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </button>
                              </div>
                            </AccessRequiredTooltipWrapper>
                          </div>
                        </AuthLockedPreview>

                        <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
                          <a
                            href={SUPABASE_API_KEYS_DOCS_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cx("inline-flex items-center gap-1", TEXT_LINK_CLASS)}
                          >
                            API keys docs
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>

                  <PreviewCard
                    label="Create API key"
                    hint="Temporary secret key"
                    imageSrc={supabaseSecretKeyPng}
                    imageAlt="Supabase dashboard showing where to create a temporary secret key"
                  />

                  <div className="md:col-span-2">
                    <AuthLockedPreview
                      active={authFieldsLocked}
                      authStatus={authStatus}
                      onUnlock={onOpenSignin}
                    >
                      {authFieldsLocked ? (
                        <div className="flex items-start gap-3 text-sm">
                          <AccessRequiredTooltipWrapper
                            locked
                            triggerClassName="inline-flex"
                            inline
                          >
                            <Checkbox
                              checked={targetBlankConfirmed}
                              disabled
                              aria-label="I confirmed the Supabase database is blank"
                              className="mt-0.5"
                            />
                          </AccessRequiredTooltipWrapper>
                          <span className="space-y-1">
                            <span className="block font-medium text-zinc-500">
                              I confirmed the target database is blank
                            </span>
                            <span className="block text-zinc-600">
                              Use a fresh or reset Supabase database before starting the export.
                            </span>
                          </span>
                        </div>
                      ) : (
                        <label className="flex cursor-pointer items-start gap-3 text-sm">
                          <Checkbox
                            checked={targetBlankConfirmed}
                            onCheckedChange={(checked) => setTargetBlankConfirmed(checked === true)}
                            disabled={isTransferRunning}
                            aria-label="I confirmed the Supabase database is blank"
                            className="mt-0.5"
                          />
                          <span className="space-y-1">
                            <span className="block font-medium text-zinc-900">
                              I confirmed the target database is blank
                            </span>
                            <span className="block text-zinc-600">
                              Use a fresh or reset Supabase database before starting the export.
                            </span>
                          </span>
                        </label>
                      )}
                    </AuthLockedPreview>
                  </div>
                </div>
              ) : null}

              <div className={SECTION_DIVIDER_CLASS} />

              <div className="grid items-start gap-10 md:grid-cols-2 md:items-start md:gap-x-12">
                <div className="max-w-xl space-y-6">
                  <div className="space-y-2">
                    <h2 className={SECTION_TITLE_CLASS}>Step 3: Run the export</h2>
                    <p className="text-sm text-zinc-600">
                      {exportPath === "download"
                        ? "Download your Lovable Cloud data as a ZIP file."
                        : "Transfer directly into your Supabase project."}
                    </p>
                  </div>

                  <AuthLockedPreview
                    active={authFieldsLocked}
                    authStatus={authStatus}
                    onUnlock={onOpenSignin}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                      {exportPath === "download" && zipExportSupported ? (
                        authFieldsLocked ? (
                          <AccessRequiredTooltipWrapper locked triggerClassName="inline-flex">
                            <button
                              type="button"
                              onClick={() => void handleStartDownload()}
                              disabled
                              className={cx(
                                BUTTON_SHELL_CLASS,
                                "h-11 cursor-pointer bg-emerald-500 px-8 text-white shadow-sm hover:bg-emerald-600 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
                                FOCUS_RING_CLASS,
                              )}
                            >
                              <Download className="h-4 w-4" />
                              <span>Download ZIP</span>
                            </button>
                          </AccessRequiredTooltipWrapper>
                        ) : (
                          <RequirementsPopover
                            show={showDownloadBlockedTooltip}
                            label="Before you can export"
                            requirements={downloadRequirements}
                          >
                            <button
                              type="button"
                              onClick={() => void handleStartDownload()}
                              disabled={!canStartDownload}
                              className={cx(
                                BUTTON_SHELL_CLASS,
                                "h-11 cursor-pointer bg-emerald-500 px-8 text-white shadow-sm hover:bg-emerald-600 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
                                FOCUS_RING_CLASS,
                              )}
                            >
                              <Download className="h-4 w-4" />
                              <span>
                                {isTransferRunning && transferRun.action === "download"
                                  ? "Export running..."
                                  : "Download ZIP"}
                              </span>
                            </button>
                          </RequirementsPopover>
                        )
                      ) : null}

                      {exportPath === "transfer" ? (
                        authFieldsLocked ? (
                          <AccessRequiredTooltipWrapper locked triggerClassName="inline-flex">
                            <button
                              type="button"
                              onClick={() => void handleStartTransfer()}
                              disabled
                              className={cx(
                                BUTTON_SHELL_CLASS,
                                "h-11 px-8 shadow-sm disabled:pointer-events-none disabled:cursor-not-allowed",
                                "bg-emerald-500 text-white disabled:opacity-50",
                                FOCUS_RING_CLASS,
                              )}
                            >
                              Transfer to Supabase
                            </button>
                          </AccessRequiredTooltipWrapper>
                        ) : (
                          <div className="space-y-3">
                            <button
                              type="button"
                              onClick={() => void handleStartTransfer()}
                              disabled={!canStartTransfer}
                              className={cx(
                                BUTTON_SHELL_CLASS,
                                "h-11 px-8 shadow-sm disabled:pointer-events-none disabled:cursor-not-allowed",
                                isTransferCompleted
                                  ? "bg-emerald-500 text-white disabled:opacity-45"
                                  : "cursor-pointer bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50",
                                FOCUS_RING_CLASS,
                              )}
                            >
                              {isTransferCompleted
                                ? "Completed"
                                : isTransferRunning && transferRun.action === "transfer"
                                  ? "Transfer running..."
                                  : "Transfer to Supabase"}
                            </button>
                            {showRetryStorageOnly ? (
                              <div className="space-y-2">
                                <button
                                  type="button"
                                  onClick={() => void handleRetryStorageOnly()}
                                  disabled={!canRetryStorageOnly}
                                  className={cx(
                                    BUTTON_SHELL_CLASS,
                                    "h-11 border border-stone-300 bg-white px-6 text-zinc-900 shadow-sm hover:bg-stone-50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
                                    FOCUS_RING_CLASS,
                                  )}
                                >
                                  {isTransferRunning && transferRun.variant === "storage-only"
                                    ? "Retrying storage..."
                                    : "Retry storage only"}
                                </button>
                                <p className="max-w-[420px] text-sm leading-relaxed text-zinc-600">
                                  Retries the storage transfer without rerunning the database clone.
                                  Files that already exist on the target with the same path are left
                                  in place.
                                </p>
                              </div>
                            ) : null}
                            {showTransferBlockedTooltip && unmetTransferRequirements.length > 0 ? (
                              <div className="max-w-[420px] space-y-2 text-sm text-zinc-600">
                                <p className="font-medium text-zinc-900">
                                  Before you can transfer, ensure:
                                </p>
                                <ul className="ml-5 list-disc space-y-1.5">
                                  {unmetTransferRequirements.map((requirement) => (
                                    <li key={requirement.label}>{requirement.label}</li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                          </div>
                        )
                      ) : null}
                    </div>
                  </AuthLockedPreview>

                  {transferRun.status !== "idle" ? (
                    <TransferRunCard transferRun={transferRun} />
                  ) : null}

                  <p className="text-xs text-zinc-500">
                    Need help?{" "}
                    <button
                      type="button"
                      onClick={() => showIntercom()}
                      className="underline decoration-zinc-300 underline-offset-2 transition-colors hover:text-zinc-600 hover:decoration-zinc-400"
                    >
                      Reach out via chat
                    </button>
                    .
                  </p>
                </div>

                <PromoCard assetBaseUrl={assetBaseUrl} promoVideoEmbedUrl={promoVideoEmbedUrl} />
              </div>

              <div className={SECTION_DIVIDER_CLASS} />

              <div className="space-y-2">
                <h2 className={SECTION_TITLE_CLASS}>Step 4: Transfer configs</h2>
                <p className="pb-4 text-sm text-zinc-600">
                  You&apos;ll need to transfer over some configs from your Lovable Cloud project
                  over to your Supabase to finalize the transfer.
                </p>
                <CleanupChecklist
                  locked={authFieldsLocked}
                  items={[
                    {
                      id: "migrate-env-vars",
                      title: "Migrate env vars",
                      description:
                        "In Lovable, go to Cloud > Secrets and ensure those secrets are copied over to your new Supabase project in Edge Functions > Secrets. This way your new edge functions can access them.",
                    },
                    {
                      id: "reconfigure-auth-providers",
                      title: "Reconfigure auth settings",
                      description:
                        "Be sure to recreate any enabled auth provider settings in your new Supabase project so your existing login methods keep working against the new backend.",
                    },
                    {
                      id: "move-email-templates",
                      title: "Move over any auth email templates",
                      description:
                        "Copy paste the old auth email templates into your new Supabase project (or route your auth emails via Dreamlit in one-click).",
                    },
                    {
                      id: "set-up-engagement-emails",
                      title: "Set up the emails that keep users active (optional)",
                      description: (
                        <>
                          <span className="italic">
                            &ldquo;Welcome them on signup. Remind them 3 days before their trial
                            ends. Win them back if they go quiet for a week.&rdquo;
                          </span>{" "}
                          Describe it in plain English and{" "}
                          <a
                            href={DEFAULT_DREAMLIT_BASE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={TEXT_LINK_CLASS}
                          >
                            Dreamlit
                            <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
                          </a>{" "}
                          builds the entire workflow end-to-end. Preview with live data from your
                          Supabase database, then publish when you&apos;re ready.
                        </>
                      ),
                    },
                  ]}
                />
              </div>

              <div className={SECTION_DIVIDER_CLASS} />

              <div className="space-y-2">
                <h2 className={SECTION_TITLE_CLASS}>Step 5: Cleanups</h2>
                <p className="text-sm text-zinc-600 pb-4">
                  After the export completes, check off each item as you clean up the temporary
                  access you created for the migration.
                </p>
                <CleanupChecklist
                  locked={authFieldsLocked}
                  items={[
                    {
                      id: "remove-function",
                      title: "Remove the migrate-helper function",
                      description:
                        "Tell Lovable to remove the temporary edge function you created for the export.",
                      prompt: 'Remove the edge function "migrate-helper".',
                    },
                    {
                      id: "delete-admin-key",
                      title: "Delete the temporary Supabase secret API key",
                      description:
                        "Open Project Settings > API Keys > Publishable Secret Keys and delete the key you pasted into Step 2.",
                      links: (
                        <a
                          href={SUPABASE_API_KEYS_DOCS_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cx("inline-flex items-center gap-1 text-xs", TEXT_LINK_CLASS)}
                        >
                          API keys docs
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </a>
                      ),
                    },
                    {
                      id: "reset-password",
                      title: "Reset the Supabase database password (optional)",
                      description:
                        "In Supabase database settings, reset the postgres password you used in the connection string.",
                      links: (
                        <a
                          href={SUPABASE_PASSWORDS_DOCS_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cx("inline-flex items-center gap-1 text-xs", TEXT_LINK_CLASS)}
                        >
                          Database password docs
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </a>
                      ),
                    },
                  ]}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={cx(SECTION_DIVIDER_CLASS, "-mt-px")} />

      <AfterMigrationGuideSection>
        <>
          Next up:{" "}
          <a
            href={AFTER_MIGRATION_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={TEXT_LINK_CLASS}
          >
            setup your development and production environments
            <ArrowUpRight className="ml-0.5 inline-block h-3 w-3" />
          </a>
          .
        </>
      </AfterMigrationGuideSection>
      <div className={cx(SECTION_DIVIDER_CLASS, "-mt-px")} />
      <FaqSection faqs={FAQ_ITEMS} />
    </section>
  );
}

function PromoCard({
  assetBaseUrl,
  promoVideoEmbedUrl,
}: {
  assetBaseUrl: string;
  promoVideoEmbedUrl: string;
}) {
  const [isPlaying, setIsPlaying] = useState(false);

  return (
    <aside className="md:self-end">
      <div className={PANEL_FRAME_CLASS}>
        <div className={cx(PANEL_CARD_CLASS, "p-5")}>
          <div className="space-y-2">
            <p className="text-sm font-medium text-zinc-900">While you&apos;re waiting...</p>
            <p className="text-sm leading-relaxed text-zinc-600">
              Watch <span className="font-medium text-zinc-800">{PROMO_VIDEO_TITLE}</span> starring{" "}
              <span className="font-medium text-zinc-800">Austin Nasso</span>:
            </p>
          </div>

          <div className="mt-5 overflow-hidden rounded-lg border border-stone-100 bg-white shadow-sm">
            {isPlaying ? (
              <iframe
                src={promoVideoEmbedUrl}
                title={`${PROMO_VIDEO_TITLE} promo video`}
                className="aspect-video h-auto w-full border-0"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
              />
            ) : (
              <button
                type="button"
                onClick={() => setIsPlaying(true)}
                className={cx("relative block w-full overflow-hidden bg-white", FOCUS_RING_CLASS)}
                aria-label={`Play ${PROMO_VIDEO_TITLE} promo video`}
              >
                <img
                  src={assetUrl(assetBaseUrl, "/promothumb1.webp")}
                  alt={`Promo video thumbnail for ${PROMO_VIDEO_TITLE}`}
                  className="aspect-video w-full object-cover"
                />

                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="flex h-14 w-14 items-center justify-center rounded-full border border-black/10 bg-white/90 text-orange-500 shadow-[0px_10px_25px_-8px_rgba(0,0,0,0.35)]">
                    <Play className="h-7 w-7" fill="currentColor" />
                  </span>
                </div>
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function FaqSection({ faqs }: { faqs: readonly FaqItem[] }) {
  const [openId, setOpenId] = useState<string | null>(faqs[0]?.id ?? null);

  return (
    <section className="relative pt-16 sm:pt-24">
      <div className="relative mx-auto w-full max-w-7xl px-4 pb-8 sm:px-12 lg:px-16">
        <div className="mx-auto flex w-full max-w-[1280px] flex-col items-center gap-4 text-center">
          <SectionBadge label="FAQs" icon={<CircleHelp className="h-4 w-4" />} />
          <h2 className="text-3xl font-medium leading-tight tracking-tight text-neutral-900 sm:text-[40px] sm:leading-[48px]">
            Frequently asked questions
          </h2>
        </div>
      </div>

      <div className="relative mx-auto w-full max-w-5xl px-4 pb-24 sm:px-12 lg:px-16">
        <div className="mx-auto -mt-px w-full max-w-[1000px] rounded-2xl border border-stone-200/80 bg-gradient-to-b from-[#f8f8f7] to-[#f5f5f4] p-1">
          <div className="flex flex-col gap-1">
            {faqs.map((item) => {
              const isOpen = item.id === openId;

              return (
                <div
                  key={item.id}
                  className={cx(
                    "w-full rounded-xl border border-stone-100 bg-white text-left shadow-sm transition-[border-color,background-color,box-shadow] duration-200",
                    isOpen
                      ? "border-stone-200 bg-white shadow-md"
                      : "bg-white hover:bg-stone-50/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setOpenId((current) => (current === item.id ? null : item.id))}
                    className="flex w-full items-center justify-between gap-6 p-4 text-left"
                  >
                    <p className="text-md min-w-0 font-normal leading-6 text-neutral-900 sm:text-lg sm:leading-7">
                      {item.question}
                    </p>
                    {isOpen ? (
                      <Minus className="h-4 w-4 shrink-0 text-neutral-400" />
                    ) : (
                      <Plus className="h-4 w-4 shrink-0 text-neutral-400" />
                    )}
                  </button>

                  <div
                    className={cx(
                      "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                      isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                    )}
                  >
                    <div className="overflow-hidden">
                      <div className="px-4 pb-4 text-base leading-6 text-neutral-600 sm:text-lg sm:leading-7 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:mb-2 [&_ul]:ml-5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul:last-child]:mb-0 [&_ol]:mb-2 [&_ol]:ml-5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol:last-child]:mb-0 [&_li]:text-base [&_li]:leading-6">
                        {item.answer}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function SimpleFooter({ dreamlitBaseUrl }: { dreamlitBaseUrl: string }) {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="relative bg-neutral-950 text-white">
      <div className="relative mx-auto w-full max-w-7xl px-4 py-12 sm:px-12 sm:py-16 lg:px-16">
        <div className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <div className="space-y-1">
              <p className="text-lg leading-7 text-neutral-400">Free migration utility</p>
              <p className="max-w-sm text-lg font-semibold leading-7 text-white">
                Lovable Cloud to Supabase Exporter
              </p>
            </div>

            {/* <a
              href={dreamlitBaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group mt-10 flex items-center gap-2 transition-opacity hover:opacity-80"
            >
              <img
                src={assetUrl(assetBaseUrl, "/logo.svg")}
                alt="Dreamlit"
                width={32}
                height={32}
                className="h-8 w-8 invert transition-transform group-hover:scale-105"
              />
              <img
                src={assetUrl(assetBaseUrl, "/dreamlittext.svg")}
                alt="Dreamlit"
                width={128}
                height={18}
                className="h-[18px] w-auto invert"
              />
            </a> */}
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:gap-10 lg:col-span-8 lg:col-start-5 lg:grid-cols-3 lg:justify-self-end">
            {[
              {
                title: "Resources",
                links: [
                  { label: "Dreamlit", href: dreamlitBaseUrl },
                  {
                    label: "Exporter GitHub",
                    href: OPEN_SOURCE_REPO_URL,
                  },
                ],
              },
              {
                title: "Guides",
                links: [
                  {
                    label: "Lovable migration",
                    href: "https://github.com/dreamlit-ai/lovable-cloud-to-supabase-exporter/blob/main/docs/choosing-how-you-build-and-host.md",
                  },
                  {
                    label: "Lovable email",
                    href: "https://dreamlit.ai/docs/guides/lovable-email",
                  },
                  // {
                  //   label: "Supabase",
                  //   href: "https://dreamlit.ai/docs/configuration/data-sources/supabase",
                  // },
                ],
              },
              {
                title: "Blog posts",
                links: [
                  {
                    label: "The four types of emails",
                    href: "https://dreamlit.ai/blog/sending-emails-lovable-guide",
                  },
                  {
                    label: "Email providers compared",
                    href: "https://dreamlit.ai/blog/resend-vs-sendgrid-vs-dreamlit",
                  },
                  {
                    label: "Supabase email overview",
                    href: "https://dreamlit.ai/blog/how-to-send-emails-supabase",
                  },
                ],
              },
            ].map((column) => (
              <div key={column.title} className="space-y-4">
                <p className="text-sm font-semibold tracking-wide text-white">{column.title}</p>
                <ul className="space-y-3">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group relative inline-block text-sm text-neutral-400 transition-colors hover:text-orange-400"
                      >
                        <span>{link.label}</span>
                        <span className="absolute -bottom-0.5 left-0 h-px w-0 bg-orange-400/60 transition-all group-hover:w-full" />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid w-full grid-cols-[1fr_minmax(0,80rem)_1fr]">
        <div className="h-px bg-gradient-to-r from-transparent to-white/10" />
        <div className="h-px w-full bg-white/10" />
        <div className="h-px bg-gradient-to-l from-transparent to-white/10" />
      </div>

      <div className="mx-auto w-full max-w-7xl px-4 pb-10 pt-8 sm:px-12 lg:px-16">
        <p className="text-center text-xs text-neutral-500 sm:text-left">
          © {currentYear} Dreamlit AI. All rights reserved.
        </p>
      </div>
    </footer>
  );
}

function TransferRunCard({ transferRun }: { transferRun: TransferRunState }) {
  const action = transferRun.action ?? "transfer";
  const variant = transferRun.variant ?? "full";
  const isBusy = transferRun.status === "starting" || transferRun.status === "running";
  const fallbackStatus =
    transferRun.status === "starting"
      ? "starting"
      : transferRun.status === "running" || transferRun.status === "succeeded"
        ? "running"
        : "idle";
  const dbProgressView = getDbCloneProgressView(transferRun.record, fallbackStatus);
  const storageProgressView = getStorageCopyProgressView(transferRun.record, fallbackStatus);

  const cardTitle =
    transferRun.status === "running" || transferRun.status === "starting"
      ? action === "download"
        ? "Exporting..."
        : variant === "storage-only"
          ? "Retrying storage transfer..."
          : "Transferring to Supabase..."
      : transferRun.status === "succeeded"
        ? action === "download"
          ? "Export completed"
          : variant === "storage-only"
            ? "Storage transfer completed"
            : "Transferred to Supabase"
        : transferRun.status === "failed"
          ? action === "download"
            ? "Export failed"
            : variant === "storage-only"
              ? "Storage retry failed"
              : "Transfer failed"
          : "Transfer in progress";
  const cardNote =
    transferRun.status === "succeeded"
      ? action === "download"
        ? "Export complete."
        : variant === "storage-only"
          ? "Storage retry complete."
          : "Transfer complete."
      : transferRun.status === "failed"
        ? transferRun.errorMessage
          ? null
          : action === "download"
            ? "Export failed."
            : variant === "storage-only"
              ? "Storage retry failed."
              : "Transfer failed."
        : TRANSFER_CARD_NOTE;
  return (
    <div className={PANEL_FRAME_CLASS}>
      <div className={cx(PANEL_CARD_CLASS, "p-5")}>
        <div className="flex items-center gap-3">
          {isBusy ? (
            <LoaderCircle className="h-5 w-5 animate-spin text-orange-500" />
          ) : transferRun.status === "succeeded" ? (
            <Check className="h-5 w-5 text-emerald-600" />
          ) : (
            <X className="h-5 w-5 text-red-600" />
          )}
          <h3 className="text-base font-medium tracking-tight text-zinc-900">{cardTitle}</h3>
        </div>

        {cardNote ? <p className="mt-3 text-sm leading-relaxed text-zinc-600">{cardNote}</p> : null}

        {isBusy ? (
          <p className="mt-1.5 text-xs text-zinc-400">
            Typically takes 2 &ndash; 5 minutes depending on database size.
          </p>
        ) : null}

        {transferRun.errorMessage ? (
          <div
            className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            role="alert"
          >
            <p>{transferRun.errorMessage}</p>
          </div>
        ) : null}

        <div className="mt-5 h-px bg-stone-200/80" />

        <div className="mt-5 space-y-4">
          <TaskProgressSection
            label={getTransferRowLabel("db", action)}
            value={getTransferRowValue("db", dbProgressView, action, transferRun.record)}
            progressView={dbProgressView}
          />
          <TaskProgressSection
            label={getTransferRowLabel("storage", action)}
            value={getTransferRowValue("storage", storageProgressView, action, transferRun.record)}
            progressView={storageProgressView}
          />
        </div>
      </div>
    </div>
  );
}

function TaskProgressSection({
  label,
  value,
  progressView,
}: {
  label: string;
  value: string;
  progressView: JobProgressView;
}) {
  const progressPercent = Math.max(0, Math.min(100, Math.round(progressView.percent)));
  const updatedAtLabel = formatProgressUpdatedAt(progressView.updatedAt);
  const valueClasses =
    progressView.status === "succeeded"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : progressView.status === "failed"
        ? "border-red-200 bg-red-50 text-red-700"
        : progressView.status === "idle"
          ? "border-stone-200 bg-white text-zinc-600"
          : "border-orange-200 bg-orange-50 text-orange-700";
  const progressBarClasses =
    progressView.status === "succeeded"
      ? "bg-emerald-500"
      : progressView.status === "failed"
        ? "bg-red-500"
        : progressView.status === "idle"
          ? "bg-stone-300"
          : "bg-orange-500";

  return (
    <div className="rounded-lg border border-stone-200/80 bg-stone-50/70 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
            {label}
          </p>
          <p className="mt-1 text-sm font-medium text-zinc-900 sm:text-[15px]">
            {progressView.headline}
          </p>
        </div>
        <span
          className={cx(
            "inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium",
            valueClasses,
          )}
        >
          {value}
        </span>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-stone-200/90">
        <div
          className={cx(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            progressBarClasses,
          )}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <p className="mt-3 text-sm leading-relaxed text-zinc-700">{progressView.detail}</p>

      {progressView.context || updatedAtLabel ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
          {progressView.context ? <span>{progressView.context}</span> : null}
          {updatedAtLabel ? <span>{updatedAtLabel}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function formatProgressUpdatedAt(value: string | null) {
  if (!value) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  return `Updated ${parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function getTransferRowLabel(kind: "db" | "storage", action: ExportAction) {
  if (kind === "db") {
    return action === "download" ? "Data export" : "Data transfer";
  }

  return action === "download" ? "Storage export" : "Storage transfer";
}

function getTransferRowValue(
  kind: "db" | "storage",
  progressView: JobProgressView,
  action: ExportAction,
  record: MigrationJobRecord | null,
) {
  return kind === "db"
    ? getDbTransferRowValue(progressView, action, record)
    : getStorageTransferRowValue(progressView, action, record);
}

function formatCountLabel(count: number, singular: string) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function getDbCloneTableCount(record: MigrationJobRecord | null) {
  for (const event of [...(record?.events ?? [])].reverse()) {
    const tableCount =
      typeof event.data?.table_count === "number"
        ? event.data.table_count
        : typeof event.data?.source_table_count === "number"
          ? event.data.source_table_count
          : null;
    if (typeof tableCount === "number" && Number.isFinite(tableCount)) {
      return tableCount;
    }
  }

  return null;
}

function getDbTransferRowValue(
  progressView: JobProgressView,
  action: ExportAction,
  record: MigrationJobRecord | null,
) {
  const latestEvent = getLatestTaskEvent(record, "db");
  const latestStage = typeof latestEvent?.data?.stage === "string" ? latestEvent.data.stage : null;
  const tableCount = getDbCloneTableCount(record);
  const transferVerb = action === "download" ? "exported" : "transferred";

  switch (progressView.status) {
    case "succeeded":
      return typeof tableCount === "number"
        ? `${tableCount}/${tableCount} ${tableCount === 1 ? "table" : "tables"} ${transferVerb}`
        : action === "download"
          ? "Exported"
          : "Transferred";
    case "failed":
      return "Failed";
    case "idle":
      return "Waiting";
    case "starting":
    case "running":
      switch (latestEvent?.phase) {
        case "container.build.started":
          return "Preparing runtime";
        case "container.build.succeeded":
          return "Runtime ready";
        case "container.start_invoked":
          return "Starting runtime";
        case "target_validation.started":
          return "Running checks";
        case "target_validation.succeeded":
          return "Checks passed";
        case "source_edge_function.resolved":
        case "db_clone.started":
          return typeof tableCount === "number"
            ? `${formatCountLabel(tableCount, "table")} detected`
            : "Lovable Cloud connected";
        case "db_clone.progress":
          switch (latestStage) {
            case "dump_schema":
              return "Dumping schema";
            case "dump_data":
              return typeof tableCount === "number"
                ? `Dumping ${formatCountLabel(tableCount, "table")}`
                : "Dumping tables";
            case "restore_schema":
              return "Restoring schema";
            case "restore_data":
              return typeof tableCount === "number"
                ? `Restoring ${formatCountLabel(tableCount, "table")}`
                : "Restoring tables";
            case "completed":
              return typeof tableCount === "number"
                ? `Finalizing ${formatCountLabel(tableCount, "table")}`
                : "Finalizing";
            default:
              return "Running";
          }
        default:
          return "Running";
      }
  }

  return "Running";
}

function getStorageTransferRowValue(
  progressView: JobProgressView,
  action: ExportAction,
  record: MigrationJobRecord | null,
) {
  const latestEvent = getLatestTaskEvent(record, "storage");
  const latestStageInfo = getLatestStorageStageInfo(record);
  const latestStage = latestStageInfo?.stage ?? null;
  const latestProgress = getLatestStorageProgress(record);
  const latestSummary = getLatestStorageSummary(record);
  const storageStarted = hasAnyTaskEvent(record, [
    "storage_copy.started",
    "storage_copy.debug",
    "storage_copy.progress",
    "storage_copy.succeeded",
    "storage_copy.partial",
    "storage_copy.failed",
  ]);
  const transferVerb = action === "download" ? "exported" : "transferred";

  switch (progressView.status) {
    case "succeeded": {
      const copied = latestSummary?.objectsCopied ?? latestProgress?.objectsCopied;
      const skippedExisting =
        latestSummary?.objectsSkippedExisting ?? latestProgress?.objectsSkippedExisting ?? 0;
      return typeof copied === "number" && copied > 0
        ? `${formatCountLabel(copied, "storage file")} ${transferVerb}`
        : skippedExisting > 0 && action !== "download"
          ? `${formatCountLabel(skippedExisting, "storage file")} already on target`
          : action === "download"
            ? "Exported"
            : "Transferred";
    }
    case "failed":
      return latestSummary?.objectsFailed && latestSummary.objectsFailed > 0
        ? "Completed with errors"
        : "Failed";
    case "idle":
      return progressView.detail.toLowerCase().includes("did not start because")
        ? "Not run"
        : "Waiting";
    case "starting":
    case "running":
      if (!storageStarted) {
        return "Waiting";
      }

      if (
        latestProgress &&
        latestProgress.objectsTotal > 0 &&
        latestStage === "copy_source_bucket"
      ) {
        return `${Math.min(
          latestProgress.objectsCopied +
            latestProgress.objectsFailed +
            latestProgress.objectsSkippedExisting +
            latestProgress.objectsSkippedMissing,
          latestProgress.objectsTotal,
        )}/${latestProgress.objectsTotal} files`;
      }

      switch (latestStage) {
        case "list_source_buckets":
          return "Listing buckets";
        case "list_target_buckets":
          return "Checking Supabase";
        case "scan_source_bucket":
          return latestProgress && latestProgress.objectsTotal > 0
            ? `${formatCountLabel(latestProgress.objectsTotal, "file")} detected`
            : "Scanning files";
        case "prepare_target_bucket":
          return "Preparing buckets";
        case "copy_source_bucket":
          return "Copying files";
        default:
          if (latestProgress && latestProgress.objectsTotal > 0) {
            return `${Math.min(
              latestProgress.objectsCopied +
                latestProgress.objectsFailed +
                latestProgress.objectsSkippedExisting +
                latestProgress.objectsSkippedMissing,
              latestProgress.objectsTotal,
            )}/${latestProgress.objectsTotal} files`;
          }
          return latestEvent?.phase === "storage_copy.started" ? "Starting" : "Running";
      }
  }

  return "Running";
}

function PromptCard({ text, locked = false }: { text: string; locked?: boolean }) {
  const [hasCopied, setHasCopied] = useState(false);

  const copyPrompt = async () => {
    if (locked) return;

    try {
      await navigator.clipboard.writeText(text);
      setHasCopied(true);
      window.setTimeout(() => setHasCopied(false), 2000);
    } catch {
      // Ignore clipboard errors.
    }
  };

  const button = (
    <button
      type="button"
      onClick={() => void copyPrompt()}
      disabled={locked}
      className={cx(
        "inline-flex h-7 w-24 shrink-0 items-center justify-center gap-1 rounded-lg text-xs font-medium shadow-sm transition-colors",
        locked
          ? "cursor-not-allowed bg-green-700 text-white opacity-85"
          : "bg-green-700 text-white hover:bg-emerald-700",
        FOCUS_RING_CLASS,
      )}
    >
      {hasCopied ? (
        <>
          <Check className="h-3.5 w-3.5" />
          <span>Copied</span>
        </>
      ) : (
        <span>Copy prompt</span>
      )}
    </button>
  );

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-stone-200/80 bg-stone-50/70 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm leading-5 tracking-[-0.1px] text-stone-900">{text}</p>
      {locked ? (
        <AccessRequiredTooltipWrapper locked triggerClassName="inline-flex">
          {button}
        </AccessRequiredTooltipWrapper>
      ) : (
        button
      )}
    </div>
  );
}

function PreviewCard({
  label,
  hint,
  imageSrc,
  imageAlt,
  actionLabel,
  expandMedia,
}: {
  label: string;
  hint: string;
  imageSrc?: string;
  imageAlt?: string;
  actionLabel?: string;
  expandMedia?: PreviewMedia;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const resolvedImageAlt = imageAlt ?? label;
  const resolvedExpandMedia =
    expandMedia ??
    (imageSrc
      ? {
          kind: "image" as const,
          src: imageSrc,
          alt: resolvedImageAlt,
          title: resolvedImageAlt,
        }
      : null);
  const isInteractive = Boolean(resolvedExpandMedia && imageSrc);
  const isVideoPreview = resolvedExpandMedia?.kind === "video";
  const interactiveLabel = actionLabel ?? (isVideoPreview ? "Watch video" : "Open larger image");

  return (
    <div className="self-start">
      <div className={PANEL_FRAME_CLASS}>
        <div className={cx(PANEL_CARD_CLASS, "overflow-hidden")}>
          {imageSrc ? (
            isInteractive ? (
              <button
                type="button"
                onClick={() => setIsExpanded(true)}
                className={cx(
                  "relative block aspect-[16/10] w-full overflow-hidden bg-[#FCFBF8] text-left",
                  isVideoPreview ? "cursor-pointer" : "cursor-pointer",
                  FOCUS_RING_CLASS,
                )}
                aria-label={interactiveLabel}
              >
                <img
                  src={imageSrc}
                  alt={resolvedImageAlt}
                  className={cx(
                    "h-full w-full",
                    isVideoPreview ? "object-cover object-center" : "object-contain",
                  )}
                />
                <div
                  className={cx(
                    "pointer-events-none absolute inset-0 opacity-100",
                    isVideoPreview
                      ? "bg-gradient-to-t from-black/28 via-black/0 to-transparent"
                      : "bg-transparent",
                  )}
                />
                {isVideoPreview ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 text-zinc-900 shadow-[0px_16px_32px_-18px_rgba(15,23,42,0.45)]">
                      <Play className="h-5 w-5 translate-x-[1px]" fill="currentColor" />
                    </span>
                  </div>
                ) : null}
              </button>
            ) : (
              <div className="relative aspect-[16/10] w-full bg-white">
                <img
                  src={imageSrc}
                  alt={imageAlt ?? label}
                  className="h-full w-full object-contain"
                />
              </div>
            )
          ) : (
            <div className="relative aspect-[16/10] w-full bg-gradient-to-b from-stone-50 to-stone-100">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(#0f172a_1px,transparent_1px)] bg-[length:18px_18px] opacity-[0.06]" />
              <div className="flex h-full w-full items-center justify-center px-6 text-center">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-zinc-800">{label}</p>
                  <p className="text-xs text-zinc-500">{hint}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {resolvedExpandMedia ? (
        <PreviewMediaModal
          open={isExpanded}
          onClose={() => setIsExpanded(false)}
          media={resolvedExpandMedia}
        />
      ) : null}
    </div>
  );
}

function PreviewMediaModal({
  open,
  onClose,
  media,
}: {
  open: boolean;
  onClose: () => void;
  media: PreviewMedia;
}) {
  const closeTimeoutRef = useRef<number | null>(null);
  const openFrameRef = useRef<number | null>(null);
  const [isMounted, setIsMounted] = useState(open);
  const [isVisible, setIsVisible] = useState(open);

  useEffect(() => {
    if (open) {
      if (closeTimeoutRef.current) {
        window.clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      if (openFrameRef.current) {
        window.cancelAnimationFrame(openFrameRef.current);
        openFrameRef.current = null;
      }
      setIsMounted(true);
      openFrameRef.current = window.requestAnimationFrame(() => {
        setIsVisible(true);
        openFrameRef.current = null;
      });
      return () => {
        if (openFrameRef.current) {
          window.cancelAnimationFrame(openFrameRef.current);
          openFrameRef.current = null;
        }
      };
    }

    if (!isMounted) return;

    setIsVisible(false);
    closeTimeoutRef.current = window.setTimeout(() => {
      setIsMounted(false);
      closeTimeoutRef.current = null;
    }, PREVIEW_VIDEO_MODAL_ANIMATION_MS);

    return () => {
      if (closeTimeoutRef.current) {
        window.clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
    };
  }, [isMounted, open]);

  useEffect(() => {
    if (!isMounted) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isMounted, onClose]);

  if (!isMounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] isolate overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={media.title}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-slate-950/30 backdrop-blur-[2px] transition-opacity duration-200"
        onClick={onClose}
        style={{
          opacity: isVisible ? 1 : 0,
        }}
      />
      <div className="pointer-events-none relative z-10 flex min-h-full items-center justify-center p-4 sm:p-6">
        <div
          className="pointer-events-auto w-full max-w-[1120px] transition-opacity duration-200"
          style={{ opacity: isVisible ? 1 : 0 }}
        >
          <div className="relative overflow-hidden rounded-[26px] border border-stone-200/85 bg-white/96 p-2 shadow-[0px_24px_80px_-28px_rgba(15,23,42,0.35)] sm:p-3">
            <button
              type="button"
              onClick={onClose}
              className={cx(
                "absolute right-5 top-5 z-10 rounded-full bg-white/80 px-3 py-1 text-sm font-medium text-gray-900 shadow transition-colors hover:bg-white",
                FOCUS_RING_CLASS,
              )}
              aria-label="Close walkthrough video"
            >
              Close
            </button>

            {media.kind === "video" ? (
              <div className="flex min-h-[220px] items-center justify-center rounded-[20px] bg-stone-100 sm:min-h-[320px]">
                <video
                  src={media.src}
                  poster={media.posterSrc}
                  controls
                  autoPlay
                  muted
                  playsInline
                  preload="metadata"
                  className="block h-auto max-h-[78vh] w-full rounded-[20px] bg-stone-100"
                />
              </div>
            ) : (
              <img
                src={media.src}
                alt={media.alt}
                className="block h-auto max-h-[78vh] w-full rounded-[20px] object-contain bg-stone-100"
              />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CodeCard({ language, code, html }: { language: string; code: string; html: string }) {
  const hasCode = code.length > 0;

  return (
    <div className="smk-code-theme overflow-hidden rounded-lg border border-stone-200/80 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-stone-200/80 bg-stone-50/60 px-4 py-2">
        <span className="text-xs font-medium text-zinc-600">{language}</span>
        {hasCode ? <CopyCodeButton text={code} /> : null}
      </div>

      {hasCode ? (
        <pre className="h-56 overflow-auto bg-white px-3 py-3 text-xs leading-5 text-zinc-900 sm:h-64 sm:px-4 sm:text-sm sm:leading-6">
          <code className="block font-mono" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      ) : (
        <div className="flex h-56 items-center justify-center px-4 py-3 sm:h-64">
          <p className="text-sm text-zinc-600">Enter an access key above to get the helper code.</p>
        </div>
      )}
    </div>
  );
}

function CopyCodeButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard errors.
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={cx(
        "inline-flex h-6 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-stone-100 hover:text-zinc-900",
        FOCUS_RING_CLASS,
      )}
      aria-label="Copy code"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function StepNumber({ value }: { value: number }) {
  return (
    <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-orange-300/40 bg-orange-50 text-xs font-semibold text-orange-700">
      {value}
    </span>
  );
}

function ExportPathToggle({
  value,
  onChange,
  disabled,
}: {
  value: ExportAction;
  onChange: (value: ExportAction) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="inline-flex flex-col rounded-lg border border-stone-200/80 bg-stone-100/60 p-1 sm:flex-row">
        <button
          type="button"
          onClick={() => onChange("transfer")}
          disabled={disabled}
          className={cx(
            "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all",
            value === "transfer"
              ? "bg-white text-zinc-900 shadow-sm"
              : "cursor-pointer text-zinc-500 hover:text-zinc-700",
            disabled && "!cursor-not-allowed opacity-60",
          )}
        >
          <ArrowRight className="h-3.5 w-3.5" />
          Transfer to Supabase
        </button>
        <button
          type="button"
          onClick={() => onChange("download")}
          disabled={disabled}
          className={cx(
            "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all",
            value === "download"
              ? "bg-white text-zinc-900 shadow-sm"
              : "cursor-pointer text-zinc-500 hover:text-zinc-700",
            disabled && "!cursor-not-allowed opacity-60",
          )}
        >
          <Download className="h-3.5 w-3.5" />
          Download ZIP
        </button>
      </div>
      <p className="text-sm text-zinc-600">
        {value === "transfer" ? "Connect your Supabase project below to transfer directly." : ""}
      </p>
    </div>
  );
}

function DefinedTerm({ children, definition }: { children: ReactNode; definition: string }) {
  return (
    <>
      <span>{children}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="relative ml-[0.28em] inline-flex cursor-pointer align-baseline text-zinc-400 transition-colors hover:text-zinc-500"
            aria-label="Show definition"
          >
            <Info
              aria-hidden="true"
              className="shrink-0"
              style={{ width: "0.78em", height: "0.78em" }}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          <div className="max-w-[240px] text-sm leading-5 text-neutral-900">{definition}</div>
        </TooltipContent>
      </Tooltip>
    </>
  );
}

function AccessRequiredTooltipWrapper({
  locked,
  children,
  triggerClassName,
  inline = false,
}: {
  locked: boolean;
  children: ReactNode;
  triggerClassName?: string;
  inline?: boolean;
}) {
  if (!locked) {
    return <>{children}</>;
  }

  const WrapperTag = inline ? "span" : "div";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <WrapperTag
          tabIndex={0}
          className={cx(
            "cursor-not-allowed focus:outline-none [&_button]:pointer-events-none [&_input]:pointer-events-none [&_textarea]:pointer-events-none",
            triggerClassName,
          )}
        >
          {children}
        </WrapperTag>
      </TooltipTrigger>
      <TooltipContent side="top" align="center">
        <div className="max-w-[240px] text-sm leading-5 text-neutral-900">
          <span className="font-medium">Access Required</span>. Create a free account to run the
          exporter tool.
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function RequirementsPopover({
  show,
  label,
  requirements,
  children,
}: {
  show: boolean;
  label: string;
  requirements: Array<{ label: string; done: boolean }>;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const togglePopover = () => {
    if (show) {
      setIsOpen((open) => !open);
    }
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!show) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setIsOpen((open) => !open);
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    const dismiss = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      setIsOpen(false);
    };

    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [isOpen]);

  useEffect(() => {
    if (!show) setIsOpen(false);
  }, [show]);

  const popover =
    show && isOpen ? (
      <div className="absolute left-0 top-full z-20 mt-3 w-[320px] rounded-2xl border border-stone-200/80 bg-white p-4 text-left shadow-[0_18px_50px_-18px_rgba(15,23,42,0.28)]">
        <p className="text-sm font-medium text-zinc-900">{label}</p>
        <div className="mt-3 space-y-2">
          {requirements.map((requirement) => (
            <div key={requirement.label} className="flex items-start gap-2 text-sm">
              {requirement.done ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <X className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
              )}
              <span className={requirement.done ? "text-zinc-700" : "text-zinc-500"}>
                {requirement.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    ) : null;

  if (!show) {
    return (
      <div ref={ref} className="relative inline-flex">
        {children}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={cx("relative inline-flex cursor-pointer", FOCUS_RING_CLASS)}
      role="button"
      tabIndex={0}
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      onClick={togglePopover}
      onKeyDown={handleTriggerKeyDown}
    >
      {children}
      {popover}
    </div>
  );
}

function CleanupChecklist({
  items,
  locked = false,
}: {
  items: Array<{
    id: string;
    title: string;
    description: ReactNode;
    prompt?: string;
    links?: ReactNode;
  }>;
  locked?: boolean;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const toggleItem = (id: string) => {
    if (locked) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {items.map((item) => {
        const isDone = checked.has(item.id);
        const checkboxControl = locked ? (
          <AccessRequiredTooltipWrapper locked triggerClassName="inline-flex" inline>
            <Checkbox checked={isDone} disabled aria-label={item.title} className="mt-1" />
          </AccessRequiredTooltipWrapper>
        ) : (
          <Checkbox
            checked={isDone}
            onCheckedChange={() => toggleItem(item.id)}
            aria-label={item.title}
            className="mt-1"
          />
        );
        const primaryContent = locked ? (
          <div className="space-y-1">
            <p
              className={cx(
                "text-sm font-medium",
                isDone ? "text-zinc-500" : "text-zinc-900",
                "text-zinc-500 no-underline",
              )}
            >
              {item.title}
            </p>
            <p className="text-sm text-zinc-600">{item.description}</p>
          </div>
        ) : (
          <button type="button" onClick={() => toggleItem(item.id)} className="w-full text-left">
            <div className="space-y-1">
              <p className={cx("text-sm font-medium", isDone ? "text-zinc-500" : "text-zinc-900")}>
                {item.title}
              </p>
              <p className="text-sm text-zinc-600">{item.description}</p>
            </div>
          </button>
        );
        const secondaryContent =
          item.prompt || item.links ? (
            <div className="space-y-2 pt-1">
              {item.prompt ? (
                <div className="pt-3">
                  <PromptCard text={item.prompt} locked={locked} />
                </div>
              ) : null}
              {item.links ? <div>{item.links}</div> : null}
            </div>
          ) : null;

        return (
          <div key={item.id} className={cx("bg-white transition-opacity", isDone && "opacity-60")}>
            <div className="flex items-start gap-3 text-left">
              {checkboxControl}
              <div className="min-w-0 flex-1 space-y-0">
                {primaryContent}
                {secondaryContent}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TurnstileWidget({
  siteKey,
  resetKey,
  onTokenChange,
  onErrorChange,
}: {
  siteKey: string;
  resetKey: number;
  onTokenChange: (token: string) => void;
  onErrorChange: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let isDisposed = false;

    const mountWidget = async () => {
      onTokenChange("");
      onErrorChange("");
      setIsLoading(true);

      try {
        await loadTurnstileScript();

        if (isDisposed || !window.turnstile) {
          return;
        }

        container.replaceChildren();
        widgetIdRef.current = window.turnstile.render(container, {
          sitekey: siteKey,
          theme: "light",
          callback: (token) => {
            onErrorChange("");
            onTokenChange(token);
          },
          "expired-callback": () => {
            onTokenChange("");
            onErrorChange("Human check expired. Try again.");
            if (widgetIdRef.current && window.turnstile) {
              window.turnstile.reset(widgetIdRef.current);
            }
          },
          "error-callback": () => {
            onTokenChange("");
            onErrorChange(
              isLocalHost(window.location.hostname)
                ? "Cloudflare Turnstile is unavailable on localhost."
                : "Human check failed. Retry.",
            );
          },
        });
        setIsLoading(false);
      } catch {
        if (isDisposed) return;
        onTokenChange("");
        onErrorChange("Human check could not load. Refresh and try again.");
        setIsLoading(false);
      }
    };

    void mountWidget();

    return () => {
      isDisposed = true;
      onTokenChange("");

      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }

      container.replaceChildren();
    };
  }, [onErrorChange, onTokenChange, resetKey, siteKey]);

  return (
    <div className="relative h-[80px] w-full">
      <div
        ref={containerRef}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      />
      {isLoading ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-zinc-500">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-orange-500" />
          <span>Loading human check...</span>
        </div>
      ) : null}
    </div>
  );
}

function SigninModal({
  open,
  onOpenChange,
  dreamlitBaseUrl,
  dismissible,
  authConfig,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dreamlitBaseUrl: string;
  dismissible: boolean;
  authConfig?: LovableCloudToSupabaseExporterAuthConfig | null;
}) {
  const [step, setStep] = useState<SigninStep>("form");
  const [email, setEmail] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaErrorMessage, setCaptchaErrorMessage] = useState("");
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const resolvedAuthConfig = getOptionalAuthConfig(authConfig);
  const turnstileSiteKey = resolvedAuthConfig?.turnstileSiteKey ?? "";
  const requiresHumanCheck = turnstileSiteKey.length > 0;
  const showTurnstilePlaceholder = import.meta.env.DEV && !requiresHumanCheck;

  useEffect(() => {
    if (open) return;
    setStep("form");
    setEmail("");
    setCaptchaToken("");
    setCaptchaErrorMessage("");
    setCaptchaResetKey(0);
    setIsSubmitting(false);
    setErrorMessage("");
  }, [open]);

  const displayEmail = email.trim() || "email@example.com";

  const handleSubmit = async () => {
    if (step === "success" || isSubmitting) return;

    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setErrorMessage("Enter an email address.");
      return;
    }

    if (requiresHumanCheck && !captchaToken) {
      setCaptchaErrorMessage("Complete the human check.");
      return;
    }

    const resolvedAuthConfig = getAuthConfig(authConfig);
    if ("error" in resolvedAuthConfig) {
      setErrorMessage(resolvedAuthConfig.error);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage("");
    setCaptchaErrorMessage("");

    try {
      const supabase = createSupabaseAuthClient(resolvedAuthConfig);
      const { error } = await supabase.auth.signInWithOtp({
        email: normalizedEmail,
        options: {
          emailRedirectTo: resolvedAuthConfig.redirectUrl,
          shouldCreateUser: true,
          ...(resolvedAuthConfig.turnstileSiteKey ? { captchaToken } : {}),
        },
      });
      if (error) {
        throw error;
      }

      setStep("success");
    } catch (error) {
      if (requiresHumanCheck) {
        setCaptchaToken("");
        setCaptchaResetKey((current) => current + 1);
      }
      setErrorMessage(toMagicLinkErrorMessage(error, { requiresHumanCheck }));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !dismissible) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="w-[calc(100%-2rem)] max-w-[562px] gap-0 rounded-lg border border-stone-100 bg-[#f8f8f7] p-1 shadow-[0px_24px_80px_-28px_rgba(0,0,0,0.35)]"
        onEscapeKeyDown={(event) => {
          if (!dismissible) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (!dismissible) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (!dismissible) {
            event.preventDefault();
          }
        }}
      >
        <div className="relative grid min-h-[511px] grid-rows-[minmax(72px,1fr)_auto_minmax(72px,1fr)] rounded-lg border border-neutral-100 bg-white px-6 sm:px-[83px]">
          {dismissible ? (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cx(
                "absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-full bg-stone-100 text-zinc-600 transition-colors hover:bg-stone-200 hover:text-zinc-900",
                FOCUS_RING_CLASS,
              )}
              aria-label="Close sign in dialog"
            >
              <X size={18} />
            </button>
          ) : null}

          <div aria-hidden="true" />

          <div className="mx-auto flex w-full max-w-[386px] flex-col self-center text-center">
            <DialogTitle className="text-xl font-medium leading-normal text-zinc-900">
              Sign in for free access
            </DialogTitle>

            <DialogDescription className="mt-2 text-base font-regular leading-normal text-zinc-700">
              Enter your email below to run the tool.
            </DialogDescription>

            <div className="mt-4 space-y-2 text-left">
              <input
                id="smk-signin-email"
                type="email"
                value={step === "success" ? displayEmail : email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Email"
                readOnly={step === "success"}
                autoComplete="off"
                className="flex h-10 w-full rounded-md border border-[#eae7ec] bg-white px-3 py-2 text-sm text-zinc-900 shadow-none transition-colors placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/50 disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-white read-only:text-zinc-900"
              />

              {step === "success" && (
                <p className="text-sm leading-5 text-green-600 self-center text-center">
                  Sent! Check your email for a <span className="font-semibold">magic link</span> to
                  sign in here.
                </p>
              )}
            </div>

            {step === "form" ? (
              <div className="mx-auto mt-4 w-full">
                {requiresHumanCheck ? (
                  <TurnstileWidget
                    siteKey={turnstileSiteKey}
                    resetKey={captchaResetKey}
                    onTokenChange={setCaptchaToken}
                    onErrorChange={setCaptchaErrorMessage}
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    className={cx(
                      "h-[80px] w-full",
                      showTurnstilePlaceholder &&
                        "flex items-center justify-center rounded-md border border-dashed border-stone-200 bg-stone-50/80 text-xs font-medium text-zinc-400",
                    )}
                  >
                    {showTurnstilePlaceholder ? "Cloudflare Turnstile placeholder" : null}
                  </div>
                )}
              </div>
            ) : null}

            {errorMessage ? (
              <p className="mt-2 text-left text-sm leading-5 text-red-700 " role="alert">
                {errorMessage}
              </p>
            ) : null}

            {captchaErrorMessage ? (
              <p className="mt-2 text-left text-sm leading-5 text-red-700" role="alert">
                {captchaErrorMessage}
              </p>
            ) : null}

            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={isSubmitting || step === "success" || (requiresHumanCheck && !captchaToken)}
              className={cx(
                "mt-4 h-10 w-full rounded-[10px] text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70",
                step === "form"
                  ? "bg-orange-500 text-white hover:bg-orange-600"
                  : "cursor-default bg-stone-100 text-zinc-500 disabled:opacity-100",
                FOCUS_RING_CLASS,
              )}
            >
              {isSubmitting
                ? "Sending magic link..."
                : step === "success"
                  ? "Sent"
                  : "Send magic link"}
            </button>
          </div>

          <div className="mx-auto flex w-full max-w-[351px] items-end justify-center pb-6 text-center sm:pb-8">
            <p className="text-xs leading-5 text-zinc-500">
              By continuing, you agree to our{" "}
              <a
                href={siteUrl(dreamlitBaseUrl, "/terms-of-service")}
                className="underline decoration-zinc-400 underline-offset-2 transition-colors hover:text-zinc-700"
              >
                Terms of Service
              </a>{" "}
              and{" "}
              <a
                href={siteUrl(dreamlitBaseUrl, "/privacy-policy")}
                className="underline decoration-zinc-400 underline-offset-2 transition-colors hover:text-zinc-700"
              >
                Privacy Policy
              </a>
              .
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AuthLockedPreview({
  children,
}: {
  active: boolean;
  authStatus: AuthGateStatus;
  onUnlock: () => void;
  children: ReactNode;
}) {
  return <>{children}</>;
}

function hasAuthConfig(authConfig?: LovableCloudToSupabaseExporterAuthConfig | null) {
  return Boolean(getOptionalAuthConfig(authConfig));
}

function loadTurnstileScript() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Cloudflare Turnstile requires a browser environment."));
  }

  if (window.turnstile) {
    return Promise.resolve();
  }

  if (turnstileScriptPromise) {
    return turnstileScriptPromise;
  }

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_URL}"]`,
    );
    const script = existingScript ?? document.createElement("script");

    const handleLoad = () => {
      if (window.turnstile) {
        resolve();
        return;
      }

      turnstileScriptPromise = null;
      reject(new Error("Cloudflare Turnstile did not initialize."));
    };

    const handleError = () => {
      turnstileScriptPromise = null;
      reject(new Error("Cloudflare Turnstile could not load."));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existingScript) {
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return turnstileScriptPromise;
}

function getOptionalAuthConfig(
  authConfig?: LovableCloudToSupabaseExporterAuthConfig | null,
): ResolvedAuthConfig | null {
  const url = authConfig?.url?.trim() || import.meta.env.VITE_SUPABASE_URL?.trim();
  const anonKey = authConfig?.anonKey?.trim() || import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  const configuredRedirectUrl =
    authConfig?.redirectUrl?.trim() || import.meta.env.VITE_SUPABASE_REDIRECT_URL?.trim();
  const turnstileSiteKey =
    authConfig?.turnstileSiteKey?.trim() || import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();

  if (!url || !anonKey) {
    return null;
  }

  return {
    url,
    anonKey,
    redirectUrl:
      configuredRedirectUrl || (typeof window === "undefined" ? "" : window.location.href),
    turnstileSiteKey: turnstileSiteKey || undefined,
  };
}

function getAuthConfig(
  authConfig?: LovableCloudToSupabaseExporterAuthConfig | null,
): ResolvedAuthConfig | { error: string } {
  const resolvedAuthConfig = getOptionalAuthConfig(authConfig);
  if (!resolvedAuthConfig) {
    return {
      error: "Sign-in is not configured yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
    };
  }

  return resolvedAuthConfig;
}

function createSupabaseAuthClient(authConfig: { url: string; anonKey: string }) {
  return createClient(authConfig.url, authConfig.anonKey);
}

function createInitialTransferRunState(): TransferRunState {
  return {
    action: null,
    variant: null,
    status: "idle",
    errorMessage: "",
    jobId: null,
    record: null,
  };
}

function getExporterApiBaseUrl(apiBaseUrl?: string) {
  return normalizeUrl(
    apiBaseUrl?.trim() ||
      import.meta.env.VITE_LOVABLE_EXPORTER_API_BASE_URL?.trim() ||
      DEFAULT_EXPORTER_API_BASE_URL,
  );
}

function supportsZipExportForApiBaseUrl(apiBaseUrl: string) {
  if (!apiBaseUrl) return false;

  try {
    const parsed = new URL(apiBaseUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

const DB_PASSWORD_PLACEHOLDER = "[YOUR-PASSWORD]";

function containsDbPasswordPlaceholder(value: string) {
  return value.includes(DB_PASSWORD_PLACEHOLDER);
}

function getTargetDbValidationError({
  targetDbUrl,
  targetDbUrlInput,
  targetProjectUrl,
  usesTargetDbUrlPasswordPlaceholder,
}: {
  targetDbUrl: string;
  targetDbUrlInput: string;
  targetProjectUrl: string;
  usesTargetDbUrlPasswordPlaceholder: boolean;
}) {
  if (usesTargetDbUrlPasswordPlaceholder) {
    return "Password placeholder detected. Replace [YOUR-PASSWORD] above with your database password. You can reset your password if you forgot it in your project's Database Settings.";
  }

  if (targetDbUrlInput && !targetDbUrl) {
    return "Paste a valid Postgres connection string.";
  }

  if (containsDbPasswordPlaceholder(targetDbUrl)) {
    return "Enter the real DB password in the connection string. Don't worry, you can rotate it after the migration.";
  }

  if (targetDbUrl && !targetProjectUrl) {
    return "Paste a Supabase direct connection or session pooler connection string.";
  }

  return "";
}

function buildSupabaseProjectUrl(projectRef: string) {
  if (!projectRef) return "";
  return `https://${projectRef}.supabase.co`;
}

function buildJobId(prefix: "export" | "db" | "storage" | "download") {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${prefix}-${Date.now()}-${suffix}`;
}

async function startExportJob(
  baseUrl: string,
  jobId: string,
  body: {
    source_edge_function_url: string;
    source_edge_function_access_key: string;
    target_db_url: string;
    confirm_target_blank: boolean;
    target_project_url: string;
    target_admin_key: string;
  },
  accessToken?: string | null,
) {
  await postMigrationJob(baseUrl, jobId, "start-export", body, accessToken);
}

async function startDownloadJob(
  baseUrl: string,
  jobId: string,
  body: {
    source_edge_function_url: string;
    source_edge_function_access_key: string;
  },
  accessToken?: string | null,
) {
  await postMigrationJob(baseUrl, jobId, "start-download", body, accessToken);
}

async function startStorageJob(
  baseUrl: string,
  jobId: string,
  body: {
    source_edge_function_url: string;
    source_edge_function_access_key: string;
    target_project_url: string;
    target_admin_key: string;
    skip_existing_target_objects?: boolean;
  },
  accessToken?: string | null,
) {
  await postMigrationJob(baseUrl, jobId, "start-storage", body, accessToken);
}

async function postMigrationJob(
  baseUrl: string,
  jobId: string,
  action: "start-export" | "start-download" | "start-storage",
  body: Record<string, unknown>,
  accessToken?: string | null,
) {
  const response = await fetch(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/${action}`, {
    method: "POST",
    headers: buildApiHeaders(accessToken, true),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

async function getMigrationJobStatus(baseUrl: string, jobId: string, accessToken?: string | null) {
  const response = await fetch(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/status`, {
    headers: buildApiHeaders(accessToken, false),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as MigrationJobRecord;
}

function hasMigrationJobPhase(record: MigrationJobRecord, phase: string) {
  return record.events.some((event) => event.phase === phase);
}

function isDownloadArtifactReadyRecord(record: MigrationJobRecord) {
  return record.status === "succeeded" || hasMigrationJobPhase(record, "artifact_delivery.ready");
}

async function getRequestAccessToken(
  authConfig: LovableCloudToSupabaseExporterAuthConfig | null | undefined,
) {
  const accessToken = await getApiAccessToken(authConfig);
  if (getOptionalAuthConfig(authConfig) && !accessToken) {
    throw new Error("Your sign-in session expired. Sign in again and retry.");
  }
  return accessToken;
}

async function requestArtifactAccessUrl(
  baseUrl: string,
  jobId: string,
  accessToken: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/artifact-access`, {
    method: "POST",
    headers: buildApiHeaders(accessToken, false),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const body = (await response.json().catch(() => null)) as {
    download_url?: unknown;
  } | null;
  if (!body || typeof body.download_url !== "string" || !body.download_url.trim()) {
    throw new Error("Artifact access response was invalid.");
  }

  return body.download_url;
}

async function downloadJobArtifact(
  baseUrl: string,
  jobId: string,
  authConfig?: LovableCloudToSupabaseExporterAuthConfig | null,
) {
  const accessToken = await getRequestAccessToken(authConfig);
  const artifactUrl = accessToken
    ? await requestArtifactAccessUrl(baseUrl, jobId, accessToken)
    : `${baseUrl}/jobs/${encodeURIComponent(jobId)}/artifact`;

  const anchor = document.createElement("a");
  anchor.href = artifactUrl;
  anchor.download = `lovable-cloud-export-${jobId}.zip`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

async function pollForDownloadCompletion(
  baseUrl: string,
  jobId: string,
  onUpdate: (record: MigrationJobRecord) => void,
  onArtifactReady: (record: MigrationJobRecord) => void,
  authConfig?: LovableCloudToSupabaseExporterAuthConfig | null,
) {
  let artifactReadyHandled = false;

  for (;;) {
    const accessToken = await getRequestAccessToken(authConfig);
    const record = await getMigrationJobStatus(baseUrl, jobId, accessToken);
    onUpdate(record);

    if (!artifactReadyHandled && isDownloadArtifactReadyRecord(record)) {
      artifactReadyHandled = true;
      onArtifactReady(record);
    }

    if (record.status === "succeeded" || record.status === "failed") {
      return record;
    }

    await sleep(JOB_POLL_INTERVAL_MS);
  }
}

async function pollForJobCompletion(
  baseUrl: string,
  jobId: string,
  onUpdate: (record: MigrationJobRecord) => void,
  authConfig?: LovableCloudToSupabaseExporterAuthConfig | null,
) {
  for (;;) {
    const accessToken = await getRequestAccessToken(authConfig);
    const record = await getMigrationJobStatus(baseUrl, jobId, accessToken);
    onUpdate(record);

    if (record.status === "succeeded" || record.status === "failed") {
      return record;
    }

    await sleep(JOB_POLL_INTERVAL_MS);
  }
}

async function readApiError(response: Response) {
  const text = await response.text();
  if (!text) {
    return `Request failed with status ${response.status}.`;
  }

  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // Fall through to raw text.
  }

  return text;
}

async function getApiAccessToken(
  authConfig: LovableCloudToSupabaseExporterAuthConfig | null | undefined,
) {
  const resolvedAuthConfig = getOptionalAuthConfig(authConfig);
  if (!resolvedAuthConfig) {
    return null;
  }

  const supabase = createSupabaseAuthClient(resolvedAuthConfig);
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function buildApiHeaders(accessToken?: string | null, includeJson = false) {
  const headers: Record<string, string> = {};
  if (includeJson) {
    headers["Content-Type"] = "application/json";
  }
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

const DB_PROGRESS_PHASES = new Set([
  "container.start_invoked",
  "container.build.started",
  "container.build.succeeded",
  "target_validation.started",
  "target_validation.succeeded",
  "target_validation.failed",
  "source_edge_function.resolved",
  "db_clone.started",
  "db_clone.progress",
  "db_clone.succeeded",
  "db_clone.failed",
]);

const STORAGE_PROGRESS_PHASES = new Set([
  "source_edge_function.resolved",
  "storage_copy.started",
  "storage_copy.debug",
  "storage_copy.progress",
  "storage_copy.succeeded",
  "storage_copy.partial",
  "storage_copy.failed",
]);

function getLatestTaskEvent(record: MigrationJobRecord | null, kind: "db" | "storage") {
  const allowed = kind === "db" ? DB_PROGRESS_PHASES : STORAGE_PROGRESS_PHASES;
  return [...(record?.events ?? [])].reverse().find((event) => allowed.has(event.phase));
}

function hasTaskEvent(record: MigrationJobRecord | null, phase: string) {
  return (record?.events ?? []).some((event) => event.phase === phase);
}

function hasAnyTaskEvent(record: MigrationJobRecord | null, phases: Iterable<string>) {
  const allowed = new Set(phases);
  return (record?.events ?? []).some((event) => allowed.has(event.phase));
}

const GENERIC_FAILURE_PATTERNS = [
  /status debug fields/i,
  /monitor_raw_error/i,
  /^export failed\.?$/i,
  /^storage copy failed\.?$/i,
  /^combined export failed.*$/i,
  /^zip export failed.*$/i,
  /inspect runtime logs/i,
  /internal server error/i,
];

function normalizeFailureText(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function textIncludesIgnoreCase(left: string, right: string) {
  const leftClean = normalizeFailureText(left).toLowerCase();
  const rightClean = normalizeFailureText(right).toLowerCase();
  return Boolean(leftClean && rightClean && leftClean.includes(rightClean));
}

function isGenericFailureMessage(message: string) {
  const cleaned = normalizeFailureText(message);
  if (!cleaned) return true;
  return GENERIC_FAILURE_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function getLatestFailureEvent(record: MigrationJobRecord | null) {
  return [...(record?.events ?? [])]
    .reverse()
    .find(
      (event) =>
        event.level === "error" &&
        (event.phase === "target_validation.failed" ||
          event.phase === "db_clone.failed" ||
          event.phase === "storage_copy.failed" ||
          event.phase === "container.start_failed" ||
          event.phase === "monitor.failed" ||
          event.phase === "export.failed"),
    );
}

function formatFailureContext(data: Record<string, unknown> | undefined) {
  const storageAction = typeof data?.storage_action === "string" ? data.storage_action : "";
  const bucketId = typeof data?.bucket_id === "string" ? data.bucket_id : "";
  const objectPath = typeof data?.object_path === "string" ? data.object_path : "";
  const statusCode = typeof data?.status_code === "number" ? data.status_code : null;
  const attempts = typeof data?.attempts === "number" ? data.attempts : null;

  const location = bucketId && objectPath ? `${bucketId}/${objectPath}` : objectPath || bucketId;
  const parts: string[] = [];
  if (storageAction) parts.push(storageAction.replaceAll("_", " "));
  if (location) parts.push(location);
  if (statusCode !== null) parts.push(`HTTP ${statusCode}`);
  if (attempts !== null && attempts > 1) parts.push(`${attempts} attempts`);
  return parts.length > 0 ? `Context: ${parts.join(" • ")}` : "";
}

function joinMessageAndHint(message: string | null | undefined, hint: string | null | undefined) {
  const cleanedMessage = message?.trim() || "";
  const cleanedHint = hint?.trim() || "";

  if (cleanedMessage && cleanedHint) {
    if (cleanedMessage.toLowerCase() === cleanedHint.toLowerCase()) {
      return cleanedMessage;
    }
    return `${cleanedMessage} ${cleanedHint}`;
  }

  return cleanedMessage || cleanedHint || "";
}

function buildFailureMessage(
  record: MigrationJobRecord | null,
  preferredMessage?: string | null,
  eventData?: Record<string, unknown>,
) {
  const primaryMessage = normalizeFailureText(preferredMessage ?? record?.error);
  const rawMessage = normalizeFailureText(record?.debug?.monitor_raw_error);
  const hint = normalizeFailureText(record?.debug?.failure_hint);
  const chosenMessage =
    rawMessage && (isGenericFailureMessage(primaryMessage) || !primaryMessage)
      ? rawMessage
      : primaryMessage;

  let message = joinMessageAndHint(chosenMessage, hint);
  const context = formatFailureContext(eventData);
  if (context && !textIncludesIgnoreCase(message, context.replace(/^Context:\s*/, ""))) {
    message = message ? `${message} ${context}` : context;
  }

  return message || "Export failed.";
}

function getTransferFailureMessage(record: MigrationJobRecord | null) {
  const latestFailureEvent = getLatestFailureEvent(record);
  return buildFailureMessage(
    record,
    latestFailureEvent?.message ?? record?.error,
    latestFailureEvent?.data,
  );
}

function getLatestStorageProgress(record: MigrationJobRecord | null) {
  const progressEvent = [...(record?.events ?? [])]
    .reverse()
    .find((event) => event.phase === "storage_copy.progress");

  const objectsCopied = progressEvent?.data?.objects_copied;
  const objectsTotal = progressEvent?.data?.objects_total;
  const objectsFailed = progressEvent?.data?.objects_failed;
  const bucketId = progressEvent?.data?.bucket_id;
  const prefix = progressEvent?.data?.prefix;
  const bucketsProcessed = progressEvent?.data?.buckets_processed;
  const bucketsTotal = progressEvent?.data?.buckets_total;
  const prefixesScanned = progressEvent?.data?.prefixes_scanned;
  const scanComplete = progressEvent?.data?.scan_complete;
  const objectsSkippedExisting = progressEvent?.data?.objects_skipped_existing;
  const objectsSkippedMissing = progressEvent?.data?.objects_skipped_missing;

  if (typeof objectsCopied !== "number" || typeof objectsTotal !== "number") {
    return null;
  }

  return {
    bucketId: typeof bucketId === "string" ? bucketId : "",
    prefix: typeof prefix === "string" ? prefix : "",
    bucketsProcessed: typeof bucketsProcessed === "number" ? bucketsProcessed : null,
    bucketsTotal: typeof bucketsTotal === "number" ? bucketsTotal : null,
    prefixesScanned: typeof prefixesScanned === "number" ? prefixesScanned : 0,
    scanComplete: scanComplete === true,
    objectsCopied,
    objectsTotal,
    objectsFailed: typeof objectsFailed === "number" ? objectsFailed : 0,
    objectsSkippedExisting: typeof objectsSkippedExisting === "number" ? objectsSkippedExisting : 0,
    objectsSkippedMissing: typeof objectsSkippedMissing === "number" ? objectsSkippedMissing : 0,
  };
}

function getLatestStorageSummary(record: MigrationJobRecord | null) {
  const summaryEvent = [...(record?.events ?? [])]
    .reverse()
    .find(
      (event) =>
        event.phase === "storage_copy.succeeded" ||
        event.phase === "storage_copy.partial" ||
        event.phase === "storage_copy.failed",
    );

  const objectsCopied = summaryEvent?.data?.objects_copied;
  const objectsTotal = summaryEvent?.data?.objects_total;
  const objectsFailed = summaryEvent?.data?.objects_failed;
  const objectsSkippedExisting = summaryEvent?.data?.objects_skipped_existing;
  const objectsSkippedMissing = summaryEvent?.data?.objects_skipped_missing;

  if (typeof objectsCopied !== "number" || typeof objectsTotal !== "number") {
    return null;
  }

  return {
    objectsCopied,
    objectsTotal,
    objectsFailed: typeof objectsFailed === "number" ? objectsFailed : 0,
    objectsSkippedExisting: typeof objectsSkippedExisting === "number" ? objectsSkippedExisting : 0,
    objectsSkippedMissing: typeof objectsSkippedMissing === "number" ? objectsSkippedMissing : 0,
  };
}

function getLatestStorageStageInfo(record: MigrationJobRecord | null) {
  const stageEvent = [...(record?.events ?? [])]
    .reverse()
    .find(
      (event) => event.phase === "storage_copy.debug" || event.phase === "storage_copy.started",
    );

  if (!stageEvent) return null;

  return {
    stage: typeof stageEvent.data?.stage === "string" ? stageEvent.data.stage : null,
    message: stageEvent.message,
    bucketId: typeof stageEvent.data?.bucket_id === "string" ? stageEvent.data.bucket_id : "",
    prefix: typeof stageEvent.data?.prefix === "string" ? stageEvent.data.prefix : "",
    at: stageEvent.at ?? null,
  };
}

function formatStorageProgressCount(progress: {
  objectsCopied: number;
  objectsTotal: number;
  objectsFailed: number;
  objectsSkippedExisting: number;
  objectsSkippedMissing: number;
  prefixesScanned?: number;
  scanComplete?: boolean;
}) {
  if (progress.objectsTotal === 0) {
    if (typeof progress.prefixesScanned === "number" && progress.prefixesScanned > 0) {
      const folderLabel = progress.prefixesScanned === 1 ? "folder" : "folders";
      if (progress.scanComplete) {
        return `Scanned ${progress.prefixesScanned} ${folderLabel}.`;
      }
      return `Scanned ${progress.prefixesScanned} ${folderLabel}; still discovering storage objects...`;
    }
    return "Scanning storage objects...";
  }

  const handledCount =
    progress.objectsCopied +
    progress.objectsFailed +
    progress.objectsSkippedExisting +
    progress.objectsSkippedMissing;
  const details = [`${progress.objectsCopied} copied`];
  if (progress.objectsFailed > 0) {
    details.push(`${progress.objectsFailed} failed`);
  }
  if (progress.objectsSkippedExisting > 0) {
    details.push(`${progress.objectsSkippedExisting} already on target`);
  }
  if (progress.objectsSkippedMissing > 0) {
    details.push(`${progress.objectsSkippedMissing} missing`);
  }

  return `${handledCount} / ${progress.objectsTotal} objects handled (${details.join(", ")})`;
}

function formatStoragePrefixLabel(prefix: string) {
  const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `Folder ${trimmed}` : "";
}

function formatStorageProgressContext(
  progress: {
    bucketId: string;
    prefix: string;
    bucketsProcessed: number | null;
    bucketsTotal: number | null;
  } | null,
  stageInfo?: ReturnType<typeof getLatestStorageStageInfo>,
) {
  const bucketId = progress?.bucketId || stageInfo?.bucketId || "";
  const prefix = progress?.prefix || stageInfo?.prefix || "";
  const parts: string[] = [];

  if (
    typeof progress?.bucketsProcessed === "number" &&
    typeof progress?.bucketsTotal === "number" &&
    progress.bucketsTotal > 0
  ) {
    parts.push(
      `Bucket ${Math.min(progress.bucketsProcessed + 1, progress.bucketsTotal)} of ${progress.bucketsTotal}`,
    );
  } else if (bucketId) {
    parts.push("Current bucket");
  }

  if (bucketId) {
    parts.push(bucketId);
  }

  const prefixLabel = formatStoragePrefixLabel(prefix);
  if (prefixLabel) {
    parts.push(prefixLabel);
  }

  return parts.join(" • ");
}

function getDbCloneProgressView(
  record: MigrationJobRecord | null,
  fallbackStatus: "idle" | "starting" | "running",
): JobProgressView {
  const latestEvent = getLatestTaskEvent(record, "db") ?? null;
  const storageStarted = hasAnyTaskEvent(record, [
    "storage_copy.started",
    "storage_copy.progress",
    "storage_copy.succeeded",
    "storage_copy.partial",
    "storage_copy.failed",
  ]);
  const status: TaskCardStatus =
    hasTaskEvent(record, "db_clone.succeeded") || storageStarted
      ? "succeeded"
      : hasTaskEvent(record, "target_validation.failed") ||
          hasTaskEvent(record, "db_clone.failed") ||
          (record?.status === "failed" && !hasTaskEvent(record, "db_clone.succeeded"))
        ? "failed"
        : fallbackStatus;

  if (status === "succeeded") {
    return {
      status,
      percent: 100,
      headline: "Database cloned",
      detail: "Schema and data copied into your Supabase project.",
      context: null,
      updatedAt: record?.finished_at ?? latestEvent?.at ?? null,
    };
  }

  if (status === "failed") {
    return {
      status,
      percent: getDbClonePercentForPhase(latestEvent?.phase),
      headline: "Database clone failed",
      detail: buildFailureMessage(record, latestEvent?.message, latestEvent?.data),
      context: null,
      updatedAt: record?.finished_at ?? latestEvent?.at ?? null,
    };
  }

  return {
    status,
    percent:
      latestEvent?.phase != null
        ? getDbClonePercentForPhase(latestEvent.phase)
        : fallbackStatus === "idle"
          ? 0
          : 8,
    headline: getDbCloneHeadlineForPhase(latestEvent?.phase, fallbackStatus),
    detail:
      latestEvent?.message ??
      (fallbackStatus === "idle" ? "Waiting to start." : "Preparing the database transfer."),
    context: null,
    updatedAt: latestEvent?.at ?? record?.started_at ?? null,
  };
}

function getStorageCopyProgressView(
  record: MigrationJobRecord | null,
  fallbackStatus: "idle" | "starting" | "running",
): JobProgressView {
  const latestEvent = getLatestTaskEvent(record, "storage") ?? null;
  const latestStageInfo = getLatestStorageStageInfo(record);
  const latestProgress = getLatestStorageProgress(record);
  const latestSummary = getLatestStorageSummary(record);
  const dbSucceeded = hasTaskEvent(record, "db_clone.succeeded");
  const targetValidationFailed = hasTaskEvent(record, "target_validation.failed");
  const dbFailed = hasTaskEvent(record, "db_clone.failed");
  const storageStarted = hasAnyTaskEvent(record, [
    "storage_copy.started",
    "storage_copy.progress",
    "storage_copy.succeeded",
    "storage_copy.partial",
    "storage_copy.failed",
  ]);
  const storageBlocked =
    targetValidationFailed || dbFailed || (record?.status === "failed" && !dbSucceeded);
  const status: TaskCardStatus =
    hasTaskEvent(record, "storage_copy.succeeded") || hasTaskEvent(record, "storage_copy.partial")
      ? "succeeded"
      : hasTaskEvent(record, "storage_copy.failed") ||
          (record?.status === "failed" &&
            storageStarted &&
            !hasTaskEvent(record, "storage_copy.succeeded") &&
            !hasTaskEvent(record, "storage_copy.partial"))
        ? "failed"
        : storageBlocked
          ? "idle"
          : fallbackStatus;

  if (status === "succeeded") {
    return {
      status,
      percent: 100,
      headline: "Storage copied",
      detail: latestSummary
        ? formatStorageProgressCount(latestSummary)
        : "Storage objects copied into your Supabase project.",
      context: formatStorageProgressContext(latestProgress, latestStageInfo) || null,
      updatedAt: record?.finished_at ?? latestEvent?.at ?? null,
    };
  }

  if (status === "failed") {
    const failureMessage = buildFailureMessage(record, latestEvent?.message, latestEvent?.data);
    return {
      status,
      percent: getStorageProgressPercent(latestProgress, latestEvent?.phase),
      headline:
        latestSummary && latestSummary.objectsFailed > 0
          ? "Storage copy completed with errors"
          : "Storage copy failed",
      detail:
        latestSummary && latestSummary.objectsFailed > 0
          ? `${formatStorageProgressCount(latestSummary)}. ${failureMessage}`
          : failureMessage,
      context: formatStorageProgressContext(latestProgress, latestStageInfo) || null,
      updatedAt: record?.finished_at ?? latestEvent?.at ?? null,
    };
  }

  if (!storageStarted && storageBlocked) {
    return {
      status,
      percent: 0,
      headline: "Waiting to start",
      detail: targetValidationFailed
        ? "Storage copy did not start because the Supabase database check failed."
        : "Storage copy did not start because database clone failed.",
      context: null,
      updatedAt: record?.finished_at ?? null,
    };
  }

  return {
    status,
    percent: storageStarted ? getStorageProgressPercent(latestProgress, latestEvent?.phase) : 0,
    headline: getStorageProgressHeadline(latestProgress, latestStageInfo, fallbackStatus),
    detail: getStorageProgressDetail(
      latestProgress,
      latestStageInfo,
      storageStarted ? latestEvent?.message : undefined,
      fallbackStatus,
    ),
    context: formatStorageProgressContext(latestProgress, latestStageInfo) || null,
    updatedAt: storageStarted
      ? (latestEvent?.at ?? latestStageInfo?.at ?? record?.started_at ?? null)
      : null,
  };
}

function getDbClonePercentForPhase(phase?: string) {
  switch (phase) {
    case "container.build.started":
      return 12;
    case "container.build.succeeded":
      return 28;
    case "container.start_invoked":
      return 38;
    case "target_validation.started":
      return 52;
    case "target_validation.succeeded":
      return 62;
    case "source_edge_function.resolved":
      return 74;
    case "db_clone.started":
      return 86;
    case "db_clone.succeeded":
      return 100;
    case "target_validation.failed":
      return 52;
    case "db_clone.failed":
      return 86;
    default:
      return 8;
  }
}

function getDbCloneHeadlineForPhase(
  phase: string | undefined,
  fallbackStatus: "idle" | "starting" | "running",
) {
  switch (phase) {
    case "container.start_invoked":
      return "Starting runtime";
    case "container.build.started":
      return "Preparing runtime";
    case "container.build.succeeded":
      return "Runtime ready";
    case "target_validation.started":
      return "Checking Supabase database";
    case "target_validation.succeeded":
      return "Supabase database ready";
    case "source_edge_function.resolved":
      return "Lovable Cloud connected";
    case "db_clone.succeeded":
      return "Database cloned";
    case "target_validation.failed":
      return "Supabase database check failed";
    case "db_clone.failed":
      return "Database clone failed";
    case "db_clone.started":
      return "Starting clone";
    default:
      return fallbackStatus === "idle" ? "Waiting to start" : "Starting clone";
  }
}

function getStorageProgressPercent(
  progress: ReturnType<typeof getLatestStorageProgress>,
  phase?: string,
) {
  if (progress && progress.objectsTotal > 0) {
    const completed =
      progress.objectsCopied +
      progress.objectsFailed +
      progress.objectsSkippedExisting +
      progress.objectsSkippedMissing;
    const ratio = completed / progress.objectsTotal;
    return Math.max(8, Math.min(98, Math.round(ratio * 100)));
  }

  if (progress && progress.prefixesScanned > 0) {
    return Math.max(12, Math.min(42, 12 + Math.round(Math.sqrt(progress.prefixesScanned) * 3)));
  }

  switch (phase) {
    case "source_edge_function.resolved":
      return 18;
    case "storage_copy.progress":
      return 12;
    case "storage_copy.started":
      return 6;
    default:
      return 0;
  }
}

function getStorageProgressHeadline(
  progress: ReturnType<typeof getLatestStorageProgress>,
  stageInfo: ReturnType<typeof getLatestStorageStageInfo>,
  fallbackStatus: "idle" | "starting" | "running",
) {
  switch (stageInfo?.stage) {
    case "list_source_buckets":
      return "Listing source buckets";
    case "list_target_buckets":
      return "Checking Supabase buckets";
    case "count_source_objects":
      return "Counting source objects";
    case "scan_source_bucket":
      return "Scanning source bucket";
    case "prepare_target_bucket":
      return "Preparing Supabase bucket";
    case "copy_source_bucket":
      return progress && progress.objectsTotal > 0
        ? "Copying storage objects"
        : "Discovering storage objects";
    default:
      break;
  }

  if (progress && progress.objectsTotal > 0) {
    return "Copying storage objects";
  }

  if (progress) {
    return progress.prefixesScanned > 0 ? "Scanning storage tree" : "Scanning storage";
  }

  return fallbackStatus === "idle" ? "Waiting to start" : "Starting storage copy";
}

function getStorageProgressDetail(
  progress: ReturnType<typeof getLatestStorageProgress>,
  stageInfo: ReturnType<typeof getLatestStorageStageInfo>,
  fallbackMessage: string | undefined,
  fallbackStatus: "idle" | "starting" | "running",
) {
  if (progress) {
    return formatStorageProgressCount(progress);
  }

  if (stageInfo?.message) {
    return stageInfo.message;
  }

  if (fallbackMessage) {
    return fallbackMessage;
  }

  return fallbackStatus === "idle" ? "Waiting to start." : "Preparing the storage transfer.";
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function generateAccessKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 48);
}

function assetUrl(baseUrl: string, path: string) {
  const normalizedBaseUrl = normalizeUrl(baseUrl);
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

function siteUrl(baseUrl: string, path: string) {
  const normalizedBaseUrl = normalizeUrl(baseUrl);
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

function normalizeUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong while sending the magic link.";
}

function toMagicLinkErrorMessage(error: unknown, options: { requiresHumanCheck: boolean }) {
  const message = toErrorMessage(error);
  if (!options.requiresHumanCheck && /captcha/i.test(message)) {
    return "Supabase Auth CAPTCHA is enabled for this project. Add VITE_TURNSTILE_SITE_KEY or disable CAPTCHA in Supabase Auth to bypass the human check locally.";
  }

  return message;
}

function toRequestErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}
