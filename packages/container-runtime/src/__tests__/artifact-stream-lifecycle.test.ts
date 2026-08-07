import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactStreamTimeoutController } from "../artifact-stream-lifecycle";

describe("artifact stream timeout lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a prompt request alive beyond the thirty-minute live window", async () => {
    vi.useFakeTimers();
    const onIdleTimeout = vi.fn();
    const onStallTimeout = vi.fn();
    const controller = createArtifactStreamTimeoutController({
      idleTimeoutMs: 30 * 60 * 1000,
      stallTimeoutMs: 15 * 60 * 1000,
      onIdleTimeout,
      onStallTimeout,
    });

    vi.advanceTimersByTime(29 * 60 * 1000);
    controller.requestStarted();
    const generation = new Promise<void>((resolve) => {
      setTimeout(resolve, 6 * 60 * 1000);
    });
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    await generation;

    expect(onIdleTimeout).not.toHaveBeenCalled();
    expect(onStallTimeout).not.toHaveBeenCalled();
    controller.stop();
  });

  it("uses a separate inactivity deadline after the stream starts", () => {
    vi.useFakeTimers();
    const onIdleTimeout = vi.fn();
    const onStallTimeout = vi.fn();
    const controller = createArtifactStreamTimeoutController({
      idleTimeoutMs: 30 * 60 * 1000,
      stallTimeoutMs: 15 * 60 * 1000,
      onIdleTimeout,
      onStallTimeout,
    });

    controller.requestStarted();
    vi.advanceTimersByTime(10 * 60 * 1000);
    controller.activityObserved();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(onIdleTimeout).not.toHaveBeenCalled();
    expect(onStallTimeout).toHaveBeenCalledOnce();
  });
});
