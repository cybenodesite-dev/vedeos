/** صياغات الردود العربية للأدوات — المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية. */
import type { TaskRow } from "@/lib/turso";

export function fmtImageDone(urls: string[], taskId: string): string {
  const lines = ["✅ تم توليد الصورة بنجاح", ""];
  for (const u of urls) lines.push(`![image](${u})`);
  lines.push("", ...urls.map((u) => `الرابط المباشر: ${u}`));
  lines.push("", `task_id: ${taskId}`);
  return lines.join("\n");
}

export function fmtVideoDone(urls: string[], taskId: string): string {
  const lines = ["✅ تم توليد الفيديو بنجاح", ""];
  for (const u of urls) lines.push(`الرابط المباشر: ${u}`);
  lines.push("", `task_id: ${taskId}`);
  return lines.join("\n");
}

export function fmtMergeDone(urls: string[], taskId: string): string {
  const lines = ["✅ تم دمج المقاطع بنجاح", ""];
  for (const u of urls) lines.push(`الرابط المباشر: ${u}`);
  lines.push("", `task_id: ${taskId}`);
  lines.push("", "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
  return lines.join("\n");
}

export function fmtProcessing(taskId: string): string {
  return [
    `⏳ المهمة قيد المعالجة — task_id: ${taskId}`,
    "",
    "تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.",
  ].join("\n");
}

export function fmtFailed(reason: string): string {
  return `❌ فشلت المهمة: ${reason}`;
}

export function fmtNoKeys(model: string): string {
  return `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
}

export function fmtMergeNeedsTooMany(): string {
  return "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).";
}

export function fmtMergeNeedsTwo(details?: string[]): string {
  const base = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
  if (details?.length) {
    return [base, "", "تفاصيل المعرفات:", ...details.map((d) => `- ${d}`)].join("\n");
  }
  return base;
}

export function fmtNotFound(taskId: string): string {
  return `❌ لم تُعثر على مهمة بالمعرّف: ${taskId}`;
}

const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = {
  completed: "مكتملة ✅",
  processing: "قيد المعالجة ⏳",
  pending: "منتظرة ⏳",
  failed: "فاشلة ❌",
};

/** صياغة قائمة الوسائط لـ list_media — مرتبة من الأحدث */
export function fmtMediaList(tasks: TaskRow[]): string {
  if (!tasks.length) {
    return "لا توجد وسائط مخزنة بعد — ولّد صورة أو فيديو أولًا وستظهر هنا بروابطها.";
  }
  const lines: string[] = [`📁 آخر ${tasks.length} وسيطة مخزنة (من الأحدث):`, ""];
  tasks.forEach((t, i) => {
    const urls = parseUrls(t);
    lines.push(`${i + 1}. [${TYPE_AR[t.type] ?? t.type}] ${STATUS_AR[t.status] ?? t.status} — ${t.model}`);
    lines.push(`   task_id: ${t.id}`);
    if (t.prompt) lines.push(`   الوصف: ${truncate(t.prompt, 80)}`);
    if (urls.length) {
      for (const u of urls) lines.push(`   الرابط: ${u}`);
    } else if (t.status === "failed" && t.error_message) {
      lines.push(`   السبب: ${truncate(t.error_message, 120)}`);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

function parseUrls(t: TaskRow): string[] {
  try {
    const arr = JSON.parse(t.result_urls_json || "[]") as string[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
