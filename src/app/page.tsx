"use client";

/**
 * لوحة الإدارة العربية (RTL) — صفحة واحدة بثلاث بطاقات:
 * أ) مدير المفاتيح  ب) لوحة المهام  ج) ربط السيرفر
 * كل البيانات تُجلب من /api/* وتتحدث تلقائيًا.
 */
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ar } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity,
  Check,
  Copy,
  Database,
  ExternalLink,
  KeyRound,
  Link2,
  PlugZap,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

/* ------------------------------- الأنواع ------------------------------- */

interface KeyItem {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface TaskItem {
  id: string;
  type: "image" | "video" | "merge";
  status: "pending" | "processing" | "completed" | "failed";
  model: string;
  provider: string | null;
  prompt: string;
  progress: number;
  urls: string[];
  error_message: string | null;
  attempts_count: number;
  created_at: string;
}

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

/* ------------------------------ ثوابت مساعدة ------------------------------ */

const PROVIDERS = [
  { id: "kie", name: "kie.ai" },
  { id: "cometapi", name: "CometAPI" },
];

const TOOLS = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن (وصف نصي أو صورة أول إطار)" },
  { name: "merge_videos", desc: "دمج 2–10 مقاطع في فيديو واحد بالترتيب المعطى" },
  { name: "get_task", desc: "متابعة أي مهمة بمعرّفها حتى الاكتمال" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها" },
];

const KEY_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  exhausted: { label: "مستنزف", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  disabled: { label: "معطّل", cls: "bg-gray-100 text-gray-600 border-gray-300" },
};

const TASK_STATUS: Record<string, { label: string; cls: string }> = {
  completed: { label: "مكتملة", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  processing: { label: "قيد المعالجة", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  pending: { label: "منتظرة", cls: "bg-gray-100 text-gray-600 border-gray-300" },
  failed: { label: "فاشلة", cls: "bg-rose-100 text-rose-800 border-rose-300" },
};

const TASK_TYPE: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    return formatDistanceToNow(d, { locale: ar, addSuffix: true });
  } catch {
    return "—";
  }
}

/* -------------------------------- الصفحة -------------------------------- */

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [mcpUrl, setMcpUrl] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const fetchKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setKeys(j.keys);
    } catch {
      /* تجاهل */
    }
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setTasks(j.tasks);
        setStats(j.stats);
      }
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    fetchKeys();
    fetchTasks();
    const t1 = setInterval(fetchTasks, 5000); // لوحة المهام تتحدث كل ~5 ثوانٍ
    const t2 = setInterval(fetchKeys, 5000); // لتتبع تغيّر حالات المفاتيح (تبديل تلقائي)
    const t3 = setInterval(fetchHealth, 15000);
    setMcpUrl(`${window.location.origin}/mcp`);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
    };
  }, [fetchHealth, fetchKeys, fetchTasks]);

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const j = await r.json();
      if (j.ok) {
        setFormMsg({ ok: true, text: "أُضيف المفتاح بنجاح — سيُجرَّب أولًا في الترتيب التسلسلي" });
        setApiKey("");
        setLabel("");
        fetchKeys();
      } else {
        setFormMsg({ ok: false, text: j.error ?? "فشل الإضافة" });
      }
    } catch {
      setFormMsg({ ok: false, text: "تعذر الاتصال بالسيرفر" });
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleKey(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: k.status === "disabled" ? "enable" : "disable" }),
    });
    fetchKeys();
  }

  async function removeKey(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    fetchKeys();
  }

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // احتياط للمتصفحات القديمة
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(tag);
    setTimeout(() => setCopied(null), 2000);
  }

  /* ------------------------------ إعدادات الربط ------------------------------ */
  const authHeader = health?.authRequired
    ? { Authorization: "Bearer <MCP_ACCESS_TOKEN>" }
    : undefined;

  const chatgptConfig = JSON.stringify(
    { mcpServers: { "media-generator": { url: mcpUrl, ...(authHeader ? { headers: authHeader } : {}) } } },
    null,
    2
  );
  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        "media-generator": { type: "http", url: mcpUrl, ...(authHeader ? { headers: authHeader } : {}) },
      },
    },
    null,
    2
  );
  const cursorConfig = JSON.stringify(
    { mcpServers: { "media-generator": { url: mcpUrl, ...(authHeader ? { headers: authHeader } : {}) } } },
    null,
    2
  );

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* ------------------------------- الهيدر ------------------------------- */}
      <header className="border-b bg-white sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 me-auto">
            <div className="w-9 h-9 rounded-lg bg-emerald-600 text-white flex items-center justify-center">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">MCP Media Generator</h1>
              <p className="text-xs text-gray-500">خادم توليد الصور والفيديو ودمج المقاطع</p>
            </div>
          </div>
          {health ? (
            <div className="flex items-center gap-2">
              <Badge
                className={`gap-1 ${health.ok && health.database === "turso-connected"
                  ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                  : "bg-rose-100 text-rose-800 border border-rose-300"}`}
              >
                <Database className="w-3 h-3" />
                {health.ok && health.database === "turso-connected" ? "Turso متصل" : "غير متصل"}
              </Badge>
              <Badge
                className={`gap-1 ${health.merger?.healthy
                  ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                  : "bg-amber-100 text-amber-800 border border-amber-300"}`}
              >
                <PlugZap className="w-3 h-3" />
                خدمة الدمج {health.merger?.healthy ? "جاهزة" : "غير مهيأة"}
              </Badge>
              {health.authRequired && <Badge className="border">محمي بـ Token</Badge>}
            </div>
          ) : (
            <Badge className="bg-rose-100 text-rose-800 border border-rose-300">غير متصل</Badge>
          )}
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-6 grid gap-6 lg:grid-cols-2 items-start">
        {/* ---------------------------- أ) مدير المفاتيح ---------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-emerald-700" />
              مدير المفاتيح
            </CardTitle>
            <CardDescription>
              أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند
              أي خطأ أو نفاد رصيد دون توقف.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={addKey} className="grid gap-2 sm:grid-cols-[130px_1fr]">
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger aria-label="المزود">
                  <SelectValue placeholder="المزود" />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="API Key — يُخفى دائمًا بعد الحفظ"
                required
                minLength={8}
                dir="ltr"
                className="text-left"
              />
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="تسمية اختيارية (مثال: حساب رئيسي)"
                className="sm:col-span-2"
              />
              <Button type="submit" disabled={submitting} className="sm:col-span-2 bg-emerald-700 hover:bg-emerald-800">
                {submitting ? "جارٍ الإضافة…" : "إضافة المفتاح"}
              </Button>
            </form>
            {formMsg && (
              <p className={`text-sm ${formMsg.ok ? "text-emerald-700" : "text-rose-700"}`}>{formMsg.text}</p>
            )}

            <ScrollArea className="max-h-96 overflow-y-auto rounded-md border">
              <div className="divide-y">
                {keys.length === 0 && (
                  <p className="p-4 text-sm text-gray-500">لا مفاتيح بعد — أضف أول مفتاح لتبدأ التوليد.</p>
                )}
                {keys.map((k) => {
                  const st = KEY_STATUS[k.status] ?? KEY_STATUS.active;
                  return (
                    <div key={k.id} className="p-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <code dir="ltr" className="text-xs bg-gray-100 rounded px-2 py-1 font-mono">
                          {k.masked}
                        </code>
                        <Badge className={`border ${st.cls}`}>{st.label}</Badge>
                        <span className="text-xs text-gray-500">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</span>
                        {k.label && <span className="text-xs text-gray-700">• {k.label}</span>}
                        <span className="ms-auto flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => toggleKey(k)}
                            title={k.status === "disabled" ? "تنشيط" : "تعطيل"}
                          >
                            {k.status === "disabled" ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => removeKey(k)} title="حذف">
                            <Trash2 className="w-4 h-4 text-rose-600" />
                          </Button>
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                        <span>استخدام: {k.usage_count}</span>
                        <span className="text-emerald-700">نجاح: {k.success_count}</span>
                        <span className="text-rose-700">فشل: {k.fail_count}</span>
                        <span>آخر استخدام: {timeAgo(k.last_used_at)}</span>
                      </div>
                      {k.last_error && (
                        <p dir="ltr" className="text-xs text-rose-700 text-left font-mono truncate" title={k.last_error}>
                          {k.last_error}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* ---------------------------- ج) ربط السيرفر ---------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="w-5 h-5 text-emerald-700" />
              ربط السيرفر
            </CardTitle>
            <CardDescription>انسخ الرابط أو الإعداد الجاهز لأي عميل MCP.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input readOnly dir="ltr" value={mcpUrl} className="text-left font-mono text-xs" />
              <Button variant="outline" onClick={() => copy(mcpUrl, "url")} title="نسخ الرابط">
                {copied === "url" ? <Check className="w-4 h-4 text-emerald-700" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>

            <Tabs defaultValue="chatgpt">
              <TabsList className="grid grid-cols-3 w-full text-xs">
                <TabsTrigger value="chatgpt">ChatGPT / GPT</TabsTrigger>
                <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor">Cursor وغيره</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <p className="text-xs text-gray-500">
                  في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
                </p>
                <JsonBlock json={chatgptConfig} onCopy={() => copy(chatgptConfig, "chatgpt")} copied={copied === "chatgpt"} />
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <p className="text-xs text-gray-500">ضع الإعداد داخل ملف claude_desktop_config.json.</p>
                <JsonBlock json={claudeConfig} onCopy={() => copy(claudeConfig, "claude")} copied={copied === "claude"} />
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <p className="text-xs text-gray-500">نفس الصيغة لملف mcp.json في Cursor / Windsurf / Cline.</p>
                <JsonBlock json={cursorConfig} onCopy={() => copy(cursorConfig, "cursor")} copied={copied === "cursor"} />
              </TabsContent>
            </Tabs>

            <div>
              <p className="text-sm font-semibold mb-2">الأدوات الخمس المتاحة:</p>
              <div className="flex flex-wrap gap-2">
                {TOOLS.map((t) => (
                  <span
                    key={t.name}
                    className="inline-flex items-center gap-1 rounded-full border bg-white px-3 py-1 text-xs"
                    title={t.desc}
                  >
                    <code dir="ltr" className="font-mono text-emerald-800">{t.name}</code>
                    <span className="text-gray-500">— {t.desc}</span>
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
              المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا
              تنقطع العملية.
            </div>
          </CardContent>
        </Card>

        {/* ---------------------------- ب) لوحة المهام ---------------------------- */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="flex items-center gap-2">
                <RefreshCw className="w-5 h-5 text-emerald-700" />
                لوحة المهام
              </CardTitle>
              <span className="text-xs text-gray-400">تتحدث تلقائيًا كل 5 ثوانٍ</span>
              <div className="ms-auto flex flex-wrap gap-2 text-xs">
                <StatChip label="الإجمالي" value={stats.total} cls="bg-gray-100 text-gray-700" />
                <StatChip label="مكتملة" value={stats.completed} cls="bg-emerald-100 text-emerald-800" />
                <StatChip label="فاشلة" value={stats.failed} cls="bg-rose-100 text-rose-800" />
                <StatChip label="جارية" value={stats.processing} cls="bg-amber-100 text-amber-800" />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-[520px] overflow-y-auto rounded-md border">
              <div className="divide-y">
                {tasks.length === 0 && (
                  <p className="p-4 text-sm text-gray-500">
                    لا مهام بعد — استدعِ generate_image أو generate_video من أي عميل MCP وستظهر هنا مباشرة.
                  </p>
                )}
                {tasks.map((t) => {
                  const st = TASK_STATUS[t.status] ?? TASK_STATUS.pending;
                  return (
                    <div key={t.id} className="p-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="font-semibold">{TASK_TYPE[t.type] ?? t.type}</Badge>
                        <Badge className={`border ${st.cls}`}>{st.label}</Badge>
                        <code dir="ltr" className="text-[10px] text-gray-500 font-mono">{t.model}</code>
                        <span className="text-xs text-gray-400">{timeAgo(t.created_at)}</span>
                        {t.attempts_count > 1 && (
                          <Badge variant="outline" className="text-xs">محاولات: {t.attempts_count}</Badge>
                        )}
                        {t.provider && <span className="text-xs text-gray-400">عبر {t.provider}</span>}
                      </div>
                      {t.prompt && <p className="text-sm text-gray-700 line-clamp-2">{t.prompt}</p>}
                      {(t.status === "processing" || t.status === "pending") && (
                        <Progress value={t.progress} className="h-2" />
                      )}
                      {t.status === "failed" && t.error_message && (
                        <p className="text-xs text-rose-700">{t.error_message}</p>
                      )}
                      {t.urls.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {t.urls.map((u, i) => (
                            <a
                              key={i}
                              href={u}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-emerald-800 hover:underline"
                            >
                              <ExternalLink className="w-3 h-3" />
                              {t.type === "image" ? `فتح الصورة ${t.urls.length > 1 ? i + 1 : ""}` : "فتح الفيديو"}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </main>

      <footer className="border-t bg-white mt-auto">
        <div className="max-w-6xl mx-auto px-4 py-3 text-xs text-gray-500 flex flex-wrap gap-2">
          <span>MCP Media Generator v1.2.0</span>
          <span>•</span>
          <span dir="ltr" className="font-mono">{mcpUrl || "/mcp"}</span>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------ مكونات صغيرة ------------------------------ */

function StatChip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 ${cls}`}>
      <strong>{value}</strong> {label}
    </span>
  );
}

function JsonBlock({ json, onCopy, copied }: { json: string; onCopy: () => void; copied: boolean }) {
  return (
    <div className="relative">
      <pre dir="ltr" className="text-left text-xs bg-gray-950 text-gray-100 rounded-md p-3 pt-10 overflow-x-auto font-mono">
        {json}
      </pre>
      <Button
        size="sm"
        variant="outline"
        className="absolute top-2 left-2 bg-white/90"
        onClick={onCopy}
        title="نسخ JSON"
      >
        {copied ? <Check className="w-4 h-4 text-emerald-700" /> : <Copy className="w-4 h-4" />}
      </Button>
    </div>
  );
}
