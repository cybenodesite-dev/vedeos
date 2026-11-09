/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفة MCP.
 * يستخدم WebStandardStreamableHTTPServerTransport الرسمي من SDK بوضع **stateless**:
 * يُنشأ زوج (McpServer + Transport) جديد لكل طلب — هذا هو النمط الرسمي الموصى به
 * للمنصات اللاخادمية (Vercel / Cloudflare Workers) حيث لا تضمن المنصة نفس العملية
 * بين الطلبات المتتالية؛ فلا توجد جلسات في الذاكرة تضيع بين instance وآخر
 * (يست eliminate خطأ "Session not found" نهائيًا).
 *
 * POST: رسائل JSON-RPC (initialize / tools/list / tools/call ...)
 *       كل رسالة تُعالج باستقلال تام، وترويسة mcp-session-id الواردة تُتجاهل (بلا جلسات).
 * GET : 405 — البث المستقل من السيرفر غير متاح في وضع stateless (أدواتنا تعيد
 *       النتيجة والتقدم داخل استجابة POST نفسها عبر _meta.progressToken).
 * DELETE: 405 — لا توجد جلسة في الذاكرة ليتم إنهاؤها.
 *
 * مصادقة اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, TOOL_NAMES } from "@/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * أقصى مدة تنفيذ على Vercel — نافذة الانتظار القصوى للأدوات 240 ثانية + هامش.
 * إن رفضتها خطتك خفّضها إلى 60 — المهمة تبقى محفوظة في Turso وتُستكمل عبر get_task.
 */
export const maxDuration = 300;

function jsonError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * معالجة POST بوضع stateless: زوج جديد لكل طلب — نمط SDK الرسمي
 * ("Stateless transport cannot be reused across requests. Create a new transport per request.")
 */
async function handlePost(request: Request): Promise<Response> {
  // فحص الأداة المجهولة قبل تمرير الجسم للـ transport — رسالة عربية صريحة بدل خطأ إنجليزي
  try {
    const peek = (await request.clone().json()) as {
      method?: string;
      id?: unknown;
      params?: { name?: string };
    };
    if (peek?.method === "tools/call" && !TOOL_NAMES.includes(peek.params?.name ?? "")) {
      const name = peek.params?.name ?? "(فارغ)";
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: peek.id ?? null,
          result: {
            content: [{ type: "text", text: `❌ أداة غير معروفة: ${name}. المتاح: ${TOOL_NAMES.join("، ")}` }],
            isError: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch {
    /* ليس JSON أو تعذر القراءة — الـ transport سيتعامل معه */
  }

  // زوج جديد لكل طلب — بلا جلسات في الذاكرة، والطلبات مستقلة تمامًا
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  // مصادقة اختيارية على /mcp
  const token = process.env.MCP_ACCESS_TOKEN;
  if (token) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${token}`) {
      return jsonError(401, -32001, "Unauthorized: Authorization: Bearer <MCP_ACCESS_TOKEN> مطلوب");
    }
  }
  return handlePost(request);
}

/** GET غير مدعوم في وضع stateless — لا بث مستقل من السيرفر */
export async function GET(): Promise<Response> {
  return jsonError(
    405,
    -32001,
    "Method Not Allowed: وضع stateless لا يوفر بث SSE مستقل — النتائج والتقدم يعودان ضمن استجابة POST مباشرة"
  );
}

/** DELETE غير مدعوم في وضع stateless — لا توجد جلسات تُنهى */
export async function DELETE(): Promise<Response> {
  return jsonError(405, -32001, "Method Not Allowed: وضع stateless بلا جلسات — لا حاجة لإنهاء جلسة");
}

/** CORS للعملاء القائمين على المتصفح — لا يحتاجه العملاء الخادمية لكنه لا يضر */
export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
      "Access-Control-Max-Age": "86400",
    },
  });
}
