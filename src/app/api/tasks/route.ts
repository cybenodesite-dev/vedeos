/** GET /api/tasks — أحدث المهام + الإحصائيات (للوحة المهام في الواجهة) */
import { listRecentTasks, taskStats, type AttemptRecord, type TaskRow } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicTask(t: TaskRow) {
  let urls: string[] = [];
  try {
    urls = JSON.parse(t.result_urls_json || "[]") as string[];
  } catch {
    urls = [];
  }
  let attempts: AttemptRecord[] = [];
  try {
    attempts = JSON.parse(t.attempts_json || "[]") as AttemptRecord[];
  } catch {
    attempts = [];
  }
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    model: t.model,
    provider: t.provider,
    prompt: t.prompt?.slice(0, 160) ?? "",
    progress: Number(t.progress ?? 0),
    urls,
    error_message: t.error_message,
    attempts_count: attempts.length,
    created_at: t.created_at,
    completed_at: t.completed_at,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 20) || 20));
    const type = url.searchParams.get("type") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const [tasks, stats] = await Promise.all([
      listRecentTasks(limit, { type: type || undefined, status: status || undefined }),
      taskStats(),
    ]);
    return Response.json({ ok: true, stats, tasks: tasks.map(publicTask) });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "خطأ غير معروف" }, { status: 500 });
  }
}
