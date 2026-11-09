/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفة MCP.
 * يستخدم WebStandardStreamableHTTPServerTransport الرسمي من SDK (يعمل مباشرة بـ
 * Web Request/Response في Next.js App Router — بلا تحويل يدوي لـ JSON-RPC).
 *
 * POST: رسائل JSON-RPC (initialize / tools/list / tools/call ...)
 * GET : بث SSE مستقل للرسائل التي يبدأها السيرفر (يتطلب جلسة قائمة)
 * DELETE: إنهاء الجلسة
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

interface SessionPair {
  server: ReturnType<typeof createMcpServer>;
  transport: WebStandardStreamableHTTPServerTransport;
  lastUsed: number;
}

/** جلسات حية في الذاكرة (كل عملية serverless لها خريطتها) */
const g = globalThis as unknown as { __mcpSessions?: Map<string, SessionPair> };
const sessions: Map<string, SessionPair> = (g.__mcpSessions ??= new Map());
const MAX_SESSIONS = 100;

function jsonError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/** إنشاء زوج (server + transport) جديد بوضع stateful */
function createSession(): SessionPair {
  const pair: SessionPair = {
    server: null as unknown as SessionPair["server"],
    transport: null as unknown as WebStandardStreamableHTTPServerTransport,
    lastUsed: Date.now(),
  };
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => {
      pair.lastUsed = Date.now();
      sessions.set(sessionId, pair);
      evictIfNeeded();
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
    },
  });
  const server = createMcpServer();
  pair.server = server;
  pair.transport = transport;
  // connect ضروري قبل معالجة أي طلب (نمط SDK الرسمي)
  void server.connect(transport);
  return pair;
}

/** حصر حجم خريطة الجلسات — أغلق الأقدم عند التجاوز */
function evictIfNeeded(): void {
  while (sessions.size > MAX_SESSIONS) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of sessions) {
      if (v.lastUsed < oldest) {
        oldest = v.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    const victim = sessions.get(oldestKey);
    sessions.delete(oldestKey);
    void victim?.transport.close().catch(() => {});
  }
}

async function handleMcp(request: Request): Promise<Response> {
  // مصادقة اختيارية على /mcp
  const token = process.env.MCP_ACCESS_TOKEN;
  if (token) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${token}`) {
      return jsonError(401, -32001, "Unauthorized: Authorization: Bearer <MCP_ACCESS_TOKEN> مطلوب");
    }
  }

  const sessionId = request.headers.get("mcp-session-id");

  if (request.method === "POST") {
    // فحص الأداة المجهولة قبل تمرير الجسم للـ transport — رسالة عربية صريحة بدل خطأ إنجليزي
    try {
      const peek = (await request.clone().json()) as {
        method?: string;
        id?: unknown;
        params?: { name?: string };
      };
      if (peek?.method === "tools/call" && !TOOL_NAMES.includes(peek.params?.name ?? "")) {
        const name = peek.params?.name ?? "(فارغ)";
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: peek.id ?? null,
          result: {
            content: [{ type: "text", text: `❌ أداة غير معروفة: ${name}. المتاح: ${TOOL_NAMES.join("، ")}` }],
            isError: true,
          },
        });
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
        });
      }
    } catch {
      /* ليس JSON أو تعذر القراءة — الـ transport سيتعامل معه */
    }

    if (sessionId) {
      const pair = sessions.get(sessionId);
      if (!pair) {
        // معرّف جلسة غير معروف (انتهى أو من عملية أخرى) → 404 حسب المواصفة
        return jsonError(404, -32001, "Session not found");
      }
      pair.lastUsed = Date.now();
      return pair.transport.handleRequest(request);
    }
    // بلا جلسة: initialize جديد
    const pair = createSession();
    const response = await pair.transport.handleRequest(request);
    evictIfNeeded();
    return response;
  }

  // GET (بث SSE مستقل) و DELETE (إنهاء الجلسة) يتطلبان جلسة قائمة
  if (sessionId) {
    const pair = sessions.get(sessionId);
    if (pair) {
      pair.lastUsed = Date.now();
      return pair.transport.handleRequest(request);
    }
    return jsonError(404, -32001, "Session not found");
  }
  // حسب المواصفة: GET بلا جلسة → 405
  return jsonError(
    request.method === "GET" ? 405 : 400,
    -32001,
    request.method === "GET" ? "Method Not Allowed: session id مطلوب" : "Bad Request: session id مطلوب"
  );
}

export async function POST(request: Request): Promise<Response> {
  return handleMcp(request);
}
export async function GET(request: Request): Promise<Response> {
  return handleMcp(request);
}
export async function DELETE(request: Request): Promise<Response> {
  return handleMcp(request);
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
