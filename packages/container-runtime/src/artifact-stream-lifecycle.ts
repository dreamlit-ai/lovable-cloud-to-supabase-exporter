export interface ArtifactStreamTimeoutController {
  requestStarted(): void;
  activityObserved(): void;
  retryWaiting(): void;
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

  let idleTimer: NodeJS.Timeout | null = null;

  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!stopped && !requestAccepted) onIdleTimeout();
    }, idleTimeoutMs);
    idleTimer.unref();
  };

  const armStallTimer = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (!stopped && requestAccepted) onStallTimeout();
    }, stallTimeoutMs);
    stallTimer.unref();
  };

  armIdleTimer();

  return {
    requestStarted(): void {
      if (stopped || requestAccepted) return;
      requestAccepted = true;
      if (idleTimer) clearTimeout(idleTimer);
      armStallTimer();
    },
    activityObserved(): void {
      if (stopped || !requestAccepted) return;
      armStallTimer();
    },
    retryWaiting(): void {
      if (stopped || !requestAccepted) return;
      requestAccepted = false;
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      armIdleTimer();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (stallTimer) clearTimeout(stallTimer);
    },
  };
};
