"use client";

import Intercom, { show, shutdown, update } from "@intercom/messenger-js-sdk";

export { show as showIntercom };
import { useCallback, useEffect, useRef } from "react";
import { getIntercomAttributes, normalizeIntercomEmail } from "./intercom-config";

const APP_ID = import.meta.env.VITE_INTERCOM_APP_ID?.trim();

export function IntercomMessenger({ email }: { email?: string | null }) {
  const hasBootedRef = useRef(false);
  const identifiedEmailRef = useRef<string | null>(null);
  const normalizedEmail = normalizeIntercomEmail(email);

  const bootIntercom = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!APP_ID) return;

    Intercom({
      app_id: APP_ID,
      hide_default_launcher: false,
      ...getIntercomAttributes(),
    });
    hasBootedRef.current = true;
  }, []);

  useEffect(() => {
    if (!APP_ID) return;

    bootIntercom();

    return () => {
      if (!hasBootedRef.current) return;

      shutdown();
      hasBootedRef.current = false;
      identifiedEmailRef.current = null;
    };
  }, [bootIntercom]);

  useEffect(() => {
    if (!APP_ID) return;
    if (!hasBootedRef.current) return;

    if (!normalizedEmail) {
      if (!identifiedEmailRef.current) {
        return;
      }

      shutdown();
      bootIntercom();
      identifiedEmailRef.current = null;
      return;
    }

    update(getIntercomAttributes(normalizedEmail));
    identifiedEmailRef.current = normalizedEmail;
  }, [bootIntercom, normalizedEmail]);

  return null;
}
