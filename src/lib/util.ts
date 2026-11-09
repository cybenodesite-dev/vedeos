/** أدوات صغيرة مشتركة */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function safeMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 400);
  return String(err ?? "خطأ غير معروف").slice(0, 400);
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? Math.round(v) : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
