# راهنمای استقرار و پیکربندی سامانه دو لایه UP-PRO روی کلودفلر

این بسته شامل سورس‌کد کامل و آماده بهره‌برداری سامانه کارخانه ربات‌ساز **UP-PRO** (لایه اول: `master_up_pro.js`) و ربات‌های آپلودر و ناشر هوشمند فرزند **UP-PROn** (لایه دوم: `child_up_pron.js`) است.

## ۱. فایل تنظیمات `wrangler.toml` برای ورکر مادر (`UP-PRO`)

فایل `wrangler.toml` زیر را در پوشه پروژه اصلی قرار دهید:

```toml
name = "UP-PRO"
main = "master_up_pro.js"
compatibility_date = "2024-09-23"
workers_dev = true

# اتصال دیتابیس D1 مخصوص کارخانه مادر (UP-PRO)
[[d1_databases]]
binding = "DB"
database_name = "up_pro_master_db"
database_id = "REPLACE_WITH_MASTER_D1_UUID"

[vars]
# آیدی عددی تلگرام مدیر اصلی کارخانه (می‌توانید چند آیدی را با کاما جدا کنید)
ADMIN_ID = "123456789"
# توکن ربات تلگرام مادر (UP-PRO) که از @BotFather دریافت کرده‌اید
# توصیه امنیتی: می‌توانید به جای قرار دادن در vars، با دستور wrangler secret put BOT_TOKEN ثبت کنید
BOT_TOKEN = "REPLACE_WITH_MASTER_BOT_TOKEN"
```

## ۲. دستورات ساخت دیتابیس D1 و مقداردهی اولیه جداول (`schema.sql`)

ورکر مادر (`UP-PRO`) به صورت خودکار در اولین درخواست، جداول خود را با `CREATE TABLE IF NOT EXISTS` ایجاد می‌کند. با این حال، برای ساخت دیتابیس و اجرای مستقیم دستورات SQL از طریق Wrangler CLI، دستورات زیر را اجرا کنید:

```bash
# ۱. ساخت دیتابیس D1 برای کارخانه مادر
npx wrangler d1 create up_pro_master_db

# ۲. کپی کردن database_id خروجی دستور بالا و قرار دادن آن در فایل wrangler.toml

# ۳. اجرای اسکیمای اولیه دیتابیس مادر (اختیاری - خود ورکر هم خودکار می‌سازد)
npx wrangler d1 execute up_pro_master_db --remote --command "
CREATE TABLE IF NOT EXISTS factory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  admin_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  data_json TEXT DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deployed_bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_index INTEGER NOT NULL,
  worker_name TEXT UNIQUE NOT NULL,
  bot_token TEXT NOT NULL,
  bot_username TEXT NOT NULL,
  bot_first_name TEXT DEFAULT '',
  cf_account_id TEXT NOT NULL,
  cf_token TEXT NOT NULL,
  d1_id TEXT NOT NULL,
  d1_name TEXT NOT NULL,
  ai_account_id TEXT DEFAULT '',
  ai_api_token TEXT DEFAULT '',
  admin_id TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"
```

## ۳. دیپلوی ورکر مادر (`UP-PRO`) و اتصال وبهوک

```bash
# ۱. ثبت امن توکن ربات مادر (در صورتی که در wrangler.toml قرار نداده‌اید)
npx wrangler secret put BOT_TOKEN

# ۲. انتشار ورکر مادر روی کلودفلر
npx wrangler deploy

# ۳. فعال‌سازی خودکار وبهوک تلگرام ربات مادر:
# کافیست آدرس زیر را یک بار در مرورگر خود باز کنید:
# https://UP-PRO.<YOUR_SUBDOMAIN>.workers.dev/setup-webhook
```

## ۴. خلاصه معماری و قابلیت‌های پیاده‌سازی شده

| بخش | ویژگی‌های کلیدی پیاده‌سازی شده |
| :--- | :--- |
| **کارخانه مادر (`UP-PRO`)** | ویزارد ۴ مرحله‌ای با لینک‌های مستقیم ۱-کلیکی ساخت توکن کلودفلر (اکانت ۱ برای Worker/D1 و اکانت ۲ برای Workers AI)، ساخت خودکار دیتابیس `up_pro_{n}_db`، آپلود Multipart ES Module ورکر `UP-PRO{n}`، فعال‌سازی ساب‌دامین `workers.dev`، تنظیم وبهوک امن با `secret_token`، تست سلامت زنده (`/health` و `getWebhookInfo`)، تغییر ادمین، حذف کامل از کلودفلر و آپدیت همگانی ۱-کلیکی تمام ربات‌های فرزند. |
| **موتور آپلود بدون دانلود (`UP-PROn`)** | ذخیره اتمیک `file_id` و `file_unique_id` در جدول `staging_files` بدون دانلود بافر فایل، پشتیبانی کامل از ارسال همزمان آلبوم‌های ۱۰تایی، شمارنده زنده تفکیکی و تولید کد یکتای `PRD_xxxx`. |
| **تحویل فایل و حذف خودکار ۳۰ ثانیه‌ای** | تحویل فایل‌ها با `copyMessage` (بدون نام فوروارد)، پشتیبانی از رمز عبور اختصاصی هر کد و قفل فوروارد (`protect_content`)، و حذف خودکار دسته‌ای پیام‌ها با `ctx.waitUntil` بدون نیاز به Cron Trigger. |
| **قفل‌های عضویت اجباری پیشرفته** | قفل کانال تلگرام با بررسی اجباری ادمین بودن ربات هنگام ثبت + سیستم ایمنی خودکار (Auto-Bypass) در صورت حذف ربات از ادمینی کانال در آینده + قفل لینک خارجی/ربات دیگر. |
| **ناشر هوشمند AI و اتصال دوطرفه کانال** | اجرای دوگانه هوش مصنوعی (`runCloudflareAI` با اولویت اکانت دوم و Fallback خودکار به بایندینگ `env.AI` اکانت اول)، تایید دوطرفه کانال مقصد، ۳ لحن نگارش فارسی (`Llama-3.1-8b-instruct`)، ۳ حالت کاور (`Flux-1-schnell` / اینترنت / عکس خود کالا)، پیش‌نمایش زنده و قابلیت ویرایش زنده پست منتشر شده در کانال از داخل پنل CRUD. |
