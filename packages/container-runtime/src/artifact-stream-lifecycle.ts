export interface ArtifactStreamTimeoutController {
  requestStarted(): void;
  activityObserved(): void;
  stop(): void;
}

interface ArtifactStreamTimeoutOptions {
  idleTimeoutMs: number;
  stallTimeoutMs: number;
  onIdleTimeout: () => void;
  onStallTimeout: () => void;
}

export const createArtifactStreamTimeoutController = ({
  idleTimeoutMs,
  stallTimeoutMs,
  onIdleTimeout,
  onStallTimeout,
}: ArtifactStreamTimeoutOptions): ArtifactStreamTimeoutController => {
  let requestAccepted = false;
  let stopped = false;
  let stallTimer: NodeJS.Timeout | null = null;

  const idleTimer = setTimeout(() => {
    if (!stopped && !requestAccepted) onIdleTimeout();
  }, idleTimeoutMs);
  idleTimer.unref();

  const armStallTimer = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (!stopped && requestAccepted) onStallTimeout();
    }, stallTimeoutMs);
    stallTimer.unref();
  };

  return {
    requestStarted(): void {
      if (stopped || requestAccepted) return;
      requestAccepted = true;
      clearTimeout(idleTimer);
      armStallTimer();
    },
    activityObserved(): void {
      if (stopped || !requestAccepted) return;
      armStallTimer();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimeout(idleTimer);
      if (stallTimer) clearTimeout(stallTimer);
    },
  };
};
