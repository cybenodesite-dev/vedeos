/**
 * محوّل CometAPI (api.cometapi.com) — بوابة متوافقة مع OpenAI.
 *
 * الصور (متزامنة — تعيد النتيجة فورًا):
 *   POST https://api.cometapi.com/v1/images/generations
 *   {"model":"gpt-image-2.6-flare-text-to-image","prompt":"...","n":1}
 *   → OpenAI-style {"data":[{"url"|"b64_json"}]}
 *
 * الفيديو (غير متزامن بنمط create/check):
 *   POST https://api.cometapi.com/v1/videos  {"model":"...","prompt":"...","seconds":8}
 *   → {"id"/"task_id","status":"queued","progress":0}
 *   GET  https://api.cometapi.com/v1/videos/{id}
 *   → {"status":"queued|in_progress|completed|failed|error","progress":0..100,"video_url":"..." (عند الاكتمال)}
 *
 * ملاحظة: input_reference للصورة المرجعية (image-to-video) — التوثيق يذكره كصورة مرجعية
 * دون تحديد شكل دقيق؛ نمرر الرابط نصًا. إن رفضه المزود فسيُصنَّف خطأ المعطيات ويُتوقف
 * بدل إهدار بقية المفاتيح على طلب غير صالح.
 */
import { ProviderError } from "@/lib/errors";
import type { CheckTaskResult } from "@/lib/providers/types";
import {
  CHECK_TIMEOUT_MS,
  CREATE_TIMEOUT_MS,
  fetchWithTimeout,
  type CreateTaskResult,
  type ProviderAdapter,
  type ProviderKey,
} from "@/lib/providers/types";

const BASE = "https://api.cometapi.com";

/** استخراج رسالة خطأ بأسلوب OpenAI أو نصًا خامًا */
function cometError(res: Response, json: unknown): ProviderError {
  const j = json as { error?: { message?: string; code?: string }; message?: string; msg?: string };
  const msg = j?.error?.message || j?.message || j?.msg || `CometAPI HTTP ${res.status}`;
  return new ProviderError(res.status, msg);
}

function normalizeProgress(p: unknown): number | undefined {
  const n = typeof p === "string" ? Number(p) : (p as number);
  if (typeof n !== "number" || Number.isNaN(n)) return undefined;
  // قد يرد التقدم كسرًا 0..1 → اضربه في 100 (دفاعيًا)
  if (n > 0 && n <= 1) return Math.round(n * 100);
  return Math.max(0, Math.min(100, Math.round(n)));
}

export const cometapiAdapter: ProviderAdapter = {
  async createImageSync(
    key: ProviderKey,
    providerModel: string,
    input: Record<string, unknown>
  ): Promise<{ urls: string[] }> {
    const body: Record<string, unknown> = { model: providerModel, prompt: input.prompt, n: 1 };
    // الخلفية الشفافة تُطبق عند 1K فقط حسب المواصفة
    if (typeof input.background === "string" && input.background !== "auto") {
      body.background = input.background;
    }
    if (typeof input.output_format === "string") {
      body.output_format = input.output_format;
    }
    const res = await fetchWithTimeout(
      `${BASE}/v1/images/generations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.api_key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      CREATE_TIMEOUT_MS
    );
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError(res.status || 502, `CometAPI: استجابة غير قابلة للتحليل (HTTP ${res.status})`);
    }
    if (!res.ok) throw cometError(res, json);
    const data = (json as { data?: Array<{ url?: string; b64_json?: string }> }).data ?? [];
    const urls: string[] = [];
    for (const item of data) {
      if (item?.url) {
        urls.push(item.url);
      } else if (item?.b64_json) {
        // نتيجة base64 نحولها إلى data URI — لا ننزّل أي ملف على السيرفر
        urls.push(`data:image/png;base64,${item.b64_json}`);
      }
    }
    if (!urls.length) throw new ProviderError(502, "CometAPI: لا روابط في استجابة الصور");
    return { urls };
  },

  async createTask(
    key: ProviderKey,
    providerModel: string,
    input: Record<string, unknown>
  ): Promise<CreateTaskResult> {
    const body: Record<string, unknown> = {
      model: providerModel,
      prompt: input.prompt,
      seconds: typeof input.duration === "number" ? input.duration : 8,
    };
    if (typeof input.image_url === "string" && input.image_url) {
      body.input_reference = input.image_url; // image-to-video اختياري
    }
    const res = await fetchWithTimeout(
      `${BASE}/v1/videos`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.api_key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      CREATE_TIMEOUT_MS
    );
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError(res.status || 502, `CometAPI: استجابة غير قابلة للتحليل (HTTP ${res.status})`);
    }
    if (!res.ok) throw cometError(res, json);
    const j = json as { id?: string; task_id?: string; data?: { task_id?: string } };
    const id = j.task_id || j.id || j.data?.task_id;
    if (!id) throw new ProviderError(502, "CometAPI: لا معرّف مهمة في استجابة الإنشاء");
    return { providerTaskId: id };
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult> {
    const res = await fetchWithTimeout(
      `${BASE}/v1/videos/${encodeURIComponent(providerTaskId)}`,
      { headers: { Authorization: `Bearer ${key.api_key}`, Accept: "application/json" } },
      CHECK_TIMEOUT_MS
    );
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError(res.status || 502, `CometAPI: استجابة غير قابلة للتحليل (HTTP ${res.status})`);
    }
    if (!res.ok) throw cometError(res, json);
    const j = json as {
      status?: string;
      progress?: unknown;
      video_url?: string;
      url?: string;
      error?: { message?: string } | string;
    };
    const status = (j.status ?? "in_progress").toLowerCase();
    const progress = normalizeProgress(j.progress);

    if (status === "completed" || status === "succeeded" || status === "success") {
      const url = j.video_url || j.url;
      if (!url) throw new ProviderError(502, "CometAPI: اكتملت المهمة لكن لا رابط فيديو");
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (status === "failed" || status === "error" || status === "cancelled") {
      // المزود أعلن الفشل — نعيده كحالة لتمييزه عن أخطاء شبكتنا
      const msg = typeof j.error === "string" ? j.error : j.error?.message || `CometAPI: فشلت المهمة (${status})`;
      return { status: "failed", error: msg };
    }
    return { status: "processing", progress: progress ?? 30 };
  },
};
