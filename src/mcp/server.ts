/**
 * مصنع خادم MCP — media-generator-mcp v1.2.0
 * يستخدم McpServer الرسمي من @modelcontextprotocol/sdk ويسجل الأدوات الخمس.
 * أوصاف الأدوات إنجليزية دقيقة (العميل يقرأها) — أما نتائج الاستدعاء فتُصاغ بالعربية.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration, refreshTask, type Notify } from "@/lib/generation";
import { runMerge } from "@/lib/merge";
import { listRecentTasks } from "@/lib/turso";
import {
  fmtFailed,
  fmtImageDone,
  fmtMediaList,
  fmtMergeDone,
  fmtNoKeys,
  fmtNotFound,
  fmtProcessing,
  fmtVideoDone,
} from "@/lib/format";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

/** نص التعليمات الجاهز المُرسل مع initialize */
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/** بناء دالة بث التقدم من _meta.progressToken الخاص بالطلب الحالي */
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
function makeNotify(extra: ToolExtra): Notify {
  return async (progress, message) => {
    const token = extra?._meta?.progressToken;
    if (token === undefined || token === null) return; // العميل لم يطلب بثًا
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token as string | number, progress, total: 100, message },
      });
    } catch {
      // بث التقدم لا يفشل المهمة أبدًا
    }
  };
}

type ToolResponse = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (t: string): ToolResponse => ({ content: [{ type: "text", text: t }] });
const errText = (t: string): ToolResponse => ({ content: [{ type: "text", text: t }], isError: true });

/** تحويل نتيجة المنسق إلى رد أداة عربي */
function outcomeToResponse(o: {
  taskId: string;
  status: "completed" | "processing" | "failed" | "no_keys";
  urls?: string[];
  error?: string;
  kind: "image" | "video" | "merge";
}): ToolResponse {
  if (o.status === "completed" && o.urls?.length) {
    if (o.kind === "image") return text(fmtImageDone(o.urls, o.taskId));
    if (o.kind === "video") return text(fmtVideoDone(o.urls, o.taskId));
    return text(fmtMergeDone(o.urls, o.taskId));
  }
  if (o.status === "no_keys") return errText(o.error ?? fmtNoKeys(""));
  if (o.status === "failed") return errText(fmtFailed(o.error ?? "سبب غير معروف"));
  return text(fmtProcessing(o.taskId));
}

/** إنشاء خادم MCP جديد مع الأدوات الخمس (نسخة لكل جلسة) */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  /* ------------------------------ 1) generate_image ------------------------------ */
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys). " +
        "Returns the ready image URL if generation completes within the wait window; otherwise returns a task_id — " +
        "call get_task with that task_id every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1, "prompt مطلوب").describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const notify = makeNotify(extra);
      const outcome = await runGeneration({
        type: "image",
        modelName: args.model,
        params: {
          prompt: args.prompt,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          background: args.background,
          output_format: args.output_format,
        },
        waitSeconds: args.wait_seconds ?? 90,
        notify,
      });
      return outcomeToResponse({ ...outcome, kind: "image" });
    }
  );

  /* ------------------------------ 2) generate_video ------------------------------ */
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio: dialogue, effects, music; optional image-to-video). " +
        "Videos take minutes: short wait with live progress streaming, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z
          .string()
          .max(4096)
          .describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const notify = makeNotify(extra);
      const outcome = await runGeneration({
        type: "video",
        modelName: args.model,
        params: {
          prompt: args.prompt,
          image_url: args.image_url,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          enable_audio: args.enable_audio,
          duration: args.duration,
        },
        waitSeconds: args.wait_seconds ?? 25,
        notify,
      });
      return outcomeToResponse({ ...outcome, kind: "video" });
    }
  );

  /* ------------------------------ 3) merge_videos ------------------------------ */
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (direct public video URLs, e.g. from generate_video) " +
        "or 'task_ids' (completed video generation tasks — their result URLs are resolved from the database in this order, ideal after generating several clips). " +
        "Accepts 2 to 10 clips. Merging is usually fast: short wait with live progress streaming, then a merge task_id — track it with get_task. " +
        "NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe(
            "Public direct video URLs (http/https) in merge order — the first clip starts the final video. 2 to 10 clips."
          ),
        task_ids: z
          .array(z.string())
          .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order. 2 to 10 ids."
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const notify = makeNotify(extra);
      const outcome = await runMerge({
        urls: args.urls,
        task_ids: args.task_ids,
        waitSeconds: args.wait_seconds ?? 60,
        notify,
      });
      return outcomeToResponse({ ...outcome, kind: "merge" });
    }
  );

  /* ------------------------------ 4) get_task ------------------------------ */
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the database and live-updates from the provider/merging service while the task is in progress). " +
        "Poll it every ~10 seconds; when completed you'll find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1, "task_id مطلوب"),
      },
    },
    async (args, extra) => {
      const notify = makeNotify(extra);
      const task = await refreshTask(args.task_id, notify);
      if (!task) return errText(fmtNotFound(args.task_id));
      if (task.status === "completed") {
        let urls: string[] = [];
        try {
          urls = JSON.parse(task.result_urls_json || "[]") as string[];
        } catch {
          urls = [];
        }
        if (task.type === "image") return text(fmtImageDone(urls, task.id));
        if (task.type === "video") return text(fmtVideoDone(urls, task.id));
        return text(fmtMergeDone(urls, task.id));
      }
      if (task.status === "failed") {
        return errText(fmtFailed(task.error_message ?? "سبب غير معروف"));
      }
      return text(fmtProcessing(task.id));
    }
  );

  /* ------------------------------ 5) list_media ------------------------------ */
  server.registerTool(
    "list_media",
    {
      description:
        "Latest images/videos/merges stored with their result URLs from the database (no regeneration) — recall previously generated media.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status });
      return text(fmtMediaList(tasks));
    }
  );

  return server;
}
