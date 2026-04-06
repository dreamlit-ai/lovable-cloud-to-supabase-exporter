export const INTERCOM_EXPORTER_SOURCE = "supabase_exporter";
export const INTERCOM_EXPORTER_SOURCE_LABEL = "Supabase Exporter";

export function normalizeIntercomEmail(email?: string | null): string | null {
  const normalizedEmail = email?.trim();
  return normalizedEmail ? normalizedEmail : null;
}

export function getIntercomAttributes(email?: string | null) {
  const normalizedEmail = normalizeIntercomEmail(email);

  if (normalizedEmail) {
    return {
      email: normalizedEmail,
      source_tool: INTERCOM_EXPORTER_SOURCE_LABEL,
      support_source: INTERCOM_EXPORTER_SOURCE,
    };
  }

  return {
    source_tool: INTERCOM_EXPORTER_SOURCE_LABEL,
    support_source: INTERCOM_EXPORTER_SOURCE,
  };
}
