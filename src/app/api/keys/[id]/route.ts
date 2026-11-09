/**
 * PATCH  /api/keys/{id} — تعطيل/تنشيط يدوي {action: "disable" | "enable"} أو {status}
 * DELETE /api/keys/{id} — حذف
 */
import { deleteKey, getKey, patchKey } from "@/lib/turso";
import { maskedKeyRow } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const body = (await request.json()) as { action?: string; status?: string; label?: string };
    const key = await getKey(id);
    if (!key) return Response.json({ ok: false, error: "المفتاح غير موجود" }, { status: 404 });

    const action = (body.action ?? "").toLowerCase();
    const status = (body.status ?? "").toLowerCase();
    if (action === "disable" || status === "disabled") {
      await patchKey(id, { status: "disabled" });
    } else if (action === "enable" || status === "active") {
      // التنشيط اليدوي يعيد المفتاح إلى البركة بحالة active (يمسح آخر خطأ)
      await patchKey(id, { status: "active", last_error: null });
    } else if (body.label !== undefined) {
      await patchKey(id, { label: String(body.label).slice(0, 100) });
    } else {
      return Response.json({ ok: false, error: "action يجب أن يكون disable أو enable" }, { status: 400 });
    }
    const updated = await getKey(id);
    return Response.json({ ok: true, key: updated ? maskedKeyRow(updated) : null });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "خطأ غير معروف" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const key = await getKey(id);
    if (!key) return Response.json({ ok: false, error: "المفتاح غير موجود" }, { status: 404 });
    await deleteKey(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "خطأ غير معروف" }, { status: 500 });
  }
}
