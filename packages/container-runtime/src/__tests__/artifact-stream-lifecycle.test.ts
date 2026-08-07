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

  it("re-arms a full idle window while waiting for a retry after an abort", () => {
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
    vi.advanceTimersByTime(10 * 60 * 1000);
    controller.retryWaiting();
    vi.advanceTimersByTime(29 * 60 * 1000);

    expect(onIdleTimeout).not.toHaveBeenCalled();
    expect(onStallTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60 * 1000);
    expect(onIdleTimeout).toHaveBeenCalledOnce();
  });

  it("applies the stall deadline independently to every retry attempt", () => {
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
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(onStallTimeout).toHaveBeenCalledOnce();

    controller.retryWaiting();
    controller.requestStarted();
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(onStallTimeout).toHaveBeenCalledTimes(2);
  });
});
