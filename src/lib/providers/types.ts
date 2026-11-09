/** واجهة موحدة لكل مزود — أي خطأ يُرمى كـ ProviderError ليُصنَّف ويقرَّر التبديل. */
import type { ProviderId } from "@/lib/models";

export interface ProviderKey {
  id: string;
  provider: ProviderId;
  api_key: string;
  label: string;
}

export interface CreateTaskResult {
  providerTaskId: string;
}

export interface CheckTaskResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId */
  createTask(key: ProviderKey, providerModel: string, input: Record<string, unknown>): Promise<CreateTaskResult>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا) */
  createImageSync?(key: ProviderKey, providerModel: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult>;
}

/** مهلة افتراضية لنداءات الإنشاء */
export const CREATE_TIMEOUT_MS = 30_000;
/** مهلة افتراضية لنداءات الاستعلام */
export const CHECK_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}
