import { isTransientFetchError } from "./job-polling";

export function toRequestErrorMessage(
  error: unknown,
  fallback: string,
  options: { networkFallback?: string } = {},
) {
  if (options.networkFallback && isTransientFetchError(error)) {
    return options.networkFallback;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
