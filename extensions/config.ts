export const MIN_DURATION_MS = 1000;
export const MAX_DURATION_MS = 60 * 60 * 1000;

export function normalizeDuration(value: unknown, fallback: number): number {
  const duration = Number(value);
  return Number.isInteger(duration) && duration >= MIN_DURATION_MS && duration <= MAX_DURATION_MS
    ? duration
    : fallback;
}
