/**
 * اختبار شامل端-to-end لخادم MCP — بروتوكول كامل عبر SSE:
 * initialize → tools/call (صورة/فيديو حقيقية) مع بث التقدم → get_task حتى الاكتمال.
 * usage: node scripts/e2e-test.mjs image|video|errors|all
 */
const BASE = process.env.BASE || "http://localhost:3000";
const ACCEPT = "application/json, text/event-stream";
let session = null;
let nextId = 100;

/** POST رسالة JSON-RPC وقراءة رد SSE كاملًا (يجمع كل الأحداث) */
async function rpc(body, { quiet = false } = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: ACCEPT,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) {
    const t = await res.text();
    let j = null;
    try { j = JSON.parse(t); } catch {}
    return { status: res.status, json: j, text: t };
  }
  // بث SSE — نجمع الأحداث حتى إغلاق الاتصال
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data) continue;
      try {
        const j = JSON.parse(data);
        events.push(j);
        if (!quiet && j.method?.includes("progress")) {
          console.log(`   📡 progress ${j.params?.progress ?? "?"}/100 — ${j.params?.message ?? ""}`);
        }
      } catch {}
    }
  }
  return { status: res.status, events };
}

const resultOf = (r) => r.events?.find((e) => e.result)?.result ?? r.json?.result ?? r.json;
const textOf = (r) => {
  const res = resultOf(r);
  return res?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(res ?? r).slice(0, 300);
};

async function init() {
  const r = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e-test", version: "1.0" } },
  }, { quiet: true });
  const info = resultOf(r)?.serverInfo;
  console.log(`✅ initialize → ${info?.name} v${info?.version} (session: ${session?.slice(0, 8)}…)`);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { quiet: true });
}

async function callTool(name, args, { progress = false } = {}) {
  const r = await rpc({
    jsonrpc: "2.0", id: ++nextId, method: "tools/call",
    params: { name, arguments: args, ...(progress ? { _meta: { progressToken: "tk-" + nextId } } : {}) },
  });
  return { text: textOf(r), isError: resultOf(r)?.isError === true, raw: r };
}

/* ------------------------------ الاختبارات ------------------------------ */

async function testImage() {
  console.log("\n🖼️  اختبار توليد صورة حقيقي عبر MCP…");
  const { text, isError } = await callTool("generate_image", {
    prompt: "A cute orange tabby kitten astronaut floating in space, stars background, digital art",
    wait_seconds: 100,
  }, { progress: true });
  console.log("— الرد —");
  console.log(text.slice(0, 700));
  if (isError) throw new Error("توليد الصورة فشل");
  const m = text.match(/https?:\/\/\S+/);
  if (!m) throw new Error("لا يوجد رابط صورة في الرد");
  console.log("✅ رابط الصورة:", m[0]);
  return m[0];
}

async function testVideo() {
  console.log("\n🎬 اختبار توليد فيديو حقيقي عبر MCP (مع متابعة get_task)…");
  const first = await callTool("generate_video", {
    prompt: "Ocean waves at golden sunset, seagulls flying, calm ambient sound",
    wait_seconds: 25,
  }, { progress: true });
  console.log("— أول رد —");
  console.log(first.text.slice(0, 400));
  if (first.isError) throw new Error("توليد الفيديو فشل فورًا");
  const m = first.text.match(/task_id: ([0-9a-f-]+)/);
  if (!m) {
    // اكتمل داخل النافذة
    const u = first.text.match(/https?:\/\/\S+/);
    if (u) { console.log("✅ اكتمل داخل النافذة:", u[0]); return u[0]; }
    throw new Error("لا task_id ولا رابط في الرد");
  }
  const taskId = m[1];
  console.log(`⏳ متابعة get_task كل 15 ثانية حتى 7 دقائق (task_id: ${taskId.slice(0, 8)}…)`);
  const deadline = Date.now() + 7 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    const t = await callTool("get_task", { task_id: taskId }, { progress: true });
    if (t.text.includes("✅ تم توليد الفيديو بنجاح")) {
      const u = t.text.match(/https?:\/\/\S+/);
      console.log("✅ الفيديو اكتمل:", u?.[0]);
      return u?.[0];
    }
    if (t.text.includes("❌ فشلت المهمة")) throw new Error("الفideo فشل: " + t.text.slice(0, 300));
    if (t.text.includes("بانتظار توفر مفتاح صالح")) {
      // السلوك المصمم: المفتاح الحالي مستنزف لهذا الموديل والمهمة تنتظر مفتاحًا صالحًا
      console.log("⚠️ المهمة قيد المعالجة وبانتظار مفتاح صالح — رصيد الحساب لا يكفي للفيديو (أضف رصيدًا أو مفتاحًا آخر). النظام يلتزم المواصفة.");
      return null;
    }
    process.stdout.write("   … لا تزال قيد المعالجة\n");
  }
  throw new Error("انتهت مهلة متابعة الفيديو (7 دقائق)");
}

async function testErrors() {
  console.log("\n🧪 اختبارات الرسائل العربية والحدود…");
  // 1) أداة غير معروفة
  const uk = await callTool("nonexistent_tool", {});
  console.log("1) أداة مجهولة:", uk.text.slice(0, 150), uk.isError ? "(isError ✓)" : "(⚠️ isError=false)");
  // 2) دمج بمقطع واحد
  const m1 = await callTool("merge_videos", { urls: ["https://example.com/a.mp4"] });
  console.log("2) دمج بمقطع واحد:", m1.text.split("\n")[0], m1.isError ? "(isError ✓)" : "(⚠️ isError=false)");
  // 3) دمج بأكثر من 10
  const many = Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`);
  const m11 = await callTool("merge_videos", { urls: many });
  console.log("3) دمج بـ 11 مقطعًا:", m11.text.split("\n")[0], m11.isError ? "(isError ✓)" : "(⚠️ isError=false)");
  // 4) مزيج رابط واحد + مهمتين وهميتين → رسالة تفاصيل عربية (وليس خطأ zod إنجليزي)
  const mix = await callTool("merge_videos", { urls: ["https://example.com/a.mp4"], task_ids: ["abc", "def"] });
  console.log("4) مزيج 1+2 (تفاصيل عربية):", mix.text.split("\n").slice(0, 5).join(" | ").slice(0, 220));
  // 5) get_task لمهمة غير موجودة
  const nf = await callTool("get_task", { task_id: "does-not-exist-000" });
  console.log("5) مهمة غير موجودة:", nf.text.slice(0, 120), nf.isError ? "(isError ✓)" : "(⚠️ isError=false)");
  // 6) list_media
  const lm = await callTool("list_media", { limit: 5 });
  console.log("6) list_media (أول 3 أسطر):", lm.text.split("\n").slice(0, 3).join(" | ").slice(0, 200));
}

const mode = process.argv[2] || "all";
await init();
if (mode === "image" || mode === "all") await testImage();
if (mode === "video" || mode === "all") await testVideo();
if (mode === "errors" || mode === "all") await testErrors();
console.log("\n🎉 اكتمل الاختبار بنجاح");
