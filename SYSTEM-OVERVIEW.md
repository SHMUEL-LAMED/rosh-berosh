# ראש בראש — מערכת הסקרים המלאה

המאגר כולל שתי גרסאות משלימות:

- הקוד הקיים בשורש המאגר — גרסת GitHub Pages הסטטית, שנשארת פעילה לפרסום הציבורי.
- `full-stack-app/` — מערכת הסקרים המלאה עם Cloudflare Workers, D1 ו-R2.
- `ivr-service/` — שירות Node.js רציף לחיבור מערכת הסקרים לקו ימות המשיח.

## מבנה הפרויקט

```text
.
├── app/                 # גרסת GitHub Pages הקיימת
├── full-stack-app/      # האתר המלא וה-API
└── ivr-service/         # שירות הטלפון
```

## הפעלת האתר המלא

```bash
cd full-stack-app
npm install
npm run dev
```

האתר המלא דורש חיבורי Cloudflare D1 ו-R2 בהתאם לקובץ `.openai/hosting.json`.

## הפעלת שירות הטלפון

```bash
cd ivr-service
npm ci
cp .env.example .env
npm start
```

יש להגדיר ב-`.env` את `SITE_API_BASE_URL` לכתובת האתר המלא, ללא `/` בסוף.

## הערת פריסה

שירות הטלפון חייב לרוץ כתהליך Node.js קבוע, למשל ב-Render, Railway, Fly.io או VPS. הוא אינו מתאים ל-GitHub Pages או ל-Cloudflare Workers רגילים, מפני שהוא שומר את מצב השיחה בזיכרון בין ההקשות.
