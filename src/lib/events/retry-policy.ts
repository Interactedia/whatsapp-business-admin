export const DEFAULT_DELIVERY_MAX_ATTEMPTS = 5;
export const DEFAULT_DELIVERY_BASE_DELAY_MS = 1_000;
export const DEFAULT_DELIVERY_MAX_DELAY_MS = 60_000;

export interface DeliveryRetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  now?: Date;
  random?: () => number;
}

export interface DeliveryRetryDecision {
  exhausted: boolean;
  nextRetryAt: Date | null;
  delayMs: number | null;
}

export const deliveryPolicy = (policy: DeliveryRetryPolicy = {}) => ({
  maxAttempts: Math.max(1, policy.maxAttempts ?? DEFAULT_DELIVERY_MAX_ATTEMPTS),
  baseDelayMs: Math.max(1, policy.baseDelayMs ?? DEFAULT_DELIVERY_BASE_DELAY_MS),
  maxDelayMs: Math.max(1, policy.maxDelayMs ?? DEFAULT_DELIVERY_MAX_DELAY_MS),
  jitterRatio: Math.max(0, Math.min(1, policy.jitterRatio ?? 0)),
  now: policy.now ?? new Date(),
  random: policy.random ?? Math.random,
});

export const retryAfterDelayMs = (value: string | null | undefined, now: Date, maxDelayMs: number): number | null => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), maxDelayMs);

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.min(Math.max(0, dateMs - now.getTime()), maxDelayMs);
};

export const nextRetryDecision = (
  completedAttempts: number,
  retryAfterHeader?: string | null,
  policy: DeliveryRetryPolicy = {}
): DeliveryRetryDecision => {
  const p = deliveryPolicy(policy);
  if (completedAttempts >= p.maxAttempts) return { exhausted: true, nextRetryAt: null, delayMs: null };

  const retryAfterMs = retryAfterDelayMs(retryAfterHeader, p.now, p.maxDelayMs);
  const backoffMs = Math.min(p.baseDelayMs * 2 ** Math.max(0, completedAttempts - 1), p.maxDelayMs);
  const jitterMs = p.jitterRatio === 0 ? 0 : Math.round(backoffMs * p.jitterRatio * p.random());
  const delayMs = Math.min(retryAfterMs ?? backoffMs + jitterMs, p.maxDelayMs);
  return { exhausted: false, nextRetryAt: new Date(p.now.getTime() + delayMs), delayMs };
};
