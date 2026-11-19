/**
 * Timeout helpers shared by the SSH command and scp paths.
 *
 * `setTimeout` only accepts a signed 32-bit delay. Node clamps larger values to
 * 1 ms (with a warning), which would abort a long-running call immediately
 * instead of waiting, so every externally supplied timeout is clamped first.
 */

export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Normalize an optional timeout: 0/negative/undefined means "no timeout". */
export const clampTimeoutMs = (timeoutMs?: number): number | undefined => {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.min(Math.round(timeoutMs), MAX_TIMEOUT_MS);
};
