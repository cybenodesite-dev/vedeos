/** GET /api/health — جهوزية النظام العامة (runtime nodejs + force-dynamic) */
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { mergerHealthy, mergerBase, mergerConfigured } from "@/lib/merger";
import { modelsInfo } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let database = "turso-error";
  let ok = false;
  try {
    await ensureSchema();
    ok = await dbHealthy();
    database = ok ? "turso-connected" : "turso-error";
  } catch {
    ok = false;
    database = "turso-error";
  }

  const merger = { base: mergerConfigured() ? mergerBase() : null, healthy: await mergerHealthy() };

  return Response.json(
    {
      ok,
      database,
      mcpEndpoint: "/mcp",
      models: modelsInfo(),
      merger,
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: ok ? 200 : 503 }
  );
}
