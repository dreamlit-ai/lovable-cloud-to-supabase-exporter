import {
  psqlSelect1ViaSpawn,
  resolveSupabasePostgresUrlWithSessionPoolerFallback,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core/supabase-session-pooler-resolve-node";

const buildPsqlProbeEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PGCONNECT_TIMEOUT: "10",
});

export const resolveSupabasePostgresUrlWithSessionPoolerFallbackForCli = async (
  postgresUrl: string,
): Promise<string> => {
  const result = await resolveSupabasePostgresUrlWithSessionPoolerFallback({
    postgresUrl,
    trySelect1: async (url) => {
      await psqlSelect1ViaSpawn(url, buildPsqlProbeEnv());
    },
    preferredPoolerHostsFromEnv: process.env.SUPABASE_SESSION_POOLER_HOSTS?.trim() || null,
  });

  return result.url;
};
