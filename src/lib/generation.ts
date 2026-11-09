/**
 * منسّق التوليد — قلب المشروع.
 *
 * القواعد الجوهرية المطبقة هنا:
 * 1) ترتيب المفاتيح تسلسلي صارم حسب الإضافة (created_at ASC, id ASC) — لا round-robin.
 * 2) عند أي خطأ مفتاح/رصيد/مؤقت: انتقال فوري للمفتاح التالي دون توقف المهمة.
 * 3) فشل منتصف المهمة برسالة تشبه مشكلات مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس
 *    task_id على المفتاح التالي — العميل يرى «قيد المعالجة» فقط ولا يعلم بالتبديل.
 * 4) مهمة فشلت على كل المفاتيح تبقى processing («بانتظار توفر مفتاح صالح…») وتُعاد
 *    محاولتها تلقائيًا مع كل get_task بتهدئة ~45 ثانية.
 * 5) نموذج الذكاء الاصطناعي لا يرى أبدًا خطأ مفتاح أو رصيد — كل الصياغات الخارجية عربية نظيفة.
 */
import { classifyProviderError, KEY_RELATED_FAILURE, ProviderError } from "@/lib/errors";
import { recordKeyAttempt } from "@/lib/keys";
import { getKey, getKeyPool, getTask, insertTask, updateTask, type ApiKeyRow, type AttemptRecord, type TaskRow, nowStamp } from "@/lib/turso";
import { sleep, safeMessage } from "@/lib/util";
import { getAdapter, type ProviderKey } from "@/lib/providers";
import { resolveModel, type ModelDef, type ProviderId } from "@/lib/models";

export type Notify = (progress: number, message: string) => void | Promise<void>;

export interface GenerationOutcome {
  taskId: string;
  status: "completed" | "processing" | "failed" | "no_keys";
  urls?: string[];
  /** رسالة عربية آمنة للعميل — لا تذكر مفاتيح أو رصيد أبدًا */
  error?: string;
}

/** هدئة قبل إعادة محاولة الإنشاء عند كل get_task بعد فشل كل المفاتيح (45 ثانية) */
const RETRY_COOLDOWN_MS = 45_000;
/** الفاصل بين استعلامات المزود أثناء نافذة الانتظار */
const POLL_INTERVAL_MS = 3_000;

function toProviderKey(k: ApiKeyRow): ProviderKey {
  return { id: k.id, provider: k.provider as ProviderId, api_key: k.api_key, label: k.label };
}

/** بناء input المزود من معطيات الأداة الأصلية (تُخزن كما هي لإعادة الإنشاء عند التبديل) */
export function buildInput(type: "image" | "video", params: Record<string, unknown>): Record<string, unknown> {
  if (type === "image") {
    const out: Record<string, unknown> = { prompt: params.prompt };
    for (const f of ["aspect_ratio", "resolution", "background", "output_format"] as const) {
      if (typeof params[f] === "string" && params[f]) out[f] = params[f];
    }
    return out;
  }
  const out: Record<string, unknown> = { prompt: params.prompt };
  for (const f of ["image_url", "aspect_ratio", "resolution", "enable_audio", "duration"] as const) {
    if (params[f] !== undefined && params[f] !== null) out[f] = params[f];
  }
  return out;
}

interface CreateOutcome {
  ok: "completed-sync" | "created" | "pool-exhausted" | "params-failed";
  urls?: string[];
  key?: ApiKeyRow;
  keyIndex?: number;
  providerTaskId?: string;
  publicError?: string;
}

function attemptRec(a: {
  provider: string;
  keyId: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
}): AttemptRecord {
  return { ...a, at: nowStamp() };
}

/**
 * تجربة مرشحي المفاتيح بالترتيب حتى نجاح الإنشاء.
 * كل محاولة (نجاح أو فشل + فئتها) تُسجَّل في attempts_json، وعدّادات المفتاح تُحدَّث دائمًا.
 */
