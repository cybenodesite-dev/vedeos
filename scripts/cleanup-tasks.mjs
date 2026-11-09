/**
 * سكربت صيانة: حذف مهام من قاعدة Turso (تنظيف آثار الاختبار).
 * الاستخدام: bun --env-file=.env.local scripts/cleanup-tasks.mjs [task_id | all]
 */
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  console.error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN مفقودان");
  process.exit(1);
}
const db = createClient({ url, authToken: token });
const arg = process.argv[2] ?? "";

if (arg === "all") {
  const r = await db.execute("DELETE FROM tasks");
  console.log(`deleted rows: ${r.rowsAffected}`);
} else if (arg) {
  const r = await db.execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [arg] });
  console.log(`deleted rows: ${r.rowsAffected}`);
} else {
  const r = await db.execute("SELECT id, type, status, model, created_at FROM tasks ORDER BY created_at DESC LIMIT 20");
  for (const row of r.rows) console.log(Object.values(row).join(" | "));
  if (!r.rows.length) console.log("(no tasks)");
}
