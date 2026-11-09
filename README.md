# MCP Media Generator

خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع + لوحة إدارة عربية (RTL).

## القدرات

- **توليد صور** — `gpt-image-2-6/flare-text-to-image` (عبر kie.ai و CometAPI)
- **توليد فيديو بصوت متزامن** — `grok-imagine-video-1-5-preview` (مع image-to-video اختياري)
- **دمج حتى 10 مقاطع** في فيديو واحد — Video Merger API v2
- **تبديل مفاتيح تسلسلي تلقائي**: المفاتيح تُجرَّب بترتيب إضافتها، وعند أي خطأ أو نفاد رصيد ينتقل فورًا للمفتاح التالي **دون توقف المهمة** وبنفس `task_id` — نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.

## خادم MCP

المسار: `/mcp` (نقل Streamable HTTP الرسمي عبر `@modelcontextprotocol/sdk`).

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

1. اربط المستودع على Vercel.
2. أضف متغيرات البيئة الثلاثة (`TURSO_DATABASE_URL`، `TURSO_AUTH_TOKEN`، `MERGER_API_BASE`).
3. Deploy — كل الاتصالات عبر HTTP (مناسب للـ serverless) ولا يوجد أي ملف محلي.

## قواعد جوهرية

1. روابط فقط — لا تُنزَّل وسائط على السيرفر إطلاقًا.
2. المفاتيح تُخفى دائمًا (`maskKey`) في كل الاستجابات والسجلات.
3. مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد مع كل `get_task` (تهدئة 45 ثانية).
4. ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة.
