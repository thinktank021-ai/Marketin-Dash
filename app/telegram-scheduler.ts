/** Scheduler authentication helpers are kept pure so rotation and grace-period
 * behavior can be verified without a live D1 database or Telegram credential. */
export function constantTimeEqual(left: string, right: string) {
  const leftLength = left.length;
  const rightLength = right.length;
  const length = Math.max(leftLength, rightLength);
  let difference = leftLength ^ rightLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function schedulerSecretMatches(secret: string, current: string | null, previous: string | null, previousExpiresAt: string | null, now = Date.now()) {
  if (current && constantTimeEqual(secret, current)) return "current" as const;
  if (previous && previousExpiresAt && Date.parse(previousExpiresAt) > now && constantTimeEqual(secret, previous)) return "grace" as const;
  return null;
}

export function schedulerHealthError(code: "secret_mismatch" | "dispatch_failed", detail?: string) {
  if (code === "secret_mismatch") return "کلید Scheduler با Code.gs یکسان نیست؛ از داشبورد کلید جدید بسازید و کد تولیدشده را کامل جایگزین کنید.";
  return detail ? `ارسال گزارش از Scheduler با خطا متوقف شد: ${detail}` : "ارسال گزارش از Scheduler با خطا متوقف شد.";
}
