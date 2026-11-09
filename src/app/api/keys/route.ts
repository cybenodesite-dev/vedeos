/**
 * GET  /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey)
 * POST /api/keys — إضافة مفتاح {provider, api_key, label?} مع رفض التكرار لنفس المزود
 */
import { findDuplicateKey, insertKey, listKeys } from "@/lib/turso";
import { maskedKeyRow } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const rows = await listKeys();
    return Response.json({ ok: true, keys: rows.map(maskedKeyRow) });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "خطأ غير معروف" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = (body.provider ?? "").trim().toLowerCase();
    const apiKey = (body.api_key ?? "").trim();
    const label = (body.label ?? "").trim().slice(0, 100);

    if (provider !== "kie" && provider !== "cometapi") {
      return Response.json({ ok: false, error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey || apiKey.length < 8) {
      return Response.json({ ok: false, error: "المفتاح مطلوب (8 أحرف على الأقل)" }, { status: 400 });
    }

    // رفض التكرار لنفس المزود
    const dup = await findDuplicateKey(provider, apiKey);
    if (dup) {
      return Response.json(
        { ok: false, error: `هذا المفتاح مضاف مسبقًا لنفس المزود (${provider})` },
        { status: 409 }
      );
    }

    const id = crypto.randomUUID();
    await insertKey({ id, provider, label, api_key: apiKey });
    const rows = await listKeys();
    const added = rows.find((r) => r.id === id);
    return Response.json({ ok: true, key: added ? maskedKeyRow(added) : null }, { status: 201 });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "خطأ غير معروف" }, { status: 500 });
  }
}