async function tryCreateAcrossPool(opts: {
  taskId: string;
  type: "image" | "video";
  modelDef: ModelDef;
  pool: ApiKeyRow[];
  fromIndex: number;
  params: Record<string, unknown>;
}): Promise<CreateOutcome> {
  const { taskId, type, modelDef, pool, fromIndex, params } = opts;
  const input = buildInput(type, params);

  for (let i = Math.max(0, fromIndex); i < pool.length; i++) {
    const key = pool[i];
    const adapter = getAdapter(key.provider as ProviderId);
    const providerModel = modelDef.providerModel[key.provider as ProviderId];
    const pk = toProviderKey(key);

    try {
      // صور متزامنة إن دعم المزود ذلك (CometAPI تعيد الرابط فورًا)
      if (type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(pk, providerModel, input);
        await recordKeyAttempt(key, { ok: true });
        await updateTask(taskId, {
          provider: key.provider,
          key_id: key.id,
          status: "completed",
          progress: 100,
          result_urls_json: urls,
          append_attempt: attemptRec({ provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true }),
        });
        return { ok: "completed-sync", urls };
      }

      const { providerTaskId } = await adapter.createTask(pk, providerModel, input);
      await recordKeyAttempt(key, { ok: true });
      await updateTask(taskId, {
        provider: key.provider,
        key_id: key.id,
        provider_task_id: providerTaskId,
        status: "processing",
        error_message: null,
        append_attempt: attemptRec({ provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true }),
      });
      return { ok: "created", key, keyIndex: i, providerTaskId };
    } catch (err) {
      const cls = classifyProviderError(err);
      await recordKeyAttempt(key, { ok: false, error: err, errorClass: cls });
      await updateTask(taskId, {
        append_attempt: attemptRec({
          provider: key.provider,
          keyId: key.id,
          keyLabel: key.label,
          ok: false,
          errorClass: cls,
          error: safeMessage(err),
        }),
      });
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات (وليس خطأ مفتاح/رصيد فيُسمح بذكره)
        const msg = safeMessage(err);
        await updateTask(taskId, { status: "failed", error_message: `معطيات الطلب غير مقبولة: ${msg}` });
        return { ok: "params-failed", publicError: `معطيات الطلب غير مقبولة: ${msg}` };
      }
      // disabled / exhausted / provider / temporary → المفتاح التالي فورًا
      continue;
    }
  }

  // فشل الإنشاء على كل المفاتيح — المهمة تبقى processing وتُعاد مع كل get_task
  await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
  return { ok: "pool-exhausted" };
}

/** هل هذه المحاولة الأخيرة حديثة؟ (تهدئة قبل إعادة المحاولة التلقائية) */
async function lastAttemptAgeMs(task: TaskRow): Promise<number> {
  try {
    const arr = JSON.parse(task.attempts_json || "[]") as AttemptRecord[];
    const last = arr[arr.length - 1];
    if (!last?.at) return Infinity;
    return Date.now() - new Date(last.at.replace(" ", "T") + "Z").getTime();
  } catch {
    return Infinity;
  }
}

/**
 * نافذة الانتظار: استعلام كل 3 ثوانٍ + بث progress، مع التعامل الحي مع فشل منتصف المهمة
 * (إعادة إنشاء بنفس task_id على المفتاح التالي).
 */
