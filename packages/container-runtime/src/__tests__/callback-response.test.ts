import { afterEach, expect, it, vi } from "vitest";
import { postCallback } from "../export-runner.js";

afterEach(() => vi.unstubAllGlobals());

it("cancels the unused callback response body", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  const fetch = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetch);

  await postCallback("https://example.test/callback", {
    callback_token: "token",
    run_id: "run",
    level: "info",
    phase: "storage_copy.progress",
    message: "Storage copy in progress.",
  });

  expect(fetch).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});
