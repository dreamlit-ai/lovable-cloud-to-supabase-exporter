const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

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

  posthogInitPromise = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(apiKey, { api_host: apiHost });
    })
    .catch((error) => {
      posthogInitPromise = null;
      console.error("Failed to initialize PostHog analytics.", error);
    });

  return posthogInitPromise;
}