async function waitWindow(opts: {
  taskId: string;
  type: "image" | "video";
  modelDef: ModelDef;
  key: ApiKeyRow;
  keyIndex: number;
  providerTaskId: string;
  waitSeconds: number;
  notify?: Notify;
}): Promise<GenerationOutcome> {
  const { taskId, type, modelDef, key, keyIndex, providerTaskId, waitSeconds, notify } = opts;
  const deadline = Date.now() + waitSeconds * 1000;
  let currentKey = key;
  let currentProviderTaskId = providerTaskId;
  let sentInitial = false;
  let lastProgress = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= deadline) break;

    const adapter = getAdapter(currentKey.provider as ProviderId);
    let res;
    try {
      res = await adapter.checkTask(toProviderKey(currentKey), currentProviderTaskId);
    } catch (err) {
      const cls = classifyProviderError(err);
      const msg = safeMessage(err);
      await updateTask(taskId, {
        append_attempt: attemptRec({
          provider: currentKey.provider,
          keyId: currentKey.id,
          keyLabel: currentKey.label,
          ok: false,
          errorClass: cls,
          error: msg,
        }),
      });
      await recordKeyAttempt(currentKey, { ok: false, error: err, errorClass: cls });

      if (cls === "disabled" || cls === "exhausted") {
        // المفتاح مات أثناء المتابعة → أعِد إنشاء نفس المهمة على التالي
        const recreated = await recreateOnNextKeys(taskId, type, modelDef, currentKey.id);
        if (recreated.outcome === "completed") return { taskId, status: "completed", urls: recreated.urls };
        if (recreated.outcome === "failed") return { taskId, status: "failed", error: recreated.error };
        if (recreated.outcome === "pool-exhausted") return { taskId, status: "processing" };
        currentKey = recreated.key!;
        currentProviderTaskId = recreated.providerTaskId!;
        continue;
      }
      // temporary / أخرى → استمر بالاستعلام حتى نهاية النافذة
      continue;
    }

    if (res.status === "processing") {
      // تقدم المزود + زحف تقديري لطيف (لا يتراجع التقدم أبدًا) — بعض المزودين لا يرسلون نسبة
      const providerP = res.progress ?? 0;
      lastProgress = Math.max(lastProgress + 4, providerP);
      const p = Math.max(1, Math.min(95, lastProgress));
      await updateTask(taskId, {
        progress: p,
        provider: currentKey.provider,
        key_id: currentKey.id,
        provider_task_id: currentProviderTaskId,
      });
      if (!sentInitial) {
        sentInitial = true;
        await notify?.(p, "بدأ التوليد — المهمة قيد المعالجة");
      }
      await notify?.(p, `قيد التوليد… ${p}%`);
      continue;
    }

    if (res.status === "completed") {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: res.urls });
      await notify?.(100, "اكتمل التوليد");
      return { taskId, status: "completed", urls: res.urls };
    }

    // res.status === "failed" — المزود أعلن الفشل برسالة
    const failMsg = res.error ?? "فشل غير معروف لدى المزود";
    await updateTask(taskId, {
      append_attempt: attemptRec({
        provider: currentKey.provider,
        keyId: currentKey.id,
        keyLabel: currentKey.label,
        ok: false,
        errorClass: KEY_RELATED_FAILURE.test(failMsg) ? "exhausted" : "provider",
        error: failMsg,
      }),
    });
    await recordKeyAttempt(currentKey, {
      ok: false,
      error: new ProviderError(KEY_RELATED_FAILURE.test(failMsg) ? 402 : 500, failMsg),
    });

    if (KEY_RELATED_FAILURE.test(failMsg)) {
      // 4.3.2: رسالة تشبه مشكلات مفتاح/رصيد → إعادة إنشاء بنفس task_id على المفتاح التالي
      const recreated = await recreateOnNextKeys(taskId, type, modelDef, currentKey.id);
      if (recreated.outcome === "completed") return { taskId, status: "completed", urls: recreated.urls };
      if (recreated.outcome === "failed") return { taskId, status: "failed", error: recreated.error };
      if (recreated.outcome === "pool-exhausted") return { taskId, status: "processing" };
      currentKey = recreated.key!;
      currentProviderTaskId = recreated.providerTaskId!;
      continue;
    }

    // فشل حقيقي (انتهاك سياسة/معطيات/غيره) → فشل نهائي، والسبب آمن للعرض (ليس مفتاحًا/رصيدًا)
    await updateTask(taskId, { status: "failed", error_message: failMsg });
    return { taskId, status: "failed", error: failMsg };
  }

  // انتهت النافذة والنتيجة لم تظهر — تبقى processing والعميل يتابع بـ get_task
  return { taskId, status: "processing" };
}

/** إعادة إنشاء نفس المهمة (نفس task_id) على المفتاح التالي في البركة */
async function recreateOnNextKeys(
  taskId: string,
  type: "image" | "video",
  modelDef: ModelDef,
  failedKeyId: string
): Promise<
  | { outcome: "completed"; urls: string[] }
  | { outcome: "failed"; error: string }
  | { outcome: "pool-exhausted" }
  | { outcome: "created"; key: ApiKeyRow; keyIndex: number; providerTaskId: string }
