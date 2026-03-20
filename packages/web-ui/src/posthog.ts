const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const POSTHOG_SCRIPT_DATA_ATTRIBUTE = "data-posthog-script";

type PostHogGlobal = {
  init: (token: string, config: { api_host: string }) => void;
};

declare global {
  interface Window {
    posthog?: PostHogGlobal;
  }
}

let posthogInitPromise: Promise<void> | null = null;

export function initPosthogAnalytics(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  const apiKey = import.meta.env.VITE_POSTHOG_KEY?.trim();
  if (!apiKey) {
    return Promise.resolve();
  }

  if (posthogInitPromise) {
    return posthogInitPromise;
  }

  const apiHost = import.meta.env.VITE_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;

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
