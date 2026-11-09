/**
 * طبقة إدارة المفاتيح: الإخفاء الإلزامي (maskKey) في كل الاستجابات والسجلات،
 * وتحديث عدّادات الاستخدام، وتمييز الحالات (active/exhausted/disabled).
 */
import { getKey, patchKey, type ApiKeyRow, nowStamp } from "@/lib/turso";
import { classifyProviderError, type ErrorClass } from "@/lib/errors";

/** إخفاء المفتاح: أول 7 أحرف + •••••••• + آخر 4 (والقصير: أول 3 + ••••) — لا يُعاد المفتاح الكامل في أي استجابة */
export function maskKey(key: string): string {
  if (key.length <= 10) {
    return key.slice(0, 3) + "••••";
  }
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

export function maskedKeyRow(row: ApiKeyRow) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    masked: maskKey(row.api_key),
    status: row.status,
    usage_count: Number(row.usage_count ?? 0),
    success_count: Number(row.success_count ?? 0),
    fail_count: Number(row.fail_count ?? 0),
    last_used_at: row.last_used_at,
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

/**
 * تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) — تُحدَّث دائمًا.
 * disabled → يُعلَّم تلقائيًا، exhausted → يبقى في القاعدة لكن يُعلَّم.
 */
export async function recordKeyAttempt(
  key: ApiKeyRow,
  outcome: { ok: boolean; error?: unknown; errorClass?: ErrorClass }
): Promise<void> {
  const cls = outcome.errorClass ?? (outcome.ok ? undefined : classifyProviderError(outcome.error));
  const errMsg =
    outcome.error instanceof Error
      ? outcome.error.message.slice(0, 300)
      : outcome.error
        ? String(outcome.error).slice(0, 300)
        : null;
  await patchKey(key.id, {
    usage_count_delta: 1,
    success_count_delta: outcome.ok ? 1 : 0,
    fail_count_delta: outcome.ok ? 0 : 1,
    last_used_at: nowStamp(),
    last_checked_at: nowStamp(),
    last_error: outcome.ok ? null : errMsg,
    // ملاحظة: لا نغيّر الحالة إلى disabled إلا عند تصنيف disabled صريح
    status: cls === "disabled" ? "disabled" : cls === "exhausted" ? "exhausted" : undefined,
  });
}

/** علّم مفتاحًا مستنزفًا عند اكتشاف 402/نفاد رصيد أثناء متابعة مهمة قائمة */
export async function markKeyExhausted(keyId: string, error: string): Promise<void> {
  await patchKey(keyId, { status: "exhausted", last_error: error.slice(0, 300), last_checked_at: nowStamp() });
}

/** علّم مفتاحًا معطلًا عند اكتشاف 401/403 أثناء متابعة مهمة قائمة */
export async function markKeyDisabled(keyId: string, error: string): Promise<void> {
  await patchKey(keyId, { status: "disabled", last_error: error.slice(0, 300), last_checked_at: nowStamp() });
}

export async function touchKeyChecked(keyId: string): Promise<void> {
  await patchKey(keyId, { last_checked_at: nowStamp() });
}

export async function refreshKey(id: string): Promise<ApiKeyRow | null> {
  return getKey(id);
}