> {
  const task = await getTask(taskId);
  const pool = await getKeyPool(modelDef.providers);
  // ابدأ بعد المفتاح الذي فشل (إن وجد في البركة الحالية — قد يكون حُذف يدويًا فلا يوجد)
  const idx = pool.findIndex((k) => k.id === failedKeyId);
  const creation = await tryCreateAcrossPool({
    taskId,
    type,
    modelDef,
    pool,
    fromIndex: idx >= 0 ? idx + 1 : 0,
    params: safeParseParams(task?.params_json),
  });
  switch (creation.ok) {
    case "completed-sync":
      return { outcome: "completed", urls: creation.urls! };
    case "created":
      return {
        outcome: "created",
        key: creation.key!,
        keyIndex: creation.keyIndex!,
        providerTaskId: creation.providerTaskId!,
      };
    case "params-failed":
      return { outcome: "failed", error: creation.publicError! };
    case "pool-exhausted":
      return { outcome: "pool-exhausted" };
  }
}

function safeParseParams(json: string | undefined | null): Record<string, unknown> {
  try {
    return JSON.parse(json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* runGeneration — التدفق الكامل لأداة generate_image / generate_video  */
/* ------------------------------------------------------------------ */

export async function runGeneration(opts: {
  type: "image" | "video";
  modelName: string;
  params: Record<string, unknown>;
  waitSeconds: number;
  notify?: Notify;
}): Promise<GenerationOutcome> {
  const modelDef = resolveModel(opts.modelName);
  if (!modelDef || modelDef.type !== opts.type) {
    return {
      taskId: "",
      status: "failed",
      error: `موديل غير معروف: ${opts.modelName}`,
    };
  }

  // 1) بركة المفاتيح بالترتيب التسلسلي الصارم — فارغة → رد no_keys قبل أي شيء
  const pool = await getKeyPool(modelDef.providers);
  if (!pool.length) {
    return {
      taskId: "",
      status: "no_keys",
      error: `❌ لا توجد مفاتيح نشطة لخدمة ${modelDef.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    };
  }

  // 2) سجّل المهمة في Turso قبل أي نداء خارجي — حتى لو انقطع الاتصال تبقى قابلة للتتبع
  const taskId = crypto.randomUUID();
  const storedParams = { ...opts.params, _waitSeconds: opts.waitSeconds };
  await insertTask({
    id: taskId,
    model: modelDef.canonical,
    type: opts.type,
    prompt: typeof opts.params.prompt === "string" ? opts.params.prompt : "",
    params_json: JSON.stringify(storedParams),
    status: "processing",
    progress: 0,
  });

  // 3) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  const creation = await tryCreateAcrossPool({
    taskId,
    type: opts.type,
    modelDef,
    pool,
    fromIndex: 0,
    params: opts.params,
  });

  if (creation.ok === "params-failed") {
    return { taskId, status: "failed", error: creation.publicError };
  }
  if (creation.ok === "completed-sync") {
    return { taskId, status: "completed", urls: creation.urls };
  }
  if (creation.ok === "pool-exhausted") {
    // تبقى processing — «بانتظار توفر مفتاح صالح…» داخليًا فقط، والعميل يرى المهمة قيد المعالجة
    return { taskId, status: "processing" };
  }

  // 4) نافذة الانتظار مع بث التقدم والتعامل الحي مع الفشل
  return waitWindow({
    taskId,
    type: opts.type,
    modelDef,
    key: creation.key!,
    keyIndex: creation.keyIndex!,
    providerTaskId: creation.providerTaskId!,
    waitSeconds: opts.waitSeconds,
    notify: opts.notify,
  });
}

/* ------------------------------------------------------------------ */
/* refreshTask — متابعة مهمة قائمة (get_task) مع نفس منطق التبديل       */
/* ------------------------------------------------------------------ */

/** منع تزامن refresh لنفس المهمة (نداءات get_task المتقاربة) */
const refreshing = new Set<string>();

export async function refreshTask(taskId: string, notify?: Notify): Promise<TaskRow | null> {
  let task = await getTask(taskId);
  if (!task) return null;
  if (task.status !== "processing" && task.status !== "pending") return task;
  if (refreshing.has(taskId)) return task; // نسخة قيد التحديث — أعد الحالة الحالية
  refreshing.add(taskId);
  try {
    const fresh = await getTask(taskId);
    if (!fresh) return task;
    task = fresh;
    if (task.status !== "processing" && task.status !== "pending") return task;

    // مهام الدمج لها مسار خاص
    if (task.provider === "merger") {
      const { refreshMergeTask } = await import("@/lib/merge");
      return refreshMergeTask(task, notify);
    }

    const modelDef = resolveModel(task.model);
    if (!modelDef) {
      await updateTask(taskId, { status: "failed", error_message: `موديل غير معروف: ${task.model}` });
      return getTask(taskId);
    }

    if (!task.provider_task_id) {
      // الإنشاء لم ينجح على أي مفتاح بعد — أعد المحاولة مع كل get_task (بتهدئة 45 ثانية)
      const age = await lastAttemptAgeMs(task);
      if (age < RETRY_COOLDOWN_MS) return task;
      const pool = await getKeyPool(modelDef.providers);
      if (!pool.length) return task;
      const params = safeParseParams(task.params_json);
      const creation = await tryCreateAcrossPool({
        taskId,
        type: task.type as "image" | "video",
        modelDef,
        pool,
        fromIndex: 0,
        params,
      });
      if (creation.ok === "completed-sync") return getTask(taskId);
      if (creation.ok === "created") {
        // أنشئت الآن — ابدأ نافذة متابعة قصيرة داخل get_task نفسها
        const waitSec = Math.min(60, typeof params._waitSeconds === "number" ? params._waitSeconds : 30);
        await waitWindow({
          taskId,
          type: task.type as "image" | "video",
          modelDef,
          key: creation.key!,
          keyIndex: creation.keyIndex!,
          providerTaskId: creation.providerTaskId!,
          waitSeconds: waitSec,
          notify,
        });
        return getTask(taskId);
      }
      return getTask(taskId); // pool-exhausted → تبقى processing
    }

    // مهمة عند المزود — حدّثها حية
    const task_ = task;
    const keyRow = task_.key_id ? await getKey(task_.key_id) : null;
    if (!keyRow) {
      // المفتاح حُذف يدويًا — أعد الإنشاء على المفاتيح المتاحة (findIndex سيجده غير موجود → من البداية)
      await recreateOnNextKeys(taskId, task_.type as "image" | "video", modelDef, task_.key_id ?? "");
      return getTask(taskId);
    }

    const adapter = getAdapter(keyRow.provider as ProviderId);
    let res;
    try {
      res = await adapter.checkTask(toProviderKey(keyRow), task_.provider_task_id!);
    } catch (err) {
      const cls = classifyProviderError(err);
      await recordKeyAttempt(keyRow, { ok: false, error: err, errorClass: cls });
      await updateTask(taskId, {
        append_attempt: attemptRec({
          provider: keyRow.provider,
          keyId: keyRow.id,
          keyLabel: keyRow.label,
          ok: false,
          errorClass: cls,
          error: safeMessage(err),
        }),
      });
      if (cls === "disabled" || cls === "exhausted") {
        await recreateOnNextKeys(taskId, task_.type as "image" | "video", modelDef, keyRow.id);
      }
      return getTask(taskId); // processing في كل الحالات — العميل يبقى يتابع
    }

    if (res.status === "processing") {
      const p = Math.max(1, Math.min(99, res.progress ?? 30));
      await updateTask(taskId, { progress: p });
      await notify?.(p, `قيد التوليد… ${p}%`);
      return getTask(taskId);
    }
    if (res.status === "completed") {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: res.urls });
      await notify?.(100, "اكتمل التوليد");
      return getTask(taskId);
    }

    // فشل معلن من المزود
    const failMsg = res.error ?? "فشل غير معروف لدى المزود";
    await updateTask(taskId, {
      append_attempt: attemptRec({
        provider: keyRow.provider,
        keyId: keyRow.id,
        keyLabel: keyRow.label,
        ok: false,
        errorClass: KEY_RELATED_FAILURE.test(failMsg) ? "exhausted" : "provider",
        error: failMsg,
      }),
    });
    await recordKeyAttempt(keyRow, {
      ok: false,
      error: new ProviderError(KEY_RELATED_FAILURE.test(failMsg) ? 402 : 500, failMsg),
    });
    if (KEY_RELATED_FAILURE.test(failMsg)) {
      await recreateOnNextKeys(taskId, task_.type as "image" | "video", modelDef, keyRow.id);
      return getTask(taskId);
    }
    await updateTask(taskId, { status: "failed", error_message: failMsg });
    return getTask(taskId);
  } finally {
    refreshing.delete(taskId);
  }
}
