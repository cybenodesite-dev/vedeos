/**
 * تدفق دمج الفيديو — Video Merger API v2.
 *
 * القواعد الحتمية هنا:
 * - ≥2 مقاطع و≤10 وكلها http/https مباشرة وعامة، وإلا رفض فوري برسالة عربية.
 * - مهمة الدمج تُسجَّل في Turso أولًا (type=merge, provider=merger, model=video-merger).
 * - POST /api/jobs ثم POST .../process خلفيًا وبمرة واحدة فقط (قفل في الذاكرة).
 * - أي خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة.
 * - أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة.
 * - get_task لمهمة دمج: إن ردت الخدمة 404 → فشل نهائي (حُذفت أو انتهت صلاحيتها بعد 24 ساعة).
 */
import {
  analyzeMergerStatus,
  mergerBase,
  mergerCreateJob,
  mergerConfigured,
  mergerGetJob,
  mergerProcessJob,
  mergerResultUrl,
} from "@/lib/merger";
import { classifyProviderError } from "@/lib/errors";
import { getTask, insertTask, updateTask, type TaskRow, nowStamp } from "@/lib/turso";
import { sleep, safeMessage } from "@/lib/util";
import type { Notify } from "@/lib/generation";

const POLL_INTERVAL_MS = 3_000;
const RETRY_COOLDOWN_MS = 45_000;

/** قفل في الذاكرة: مهمة process واحدة فقط لكل jobId حتى لا يتزامن مع get_task */
const processInFlight = new Set<string>();
/** منع تزامن refresh لمهام الدمج */
const refreshingMerges = new Set<string>();

function isPublicHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const h = parsed.hostname.toLowerCase();
    // رفض عناوين داخلية/محلية — لا نطاقات غير عامة في النتيجة
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^0\./.test(h)) return false;
    if (h === "::1" || h === "[::1]") return false;
    return true;
  } catch {
    return false;
  }
}

export interface MergeOutcome {
  taskId: string;
  status: "completed" | "processing" | "failed";
  urls?: string[];
  error?: string;
}

/** التحقق الصارم من المدخلات + حل روابط task_ids (أولًا) ثم urls المباشرة بنفس ترتيبها */
export async function resolveMergeInputs(args: {
  urls?: string[];
  task_ids?: string[];
}): Promise<{ ok: true; videos: string[] } | { ok: false; error: string; details?: string[] }> {
  const details: string[] = [];
  const resolved: string[] = [];

  // روابط task_ids أولًا — تُحل من قاعدة البيانات بالترتيب
  for (const tid of args.task_ids ?? []) {
    const t = await getTask(tid.trim());
    if (!t) {
      details.push(`${tid}: المهمة غير موجودة في قاعدة البيانات`);
      continue;
    }
    if (t.status !== "completed") {
      details.push(`${tid}: المهمة غير مكتملة (${t.status}) — أكمل التوليد أولًا`);
      continue;
    }
    let urls: string[] = [];
    try {
      urls = JSON.parse(t.result_urls_json || "[]") as string[];
    } catch {
      urls = [];
    }
    const url = urls.find((u) => typeof u === "string" && u.startsWith("http"));
    if (!url) {
      details.push(`${tid}: المهمة مكتملة لكن بلا رابط فيديو صالح`);
      continue;
    }
    resolved.push(url);
  }

  for (const u of args.urls ?? []) resolved.push(u.trim());

  // تحقق صارم بعد الجمع
  const invalid = resolved.filter((u) => !isPublicHttpUrl(u));
  if (resolved.length < 2) {
    // التفاصيل تعرض فقط المعرفات التي عجزت فعلًا عن الحل
    return { ok: false, error: "__NEEDS_TWO__", details };
  }
  if (resolved.length > 10) {
    return { ok: false, error: "__TOO_MANY__" };
  }
  if (invalid.length) {
    return {
      ok: false,
      error: `❌ روابط غير صالحة (يجب أن تكون http/https مباشرة وعامة):\n${invalid.map((u) => `- ${u}`).join("\n")}`,
    };
  }
  if (details.length) {
    return { ok: false, error: "__NEEDS_TWO_WITH_DETAILS__:" + details.join(" | ") };
  }
  return { ok: true, videos: resolved };
}

