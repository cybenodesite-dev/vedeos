/**
 * عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق).
 * العنوان من MERGER_API_BASE. المخرجات: MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18.
 * لا توجد معاملات resolution/fps — الناتج ثابت.
 *
 * القيود المقاسة: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد،
 * وكل الملفات تُحذف تلقائيًا بعد 24 ساعة (expiresAt في الاستجابات).
 *
 * قاعدة حتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري —
 * لا إعادة محاولة. أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → تُستأنف الاستعلامات.
 */
import { ProviderError } from "@/lib/errors";

const RAW_BASE = (process.env.MERGER_API_BASE || "https://xxxxxxxx").trim();

/** هل خدمة الدمج مهيأة فعلًا؟ (يتجاهل العنوان المؤقت الافتراضي) */
export function mergerConfigured(): boolean {
  if (!RAW_BASE || !/^https?:\/\//i.test(RAW_BASE)) return false;
  if (/xxxxxxxx/i.test(RAW_BASE)) return false; // العنوان المؤقت
  return true;
}

export function mergerBase(): string {
  return RAW_BASE.replace(/\/+$/, "");
}

function assertConfigured(): string {
  if (!mergerConfigured()) {
    throw new ProviderError(
      500,
      "merger: MERGER_API_BASE غير مضبوط — خدمة الدمج غير مهيأة (العنوان الافتراضي مؤقت)"
    );
  }
  return mergerBase();
}

/* ------------------------- تحليل الحالة (دفاعي) ------------------------- */

const DONE_STATES = /done|completed|complete|success|succeeded|finished/i;
const FAILED_STATES = /error|failed|failure|cancelled|canceled/i;

export type MergerStatus = "processing" | "completed" | "failed";

export interface MergerJobStatus {
  status: MergerStatus;
  progress: number; // 0..100
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

export interface MergerJobRaw {
  status?: string;
  progress?: unknown;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  [k: string]: unknown;
}

/**
 * تحليل دفاعي لرد GET /api/jobs/{id}:
 * - قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا.
 * - progress قد يأتي كسرًا 0..1 → نضربه في 100.
 */
export function analyzeMergerStatus(raw: MergerJobRaw): MergerJobStatus {
  // خطأ معلن بدون حالة = فشل فوري
  if (!raw.status && raw.error) {
    return { status: "failed", progress: 0, error: raw.error };
  }
  const s = String(raw.status ?? "").toLowerCase();
  let status: MergerStatus = "processing";
  if (DONE_STATES.test(s)) status = "completed";
  else if (FAILED_STATES.test(s)) status = "failed";

  let progress = typeof raw.progress === "string" ? Number(raw.progress) : (raw.progress as number);
  if (typeof progress !== "number" || Number.isNaN(progress)) progress = status === "completed" ? 100 : 0;
  if (progress > 0 && progress <= 1) progress = Math.round(progress * 100);
  progress = Math.max(0, Math.min(100, Math.round(progress)));

  return {
    status,
    progress,
    videoUrl: typeof raw.videoUrl === "string" ? raw.videoUrl : undefined,
    downloadUrl: typeof raw.downloadUrl === "string" ? raw.downloadUrl : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

/** رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط الرابط يدويًا من jobId */
export function mergerResultUrl(base: string, jobId: string, videoUrl?: string, downloadUrl?: string): string {
  if (videoUrl) return videoUrl;
  if (downloadUrl) return downloadUrl;
  return `${base}/api/jobs/${jobId}/video`;
}

/* ----------------------------- نداءات الخدمة ----------------------------- */

async function mergerFetch(path: string, init: RequestInit, ms: number): Promise<Response> {
  const base = assertConfigured();
  return fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(ms) });
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string; message?: string };
    return j.error || j.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export interface MergerCreateResult {
  jobId: string;
  statusUrl?: string;
  expiresAt?: string;
}

/** POST /api/jobs — إنشاء مهمة دمج */
export async function mergerCreateJob(videos: string[]): Promise<MergerCreateResult> {
  const res = await mergerFetch(
    `/api/jobs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ videos }),
    },
    30_000
  );
  if (!res.ok) throw new ProviderError(res.status, await readErrorBody(res));
  const j = (await res.json()) as { jobId?: string; job_id?: string; statusUrl?: string; expiresAt?: string };
  const jobId = j.jobId || j.job_id;
  if (!jobId) throw new ProviderError(502, "merger: لا jobId في استجابة الإنشاء");
  return { jobId, statusUrl: j.statusUrl, expiresAt: j.expiresAt };
}

/** POST /api/jobs/{id}/process — يستغرق ~10–15 ثانية (blocking) */
export async function mergerProcessJob(jobId: string): Promise<MergerJobRaw> {
  const res = await mergerFetch(
    `/api/jobs/${encodeURIComponent(jobId)}/process`,
    { method: "POST", headers: { Accept: "application/json" } },
    90_000
  );
  const j = (await res.json().catch(() => ({}))) as MergerJobRaw;
  if (!res.ok) throw new ProviderError(res.status, (j.error as string) || `HTTP ${res.status}`);
  return j;
}

/** GET /api/jobs/{id} — استعلام حالة */
export async function mergerGetJob(jobId: string): Promise<MergerJobRaw> {
  const res = await mergerFetch(
    `/api/jobs/${encodeURIComponent(jobId)}`,
    { headers: { Accept: "application/json" } },
    15_000
  );
  if (res.status === 404) {
    const e = new ProviderError(404, "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    throw e;
  }
  const j = (await res.json().catch(() => ({}))) as MergerJobRaw;
  if (!res.ok) throw new ProviderError(res.status, (j.error as string) || `HTTP ${res.status}`);
  return j;
}

/** DELETE /api/jobs/{id} — حذف فوري (تنظيف اختياري) */
export async function mergerDeleteJob(jobId: string): Promise<boolean> {
  try {
    const res = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 10_000);
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** GET /api/config — حدود الخدمة الحالية (تُستخدم لفحص الجهوزية) بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const res = await fetch(`${mergerBase()}/api/config`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}
