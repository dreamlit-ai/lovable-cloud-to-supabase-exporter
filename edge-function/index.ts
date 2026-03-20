const BUILD_ID = "2026-03-04";
const ACCESS_KEY = "replace-with-your-long-random-access-key";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-access-key, x-client-info, apikey, content-type",
};

const responseHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Build-Id": BUILD_ID,
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: responseHeaders,
  });

const errorResponse = (status: number, error: string) =>
  jsonResponse({ build_id: BUILD_ID, error }, status);

const requiredEnv = (name: string): string | null => {
  const value = Deno.env.get(name)?.trim();
  return value || null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: responseHeaders });
  }

  const requestAccessKey = req.headers.get("x-access-key")?.trim();
  if (!requestAccessKey || requestAccessKey !== ACCESS_KEY) {
    return errorResponse(401, "Unauthorized");
  }

  const supabaseDbUrl = requiredEnv("SUPABASE_DB_URL");
  if (!supabaseDbUrl) {
    return errorResponse(500, "Set SUPABASE_DB_URL and redeploy.");
  }

  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    return errorResponse(500, "Set SUPABASE_SERVICE_ROLE_KEY and redeploy.");
  }

  return jsonResponse({
    build_id: BUILD_ID,
    generated_at: new Date().toISOString(),
    supabase_db_url: supabaseDbUrl,
    service_role_key: serviceRoleKey,
  });
});
