const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const POSTHOG_SCRIPT_DATA_ATTRIBUTE = "data-posthog-script";

type PostHogGlobal = {
  init: (token: string, config: { api_host: string }) => void;
  capture?: (eventName: string, properties?: Record<string, unknown>) => void;
  identify?: (distinctId: string, properties?: Record<string, unknown>) => void;
  reset?: () => void;
  get_distinct_id?: () => string;
  get_session_id?: () => string | null;
};

declare global {
  interface Window {
    posthog?: PostHogGlobal;
  }
}

let posthogInitPromise: Promise<void> | null = null;

function getPosthogConfig() {
  const apiKey = import.meta.env.VITE_POSTHOG_KEY?.trim() || null;
  const apiHost = import.meta.env.VITE_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
  return { apiKey, apiHost };
}

export function initPosthogAnalytics(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  const { apiKey, apiHost } = getPosthogConfig();
  if (!apiKey) {
    return Promise.resolve();
  }

  if (posthogInitPromise) {
    return posthogInitPromise;
  }

  posthogInitPromise = loadPosthogScript(apiHost)
    .then(() => {
      if (!window.posthog) {
        throw new Error("PostHog did not attach to window.");
      }

      window.posthog.init(apiKey, { api_host: apiHost });
    })
    .catch((error) => {
      posthogInitPromise = null;
      console.error("Failed to initialize PostHog analytics.", error);
    });

  return posthogInitPromise;
}

export function captureExporterEvent(eventName: string, properties: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;

  void initPosthogAnalytics().then(() => {
    window.posthog?.capture?.(eventName, {
      exporter_surface: "lovable_cloud_to_supabase_exporter",
      ...properties,
    });
  });
}

export function identifyExporterUser(userId: string | null | undefined, email?: string | null) {
  const distinctId = userId?.trim();
  if (!distinctId || typeof window === "undefined") return;

  void initPosthogAnalytics().then(() => {
    window.posthog?.identify?.(
      distinctId,
      email?.trim()
        ? {
            email: email.trim(),
          }
        : undefined,
    );
  });
}

export function resetExporterAnalyticsUser() {
  if (typeof window === "undefined") return;

  void initPosthogAnalytics().then(() => {
    window.posthog?.reset?.();
  });
}

export function getExporterAnalyticsContext() {
  const { apiKey, apiHost } = getPosthogConfig();

  if (typeof window === "undefined") {
    return {
      posthog_distinct_id: null,
      posthog_session_id: null,
      posthog_project_key: apiKey,
      posthog_host: apiHost,
    };
  }

  return {
    posthog_distinct_id: window.posthog?.get_distinct_id?.() ?? null,
    posthog_session_id: window.posthog?.get_session_id?.() ?? null,
    posthog_project_key: apiKey,
    posthog_host: apiHost,
  };
}

export async function hashExporterAnalyticsId(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized || typeof crypto === "undefined" || !crypto.subtle) return null;

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function loadPosthogScript(apiHost: string): Promise<void> {
  const scriptSrc = `${apiHost.replace(".i.posthog.com", "-assets.i.posthog.com").replace(/\/$/, "")}/static/array.js`;
  const existingScript = document.querySelector<HTMLScriptElement>(
    `script[${POSTHOG_SCRIPT_DATA_ATTRIBUTE}="true"]`,
  );

  if (existingScript) {
    if (existingScript.dataset.loaded === "true") {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("PostHog script could not load.")),
        { once: true },
      );
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.crossOrigin = "anonymous";
    script.async = true;
    script.src = scriptSrc;
    script.dataset.posthogScript = "true";

    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => {
        reject(new Error("PostHog script could not load."));
      },
      { once: true },
    );

    document.head.appendChild(script);
  });
}
