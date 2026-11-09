/**
 * سجل الموديلات: يوحّد الأسماء البديلة (شرطات/نقاط) ويحدد المزودين القادرين على خدمة كل موديل.
 * أسماء الموديلات لدى كل مزود قابلة للتجاوز بمتغيرات البيئة.
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

/** اسم الموديل لدى المزود قابل للتجاوز بمتغيرات البيئة */
const envOverride = (v: string | undefined, fallback: string): string =>
  (v && v.trim()) || fallback;

const KIE_IMAGE_MODEL = envOverride(process.env.KIE_IMAGE_MODEL, "gpt-image-2-6/flare-text-to-image");
const KIE_VIDEO_MODEL = envOverride(process.env.KIE_VIDEO_MODEL, "grok-imagine-video-1-5-preview");
const COMETAPI_IMAGE_MODEL = envOverride(
  process.env.COMETAPI_IMAGE_MODEL,
  "gpt-image-2.6-flare-text-to-image"
);
const COMETAPI_VIDEO_MODEL = envOverride(process.env.COMETAPI_VIDEO_MODEL, "grok-imagine-video-1-5-preview");

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6-flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-1-5"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

/** توحيد اسم الموديل: نقاط ↔ شرطات للصيغ المعروفة، وإلا يبقى كما هو */
export function normalizeModelName(name: string): string {
  const n = name.trim().toLowerCase();
  for (const m of MODELS) {
    if (m.canonical === n || m.aliases.includes(n)) return m.canonical;
  }
  return n;
}

export function resolveModel(name: string): ModelDef | null {
  const canonical = normalizeModelName(name);
  return MODELS.find((m) => m.canonical === canonical) ?? null;
}

/** قائمة الموديلات لعرضها في /api/health */
export function modelsInfo() {
  return MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers }));
}
