/**
 * طبقة قاعدة البيانات — Turso عبر @libsql/client (HTTP، متوافق مع Vercel serverless).
 * لا ملفات SQLite محلية في الإنتاج إطلاقًا.
 * المخطط يُنشأ عند أول وصول (CREATE TABLE IF NOT EXISTS) فلا حاجة لأداة migrations.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface AttemptRecord {
  provider: string;
  keyId: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

/** طابع زمني بتنسيق SQLite مع مللي ثانية — فرز معجمي = فرز زمني حقيقي (أساس الترتيب التسلسلي للمفاتيح) */
export function nowStamp(): string {
  return new Date().toISOString().slice(0, 23).replace("T", " ").replace("Z", "");
}

/* ------------------------------------------------------------------ */
/* العميل — عميل واحد فقط لكل عملية (memoized على globalThis لمقاومة HMR) */
/* ------------------------------------------------------------------ */

const g = globalThis as unknown as { __tursoClient?: Client };

export function getDb(): Client {
  if (g.__tursoClient) return g.__tursoClient;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) {
    throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN غير مضبوطين في البيئة");
  }
  // عبر HTTP بالكامل — مناسب لبيئات serverless
  g.__tursoClient = createClient({ url, authToken: token });
  return g.__tursoClient;
}

const gSchema = globalThis as unknown as { __tursoSchema?: Promise<void> };

export function ensureSchema(): Promise<void> {
  if (gSchema.__tursoSchema) return gSchema.__tursoSchema;
  gSchema.__tursoSchema = (async () => {
    const db = getDb();
    await db.execute(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // فهرس يدعم استعلام بركة المفاتيح (provider + ترتيب الإضافة)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys (provider, created_at, id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC)`);
  })();
  return gSchema.__tursoSchema;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    const r = await getDb().execute("SELECT 1 AS ok");
    return r.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* عمليات المفاتيح                                                     */
/* ------------------------------------------------------------------ */

export async function insertKey(k: {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
}): Promise<void> {
  await ensureSchema();
  await getDb().execute(
    `INSERT INTO api_keys (id, provider, label, api_key, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
    [k.id, k.provider, k.label, k.api_key, nowStamp()]
  );
}

export async function listKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const r = await getDb().execute(`SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`);
  return r.rows as unknown as ApiKeyRow[];
}

export async function getKey(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await getDb().execute({ sql: `SELECT * FROM api_keys WHERE id = ?`, args: [id] });
  return (r.rows[0] as unknown as ApiKeyRow) ?? null;
}

/**
 * بركة المفاتيح بترتيب تسلسلي صارم حسب الإضافة (أول مفتاح أُضيف يُجرَّب أولًا).
 * هذا ليس round-robin وليس «الأقل استخدامًا أولًا» — ترتيب مقصود.
 * المفتاح المستنزف (exhausted) يبقى في القائمة؛ الوحيد المستبعد هو المعطّل يدويًا (disabled).
 */
export async function getKeyPool(providers: string[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const r = await getDb().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers as InValue[],
  });
  return r.rows as unknown as ApiKeyRow[];
}

export async function patchKey(
  id: string,
  patch: Partial<Pick<ApiKeyRow, "status" | "label" | "last_used_at" | "last_checked_at" | "last_error" | "usage_count" | "success_count" | "fail_count">> & { usage_count_delta?: number; success_count_delta?: number; fail_count_delta?: number }
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  const plain = ["status", "label", "last_used_at", "last_checked_at", "last_error"] as const;
  for (const f of plain) {
    if (patch[f] !== undefined) {
      sets.push(`${f} = ?`);
      args.push(patch[f] as InValue);
    }
  }
  const deltas = [
    ["usage_count_delta", "usage_count"],
    ["success_count_delta", "success_count"],
    ["fail_count_delta", "fail_count"],
  ] as const;
  for (const [field, col] of deltas) {
    const d = patch[field];
    if (d) {
      sets.push(`${col} = COALESCE(${col}, 0) + ?`);
      args.push(d);
    }
  }
  if (!sets.length) return;
  args.push(id);
  await getDb().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await getDb().execute({
    sql: `SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [provider, apiKey],
  });
  return (r.rows[0] as unknown as ApiKeyRow) ?? null;
}

/* ------------------------------------------------------------------ */
/* عمليات المهام                                                       */
/* ------------------------------------------------------------------ */

export async function insertTask(t: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt?: string;
  params_json?: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  result_urls_json?: string | null;
  error_message?: string | null;
  attempts_json?: string;
}): Promise<void> {
  await ensureSchema();
  await getDb().execute(
    `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, error_message, attempts_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.params_json ?? "{}",
      t.status,
      t.progress ?? 0,
      t.result_urls_json ?? null,
      t.error_message ?? null,
      t.attempts_json ?? "[]",
      nowStamp(),
      nowStamp(),
    ]
  );
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getDb().execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [id] });
  return (r.rows[0] as unknown as TaskRow) ?? null;
}

export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  result_urls_json?: string | string[] | null;
  error_message?: string | null;
  /** محاولة جديدة تُلحق بسجل المحاولات بدل الكتابة فوقه */
  append_attempt?: AttemptRecord;
}

/**
 * تحديث جزئي لمهمة: يضيف attempts ويضبط completed_at تلقائيًا عند الاكتمال.
 */
export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];

  const simple: [keyof TaskPatch, string][] = [
    ["provider", "provider"],
    ["provider_task_id", "provider_task_id"],
    ["key_id", "key_id"],
    ["status", "status"],
    ["progress", "progress"],
    ["error_message", "error_message"],
  ];
  for (const [f, col] of simple) {
    const v = patch[f];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      args.push(v as InValue);
    }
  }
  if (patch.result_urls_json !== undefined) {
    sets.push(`result_urls_json = ?`);
    const v = patch.result_urls_json;
    args.push(Array.isArray(v) ? JSON.stringify(v) : (v as InValue));
  }
  if (patch.append_attempt) {
    sets.push(`attempts_json = ?`);
    const cur = await getTask(id);
    let arr: AttemptRecord[] = [];
    try {
      arr = JSON.parse(cur?.attempts_json || "[]");
    } catch {
      arr = [];
    }
    arr.push(patch.append_attempt);
    // احتفظ بآخر 40 محاولة فقط لتفادي تضخم السجل
    if (arr.length > 40) arr = arr.slice(arr.length - 40);
    args.push(JSON.stringify(arr));
  }
  if (patch.status === "completed") {
    sets.push(`completed_at = COALESCE(completed_at, ?)`);
    args.push(nowStamp());
  }
  if (!sets.length) return;
  sets.push(`updated_at = ?`);
  args.push(nowStamp());
  args.push(id);
  await getDb().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) {
    where.push(`type = ?`);
    args.push(filters.type);
  }
  if (filters?.status) {
    where.push(`status = ?`);
    args.push(filters.status);
  }
  args.push(limit);
  const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  const r = await getDb().execute({ sql, args });
  return r.rows as unknown as TaskRow[];
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const r = await getDb().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'processing' OR status = 'pending' THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const row = r.rows[0] as unknown as Record<string, number | null>;
  return {
    total: Number(row?.total ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    processing: Number(row?.processing ?? 0),
  };
}

/** حذف مهمة (لتنظيف آثار الاختبار) */
export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [id] });
}