/** runMerge — التدفق الكامل لأداة merge_videos */
export async function runMerge(opts: {
  urls?: string[];
  task_ids?: string[];
  waitSeconds: number;
  notify?: Notify;
}): Promise<MergeOutcome> {
  // 1) تحقق صارم قبل أي تسجيل
  const inputs = await resolveMergeInputs(opts);
  if (!inputs.ok) {
    const BASE_MSG = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    let err = inputs.error;
    if (err === "__NEEDS_TWO__") {
      const details = inputs.details ?? [];
      err = details.length
        ? `${BASE_MSG}\n\nتفاصيل كل معرّف فاشل:\n${details.map((d) => `- ${d}`).join("\n")}`
        : BASE_MSG;
    } else if (err === "__TOO_MANY__") {
      err = "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).";
    } else if (err.startsWith("__NEEDS_TWO_WITH_DETAILS__:")) {
      const details = err.slice("__NEEDS_TWO_WITH_DETAILS__:".length).split(" | ");
      err = `${BASE_MSG}\n\nتفاصيل كل معرّف فاشل:\n${details.map((d) => `- ${d}`).join("\n")}`;
    }
    return { taskId: "", status: "failed", error: err };
  }

  // 2) خدمة الدمج مهيأة؟
  if (!mergerConfigured()) {
    return {
      taskId: "",
      status: "failed",
      error: "❌ خدمة الدمج غير مهيأة — اضبط MERGER_API_BASE في متغيرات البيئة ثم أعد المحاولة.",
    };
  }

  // 3) سجّل المهمة في Turso أولًا
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `${inputs.videos.length} مقاطع`,
    params_json: JSON.stringify({ videos: inputs.videos, _waitSeconds: opts.waitSeconds }),
    status: "processing",
    progress: 0,
  });

  // 4) POST /api/jobs
  let jobId: string;
  try {
    const created = await mergerCreateJob(inputs.videos);
    jobId = created.jobId;
    await updateTask(taskId, { provider_task_id: jobId, status: "processing" });
  } catch (err) {
    const cls = classifyProviderError(err);
    const msg = safeMessage(err);
    await updateTask(taskId, {
      append_attempt: { provider: "merger", keyId: "-", ok: false, errorClass: cls, error: msg, at: nowStamp() },
    });
    if (cls === "temporary") {
      // خطأ شبكتنا نحن — تبقى processing وتُعاد المحاولة مع get_task
      return { taskId, status: "processing" };
    }
    // خطأ HTTP معلن من الخدمة = فشل نهائي فوري
    await updateTask(taskId, { status: "failed", error_message: `فشل إنشاء مهمة الدمج: ${msg}` });
    return { taskId, status: "failed", error: `فشل إنشاء مهمة الدمج: ${msg}` };
  }

  // 5) أطلق process خلفيًا وبمرة واحدة فقط
  launchProcessOnce(jobId);

  // 6) نافذة الانتظار مع بث التقدم
  const deadline = Date.now() + opts.waitSeconds * 1000;
  let lastProgress = 5;
  await opts.notify?.(lastProgress, "أُرسلت المقاطع لخدمة الدمج — قيد الدمج…");

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= deadline) break;
    try {
      const raw = await mergerGetJob(jobId);
      const st = analyzeMergerStatus(raw);
      if (st.status === "completed") {
        const url = mergerResultUrl(mergerBase(), jobId, st.videoUrl, st.downloadUrl);
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          result_urls_json: [url],
          provider_task_id: jobId,
        });
        await opts.notify?.(100, "اكتمل الدمج");
        return { taskId, status: "completed", urls: [url] };
      }
      if (st.status === "failed") {
        // خطأ معلن من الخدمة = فشل نهائي (مثل مصدر يرفض التحميل — التكرار يعطي النتيجة نفسها)
        await updateTask(taskId, {
          status: "failed",
          error_message: st.error ?? "فشل الدمج لدى الخدمة",
          append_attempt: { provider: "merger", keyId: "-", ok: false, errorClass: "provider", error: st.error ?? "", at: nowStamp() },
        });
        return { taskId, status: "failed", error: st.error ?? "فشل الدمج لدى الخدمة" };
      }
      const p = Math.max(1, Math.min(99, st.progress || lastProgress));
      lastProgress = p;
      await updateTask(taskId, { progress: p, provider_task_id: jobId });
      await opts.notify?.(p, `قيد الدمج… ${p}%`);
    } catch (err) {
      const cls = classifyProviderError(err);
      if (cls !== "temporary") {
        // 404 أو خطأ معلن → فشل نهائي فوري
        const msg = safeMessage(err);
        await updateTask(taskId, {
          status: "failed",
          error_message: msg,
          append_attempt: { provider: "merger", keyId: "-", ok: false, errorClass: cls, error: msg, at: nowStamp() },
        });
        return { taskId, status: "failed", error: msg };
      }
      // خطأ شبكتنا → استمر بالاستعلام حتى انتهاء النافذة
      continue;
    }
  }

  return { taskId, status: "processing" };
}

