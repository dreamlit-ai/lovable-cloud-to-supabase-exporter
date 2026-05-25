export type ConsumedAuthRedirectFragment = {
  accessToken: string | null;
  refreshToken: string | null;
  error: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  type: string | null;
};

export type AuthRedirectSession = {
  user?: {
    id?: string | null;
    email?: string | null;
  };
} | null;

type SupabaseAuthClientForRedirect = {
  auth: {
    setSession: (session: { access_token: string; refresh_token: string }) => Promise<{
      data: { session: AuthRedirectSession };
      error: unknown | null;
    }>;
  };
};

const AUTH_FRAGMENT_SIGNAL_KEYS = new Set([
  "access_token",
  "refresh_token",
  "error",
  "error_code",
  "error_description",
]);

let consumedAuthRedirectFragment: ConsumedAuthRedirectFragment | null = null;
let consumedAuthRedirectSessionPromise: Promise<AuthRedirectSession> | null = null;

export function toHashlessUrl(input: string, baseUrl?: string) {
  try {
    const url = baseUrl ? new URL(input, baseUrl) : new URL(input);
    url.hash = "";
    return url.toString();
  } catch {
    return input.split("#")[0] ?? "";
  }
}

export function getCleanAuthRedirectUrl(configuredRedirectUrl?: string) {
  const trimmedRedirectUrl = configuredRedirectUrl?.trim();
  if (trimmedRedirectUrl) {
    return toHashlessUrl(
      trimmedRedirectUrl,
      typeof window === "undefined" ? undefined : window.location.origin,
    );
  }

  if (typeof window === "undefined") {
    return "";
  }

  return toHashlessUrl(window.location.href);
}

export function readAuthRedirectFragmentFromUrl(input: string) {
  try {
    return readAuthRedirectFragmentFromHash(new URL(input).hash);
  } catch {
    const hashIndex = input.indexOf("#");
    return hashIndex === -1 ? null : readAuthRedirectFragmentFromHash(input.slice(hashIndex));
  }
}

export function readAuthRedirectFragmentFromHash(hash: string) {
  const normalizedHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!normalizedHash) {
    return null;
  }

  const params = new URLSearchParams();
  for (const hashPart of normalizedHash.split("#")) {
    if (!hashPart) continue;
    new URLSearchParams(hashPart).forEach((value, key) => {
      params.set(key, value);
    });
  }

  if (![...AUTH_FRAGMENT_SIGNAL_KEYS].some((key) => params.has(key))) {
    return null;
  }

  return {
    accessToken: params.get("access_token"),
    refreshToken: params.get("refresh_token"),
    error: params.get("error"),
    errorCode: params.get("error_code"),
    errorDescription: params.get("error_description"),
    type: params.get("type"),
  } satisfies ConsumedAuthRedirectFragment;
}

export function consumeBrowserAuthRedirectFragment() {
  if (consumedAuthRedirectFragment) {
    return consumedAuthRedirectFragment;
  }

  if (typeof window === "undefined") {
    return null;
  }

  const fragment = readAuthRedirectFragmentFromUrl(window.location.href);
  if (!fragment) {
    return null;
  }

  consumedAuthRedirectFragment = fragment;
  window.history.replaceState(window.history.state, "", getCleanAuthRedirectUrl());
  return fragment;
}

export function hasAuthRedirectSession(fragment: ConsumedAuthRedirectFragment | null) {
  return Boolean(fragment?.accessToken && fragment.refreshToken);
}

export function getAuthRedirectError(fragment: ConsumedAuthRedirectFragment | null) {
  return fragment?.errorCode ?? fragment?.errorDescription ?? fragment?.error ?? null;
}

export async function consumeSupabaseAuthRedirectSession(supabase: SupabaseAuthClientForRedirect) {
  const fragment = consumedAuthRedirectFragment;
  if (!fragment?.accessToken || !fragment.refreshToken) {
    return null;
  }

  consumedAuthRedirectSessionPromise ??= supabase.auth
    .setSession({
      access_token: fragment.accessToken,
      refresh_token: fragment.refreshToken,
    })
    .then(({ data, error }) => {
      if (error) {
        throw error;
      }

      return data.session ?? null;
    });

  return consumedAuthRedirectSessionPromise;
}
