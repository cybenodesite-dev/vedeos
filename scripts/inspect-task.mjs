/** قراءة محاولات مهمة معينة من Turso مباشرة — تشخيص */
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("/home/z/my-project/.env.local", "utf8")
    .split("\n").filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const taskId = process.argv[2];
const r = await db.execute({ sql: `SELECT id, type, status, provider, provider_task_id, attempts_json, error_message FROM tasks WHERE id = ?`, args: [taskId] });
const row = r.rows[0];
if (!row) { console.log("لا توجد مهمة"); process.exit(1); }
console.log("status:", row.status, "| provider:", row.provider, "| pTaskId:", row.provider_task_id);
const attempts = JSON.parse(row.attempts_json || "[]");
console.log("عدد المحاولات:", attempts.length);
for (const a of attempts) {
  console.log(`- [${a.at}] ${a.provider} ok=${a.ok} class=${a.errorClass ?? "-"} :: ${(a.error ?? "").slice(0, 300)}`);
}