/** ينفذ POST /api/jobs/{id}/process مرة واحدة فقط لكل jobId (قفل في الذاكرة) */
export function launchProcessOnce(jobId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      const res = await mergerProcessJob(jobId);
      const st = analyzeMergerStatus(res);
      // نتيجة process تُكتب فورًا — لكن نترك حلقة الاستعلام هي من تُنهي المهمة رسميًا
      if (st.status === "failed") {
        // الخطأ المعلن (مثل Download failed (HTTP 403)) يُسجل — سترصده حلقة get_task/النافذة
        await markProcessError(jobId, st.error ?? "فشل process");
      }
    } catch (err) {
      const cls = classifyProviderError(err);
      if (cls !== "temporary") {
        await markProcessError(jobId, safeMessage(err));
      }
      // مؤقت: حلقة الاستعلام ستصطف على الحالة لاحقًا
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

async function markProcessError(jobId: string, error: string): Promise<void> {
  // ابحث عن المهمة المرتبطة بهذا jobId وسجل الخطأ (فشل نهائي)
  const { listRecentTasks } = await import("@/lib/turso");
  const recent = await listRecentTasks(50, { type: "merge" });
  const task = recent.find((t) => t.provider_task_id === jobId && t.status === "processing");
  if (task) {
    await updateTask(task.id, {
      status: "failed",
      error_message: error,
      append_attempt: { provider: "merger", keyId: "-", ok: false, errorClass: "provider", error, at: nowStamp() },
    });
  }
}

/** refreshMergeTask — متابعة مهمة دمج قائمة عبر GET /api/jobs/{id} */
export async function refreshMergeTask(task: TaskRow, notify?: Notify): Promise<TaskRow | null> {
  const taskId = task.id;
  if (refreshingMerges.has(taskId)) return task;
  refreshingMerges.add(taskId);
  try {
    task = (await getTask(taskId)) ?? task;
    if (task.status !== "processing" && task.status !== "pending") return task;

    if (!mergerConfigured()) return task;

    if (!task.provider_task_id) {
      // الإنشاء فشل شبكيًا — أعد المحاولة بتهدئة 45 ثانية
      const params = safeParse(task.params_json);
      const age = lastAttemptAge(task);
      if (age < RETRY_COOLDOWN_MS) return task;
      const videos = Array.isArray(params.videos) ? (params.videos as string[]) : [];
      if (videos.length < 2) {
        await updateTask(taskId, { status: "failed", error_message: "مقاطع الدمج المحفوظة غير كافية" });
        return getTask(taskId);
      }
      try {
        const created = await mergerCreateJob(videos);
        await updateTask(taskId, { provider_task_id: created.jobId });
        launchProcessOnce(created.jobId);
      } catch (err) {
        const cls = classifyProviderError(err);
        if (cls !== "temporary") {
          const msg = safeMessage(err);
          await updateTask(taskId, { status: "failed", error_message: `فشل إنشاء مهمة الدمج: ${msg}` });
        }
      }
      return getTask(taskId);
    }

    const jobId = task.provider_task_id!;
    try {
      const raw = await mergerGetJob(jobId);
      const st = analyzeMergerStatus(raw);
      if (st.status === "completed") {
        const url = mergerResultUrl(mergerBase(), jobId, st.videoUrl, st.downloadUrl);
        await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: [url] });
        await notify?.(100, "اكتمل الدمج");
        return getTask(taskId);
      }
      if (st.status === "failed") {
        await updateTask(taskId, {
          status: "failed",
          error_message: st.error ?? "فشل الدمج لدى الخدمة",
        });
        return getTask(taskId);
      }
      const p = Math.max(1, Math.min(99, st.progress || Math.round((task.progress || 5))));
      await updateTask(taskId, { progress: p });
      await notify?.(p, `قيد الدمج… ${p}%`);
      // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (مرة واحدة)
      launchProcessOnce(jobId);
      return getTask(taskId);
    } catch (err) {
      const cls = classifyProviderError(err);
      if (cls === "temporary") return getTask(taskId);
      // 404 → فشل نهائي: «مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)»
      const msg = safeMessage(err);
      await updateTask(taskId, {
        status: "failed",
        error_message: msg.includes("24 ساعة") ? msg : `فشل متابعة مهمة الدمج: ${msg}`,
      });
      return getTask(taskId);
    }
  } finally {
    refreshingMerges.delete(taskId);
  }
}

function safeParse(json: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function lastAttemptAge(task: TaskRow): number {
  try {
    const arr = JSON.parse(task.attempts_json || "[]") as Array<{ at: string }>;
    const last = arr[arr.length - 1];
    if (!last?.at) return Infinity;
    return Date.now() - new Date(last.at.replace(" ", "T") + "Z").getTime();
  } catch {
    return Infinity;
  }
}
