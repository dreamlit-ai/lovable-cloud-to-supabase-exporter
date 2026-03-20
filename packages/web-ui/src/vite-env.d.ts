/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LOVABLE_EXPORTER_API_BASE_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_REDIRECT_URL?: string;
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  readonly VITE_POSTHOG_KEY?: string;
  readonly VITE_POSTHOG_HOST?: string;
  readonly VITE_APP_BASE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
