/**
 * محوّل kie.ai — المزود الأساسي عبر Jobs API الموحد.
 *
 * POST https://api.kie.ai/api/v1/jobs/createTask
 *   Authorization: Bearer <key>
 *   {"model": "<providerModel>", "input": {...}}
 *   → {"code":200,"data":{"taskId":"..."}}
 *
 * GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id>
 *   → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
 *        "resultJson":"{\"resultUrls\":[\"https://...\"]}",  // نص JSON داخل JSON
 *        "failMsg":"..."}}
 *
 * ملاحظة مقاسة فعليًا: kie قد يرد بـ HTTP 200 مع code داخل الجسم ≠ 200 (مثل 401) —
 * لذا نعتمد code من الجسم إن وُجد، وإلا فحالة HTTP.
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

const BASE = "https://api.kie.ai";

/** استخراج رسالة الخطأ من استجابة kie بأشكالها المتعددة */
function kieError(res: Response, json: unknown): ProviderError {
  const j = json as { code?: number; msg?: string; message?: string; error?: string };
  const code = typeof j?.code === "number" ? j.code : res.status;
  const msg = j?.msg || j?.message || j?.error || `kie.ai HTTP ${res.status}`;
  return new ProviderError(code, msg);
}

async function postCreate(key: ProviderKey, body: unknown): Promise<unknown> {
  const res = await fetchWithTimeout(
    `${BASE}/api/v1/jobs/createTask`,
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
    throw new ProviderError(res.status || 502, `kie.ai: استجابة غير قابلة للتحليل (HTTP ${res.status})`);
  }
  const j = json as { code?: number; data?: { taskId?: string } };
  const code = typeof j?.code === "number" ? j.code : res.status;
  if (code !== 200 || !j?.data?.taskId) throw kieError(res, json);
  return json;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: ProviderKey, providerModel: string, input: Record<string, unknown>): Promise<CreateTaskResult> {
    const json = (await postCreate(key, { model: providerModel, input })) as {
      data: { taskId: string };
    };
    return { providerTaskId: json.data.taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult> {
    const res = await fetchWithTimeout(
      `${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      {
        headers: {
          // recordInfo يتطلب Authorization أيضًا (مقاس فعليًا: بلا ترويسة → 401)
          Authorization: `Bearer ${key.api_key}`,
          Accept: "application/json",
        },
      },
      CHECK_TIMEOUT_MS
    );
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError(res.status || 502, `kie.ai: استجابة غير قابلة للتحليل (HTTP ${res.status})`);
    }
    const j = json as {
      code?: number;
      data?: { state?: string; resultJson?: string; failMsg?: string; progress?: number };
    };
    const code = typeof j?.code === "number" ? j.code : res.status;
    if (code !== 200) throw kieError(res, json);

    const d = j.data ?? {};
    const state = d.state ?? "waiting";
    // تقدير تقدم مبني على الحالة (kie لا يرسل نسبة موثوقة دائمًا)
    const stateProgress: Record<string, number> = { waiting: 5, queuing: 20, generating: 65, success: 100 };
    const progress = typeof d.progress === "number" && d.progress > 0 ? Math.min(100, d.progress) : stateProgress[state] ?? 30;

    if (state === "success") {
      // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانيًا (لا تخترع حقولًا)
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(d.resultJson ?? "{}") as { resultUrls?: string[] };
        urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls.filter((u) => typeof u === "string") : [];
      } catch {
        urls = [];
      }
      if (!urls.length) {
        throw new ProviderError(502, "kie.ai: اكتملت المهمة لكن resultJson بلا روابط — الشكل تغيّر، راجع docs.kie.ai");
      }
      return { status: "completed", urls, progress: 100 };
    }

    if (state === "fail") {
      // المزود أعلن الفشل — نعيده كحالة (لا كاستثناء) لتمييزه عن أخطاء شبكتنا،
      // والتصنيف اللاحق على نص الرسالة يقرر: مفتاح/رصيد → إعادة إنشاء، غير ذلك → فشل نهائي
      return { status: "failed", error: d.failMsg || "kie.ai: فشلت المهمة لدى المزود" };
    }

    return { status: "processing", progress };
  },
};
