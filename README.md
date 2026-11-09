# MCP Media Generator

خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع + لوحة إدارة عربية (RTL).

## القدرات

- **توليد صور** — `gpt-image-2-6/flare-text-to-image` (عبر kie.ai و CometAPI)
- **توليد فيديو بصوت متزامن** — `grok-imagine-video-1-5-preview` (مع image-to-video اختياري)
- **دمج حتى 10 مقاطع** في فيديو واحد — Video Merger API v2
- **تبديل مفاتيح تسلسلي تلقائي**: المفاتيح تُجرَّب بترتيب إضافتها، وعند أي خطأ أو نفاد رصيد ينتقل فورًا للمفتاح التالي **دون توقف المهمة** وبنفس `task_id` — نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.

## خادم MCP

المسار: `/mcp` (نقل Streamable HTTP الرسمي عبر `@modelcontextprotocol/sdk`) — **وضع stateless**: يُبنى خادم جديد لكل طلب، لا توجد جلسات في الذاكرة، لذا يعمل بلا مشاكل على Vercel والمنصات اللاخادمية (تجاهل ترويسة `mcp-session-id` طبيعي ومطابق للنمط الرسمي من SDK).

الأدوات الخمس: `generate_image` · `generate_video` · `merge_videos` · `get_task` · `list_media`

### الربط من أي عميل

```json
{
  "mcpServers": {
    "media-generator": { "url": "https://<your-domain>/mcp" }
  }
}
```

- **ChatGPT**: Settings → Connectors → Create → Custom MCP server، وضع الرابط في «Server URL».
- **Claude Desktop**: أضف `"type": "http"` داخل الإعداد في `claude_desktop_config.json`.
- **Cursor / Windsurf / Cline**: نفس الصيغة في `mcp.json`.
- إن ضُبط `MCP_ACCESS_TOKEN` أضِف `headers.Authorization: Bearer <token>`.

## متغيرات البيئة

| المتغير | إلزامي | الوصف |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | نعم | رابط قاعدة Turso مثل `libsql://<db>-<org>.aws-eu-west-1.turso.io` |
| `TURSO_AUTH_TOKEN` | نعم | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | للدمج | عنوان خدمة دمج الفيديو (بلا مفاتيح) |
| `MCP_ACCESS_TOKEN` | اختياري | يحمي `/mcp` بمصادقة Bearer |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | اختياري | تجاوز أسماء الموديلات لدى المزودين |

## التشغيل محليًا

```bash
bun install
bun run dev          # http://localhost:3000
```

الجداول تُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — لا migrations.

## النشر على Vercel

1. اربط المستودع على Vercel (Import Git Repository).
2. أضف متغيرات البيئة من **Settings → Environment Variables** (انظر الجدول أعلاه):
   - `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` إلزاميان.
   - `MERGER_API_BASE` اختياري عمليًا: بدونه كل شيء يعمل عادي ما عدا أداة `merge_videos` التي تعيد رسالة عربية واضحة بأن الخدمة غير مهيأة.
   - `MCP_ACCESS_TOKEN` اختياري لحماية `/mcp`.
3. **مفاتيح التوليد (kie.ai / CometAPI) لا تُضاف إلى Vercel** — تُضاف من لوحة الإدارة بعد النشر (قسم «مدير المفاتيح»).
4. Deploy. لا يوجد أي ملف محلي — كل الاتصالات HTTP (Turso + المزودون + خدمة الدمج).

### ملاحظات نشر مهمة

- **`maxDuration = 300`** مضبوط على مسار `/mcp`: نافذة الانتظار القصوى للأدوات 240 ثانية. إن رفضته خطتك، خفّضه إلى 60 — المهمة تبقى محفوظة في Turso وتكتمل عبر `get_task` حتى لو انتهت مدة الدالة.
- يُفضَّل ضبط Region للدوال قريبًا من قاعدة Turso (مثلاً `fra1` لقاعدة `aws-eu-west-1`) لتقليل زمن الاستجابة.
- **توليد الفيديو أغلى من الصور** في kie.ai: إن لم يكن الرصيد كافيًا تبقى المهمة `processing` («بانتظار توفر مفتاح صالح…») وتُعاد محاولتها تلقائيًا مع كل `get_task` بعد شحن الرصيد أو إضافة مفتاح آخر.
- أضف عدة مفاتيح لكل مزود من لوحة الإدارة — التجربة تسلسلية مع تبديل فوري عند أي خطأ.

## التشغيل محليًا

```bash
bun install
bun run dev          # http://localhost:3000
```

انسخ `.env.example` إلى `.env.local` واملأ القيم. الجداول تُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — لا migrations.

## اختبارات جاهزة

```bash
bash scripts/mcp-test.sh init                      # initialize (وضع stateless — بلا جلسة)
bash scripts/mcp-test.sh tools                     # tools/list
bash scripts/mcp-test.sh calltool generate_image '{"prompt":"قطة فضائية","wait_seconds":90}'
node scripts/e2e-test.mjs all                      # صورة + فيديو + رسائل الأخطاء العربية
```

## قواعد جوهرية

1. روابط فقط — لا تُنزَّل وسائط على السيرفر إطلاقًا.
2. المفاتيح تُخفى دائمًا (`maskKey`) في كل الاستجابات والسجلات.
3. مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد مع كل `get_task` (تهدئة 45 ثانية).
4. ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة.
