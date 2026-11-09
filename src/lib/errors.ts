/**
 * أخطاء المزودين وتصنيفها الموحد — قلب سياسة التبديل التسلسلي.
 * جدول التصنيف (4.2):
 *  disabled : 401/403 أو رسالة invalid api key/unauthorized/forbidden/authentication → تعطيل المفتاح والانتقال للتالي
 *  exhausted: 402 أو رسالة insufficient/quota/balance/credit/out of credits/exhausted/充值 (تُفحص قبل 400!) → علّمه مستنزفًا والانتقال للتالي
 *  provider : model not found/unsupported model مع 400/404/422 → الموديل غير مدعوم، انتقل للتالي
 *  params   : 400/422 (معطيات الطلب) → توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
 *  temporary: 429، 5xx، انقطاع شبكة، timeout، abort → انتقل للتالي الآن
 */

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

const DISABLED_MSG = /invalid api key|unauthorized|forbidden|authentication/i;
const EXHAUSTED_MSG =
  /insufficient|quota|balance|credit|out of credits|exhausted|充值|余额|欠费/i;
const PROVIDER_MODEL_MSG = /model not found|unsupported model|unknown model|no such model/i;
const NETWORK_MSG =
  /timeout|timed out|network|fetch failed|aborted|abort|econn|etimedout|enotfound|econnreset|socket|premature close|other side closed/i;

/**
 * تصنيف موحد لأي خطأ قادم من مزود — يُطبَّق على استجابات HTTP وأخطاء الشبكة على حد سواء.
 * ترتيب الفحص مقصود: نفاد الرصيد قبل 400 لأن بعض المزودين يرسلونه بحالة 400.
 */
export function classifyProviderError(err: unknown): ErrorClass {
  const status = err instanceof ProviderError ? err.status : undefined;
  const msg = err instanceof Error ? err.message : String(err ?? "");

  // 1) disabled
  if (status === 401 || status === 403) return "disabled";
  if (DISABLED_MSG.test(msg)) return "disabled";

  // 2) exhausted — قبل فحص 400 عمدًا
  if (status === 402) return "exhausted";
  if (EXHAUSTED_MSG.test(msg)) return "exhausted";

  // 3) provider (موديل غير مدعوم)
  if (
    PROVIDER_MODEL_MSG.test(msg) &&
    (status === 400 || status === 404 || status === 422 || status === undefined)
  ) {
    return "provider";
  }

  // 4) params — معطيات الطلب
  if (status === 400 || status === 422) return "params";

  // 5) temporary — 429/5xx/شبكة
  if (status === 429) return "temporary";
  if (status !== undefined && status >= 500) return "temporary";
  if (status === undefined && NETWORK_MSG.test(msg)) return "temporary";

  // الافتراضي: اعتبره مؤقتًا (فلسفة «لا توقف أبدًا») — سيُجرَّب المفتاح التالي
  return "temporary";
}

/**
 * نمط رسائل فشل منتصف المهمة التي تثير إعادة الإنشاء على المفتاح التالي بنفس task_id.
 * (قسم 4.3.2: المزود أعلن الفشل ورسالته تطابق مشكلات مفتاح/رصيد)
 */
export const KEY_RELATED_FAILURE =
  /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|exhausted|充值|余额/i;
