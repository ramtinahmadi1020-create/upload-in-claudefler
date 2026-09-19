# upload-in-claudefler

Upload a file (up to 20 GB) and get one permanent direct link. Runs entirely on Cloudflare (Workers, R2 and D1). No dependencies besides Wrangler.

آپلود فایل (تا ۲۰ گیگابایت) و دریافت یک لینک مستقیم دائمی. کاملا روی کلودفلر اجرا می‌شود (Workers و R2 و D1).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ramtinahmadi1020-create/upload-in-claudefler)

## Deploy / استقرار

1. Click the button above and sign in to Cloudflare.
2. The R2 bucket and the D1 database are created automatically. Nothing else to set up.

۱. روی دکمه بالا بزن و وارد کلودفلر شو.
۲. باکت R2 و دیتابیس D1 خودکار ساخته می‌شوند و کار دیگری لازم نیست.

If you fork the project, change `REPO_URL` in `wrangler.jsonc` to your own repository address.

## Manual deploy / استقرار دستی

```bash
npm install
npx wrangler login
npx wrangler deploy
```

## How big files work / طرز کار فایل‌های بزرگ

- The browser cuts the file into parts of 90 MB and uploads 4 parts at the same time. Failed parts are retried automatically.
- Every part is stored in R2 under a hidden name. The user only ever sees one link: `/f/<id>/<name>`.
- When someone opens the link, the Worker streams the parts back one after another as a single file. Downloads can be paused and resumed, and video seeking works.
- Before a file is published the server checks that every part exists with the exact size. Unfinished uploads are cleaned up and never appear in the list.
- Finished files are never deleted.

## Other notes / نکات دیگر

- The list of files per device is kept in D1. The table is created automatically on first use.
- Each browser gets a random device key kept in localStorage, a cookie and IndexedDB, so the list survives clearing any one of them.
- Change the size limit with `MAX_UPLOAD_GB` in `wrangler.jsonc`.
- HTML and SVG files are served in a sandbox so they cannot read the site's data.
- R2 charges for storage above its free amount (10 GB on the free tier). Big uploads use that space.

## Local run / اجرای محلی

```bash
npm install
npm run dev
```
