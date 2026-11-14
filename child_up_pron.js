/**
 * ============================================================================
 * UP-PRO{n} — Standalone Child Telegram File Uploader & AI Channel Publisher
 * ============================================================================
 * Architecture: Zero-Dependency Cloudflare Worker (ES Module) + Cloudflare D1
 * Features:
 *   1. Zero-Download Upload & Atomic Staging Engine (Single & Album Media Groups)
 *   2. Product Code Generator (PRD_xxxx) + Auto-Archive Backup Channel Support
 *   3. User File Delivery via copyMessage + Fallback Media Send + Password Protection
 *   4. Zero-Cron Auto-Delete Engine via ctx.waitUntil() (15s/30s/45s/60s/Off)
 *   5. Advanced Force-Join Lock System (Real Channel API Check + Auto-Bypass + URL Locks)
 *   6. Dual-Account Cloudflare Workers AI Engine (Account 2 REST API + Account 1 Binding Fallback)
 *   7. Two-Way Target Channel Handshake + 3 AI Moods + 3 Cover Modes + Live Channel Post Edit
 *   8. Full Admin CRUD Panel (/panel), Empty/Broken Product Filter, Stats & Chunked Broadcast
 * ============================================================================
 */

const CHILD_VERSION = "2.5.0";

const DEFAULT_SETTINGS = {
  delete_timer: "30",
  global_protect_content: "0",
  start_text:
    "👋 سلام {name} عزیز!\n\nبه ربات دانلود و اشتراک‌گذاری فایل خوش آمدید.\nبرای دریافت فایل‌ها، روی لینک اختصاصی هر پست در کانال کلیک کنید.",
  delete_warning_text:
    "⚠️ توجه: این فایل‌ها تا {delete_timer} ثانیه دیگر به صورت خودکار حذف می‌شوند! لطفاً همین الان آن‌ها را به Saved Messages خود فوروارد کنید.",
  not_found_text:
    "❌ کد کالای مورد نظر یافت نشد، غیرفعال شده یا هنوز فایلی برای آن ثبت نشده است.",
  target_channel_id: "",
  target_channel_title: "",
  target_channel_username: "",
  pending_channel_id: "",
  pending_channel_title: "",
  pending_channel_username: "",
  backup_chat_id: "",
  ai_mood: "viral", // viral | official | minimal
  ai_cover_mode: "ai_gen", // ai_gen | internet | product_photo
  post_footer: "💎 @MyChannel | #آپلودر_اختصاصی",
  dl_button_template: "📥 دانلود فایل‌ها (کد: {code})",
  ai_account_id: "",
  ai_api_token: "",
  bot_id: "",
  bot_username: "",
  admin_id_override: "",
};

const CHILD_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    joined_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS user_states (
    user_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    data_json TEXT DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS staging_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_unique_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    file_name TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    caption TEXT DEFAULT '',
    source_chat_id TEXT DEFAULT '',
    source_message_id INTEGER DEFAULT 0,
    media_group_id TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS products (
    code TEXT PRIMARY KEY,
    title TEXT DEFAULT '',
    custom_caption TEXT DEFAULT '',
    password TEXT DEFAULT '',
    protect_content INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    views_count INTEGER DEFAULT 0,
    files_count INTEGER DEFAULT 0,
    channel_chat_id TEXT DEFAULT '',
    channel_message_id INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    last_accessed_at TEXT DEFAULT ''
  );`,
  `CREATE TABLE IF NOT EXISTS product_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_unique_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    file_name TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    caption TEXT DEFAULT '',
    source_chat_id TEXT DEFAULT '',
    source_message_id INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS force_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lock_type TEXT NOT NULL,
    title TEXT NOT NULL,
    chat_id TEXT DEFAULT '',
    invite_link TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS ai_drafts (
    product_code TEXT PRIMARY KEY,
    topic TEXT DEFAULT '',
    generated_caption TEXT DEFAULT '',
    cover_file_id TEXT DEFAULT '',
    cover_url TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  );`,
];

let schemaInitialized = false;

async function ensureSchema(db) {
  if (schemaInitialized) return;
  for (const sql of CHILD_SCHEMA_STATEMENTS) {
    await db.prepare(sql).run();
  }
  schemaInitialized = true;
}

// ============================================================================
// Database & Settings Helpers
// ============================================================================

async function getAllSettings(db, env) {
  const res = await db.prepare("SELECT key, value FROM settings").all();
  const map = { ...DEFAULT_SETTINGS };
  if (res && Array.isArray(res.results)) {
    for (const row of res.results) {
      map[row.key] = row.value;
    }
  }
  if (!map.ai_account_id && env.AI_ACCOUNT_ID) map.ai_account_id = env.AI_ACCOUNT_ID;
  if (!map.ai_api_token && env.AI_API_TOKEN) map.ai_api_token = env.AI_API_TOKEN;
  if (!map.bot_username && env.BOT_USERNAME) map.bot_username = env.BOT_USERNAME;
  return map;
}

async function setSetting(db, key, value) {
  await db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .bind(String(key), String(value ?? ""))
    .run();
}

async function getUserState(db, userId) {
  const row = await db
    .prepare("SELECT state, data_json FROM user_states WHERE user_id = ?1")
    .bind(String(userId))
    .first();
  if (!row) return { state: "IDLE", data: {} };
  let parsed = {};
  try {
    parsed = JSON.parse(row.data_json || "{}");
  } catch (_) {
    parsed = {};
  }
  return { state: row.state || "IDLE", data: parsed };
}

async function setUserState(db, userId, state, data = {}) {
  await db
    .prepare(
      "INSERT INTO user_states (user_id, state, data_json, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data_json = excluded.data_json, updated_at = excluded.updated_at"
    )
    .bind(String(userId), String(state), JSON.stringify(data || {}), Date.now())
    .run();
}

async function clearUserState(db, userId) {
  await db
    .prepare("DELETE FROM user_states WHERE user_id = ?1")
    .bind(String(userId))
    .run();
}

async function trackUser(db, from) {
  if (!from || !from.id) return;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO users (user_id, username, first_name, joined_at, last_active_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username,
         first_name = excluded.first_name,
         last_active_at = excluded.last_active_at`
    )
    .bind(
      String(from.id),
      from.username ? String(from.username) : "",
      from.first_name ? String(from.first_name) : "کاربر",
      now
    )
    .run();
}

function isAdminUser(userId, env, settings) {
  const primaryAdmin = String(settings.admin_id_override || env.ADMIN_ID || "").trim();
  const envAdmin = String(env.ADMIN_ID || "").trim();
  const uid = String(userId || "").trim();
  return Boolean(uid && (uid === primaryAdmin || uid === envAdmin));
}

// ============================================================================
// Telegram Bot API Helpers
// ============================================================================

async function tgApi(botToken, method, payload = {}) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  try {
    return await resp.json();
  } catch (err) {
    return { ok: false, description: String(err) };
  }
}

async function tgSendPhotoBinary(botToken, chatId, imageBytes, caption, replyMarkup) {
  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  if (replyMarkup) {
    form.append("reply_markup", JSON.stringify(replyMarkup));
  }
  const blob = new Blob([imageBytes], { type: "image/jpeg" });
  form.append("photo", blob, "cover.jpg");
  const resp = await fetch(url, { method: "POST", body: form });
  try {
    return await resp.json();
  } catch (err) {
    return { ok: false, description: String(err) };
  }
}

async function ensureBotIdentity(db, env, settings) {
  if (settings.bot_id && settings.bot_username) {
    return { id: settings.bot_id, username: settings.bot_username };
  }
  const me = await tgApi(env.BOT_TOKEN, "getMe", {});
  if (me && me.ok && me.result) {
    const id = String(me.result.id);
    const username = String(me.result.username || "");
    await setSetting(db, "bot_id", id);
    await setSetting(db, "bot_username", username);
    settings.bot_id = id;
    settings.bot_username = username;
    return { id, username };
  }
  return { id: "", username: env.BOT_USERNAME || "" };
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractMediaFromMessage(message) {
  if (!message) return null;
  const caption = message.caption || "";
  const mediaGroupId = message.media_group_id ? String(message.media_group_id) : "";

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const bestPhoto = message.photo[message.photo.length - 1];
    return {
      file_id: bestPhoto.file_id,
      file_unique_id: bestPhoto.file_unique_id,
      media_type: "photo",
      file_name: "photo.jpg",
      file_size: bestPhoto.file_size || 0,
      caption,
      media_group_id: mediaGroupId,
    };
  }
  if (message.video) {
    return {
      file_id: message.video.file_id,
      file_unique_id: message.video.file_unique_id,
      media_type: "video",
      file_name: message.video.file_name || "video.mp4",
      file_size: message.video.file_size || 0,
      caption,
      media_group_id: mediaGroupId,
    };
  }
  if (message.document) {
    return {
      file_id: message.document.file_id,
      file_unique_id: message.document.file_unique_id,
      media_type: "document",
      file_name: message.document.file_name || "document",
      file_size: message.document.file_size || 0,
      caption,
      media_group_id: mediaGroupId,
    };
  }
  if (message.audio) {
    return {
      file_id: message.audio.file_id,
      file_unique_id: message.audio.file_unique_id,
      media_type: "audio",
      file_name: message.audio.file_name || message.audio.title || "audio.mp3",
      file_size: message.audio.file_size || 0,
      caption,
      media_group_id: mediaGroupId,
    };
  }
  if (message.animation) {
    return {
      file_id: message.animation.file_id,
      file_unique_id: message.animation.file_unique_id,
      media_type: "animation",
      file_name: message.animation.file_name || "animation.gif",
      file_size: message.animation.file_size || 0,
      caption,
      media_group_id: mediaGroupId,
    };
  }
  if (message.voice) {
    return {
      file_id: message.voice.file_id,
      file_unique_id: message.voice.file_unique_id,
      media_type: "voice",
      file_name: "voice.ogg",
      file_size: message.voice.file_size || 0,
      caption,
      media_group_id: mediaGroupId,
    };
  }
  return null;
}

async function deliverSingleFile(botToken, targetChatId, fileRecord, protectContent) {
  // Primary delivery: Telegram copyMessage API (zero forward header)
  if (fileRecord.source_chat_id && fileRecord.source_message_id) {
    const copyRes = await tgApi(botToken, "copyMessage", {
      chat_id: targetChatId,
      from_chat_id: fileRecord.source_chat_id,
      message_id: Number(fileRecord.source_message_id),
      protect_content: Boolean(protectContent),
    });
    if (copyRes && copyRes.ok && copyRes.result && copyRes.result.message_id) {
      return copyRes.result.message_id;
    }
  }

  // Fallback delivery by file_id if original chat message was removed
  const methodMap = {
    photo: ["sendPhoto", "photo"],
    video: ["sendVideo", "video"],
    document: ["sendDocument", "document"],
    audio: ["sendAudio", "audio"],
    animation: ["sendAnimation", "animation"],
    voice: ["sendVoice", "voice"],
  };
  const [method, field] = methodMap[fileRecord.media_type] || ["sendDocument", "document"];
  const payload = {
    chat_id: targetChatId,
    [field]: fileRecord.file_id,
    protect_content: Boolean(protectContent),
  };
  if (fileRecord.caption) {
    payload.caption = fileRecord.caption;
  }
  const res = await tgApi(botToken, method, payload);
  if (res && res.ok && res.result && res.result.message_id) {
    return res.result.message_id;
  }
  return null;
}

async function deleteMessagesBatch(botToken, chatId, messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return;
  const validIds = messageIds.filter((id) => Number.isInteger(Number(id)) && Number(id) > 0);
  if (validIds.length === 0) return;

  // Attempt batch deleteMessages first (supports up to 100 messages)
  const batchRes = await tgApi(botToken, "deleteMessages", {
    chat_id: chatId,
    message_ids: validIds,
  });
  if (batchRes && batchRes.ok) return;

  // Fallback to individual deleteMessage calls
  for (const msgId of validIds) {
    await tgApi(botToken, "deleteMessage", {
      chat_id: chatId,
      message_id: msgId,
    });
  }
}

// ============================================================================
// Dual-Account Cloudflare Workers AI Helper
// ============================================================================

async function runCloudflareAI(env, settings, model, payload, expectBinary = false) {
  const aiAccountId = (settings.ai_account_id || env.AI_ACCOUNT_ID || "").trim();
  const aiApiToken = (settings.ai_api_token || env.AI_API_TOKEN || "").trim();

  // 1. Primary Method: Account 2 (or configured token) via Cloudflare REST API
  if (aiAccountId && aiApiToken) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${aiAccountId}/ai/run/${model}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aiApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (resp.ok) {
        const contentType = resp.headers.get("content-type") || "";
        if (expectBinary && !contentType.includes("application/json")) {
          const arrayBuf = await resp.arrayBuffer();
          return { ok: true, binary: new Uint8Array(arrayBuf), source: "rest_api" };
        }
        const data = await resp.json();
        if (data && data.success && data.result) {
          if (expectBinary && data.result.image) {
            const binStr = atob(data.result.image);
            const bytes = new Uint8Array(binStr.length);
            for (let i = 0; i < binStr.length; i++) {
              bytes[i] = binStr.charCodeAt(i);
            }
            return { ok: true, binary: bytes, source: "rest_api" };
          }
          return { ok: true, result: data.result, source: "rest_api" };
        }
      }
    } catch (_) {
      // Automatically fall through to Account 1 binding
    }
  }

  // 2. Automatic Fallback: Account 1 Native Workers AI Binding (env.AI)
  if (env.AI && typeof env.AI.run === "function") {
    try {
      const aiRes = await env.AI.run(model, payload);
      if (expectBinary) {
        if (aiRes instanceof ReadableStream) {
          const buf = await new Response(aiRes).arrayBuffer();
          return { ok: true, binary: new Uint8Array(buf), source: "binding" };
        }
        if (aiRes instanceof Uint8Array || aiRes instanceof ArrayBuffer) {
          return {
            ok: true,
            binary: aiRes instanceof Uint8Array ? aiRes : new Uint8Array(aiRes),
            source: "binding",
          };
        }
        if (aiRes && aiRes.image) {
          const binStr = atob(aiRes.image);
          const bytes = new Uint8Array(binStr.length);
          for (let i = 0; i < binStr.length; i++) {
            bytes[i] = binStr.charCodeAt(i);
          }
          return { ok: true, binary: bytes, source: "binding" };
        }
      }
      return { ok: true, result: aiRes, source: "binding" };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  return {
    ok: false,
    error: "هیچ توکن هوش مصنوعی یا بایندینگ AI فعالی یافت نشد.",
  };
}

// ============================================================================
// Force-Join Lock Verification Engine (With Runtime Safety Auto-Bypass)
// ============================================================================

async function checkUserForceLocks(db, env, settings, userId) {
  const locksRes = await db
    .prepare("SELECT * FROM force_locks WHERE is_active = 1 ORDER BY id ASC")
    .all();
  const locks = (locksRes && locksRes.results) || [];
  if (locks.length === 0) {
    return { locked: false, missingChannelLocks: [], urlLocks: [] };
  }

  const missingChannelLocks = [];
  const urlLocks = [];
  const primaryAdmin = String(settings.admin_id_override || env.ADMIN_ID || "").trim();

  for (const lock of locks) {
    if (lock.lock_type === "url") {
      urlLocks.push(lock);
      continue;
    }

    if (lock.lock_type === "channel" && lock.chat_id) {
      const memberRes = await tgApi(env.BOT_TOKEN, "getChatMember", {
        chat_id: lock.chat_id,
        user_id: Number(userId),
      });

      if (!memberRes || !memberRes.ok) {
        // Runtime Safety: Bot was removed from admin or channel is unreachable -> Auto-bypass & alert admin
        const errDesc = (memberRes && memberRes.description) || "Unknown API Error";
        await db
          .prepare("UPDATE force_locks SET is_active = 0 WHERE id = ?1")
          .bind(lock.id)
          .run();
        if (primaryAdmin) {
          await tgApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: primaryAdmin,
            parse_mode: "HTML",
            text:
              `⚠️ <b>هشدار ایمنی خودکار قفل عضویت اجباری</b>\n\n` +
              `ربات هنگام بررسی عضویت کاربران در کانال <b>${escapeHtml(lock.title)}</b> (<code>${escapeHtml(lock.chat_id)}</code>) با خطا مواجه شد:\n` +
              `<code>${escapeHtml(errDesc)}</code>\n\n` +
              `✅ برای جلوگیری از قفل شدن ربات روی کاربران، این قفل به صورت خودکار <b>غیرفعال (Bypass)</b> شد. لطفاً دسترسی ادمینی ربات در کانال را بررسی کنید.`,
          });
        }
        continue;
      }

      const status = memberRes.result && memberRes.result.status;
      const isJoined =
        status === "creator" ||
        status === "administrator" ||
        status === "member" ||
        (status === "restricted" && memberRes.result.is_member === true);

      if (!isJoined) {
        missingChannelLocks.push(lock);
      }
    }
  }

  return {
    locked: missingChannelLocks.length > 0,
    missingChannelLocks,
    urlLocks,
  };
}

function buildForceLockKeyboard(missingChannelLocks, urlLocks, productCode) {
  const inline_keyboard = [];
  for (const ch of missingChannelLocks) {
    inline_keyboard.push([
      {
        text: `📢 عضویت در «${ch.title}»`,
        url: ch.invite_link,
      },
    ]);
  }
  for (const u of urlLocks) {
    inline_keyboard.push([
      {
        text: `🔗 ${u.title}`,
        url: u.invite_link,
      },
    ]);
  }
  inline_keyboard.push([
    {
      text: "✅ عضو شدم / دریافت فایل",
      callback_data: `chk_join:${productCode || "NONE"}`,
    },
  ]);
  return { inline_keyboard };
}

// ============================================================================
// User File Delivery Flow
// ============================================================================

async function handleProductDelivery(ctx, db, env, settings, chatId, userId, productCode, skipPassword = false) {
  // 1. Check Force-Join Locks first
  const lockStatus = await checkUserForceLocks(db, env, settings, userId);
  if (lockStatus.locked) {
    const kb = buildForceLockKeyboard(
      lockStatus.missingChannelLocks,
      lockStatus.urlLocks,
      productCode
    );
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `🔒 <b>تایید عضویت در اسپانسرها</b>\n\n` +
        `کاربر گرامی، برای دریافت فایل‌های کد <code>${escapeHtml(productCode)}</code> ابتدا در کانال‌های زیر عضو شوید و سپس روی دکمه <b>«✅ عضو شدم / دریافت فایل»</b> بزنید:`,
      reply_markup: kb,
    });
    return;
  }

  // 2. Check if product exists and is active
  const product = await db
    .prepare("SELECT * FROM products WHERE code = ?1")
    .bind(productCode)
    .first();

  if (!product || Number(product.is_active) !== 1) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: settings.not_found_text || DEFAULT_SETTINGS.not_found_text,
    });
    return;
  }

  const filesRes = await db
    .prepare("SELECT * FROM product_files WHERE product_code = ?1 ORDER BY id ASC")
    .bind(productCode)
    .all();
  const files = (filesRes && filesRes.results) || [];

  if (files.length === 0) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: settings.not_found_text || DEFAULT_SETTINGS.not_found_text,
    });
    return;
  }

  // 3. Check Password Protection
  if (product.password && product.password.trim() !== "" && !skipPassword) {
    await setUserState(db, userId, "AWAIT_PRODUCT_PASS", { code: productCode });
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `🔐 <b>این بسته دارای رمز عبور است!</b>\n\n` +
        `لطفاً رمز عبور مربوط به کد <code>${escapeHtml(productCode)}</code> را ارسال کنید:`,
      reply_markup: {
        inline_keyboard: [[{ text: "❌ انصراف", callback_data: "user_cancel" }]],
      },
    });
    return;
  }

  // 4. Increment views_count & update last_accessed_at
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      "UPDATE products SET views_count = views_count + 1, last_accessed_at = ?1 WHERE code = ?2"
    )
    .bind(nowIso, productCode)
    .run();

  // 5. Deliver all files using copyMessage (zero forward header)
  const protectContent =
    Number(product.protect_content) === 1 ||
    String(settings.global_protect_content) === "1";

  const sentMessageIds = [];
  for (const fileRec of files) {
    const msgId = await deliverSingleFile(
      env.BOT_TOKEN,
      chatId,
      fileRec,
      protectContent
    );
    if (msgId) {
      sentMessageIds.push(msgId);
    }
  }

  // 6. Send Warning & Schedule Zero-Cron Auto-Delete via ctx.waitUntil
  const deleteTimer = parseInt(settings.delete_timer || "30", 10);
  if (deleteTimer > 0 && !protectContent && sentMessageIds.length > 0) {
    const warningTemplate =
      settings.delete_warning_text || DEFAULT_SETTINGS.delete_warning_text;
    const warningText = warningTemplate.replace(
      /\{delete_timer\}/g,
      String(deleteTimer)
    );

    const warnRes = await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: warningText,
    });
    if (warnRes && warnRes.ok && warnRes.result && warnRes.result.message_id) {
      sentMessageIds.push(warnRes.result.message_id);
    }

    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(
        new Promise((resolve) => setTimeout(resolve, deleteTimer * 1000)).then(
          () => deleteMessagesBatch(env.BOT_TOKEN, chatId, sentMessageIds)
        )
      );
    }
  } else if (protectContent && sentMessageIds.length > 0) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `🛡 <b>قفل فوروارد و ذخیره (Protect Content) برای این بسته فعال است.</b>`,
    });
  }
}

// ============================================================================
// Admin UI Menus & Panels (Fluent Persian + Clean Glass Navigation)
// ============================================================================

function getAdminMainKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "➕ آپلود فایل / ساخت کد کالا",
          callback_data: "adm_start_staging",
        },
      ],
      [
        { text: "📦 مدیریت کامل کالاها (CRUD)", callback_data: "adm_crud_list:1" },
        { text: "⚠️ کالاهای ناقص/خالی", callback_data: "adm_crud_empty" },
      ],
      [
        { text: "🤖 هوش مصنوعی و کانال", callback_data: "adm_ai_menu" },
        { text: "🔐 مدیریت قفل‌ها", callback_data: "adm_locks_menu" },
      ],
      [
        { text: "🗄 کانال/گروه بکاپ خودکار", callback_data: "adm_backup_menu" },
        { text: "⚙️ شخصی‌سازی متون و تایمر", callback_data: "adm_settings_menu" },
      ],
      [
        { text: "📊 آمار و ارسال همگانی هوشمند", callback_data: "adm_stats_menu" },
      ],
    ],
  };
}

async function renderAdminHomePanel(db, env, settings, chatId, messageId = null) {
  const counts = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM products) AS total_products,
        (SELECT COUNT(*) FROM product_files) AS total_files,
        (SELECT COALESCE(SUM(views_count), 0) FROM products) AS total_views`
    )
    .first();

  const workerName = env.WORKER_NAME || "UP-PROn";
  const channelLabel = settings.target_channel_title
    ? `✅ متصل به «${escapeHtml(settings.target_channel_title)}»`
    : "⚪ متصل نشده";
  const timerLabel =
    Number(settings.delete_timer) > 0
      ? `${settings.delete_timer} ثانیه`
      : "خاموش (بدون حذف)";

  const text =
    `🎛 <b>پنل مدیریت پیشرفته آپلودر و ناشر هوشمند (${escapeHtml(workerName)})</b>\n\n` +
    `👥 کل کاربران: <b>${counts?.total_users || 0}</b> نفر\n` +
    `📦 کل کدهای کالا: <b>${counts?.total_products || 0}</b> بسته (${counts?.total_files || 0} فایل)\n` +
    `📥 مجموع دانلودها: <b>${counts?.total_views || 0}</b> بار\n` +
    `📢 کانال مقصد AI: ${channelLabel}\n` +
    `⏱ تایمر حذف خودکار: <b>${timerLabel}</b>\n\n` +
    `👇 از دکمه‌های شیشه‌ای زیر بخش مورد نظر خود را انتخاب کنید:`;

  const kb = getAdminMainKeyboard();
  if (messageId) {
    const editRes = await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text,
      reply_markup: kb,
    });
    if (editRes && editRes.ok) return;
  }
  await tgApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text,
    reply_markup: kb,
  });
}

// ============================================================================
// Staging & Product Code Generation Engine
// ============================================================================

async function getStagingSummary(db, adminId) {
  const rows = await db
    .prepare("SELECT * FROM staging_files WHERE admin_id = ?1 ORDER BY id ASC")
    .bind(String(adminId))
    .all();
  const list = (rows && rows.results) || [];
  const counts = {
    total: list.length,
    video: 0,
    photo: 0,
    document: 0,
    audio: 0,
    animation: 0,
    voice: 0,
  };
  for (const item of list) {
    if (counts[item.media_type] !== undefined) {
      counts[item.media_type]++;
    }
  }
  return { list, counts };
}

function buildStagingStatusText(counts, targetCode = null) {
  const extraParts = [];
  if (counts.document > 0) extraParts.push(`${counts.document} فایل/سند`);
  if (counts.audio > 0) extraParts.push(`${counts.audio} موزیک/صوت`);
  if (counts.animation > 0) extraParts.push(`${counts.animation} گیف`);
  if (counts.voice > 0) extraParts.push(`${counts.voice} ویس`);
  const extraStr = extraParts.length > 0 ? `، ${extraParts.join("، ")}` : "";

  const header = targetCode
    ? `➕ <b>در حال افزودن فایل به کد کالای <code>${escapeHtml(targetCode)}</code></b>\n\n`
    : `📤 <b>حالت دریافت و آپلود فایل فعال است</b>\n\n`;

  return (
    header +
    `📊 تعداد فایل‌های دریافت شده تا الان: <b>${counts.total} فایل</b> (${counts.video} ویدیو، ${counts.photo} عکس${extraStr})\n\n` +
    `💡 می‌توانید فایل‌های تکی یا آلبوم‌های چندتایی را ارسال یا فوروارد کنید. پس از ارسال همه فایل‌ها روی دکمه زیر بزنید:`
  );
}

function buildStagingKeyboard(targetCode = null) {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ اتمام و آنالیز نهایی",
          callback_data: targetCode
            ? `adm_finish_staging:${targetCode}`
            : "adm_finish_staging:NEW",
        },
      ],
      [
        {
          text: "🗑 پاکسازی لیست موقت",
          callback_data: "adm_clear_staging",
        },
      ],
      [{ text: "🔙 انصراف و بازگشت به پنل", callback_data: "adm_home" }],
    ],
  };
}

async function generateUniqueProductCode(db) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const num = Math.floor(1000 + Math.random() * 9000);
    const code = `PRD_${num}`;
    const existing = await db
      .prepare("SELECT code FROM products WHERE code = ?1")
      .bind(code)
      .first();
    if (!existing) return code;
  }
  return `PRD_${Date.now().toString().slice(-5)}`;
}

async function finalizeStagingAndCreateProduct(db, env, settings, chatId, adminId, messageId, existingCode = null) {
  const { list, counts } = await getStagingSummary(db, adminId);
  if (list.length === 0) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: "⚠️ هنوز هیچ فایلی در لیست موقت دریافت نشده است! لطفاً ابتدا فایل‌های خود را ارسال کنید.",
    });
    return;
  }

  const botIdentity = await ensureBotIdentity(db, env, settings);
  const nowIso = new Date().toISOString();
  let productCode = existingCode && existingCode !== "NEW" ? existingCode : null;

  if (!productCode) {
    productCode = await generateUniqueProductCode(db);
    const firstCaption = (list.find((f) => f.caption)?.caption || "").slice(0, 120);
    await db
      .prepare(
        `INSERT INTO products (code, title, custom_caption, password, protect_content, is_active, views_count, files_count, created_at)
         VALUES (?1, ?2, ?3, '', 0, 1, 0, ?4, ?5)`
      )
      .bind(productCode, firstCaption || `بسته ${productCode}`, firstCaption, list.length, nowIso)
      .run();
  }

  for (const f of list) {
    await db
      .prepare(
        `INSERT INTO product_files (product_code, file_id, file_unique_id, media_type, file_name, file_size, caption, source_chat_id, source_message_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(
        productCode,
        f.file_id,
        f.file_unique_id,
        f.media_type,
        f.file_name || "",
        f.file_size || 0,
        f.caption || "",
        f.source_chat_id || "",
        f.source_message_id || 0,
        nowIso
      )
      .run();
  }

  // Recompute total files_count for product
  const countRow = await db
    .prepare("SELECT COUNT(*) AS cnt FROM product_files WHERE product_code = ?1")
    .bind(productCode)
    .first();
  await db
    .prepare("UPDATE products SET files_count = ?1, is_active = 1 WHERE code = ?2")
    .bind(countRow?.cnt || list.length, productCode)
    .run();

  // Clear staging_files and state
  await db
    .prepare("DELETE FROM staging_files WHERE admin_id = ?1")
    .bind(String(adminId))
    .run();
  await clearUserState(db, adminId);

  const deepLink = `https://t.me/${botIdentity.username || "Bot"}?start=${productCode}`;

  // Optional Auto-Archive to Backup Channel / Group
  if (settings.backup_chat_id && settings.backup_chat_id.trim() !== "") {
    const bChatId = settings.backup_chat_id.trim();
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: bChatId,
      parse_mode: "HTML",
      text:
        `🗄 <b>بکاپ خودکار بسته جدید</b>\n` +
        `🔖 کد کالا: <code>${escapeHtml(productCode)}</code>\n` +
        `📦 تعداد فایل‌های جدید: <b>${counts.total}</b>\n` +
        `🔗 لینک دانلود:\n${deepLink}`,
    });
    for (const f of list) {
      await deliverSingleFile(env.BOT_TOKEN, bChatId, f, false);
    }
  }

  const productRow = await db
    .prepare("SELECT * FROM products WHERE code = ?1")
    .bind(productCode)
    .first();

  const protectIcon = Number(productRow?.protect_content) === 1 ? "✅ فعال" : "⚪ غیرفعال";
  const passIcon = productRow?.password ? `✅ تنظیم شده (${productRow.password})` : "⚪ ندارد";

  const summaryText =
    `✅ <b>آنالیز نهایی و ثبت کد کالا با موفقیت انجام شد!</b>\n\n` +
    `🔖 <b>کد اختصاصی کالا:</b> <code>${escapeHtml(productCode)}</code>\n` +
    `📊 <b>جزئیات فایل‌های ثبت شده در این مرحله:</b>\n` +
    `• کل فایل‌ها: <b>${counts.total} فایل</b>\n` +
    `• ویدیو: <b>${counts.video}</b> | عکس: <b>${counts.photo}</b>\n` +
    `• سند/فایل: <b>${counts.document}</b> | صوت/ویس: <b>${counts.audio + counts.voice}</b> | گیف: <b>${counts.animation}</b>\n\n` +
    `🔒 رمز عبور: <b>${passIcon}</b>\n` +
    `🛡 قفل فوروارد: <b>${protectIcon}</b>\n\n` +
    `🔗 <b>لینک مستقیم اشتراک‌گذاری:</b>\n<code>${deepLink}</code>\n\n` +
    `👇 عملیات بعدی روی این کد کالا را انتخاب کنید:`;

  const kb = buildProductQuickActionsKeyboard(productCode, productRow);

  if (messageId) {
    const ed = await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: summaryText,
      reply_markup: kb,
    });
    if (ed && ed.ok) return;
  }
  await tgApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: summaryText,
    reply_markup: kb,
  });
}

function buildProductQuickActionsKeyboard(productCode, productRow) {
  const protectActive = Number(productRow?.protect_content) === 1;
  const hasPass = Boolean(productRow?.password && productRow.password.trim() !== "");
  return {
    inline_keyboard: [
      [
        {
          text: "🚀 انتشار خودکار در کانال با AI",
          callback_data: `adm_ai_pub_auto:${productCode}`,
        },
      ],
      [
        {
          text: "✏️ انتشار با موضوع دلخواه توسط AI",
          callback_data: `adm_ai_pub_topic:${productCode}`,
        },
      ],
      [
        {
          text: hasPass
            ? "🔒 تغییر / حذف رمز عبور این کد"
            : "🔒 تنظیم رمز عبور برای این کد",
          callback_data: `adm_prd_pass:${productCode}`,
        },
      ],
      [
        {
          text: protectActive
            ? "🛡 قفل فوروارد (Protect Content): ✅ فعال"
            : "🛡 قفل فوروارد (Protect Content) برای این کد",
          callback_data: `adm_prd_prot:${productCode}`,
        },
      ],
      [
        {
          text: "📦 مدیریت کامل این کالا",
          callback_data: `adm_prd_view:${productCode}`,
        },
        { text: "🏠 پنل اصلی", callback_data: "adm_home" },
      ],
    ],
  };
}

// ============================================================================
// AI Auto-Publisher, Cover Generator & Live Channel Post Editor
// ============================================================================

async function generateAICaptionForProduct(db, env, settings, productCode, customTopic = "") {
  const product = await db
    .prepare("SELECT * FROM products WHERE code = ?1")
    .bind(productCode)
    .first();
  const filesRes = await db
    .prepare("SELECT media_type, file_name, caption FROM product_files WHERE product_code = ?1")
    .bind(productCode)
    .all();
  const files = (filesRes && filesRes.results) || [];

  const videoCnt = files.filter((f) => f.media_type === "video").length;
  const photoCnt = files.filter((f) => f.media_type === "photo").length;
  const docCnt = files.filter((f) => f.media_type === "document").length;
  const sampleCaptions = files
    .map((f) => f.caption || f.file_name || "")
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");

  const topicDescription =
    customTopic ||
    product?.custom_caption ||
    sampleCaptions ||
    `بسته ویژه شامل ${files.length} فایل (${videoCnt} ویدیو و ${photoCnt} تصویر)`;

  const mood = settings.ai_mood || "viral";
  let moodInstruction = "";
  if (mood === "viral") {
    moodInstruction =
      "با لحن بسیار هیجانی، جذاب، وایرال، پرانرژی، کنجکاوی‌برانگیز و همراه با ایموجی‌های مناسب بنویس تا مخاطب فوراً ترغیب به دانلود شود.";
  } else if (mood === "official") {
    moodInstruction =
      "با لحن رسمی، تخصصی، ساختارمند، محترمانه و دقیق بنویس و جزئیات بسته را به صورت مرتب معرفی کن.";
  } else {
    moodInstruction =
      "بسیار کوتاه، مینیمال و کوبنده فقط در ۱ الی ۲ خط بنویس و مستقیم سر اصل مطلب برو.";
  }

  const systemPrompt =
    "تو یک نویسنده حرفه‌ای پست‌های کانال تلگرام به زبان فارسی هستی. فقط متن نهایی پست را به زبان فارسی روان و بدون هیچ توضیح اضافه یا مقدمه انگلیسی برگردان.";
  const userPrompt =
    `موضوع پست: ${topicDescription}\n` +
    `مشخصات فایل‌ها: مجموعاً ${files.length} فایل (${videoCnt} ویدیو، ${photoCnt} عکس، ${docCnt} سند).\n` +
    `سبک نگارش: ${moodInstruction}\n` +
    `نکته: در انتهای متن دعوت به کلیک روی دکمه شیشه‌ای زیر پست برای دانلود فایل‌ها بکن.`;

  const aiResponse = await runCloudflareAI(
    env,
    settings,
    "@cf/meta/llama-3.1-8b-instruct",
    {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 450,
      temperature: 0.75,
    },
    false
  );

  let bodyText = "";
  if (aiResponse.ok && aiResponse.result) {
    bodyText =
      typeof aiResponse.result === "string"
        ? aiResponse.result
        : aiResponse.result.response || "";
  }

  if (!bodyText || bodyText.trim().length < 10) {
    // Graceful fallback copywriting in Persian if AI quota is unreachable
    if (mood === "viral") {
      bodyText =
        `🔥 <b>پکیج ویژه و استثنایی آماده دانلود شد!</b>\n\n` +
        `✨ موضوع: <b>${escapeHtml(topicDescription)}</b>\n` +
        `📦 محتویات بسته: <b>${files.length} فایل باکیفیت</b> (${videoCnt} ویدیو، ${photoCnt} تصویر)\n\n` +
        `⚡ قبل از حذف شدن، همین الان از طریق دکمه شیشه‌ای زیر تمام فایل‌ها را یکجا دریافت کنید 👇`;
    } else if (mood === "official") {
      bodyText =
        `💎 <b>معرفی بسته فایل جدید</b>\n\n` +
        `📌 عنوان: ${escapeHtml(topicDescription)}\n` +
        `📁 تعداد کل فایل‌ها: ${files.length} مورد (${videoCnt} ویدیو، ${photoCnt} تصویر)\n\n` +
        `جهت دریافت مستقیم فایل‌ها از دکمه زیر استفاده فرمایید:`;
    } else {
      bodyText =
        `⚡ <b>${escapeHtml(topicDescription)}</b> (${files.length} فایل)\n` +
        `👇 دریافت سریع از دکمه زیر:`;
    }
  }

  const footer = (settings.post_footer || "").trim();
  const fullCaption = footer
    ? `${bodyText.trim()}\n\n${footer}`
    : bodyText.trim();

  return fullCaption.slice(0, 1000);
}

async function prepareAICoverPhoto(db, env, settings, chatId, productCode, topicText, forceMode = null) {
  const mode = forceMode || settings.ai_cover_mode || "ai_gen";

  // Mode 3: Product's own first photo
  if (mode === "product_photo") {
    const firstPhoto = await db
      .prepare(
        "SELECT file_id FROM product_files WHERE product_code = ?1 AND media_type = 'photo' ORDER BY id ASC LIMIT 1"
      )
      .bind(productCode)
      .first();
    if (firstPhoto && firstPhoto.file_id) {
      return { cover_file_id: firstPhoto.file_id, cover_url: "" };
    }
  }

  // Mode 1: Cloudflare AI Image Generation (@cf/black-forest-labs/flux-1-schnell or SDXL Lightning fallback)
  if (mode === "ai_gen") {
    const promptEn = `High quality modern digital illustration cover art for Telegram channel post, cinematic lighting, vibrant colors, sleek aesthetic, no text, subject: ${
      topicText || "digital media package"
    }`;

    let imgRes = await runCloudflareAI(
      env,
      settings,
      "@cf/black-forest-labs/flux-1-schnell",
      { prompt: promptEn, num_steps: 4 },
      true
    );

    if (!imgRes.ok || !imgRes.binary) {
      imgRes = await runCloudflareAI(
        env,
        settings,
        "@cf/bytedance/stable-diffusion-xl-lightning",
        { prompt: promptEn },
        true
      );
    }

    if (imgRes.ok && imgRes.binary && imgRes.binary.byteLength > 500) {
      const uploaded = await tgSendPhotoBinary(
        env.BOT_TOKEN,
        chatId,
        imgRes.binary,
        "🎨 کاور تولید شده توسط هوش مصنوعی کلودفلر (در حال آماده‌سازی پیش‌نمایش...)"
      );
      if (uploaded && uploaded.ok && uploaded.result) {
        const photos = uploaded.result.photo || [];
        const best = photos[photos.length - 1];
        if (best && best.file_id) {
          await tgApi(env.BOT_TOKEN, "deleteMessage", {
            chat_id: chatId,
            message_id: uploaded.result.message_id,
          });
          return { cover_file_id: best.file_id, cover_url: "" };
        }
      }
    }
  }

  // Mode 2 (or fallback): High-res random internet photo
  const seed = `${productCode}_${Date.now()}`;
  return {
    cover_file_id: "",
    cover_url: `https://picsum.photos/seed/${encodeURIComponent(seed)}/1080/720`,
  };
}

function buildChannelPostKeyboard(botUsername, productCode, settings) {
  const tpl = settings.dl_button_template || DEFAULT_SETTINGS.dl_button_template;
  const btnText = tpl.replace(/\{code\}/g, productCode);
  const deepLink = `https://t.me/${botUsername}?start=${productCode}`;
  return {
    inline_keyboard: [[{ text: btnText, url: deepLink }]],
  };
}

function buildAIPreviewAdminKeyboard(productCode) {
  return {
    inline_keyboard: [
      [
        {
          text: "📢 انتشار فوری در کانال",
          callback_data: `adm_ai_confirm_pub:${productCode}`,
        },
      ],
      [
        {
          text: "🔄 تولید مجدد متن",
          callback_data: `adm_ai_regen_text:${productCode}`,
        },
        {
          text: "🖼 تعویض عکس کاور",
          callback_data: `adm_ai_cycle_cover:${productCode}`,
        },
      ],
      [
        {
          text: "✏️ ویرایش دستی کپشن",
          callback_data: `adm_ai_manual_cap:${productCode}`,
        },
      ],
      [
        {
          text: "🔙 بازگشت به مدیریت کالا",
          callback_data: `adm_prd_view:${productCode}`,
        },
      ],
    ],
  };
}

async function generateAndShowAIPreview(db, env, settings, chatId, productCode, customTopic = "") {
  const waitMsg = await tgApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: "⏳ <b>هوش مصنوعی در حال نگارش کپشن و آماده‌سازی کاور پست است... لطفاً چند لحظه صبر کنید.</b>",
  });

  const caption = await generateAICaptionForProduct(
    db,
    env,
    settings,
    productCode,
    customTopic
  );
  const cover = await prepareAICoverPhoto(
    db,
    env,
    settings,
    chatId,
    productCode,
    customTopic || productCode
  );

  await db
    .prepare(
      `INSERT INTO ai_drafts (product_code, topic, generated_caption, cover_file_id, cover_url, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(product_code) DO UPDATE SET
         topic = excluded.topic,
         generated_caption = excluded.generated_caption,
         cover_file_id = excluded.cover_file_id,
         cover_url = excluded.cover_url,
         updated_at = excluded.updated_at`
    )
    .bind(
      productCode,
      customTopic || "",
      caption,
      cover.cover_file_id || "",
      cover.cover_url || "",
      Date.now()
    )
    .run();

  if (waitMsg && waitMsg.ok && waitMsg.result) {
    await tgApi(env.BOT_TOKEN, "deleteMessage", {
      chat_id: chatId,
      message_id: waitMsg.result.message_id,
    });
  }

  await renderAIDraftPreview(db, env, settings, chatId, productCode);
}

async function renderAIDraftPreview(db, env, settings, chatId, productCode) {
  const draft = await db
    .prepare("SELECT * FROM ai_drafts WHERE product_code = ?1")
    .bind(productCode)
    .first();
  if (!draft) return;

  const previewCaption =
    `👁‍🗨 <b>پیش‌نمایش پست آماده انتشار (${escapeHtml(productCode)}):</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `${draft.generated_caption}`;

  const kb = buildAIPreviewAdminKeyboard(productCode);
  const photoRef = draft.cover_file_id || draft.cover_url;

  if (photoRef) {
    const sent = await tgApi(env.BOT_TOKEN, "sendPhoto", {
      chat_id: chatId,
      photo: photoRef,
      caption: previewCaption.slice(0, 1024),
      parse_mode: "HTML",
      reply_markup: kb,
    });
    if (sent && sent.ok) return;
  }

  await tgApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: previewCaption,
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

async function publishDraftToTargetChannel(db, env, settings, chatId, productCode) {
  if (!settings.target_channel_id) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: "❌ <b>هنوز هیچ کانال مقصدی متصل نشده است!</b>\nلطفاً ابتدا از بخش «🤖 هوش مصنوعی و کانال» ⬅️ «📢 اتصال کانال مقصد» کانال خود را متصل کنید.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 اتصال کانال مقصد", callback_data: "adm_ai_connect_ch" }],
          [{ text: "🔙 بازگشت", callback_data: `adm_prd_view:${productCode}` }],
        ],
      },
    });
    return;
  }

  const draft = await db
    .prepare("SELECT * FROM ai_drafts WHERE product_code = ?1")
    .bind(productCode)
    .first();
  if (!draft) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "❌ پیش‌نویس پست یافت نشد. لطفاً دوباره تولید کنید.",
    });
    return;
  }

  const botIdentity = await ensureBotIdentity(db, env, settings);
  const channelKb = buildChannelPostKeyboard(
    botIdentity.username || "Bot",
    productCode,
    settings
  );

  const photoRef = draft.cover_file_id || draft.cover_url;
  let pubRes = null;

  if (photoRef) {
    pubRes = await tgApi(env.BOT_TOKEN, "sendPhoto", {
      chat_id: settings.target_channel_id,
      photo: photoRef,
      caption: draft.generated_caption,
      parse_mode: "HTML",
      reply_markup: channelKb,
    });
  } else {
    pubRes = await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: settings.target_channel_id,
      text: draft.generated_caption,
      parse_mode: "HTML",
      reply_markup: channelKb,
    });
  }

  if (!pubRes || !pubRes.ok) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `❌ <b>خطا در ارسال پست به کانال:</b>\n<code>${escapeHtml(
        pubRes?.description || "Unknown Error"
      )}</code>`,
    });
    return;
  }

  const channelMsgId = pubRes.result.message_id;
  await db
    .prepare(
      "UPDATE products SET channel_chat_id = ?1, channel_message_id = ?2, custom_caption = ?3 WHERE code = ?4"
    )
    .bind(
      String(settings.target_channel_id),
      Number(channelMsgId),
      draft.generated_caption,
      productCode
    )
    .run();

  await tgApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      `🎉 <b>پست با موفقیت در کانال «${escapeHtml(
        settings.target_channel_title || settings.target_channel_id
      )}» منتشر شد!</b>\n\n` +
      `🆔 شناسه پیام در کانال: <code>${channelMsgId}</code>\n` +
      `💡 شما می‌توانید در هر زمان از منوی مدیریت کالا، کپشن یا دکمه این پست را به صورت زنده در کانال ویرایش کنید.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📦 مدیریت این کالا",
            callback_data: `adm_prd_view:${productCode}`,
          },
          { text: "🏠 پنل اصلی", callback_data: "adm_home" },
        ],
      ],
    },
  });
}

// ============================================================================
// CRUD Product Management Views
// ============================================================================

async function renderProductDetailView(db, env, settings, chatId, productCode, messageId = null) {
  const product = await db
    .prepare("SELECT * FROM products WHERE code = ?1")
    .bind(productCode)
    .first();

  if (!product) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "❌ کد کالای مورد نظر یافت نشد.",
    });
    return;
  }

  const botIdentity = await ensureBotIdentity(db, env, settings);
  const deepLink = `https://t.me/${botIdentity.username || "Bot"}?start=${productCode}`;
  const activeStatus = Number(product.is_active) === 1 ? "✅ فعال" : "🔴 غیرفعال";
  const protectStatus = Number(product.protect_content) === 1 ? "✅ فعال" : "⚪ غیرفعال";
  const passStatus = product.password ? `✅ <code>${escapeHtml(product.password)}</code>` : "⚪ بدون رمز";
  const channelStatus =
    product.channel_message_id && Number(product.channel_message_id) > 0
      ? `✅ منتشر شده (پیام #${product.channel_message_id})`
      : "⚪ منتشر نشده";

  const text =
    `📦 <b>مدیریت اختصاصی کالا: <code>${escapeHtml(productCode)}</code></b>\n\n` +
    `📌 وضعیت: <b>${activeStatus}</b>\n` +
    `📁 تعداد فایل‌ها: <b>${product.files_count} فایل</b>\n` +
    `👁 تعداد دانلود/بازدید: <b>${product.views_count} بار</b>\n` +
    `🔒 رمز عبور: ${passStatus}\n` +
    `🛡 قفل فوروارد: <b>${protectStatus}</b>\n` +
    `📢 وضعیت پست کانال: <b>${channelStatus}</b>\n` +
    `🕒 آخرین دریافت: <code>${product.last_accessed_at || "ندارد"}</code>\n\n` +
    `🔗 <b>لینک مستقیم:</b>\n<code>${deepLink}</code>`;

  const inline_keyboard = [
    [
      { text: "🚀 انتشار خودکار با AI", callback_data: `adm_ai_pub_auto:${productCode}` },
      { text: "✏️ انتشار با موضوع دلخواه", callback_data: `adm_ai_pub_topic:${productCode}` },
    ],
    [
      { text: "➕ افزودن فایل جدید", callback_data: `adm_prd_addf:${productCode}` },
      { text: "🗂 مدیریت/حذف تکی فایل‌ها", callback_data: `adm_prd_files:${productCode}` },
    ],
    [
      { text: "🔒 تنظیم/حذف رمز عبور", callback_data: `adm_prd_pass:${productCode}` },
      { text: "🛡 تغییر قفل فوروارد", callback_data: `adm_prd_prot:${productCode}` },
    ],
    [
      { text: "✏️ ویرایش کپشن/عنوان کالا", callback_data: `adm_prd_cap:${productCode}` },
      {
        text: Number(product.is_active) === 1 ? "🔴 غیرفعال‌سازی کد" : "🟢 فعال‌سازی کد",
        callback_data: `adm_prd_toggle:${productCode}`,
      },
    ],
  ];

  if (product.channel_message_id && Number(product.channel_message_id) > 0) {
    inline_keyboard.push([
      {
        text: "📢 ویرایش زنده پست منتشر شده در کانال",
        callback_data: `adm_prd_live_edit:${productCode}`,
      },
    ]);
  }

  inline_keyboard.push([
    { text: "🗑 حذف کامل این کد کالا", callback_data: `adm_prd_del_confirm:${productCode}` },
  ]);
  inline_keyboard.push([
    { text: "🔙 لیست کالاها", callback_data: "adm_crud_list:1" },
    { text: "🏠 پنل اصلی", callback_data: "adm_home" },
  ]);

  if (messageId) {
    const ed = await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text,
      reply_markup: { inline_keyboard },
    });
    if (ed && ed.ok) return;
  }

  await tgApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text,
    reply_markup: { inline_keyboard },
  });
}

// ============================================================================
// Main Update Router (Messages & Callback Queries)
// ============================================================================

async function handleUpdate(update, env, ctx) {
  const db = env.DB;
  await ensureSchema(db);
  const settings = await getAllSettings(db, env);

  if (update.message) {
    await handleMessage(update.message, db, env, settings, ctx);
  } else if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, db, env, settings, ctx);
  }
}

async function handleMessage(message, db, env, settings, ctx) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!userId) return;

  await trackUser(db, message.from);
  const text = (message.text || "").trim();
  const isAdmin = isAdminUser(userId, env, settings);
  const userState = await getUserState(db, userId);

  // 1. Check /start command & Deep-Link Product Codes (PRD_xxxx)
  if (text.startsWith("/start")) {
    await clearUserState(db, userId);
    const parts = text.split(/\s+/);
    const payload = parts[1] ? parts[1].trim() : "";

    if (payload && payload.startsWith("PRD_")) {
      await handleProductDelivery(
        ctx,
        db,
        env,
        settings,
        chatId,
        userId,
        payload,
        false
      );
      return;
    }

    const welcomeTemplate = settings.start_text || DEFAULT_SETTINGS.start_text;
    const welcomeText = welcomeTemplate.replace(
      /\{name\}/g,
      escapeHtml(message.from.first_name || "کاربر")
    );

    const replyMarkup = isAdmin
      ? {
          inline_keyboard: [
            [{ text: "🎛 ورود به پنل مدیریت (/panel)", callback_data: "adm_home" }],
          ],
        }
      : undefined;

    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: welcomeText,
      reply_markup: replyMarkup,
    });
    return;
  }

  // 2. Admin /panel command
  if (text === "/panel" || text === "/admin") {
    if (!isAdmin) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "⛔ شما دسترسی ادمین به این ربات را ندارید.",
      });
      return;
    }
    await clearUserState(db, userId);
    await renderAdminHomePanel(db, env, settings, chatId);
    return;
  }

  // 3. User Password Entry State for Protected Product
  if (userState.state === "AWAIT_PRODUCT_PASS") {
    const targetCode = userState.data?.code;
    const product = await db
      .prepare("SELECT password FROM products WHERE code = ?1")
      .bind(targetCode)
      .first();

    if (product && text === product.password) {
      await clearUserState(db, userId);
      await handleProductDelivery(
        ctx,
        db,
        env,
        settings,
        chatId,
        userId,
        targetCode,
        true
      );
    } else {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: "❌ <b>رمز عبور اشتباه است!</b> لطفاً دوباره تلاش کنید یا روی دکمه انصراف بزنید:",
        reply_markup: {
          inline_keyboard: [[{ text: "❌ انصراف", callback_data: "user_cancel" }]],
        },
      });
    }
    return;
  }

  // Stop here if non-admin
  if (!isAdmin) {
    return;
  }

  // ========================================================================
  // Admin State Machine Handlers
  // ========================================================================

  // A. STAGING_FILES Mode (Zero-Download Atomic Media Capture)
  if (userState.state === "STAGING_FILES") {
    const media = extractMediaFromMessage(message);
    if (!media) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: "⚠️ لطفاً یک فایل (ویدیو، عکس، سند، موزیک، گیف یا ویس) ارسال کنید یا روی دکمه اتمام بزنید.",
        reply_markup: buildStagingKeyboard(userState.data?.target_code),
      });
      return;
    }

    await db
      .prepare(
        `INSERT INTO staging_files (admin_id, file_id, file_unique_id, media_type, file_name, file_size, caption, source_chat_id, source_message_id, media_group_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      )
      .bind(
        String(userId),
        media.file_id,
        media.file_unique_id,
        media.media_type,
        media.file_name,
        media.file_size,
        media.caption,
        String(chatId),
        Number(message.message_id),
        media.media_group_id,
        Date.now()
      )
      .run();

    const { counts } = await getStagingSummary(db, userId);
    const statusText = buildStagingStatusText(counts, userState.data?.target_code);
    const kb = buildStagingKeyboard(userState.data?.target_code);

    if (userState.data?.status_msg_id) {
      const ed = await tgApi(env.BOT_TOKEN, "editMessageText", {
        chat_id: chatId,
        message_id: userState.data.status_msg_id,
        parse_mode: "HTML",
        text: statusText,
        reply_markup: kb,
      });
      if (ed && ed.ok) return;
    }

    const sent = await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: statusText,
      reply_markup: kb,
    });
    if (sent && sent.ok && sent.result) {
      await setUserState(db, userId, "STAGING_FILES", {
        ...userState.data,
        status_msg_id: sent.result.message_id,
      });
    }
    return;
  }

  // B. Two-Way Target Channel Handshake
  if (userState.state === "AWAIT_TARGET_CHANNEL") {
    let targetChatId = "";
    if (message.forward_from_chat && message.forward_from_chat.type === "channel") {
      targetChatId = String(message.forward_from_chat.id);
    } else if (text.startsWith("@") || text.startsWith("-100")) {
      targetChatId = text.split(/\s+/)[0].trim();
    } else {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: "⚠️ لطفاً یک پست از کانال خود به اینجا <b>فوروارد</b> کنید، یا آیدی کانال (مثلاً <code>@MyChannel</code> یا <code>-100123456789</code>) را ارسال نمایید:",
      });
      return;
    }

    const botIdentity = await ensureBotIdentity(db, env, settings);
    const chatInfo = await tgApi(env.BOT_TOKEN, "getChat", { chat_id: targetChatId });
    if (!chatInfo || !chatInfo.ok) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `❌ <b>ربات نتوانست کانال را پیدا کند!</b>\nابتدا ربات را در کانال ادمین کنید و دوباره امتحان کنید.\n<code>${escapeHtml(
          chatInfo?.description || ""
        )}</code>`,
      });
      return;
    }

    const memberInfo = await tgApi(env.BOT_TOKEN, "getChatMember", {
      chat_id: chatInfo.result.id,
      user_id: Number(botIdentity.id),
    });

    const isAdminInChannel =
      memberInfo &&
      memberInfo.ok &&
      (memberInfo.result.status === "administrator" ||
        memberInfo.result.status === "creator");

    if (!isAdminInChannel) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: "❌ ربات در این کانال ادمین نیست! ابتدا ربات را ادمین کنید (با دسترسی ارسال پست) و دوباره امتحان کنید.",
      });
      return;
    }

    const channelTitle = chatInfo.result.title || targetChatId;
    const channelUsername = chatInfo.result.username ? `@${chatInfo.result.username}` : "";

    await setSetting(db, "pending_channel_id", String(chatInfo.result.id));
    await setSetting(db, "pending_channel_title", channelTitle);
    await setSetting(db, "pending_channel_username", channelUsername);
    await clearUserState(db, userId);

    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `✅ دسترسی ادمینی ربات در کانال «<b>${escapeHtml(
        channelTitle
      )}</b>» تایید شد. آیا اتصال نهایی را تایید می‌کنید؟`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ بله، متصل شود", callback_data: "adm_ai_confirm_ch" },
            { text: "❌ انصراف", callback_data: "adm_ai_menu" },
          ],
        ],
      },
    });
    return;
  }

  // C. Add Force-Join Telegram Channel Lock (With Mandatory Bot-Admin Check)
  if (userState.state === "AWAIT_LOCK_CHANNEL") {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const channelRef = lines[0] || "";
    const customInvite = lines[1] || "";

    if (!channelRef.startsWith("@") && !channelRef.startsWith("-100")) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          "⚠️ فرمت نامعتبر است!\n" +
          "لطفاً در خط اول یوزرنیم کانال (مثلاً <code>@MyChannel</code>) یا آیدی عددی (<code>-100...</code>) و در خط دوم لینک عضویت را بفرستید:",
      });
      return;
    }

    const botIdentity = await ensureBotIdentity(db, env, settings);
    const chatInfo = await tgApi(env.BOT_TOKEN, "getChat", { chat_id: channelRef });
    if (!chatInfo || !chatInfo.ok) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "❌ ربات در این کانال ادمین نیست! ابتدا ربات را ادمین کنید و دوباره امتحان کنید.",
      });
      return;
    }

    const memberInfo = await tgApi(env.BOT_TOKEN, "getChatMember", {
      chat_id: chatInfo.result.id,
      user_id: Number(botIdentity.id),
    });

    const isBotAdmin =
      memberInfo &&
      memberInfo.ok &&
      (memberInfo.result.status === "administrator" ||
        memberInfo.result.status === "creator");

    if (!isBotAdmin) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "❌ ربات در این کانال ادمین نیست! ابتدا ربات را ادمین کنید و دوباره امتحان کنید.",
      });
      return;
    }

    const title = chatInfo.result.title || channelRef;
    const inviteLink =
      customInvite ||
      chatInfo.result.invite_link ||
      (chatInfo.result.username
        ? `https://t.me/${chatInfo.result.username}`
        : "https://t.me/");

    await db
      .prepare(
        `INSERT INTO force_locks (lock_type, title, chat_id, invite_link, is_active, created_at)
         VALUES ('channel', ?1, ?2, ?3, 1, ?4)`
      )
      .bind(title, String(chatInfo.result.id), inviteLink, new Date().toISOString())
      .run();

    await clearUserState(db, userId);
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `✅ قفل کانال تلگرامی «<b>${escapeHtml(title)}</b>» با موفقیت تایید و فعال شد!`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔐 بازگشت به مدیریت قفل‌ها", callback_data: "adm_locks_menu" }]],
      },
    });
    return;
  }

  // D. Add External URL / Bot Link Lock
  if (userState.state === "AWAIT_LOCK_URL") {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2 || !lines[1].startsWith("http")) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          "⚠️ لطفاً در <b>خط اول عنوان دکمه</b> و در <b>خط دوم لینک کامل (با https://)</b> را ارسال کنید:\n\n" +
          "مثال:\n<code>ربات دوم ما\nhttps://t.me/OtherBot?start=vip</code>",
      });
      return;
    }

    await db
      .prepare(
        `INSERT INTO force_locks (lock_type, title, chat_id, invite_link, is_active, created_at)
         VALUES ('url', ?1, '', ?2, 1, ?3)`
      )
      .bind(lines[0], lines[1], new Date().toISOString())
      .run();

    await clearUserState(db, userId);
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `✅ قفل لینک خارجی/ربات «<b>${escapeHtml(lines[0])}</b>» با موفقیت اضافه شد!`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔐 بازگشت به مدیریت قفل‌ها", callback_data: "adm_locks_menu" }]],
      },
    });
    return;
  }

  // E. Product Custom Topic for AI Publishing
  if (userState.state === "AWAIT_AI_CUSTOM_TOPIC") {
    const productCode = userState.data?.code;
    await clearUserState(db, userId);
    await generateAndShowAIPreview(db, env, settings, chatId, productCode, text);
    return;
  }

  // F. Manual Edit of AI Draft Caption
  if (userState.state === "AWAIT_AI_MANUAL_CAPTION") {
    const productCode = userState.data?.code;
    await db
      .prepare("UPDATE ai_drafts SET generated_caption = ?1, updated_at = ?2 WHERE product_code = ?3")
      .bind(text, Date.now(), productCode)
      .run();
    await clearUserState(db, userId);
    await renderAIDraftPreview(db, env, settings, chatId, productCode);
    return;
  }

  // G. Set / Remove Product Password
  if (userState.state === "AWAIT_SET_PRD_PASS") {
    const productCode = userState.data?.code;
    const newPass = text === "/off" || text === "حذف" ? "" : text;
    await db
      .prepare("UPDATE products SET password = ?1 WHERE code = ?2")
      .bind(newPass, productCode)
      .run();
    await clearUserState(db, userId);
    await renderProductDetailView(db, env, settings, chatId, productCode);
    return;
  }

  // H. Edit Product Custom Caption / Title
  if (userState.state === "AWAIT_EDIT_PRD_CAPTION") {
    const productCode = userState.data?.code;
    await db
      .prepare("UPDATE products SET title = ?1, custom_caption = ?2 WHERE code = ?3")
      .bind(text.slice(0, 100), text, productCode)
      .run();
    await clearUserState(db, userId);
    await renderProductDetailView(db, env, settings, chatId, productCode);
    return;
  }

  // I. Live Edit Published Channel Post Caption
  if (userState.state === "AWAIT_LIVE_CHANNEL_EDIT") {
    const productCode = userState.data?.code;
    const product = await db
      .prepare("SELECT * FROM products WHERE code = ?1")
      .bind(productCode)
      .first();
    await clearUserState(db, userId);

    if (product && product.channel_chat_id && product.channel_message_id) {
      const botIdentity = await ensureBotIdentity(db, env, settings);
      const channelKb = buildChannelPostKeyboard(
        botIdentity.username || "Bot",
        productCode,
        settings
      );

      let editRes = await tgApi(env.BOT_TOKEN, "editMessageCaption", {
        chat_id: product.channel_chat_id,
        message_id: Number(product.channel_message_id),
        caption: text,
        parse_mode: "HTML",
        reply_markup: channelKb,
      });

      if (!editRes || !editRes.ok) {
        editRes = await tgApi(env.BOT_TOKEN, "editMessageText", {
          chat_id: product.channel_chat_id,
          message_id: Number(product.channel_message_id),
          text,
          parse_mode: "HTML",
          reply_markup: channelKb,
        });
      }

      if (editRes && editRes.ok) {
        await db
          .prepare("UPDATE products SET custom_caption = ?1 WHERE code = ?2")
          .bind(text, productCode)
          .run();
        await tgApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          parse_mode: "HTML",
          text: `✅ پست منتشر شده در کانال برای کد <code>${escapeHtml(productCode)}</code> به صورت زنده بروزرسانی شد!`,
        });
      } else {
        await tgApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          parse_mode: "HTML",
          text: `❌ خطا در ویرایش پست کانال:\n<code>${escapeHtml(editRes?.description || "")}</code>`,
        });
      }
    }
    await renderProductDetailView(db, env, settings, chatId, productCode);
    return;
  }

  // J. Search Product by Code or Caption
  if (userState.state === "AWAIT_CRUD_SEARCH") {
    await clearUserState(db, userId);
    const q = `%${text}%`;
    const rows = await db
      .prepare(
        "SELECT * FROM products WHERE code LIKE ?1 OR title LIKE ?1 OR custom_caption LIKE ?1 ORDER BY created_at DESC LIMIT 20"
      )
      .bind(q)
      .all();
    const list = (rows && rows.results) || [];
    if (list.length === 0) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "🔍 هیچ کالایی با این عبارت پیدا نشد.",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 بازگشت به لیست کالاها", callback_data: "adm_crud_list:1" }]],
        },
      });
      return;
    }
    const inline_keyboard = list.map((p) => [
      {
        text: `📦 ${p.code} (${p.files_count} فایل | 👁 ${p.views_count})`,
        callback_data: `adm_prd_view:${p.code}`,
      },
    ]);
    inline_keyboard.push([{ text: "🔙 بازگشت", callback_data: "adm_crud_list:1" }]);
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `🔍 <b>نتایج جستجو برای «${escapeHtml(text)}»:</b>`,
      reply_markup: { inline_keyboard },
    });
    return;
  }

  // K. Generic Settings Value Update (Footer, Button Template, Texts, Backup Chat, AI Token)
  if (userState.state === "AWAIT_SETTING_VALUE") {
    const settingKey = userState.data?.key;
    const returnMenu = userState.data?.return_menu || "adm_settings_menu";
    if (settingKey) {
      const cleanVal = text === "/off" || text === "حذف" ? "" : text;
      await setSetting(db, settingKey, cleanVal);
      settings[settingKey] = cleanVal;
    }
    await clearUserState(db, userId);
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: "✅ <b>تنظیمات جدید با موفقیت ذخیره شد!</b>",
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 بازگشت", callback_data: returnMenu }]],
      },
    });
    return;
  }

  // L. Smart Chunked Broadcast (Copy or Forward to All Users)
  if (userState.state === "AWAIT_BROADCAST_MSG") {
    const mode = userState.data?.mode || "copy";
    await clearUserState(db, userId);

    const usersRes = await db.prepare("SELECT user_id FROM users").all();
    const allUsers = (usersRes && usersRes.results) || [];

    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `🚀 <b>عملیات ارسال همگانی برای ${allUsers.length} کاربر در پس‌زمینه آغاز شد!</b>\nپس از اتمام، گزارش نهایی برای شما ارسال می‌شود.`,
    });

    const runBroadcast = async () => {
      let success = 0;
      let failed = 0;
      for (let i = 0; i < allUsers.length; i++) {
        const uid = allUsers[i].user_id;
        const method = mode === "forward" ? "forwardMessage" : "copyMessage";
        const res = await tgApi(env.BOT_TOKEN, method, {
          chat_id: uid,
          from_chat_id: chatId,
          message_id: message.message_id,
        });
        if (res && res.ok) success++;
        else failed++;

        if ((i + 1) % 20 === 0) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `✅ <b>ارسال همگانی به پایان رسید!</b>\n\n` +
          `🟢 موفق: <b>${success} نفر</b>\n` +
          `🔴 ناموفق/بلاک: <b>${failed} نفر</b>`,
      });
    };

    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(runBroadcast());
    } else {
      await runBroadcast();
    }
    return;
  }

  // Default behaviour if Admin sends a file directly without clicking staging first:
  const directMedia = extractMediaFromMessage(message);
  if (directMedia) {
    await db
      .prepare(
        `INSERT INTO staging_files (admin_id, file_id, file_unique_id, media_type, file_name, file_size, caption, source_chat_id, source_message_id, media_group_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      )
      .bind(
        String(userId),
        directMedia.file_id,
        directMedia.file_unique_id,
        directMedia.media_type,
        directMedia.file_name,
        directMedia.file_size,
        directMedia.caption,
        String(chatId),
        Number(message.message_id),
        directMedia.media_group_id,
        Date.now()
      )
      .run();

    const { counts } = await getStagingSummary(db, userId);
    const sent = await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: buildStagingStatusText(counts, null),
      reply_markup: buildStagingKeyboard(null),
    });
    await setUserState(db, userId, "STAGING_FILES", {
      target_code: null,
      status_msg_id: sent?.result?.message_id || null,
    });
  }
}

// ============================================================================
// Callback Query Handler
// ============================================================================

async function handleCallbackQuery(cb, db, env, settings, ctx) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const userId = cb.from?.id;
  const data = cb.data || "";

  if (!chatId || !userId) return;

  // 1. User Force-Join Check Callback
  if (data.startsWith("chk_join:")) {
    const productCode = data.split(":")[1];
    const lockStatus = await checkUserForceLocks(db, env, settings, userId);
    if (lockStatus.locked) {
      await tgApi(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "❌ شما هنوز در تمام کانال‌های مشخص شده عضو نشده‌اید!",
        show_alert: true,
      });
      return;
    }

    await tgApi(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "✅ عضویت شما تایید شد! در حال ارسال فایل‌ها...",
    });
    await tgApi(env.BOT_TOKEN, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });

    if (productCode && productCode !== "NONE") {
      await handleProductDelivery(
        ctx,
        db,
        env,
        settings,
        chatId,
        userId,
        productCode,
        false
      );
    }
    return;
  }

  if (data === "user_cancel") {
    await clearUserState(db, userId);
    await tgApi(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "لغو شد.",
    });
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "❌ عملیات لغو شد.",
    });
    return;
  }

  // Verify Admin Access for all `adm_*` callbacks
  if (!isAdminUser(userId, env, settings)) {
    await tgApi(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "⛔ مخصوص ادمین ربات!",
      show_alert: true,
    });
    return;
  }

  await tgApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });

  // Home Panel
  if (data === "adm_home") {
    await clearUserState(db, userId);
    await renderAdminHomePanel(db, env, settings, chatId, messageId);
    return;
  }

  // Start File Staging
  if (data === "adm_start_staging") {
    await db
      .prepare("DELETE FROM staging_files WHERE admin_id = ?1")
      .bind(String(userId))
      .run();
    await setUserState(db, userId, "STAGING_FILES", {
      target_code: null,
      status_msg_id: messageId,
    });
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: buildStagingStatusText({ total: 0, video: 0, photo: 0, document: 0, audio: 0, animation: 0, voice: 0 }, null),
      reply_markup: buildStagingKeyboard(null),
    });
    return;
  }

  // Clear Staging List
  if (data === "adm_clear_staging") {
    await db
      .prepare("DELETE FROM staging_files WHERE admin_id = ?1")
      .bind(String(userId))
      .run();
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `🗑 <b>لیست موقت پاکسازی شد!</b>\n\n` +
        buildStagingStatusText({ total: 0, video: 0, photo: 0, document: 0, audio: 0, animation: 0, voice: 0 }, null),
      reply_markup: buildStagingKeyboard(null),
    });
    return;
  }

  // Finish Staging & Generate Product Code
  if (data.startsWith("adm_finish_staging:")) {
    const targetCode = data.split(":")[1];
    await finalizeStagingAndCreateProduct(
      db,
      env,
      settings,
      chatId,
      userId,
      messageId,
      targetCode
    );
    return;
  }

  // ========================================================================
  // CRUD Products Management Callbacks
  // ========================================================================

  if (data.startsWith("adm_crud_list:")) {
    const page = Math.max(1, parseInt(data.split(":")[1] || "1", 10));
    const pageSize = 8;
    const offset = (page - 1) * pageSize;

    const totalRow = await db
      .prepare("SELECT COUNT(*) AS cnt FROM products")
      .first();
    const total = totalRow?.cnt || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const rows = await db
      .prepare("SELECT * FROM products ORDER BY created_at DESC LIMIT ?1 OFFSET ?2")
      .bind(pageSize, offset)
      .all();
    const list = (rows && rows.results) || [];

    const inline_keyboard = [
      [
        { text: "🔍 جستجوی کالا (کد/کپشن)", callback_data: "adm_crud_search" },
        { text: "⚠️ کالاهای ناقص/خالی", callback_data: "adm_crud_empty" },
      ],
    ];

    for (const p of list) {
      const statusDot = Number(p.is_active) === 1 && Number(p.files_count) > 0 ? "🟢" : "🔴";
      inline_keyboard.push([
        {
          text: `${statusDot} ${p.code} | 📁 ${p.files_count} فایل | 👁 ${p.views_count}`,
          callback_data: `adm_prd_view:${p.code}`,
        },
      ]);
    }

    const navRow = [];
    if (page > 1) {
      navRow.push({ text: "⬅️ صفحه قبل", callback_data: `adm_crud_list:${page - 1}` });
    }
    if (page < totalPages) {
      navRow.push({ text: "صفحه بعد ➡️", callback_data: `adm_crud_list:${page + 1}` });
    }
    if (navRow.length > 0) inline_keyboard.push(navRow);
    inline_keyboard.push([{ text: "🔙 بازگشت به پنل اصلی", callback_data: "adm_home" }]);

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `📦 <b>مدیریت کامل کالاها (CRUD)</b>\n` +
        `صفحه <b>${page}</b> از <b>${totalPages}</b> (مجموع: ${total} کالا)\n\n` +
        `برای مشاهده جزئیات، ویرایش فایل‌ها یا انتشار در کانال، روی کد کالای مورد نظر کلیک کنید:`,
      reply_markup: { inline_keyboard },
    });
    return;
  }

  if (data === "adm_crud_search") {
    await setUserState(db, userId, "AWAIT_CRUD_SEARCH", {});
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: "🔍 <b>جستجوی کالا</b>\n\nلطفاً کد کالا (مثلاً <code>PRD_1042</code>) یا بخشی از عنوان/کپشن آن را ارسال کنید:",
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: "adm_crud_list:1" }]],
      },
    });
    return;
  }

  if (data === "adm_crud_empty") {
    const rows = await db
      .prepare(
        "SELECT * FROM products WHERE files_count = 0 OR is_active = 0 ORDER BY created_at DESC LIMIT 25"
      )
      .all();
    const list = (rows && rows.results) || [];

    const inline_keyboard = list.map((p) => [
      {
        text: `⚠️ ${p.code} (فایل: ${p.files_count} | وضعیت: ${
          Number(p.is_active) === 1 ? "فعال" : "غیرفعال"
        })`,
        callback_data: `adm_prd_view:${p.code}`,
      },
    ]);
    inline_keyboard.push([
      { text: "📦 همه کالاها", callback_data: "adm_crud_list:1" },
      { text: "🏠 پنل اصلی", callback_data: "adm_home" },
    ]);

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        list.length > 0
          ? `⚠️ <b>لیست کالاهای ناقص (بدون فایل) یا غیرفعال (${list.length} مورد):</b>\nبرای تکمیل فایل‌ها یا حذف کامل روی هر مورد بزنید:`
          : `✅ <b>هیچ کالای ناقص یا غیرفعالی وجود ندارد!</b> تمام بسته‌های شما سالم و دارای فایل هستند.`,
      reply_markup: { inline_keyboard },
    });
    return;
  }

  if (data.startsWith("adm_prd_view:")) {
    const code = data.split(":")[1];
    await renderProductDetailView(db, env, settings, chatId, code, messageId);
    return;
  }

  if (data.startsWith("adm_prd_prot:")) {
    const code = data.split(":")[1];
    await db
      .prepare(
        "UPDATE products SET protect_content = CASE WHEN protect_content = 1 THEN 0 ELSE 1 END WHERE code = ?1"
      )
      .bind(code)
      .run();
    await renderProductDetailView(db, env, settings, chatId, code, messageId);
    return;
  }

  if (data.startsWith("adm_prd_toggle:")) {
    const code = data.split(":")[1];
    await db
      .prepare(
        "UPDATE products SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE code = ?1"
      )
      .bind(code)
      .run();
    await renderProductDetailView(db, env, settings, chatId, code, messageId);
    return;
  }

  if (data.startsWith("adm_prd_pass:")) {
    const code = data.split(":")[1];
    await setUserState(db, userId, "AWAIT_SET_PRD_PASS", { code });
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `🔒 <b>تنظیم رمز عبور برای کد <code>${escapeHtml(code)}</code></b>\n\n` +
        `لطفاً رمز عبور جدید را ارسال کنید (یا برای حذف رمز، عبارت <code>/off</code> را بفرستید):`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: `adm_prd_view:${code}` }]],
      },
    });
    return;
  }

  if (data.startsWith("adm_prd_cap:")) {
    const code = data.split(":")[1];
    await setUserState(db, userId, "AWAIT_EDIT_PRD_CAPTION", { code });
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: `✏️ <b>ویرایش عنوان/کپشن کالای <code>${escapeHtml(code)}</code></b>\n\nلطفاً متن جدید را ارسال کنید:`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: `adm_prd_view:${code}` }]],
      },
    });
    return;
  }

  if (data.startsWith("adm_prd_addf:")) {
    const code = data.split(":")[1];
    await db
      .prepare("DELETE FROM staging_files WHERE admin_id = ?1")
      .bind(String(userId))
      .run();
    await setUserState(db, userId, "STAGING_FILES", {
      target_code: code,
      status_msg_id: messageId,
    });
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: buildStagingStatusText({ total: 0, video: 0, photo: 0, document: 0, audio: 0, animation: 0, voice: 0 }, code),
      reply_markup: buildStagingKeyboard(code),
    });
    return;
  }

  if (data.startsWith("adm_prd_files:")) {
    const code = data.split(":")[1];
    const filesRes = await db
      .prepare("SELECT * FROM product_files WHERE product_code = ?1 ORDER BY id ASC")
      .bind(code)
      .all();
    const files = (filesRes && filesRes.results) || [];

    const inline_keyboard = files.map((f, idx) => [
      {
        text: `🗑 حذف فایل #${idx + 1} (${f.media_type} - ${f.file_name || "بدون نام"})`,
        callback_data: `adm_prd_delf:${code}:${f.id}`,
      },
    ]);
    inline_keyboard.push([{ text: "🔙 بازگشت به کالا", callback_data: `adm_prd_view:${code}` }]);

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `🗂 <b>فایل‌های موجود در بسته <code>${escapeHtml(code)}</code> (${files.length} فایل):</b>\n` +
        `برای حذف هر فایل از این بسته، روی آن کلیک کنید:`,
      reply_markup: { inline_keyboard },
    });
    return;
  }

  if (data.startsWith("adm_prd_delf:")) {
    const parts = data.split(":");
    const code = parts[1];
    const fileRowId = Number(parts[2]);

    await db
      .prepare("DELETE FROM product_files WHERE id = ?1 AND product_code = ?2")
      .bind(fileRowId, code)
      .run();
    const cntRow = await db
      .prepare("SELECT COUNT(*) AS cnt FROM product_files WHERE product_code = ?1")
      .bind(code)
      .first();
    await db
      .prepare("UPDATE products SET files_count = ?1 WHERE code = ?2")
      .bind(cntRow?.cnt || 0, code)
      .run();

    await renderProductDetailView(db, env, settings, chatId, code, messageId);
    return;
  }

  if (data.startsWith("adm_prd_live_edit:")) {
    const code = data.split(":")[1];
    await setUserState(db, userId, "AWAIT_LIVE_CHANNEL_EDIT", { code });
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `📢 <b>ویرایش زنده پست کانال برای <code>${escapeHtml(code)}</code></b>\n\n` +
        `لطفاً متن جدید کپشن پست کانال را ارسال کنید تا فوراً در کانال آپدیت شود:`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: `adm_prd_view:${code}` }]],
      },
    });
    return;
  }

  if (data.startsWith("adm_prd_del_confirm:")) {
    const code = data.split(":")[1];
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: `⚠️ <b>آیا از حذف کامل کد کالای <code>${escapeHtml(code)}</code> و تمام فایل‌های آن اطمینان دارید؟</b>`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🗑 بله، کاملاً حذف شود", callback_data: `adm_prd_del_exec:${code}` },
            { text: "❌ خیر، بازگشت", callback_data: `adm_prd_view:${code}` },
          ],
        ],
      },
    });
    return;
  }

  if (data.startsWith("adm_prd_del_exec:")) {
    const code = data.split(":")[1];
    await db.prepare("DELETE FROM product_files WHERE product_code = ?1").bind(code).run();
    await db.prepare("DELETE FROM ai_drafts WHERE product_code = ?1").bind(code).run();
    await db.prepare("DELETE FROM products WHERE code = ?1").bind(code).run();
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: `✅ کد کالای <code>${escapeHtml(code)}</code> با موفقیت حذف شد.`,
      reply_markup: {
        inline_keyboard: [[{ text: "📦 بازگشت به لیست کالاها", callback_data: "adm_crud_list:1" }]],
      },
    });
    return;
  }

  // ========================================================================
  // AI Auto-Publisher & Channel Settings Callbacks
  // ========================================================================

  if (data.startsWith("adm_ai_pub_auto:")) {
    const code = data.split(":")[1];
    await generateAndShowAIPreview(db, env, settings, chatId, code, "");
    return;
  }

  if (data.startsWith("adm_ai_pub_topic:")) {
    const code = data.split(":")[1];
    await setUserState(db, userId, "AWAIT_AI_CUSTOM_TOPIC", { code });
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `✏️ <b>انتشار با موضوع دلخواه توسط هوش مصنوعی (${escapeHtml(code)})</b>\n\n` +
        `لطفاً موضوع یا توضیحات کلیدی این پست را بنویسید تا هوش مصنوعی بر اساس آن کپشن و کاور تولید کند:`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: `adm_prd_view:${code}` }]],
      },
    });
    return;
  }

  if (data.startsWith("adm_ai_regen_text:")) {
    const code = data.split(":")[1];
    const draft = await db
      .prepare("SELECT topic FROM ai_drafts WHERE product_code = ?1")
      .bind(code)
      .first();
    const newCaption = await generateAICaptionForProduct(
      db,
      env,
      settings,
      code,
      draft?.topic || ""
    );
    await db
      .prepare("UPDATE ai_drafts SET generated_caption = ?1, updated_at = ?2 WHERE product_code = ?3")
      .bind(newCaption, Date.now(), code)
      .run();
    await renderAIDraftPreview(db, env, settings, chatId, code);
    return;
  }

  if (data.startsWith("adm_ai_cycle_cover:")) {
    const code = data.split(":")[1];
    const draft = await db
      .prepare("SELECT topic FROM ai_drafts WHERE product_code = ?1")
      .bind(code)
      .first();
    const cover = await prepareAICoverPhoto(
      db,
      env,
      settings,
      chatId,
      code,
      draft?.topic || code
    );
    await db
      .prepare(
        "UPDATE ai_drafts SET cover_file_id = ?1, cover_url = ?2, updated_at = ?3 WHERE product_code = ?4"
      )
      .bind(cover.cover_file_id || "", cover.cover_url || "", Date.now(), code)
      .run();
    await renderAIDraftPreview(db, env, settings, chatId, code);
    return;
  }

  if (data.startsWith("adm_ai_manual_cap:")) {
    const code = data.split(":")[1];
    await setUserState(db, userId, "AWAIT_AI_MANUAL_CAPTION", { code });
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `✏️ لطفاً کپشن دلخواه خود را برای کد <code>${escapeHtml(code)}</code> ارسال کنید:`,
    });
    return;
  }

  if (data.startsWith("adm_ai_confirm_pub:")) {
    const code = data.split(":")[1];
    await publishDraftToTargetChannel(db, env, settings, chatId, code);
    return;
  }

  if (data === "adm_ai_menu") {
    const moodLabels = {
      viral: "🔥 هیجانی و وایرال",
      official: "💎 رسمی و تخصصی",
      minimal: "⚡ کوتاه و مینیمال",
    };
    const coverLabels = {
      ai_gen: "🎨 تولید تصویر هوشمند با AI کلودفلر",
      internet: "🌐 دانلود عکس رندوم باکیفیت از اینترنت",
      product_photo: "📸 استفاده از عکس خود فایل‌ها",
    };

    const chStatus = settings.target_channel_title
      ? `✅ ${escapeHtml(settings.target_channel_title)} (<code>${escapeHtml(
          settings.target_channel_id
        )}</code>)`
      : "⚪ متصل نشده";

    const aiTokenStatus = settings.ai_api_token
      ? `✅ اکانت دوم فعال (${escapeHtml(settings.ai_account_id.slice(0, 8))}...)`
      : "⚡ استفاده از بایندینگ اکانت اول";

    const text =
      `🤖 <b>تنظیمات هوش مصنوعی و اتصال کانال مقصد</b>\n\n` +
      `📢 <b>کانال مقصد:</b> ${chStatus}\n` +
      `🎭 <b>حالت نگارش AI:</b> <b>${moodLabels[settings.ai_mood] || moodLabels.viral}</b>\n` +
      `🖼 <b>حالت کاور پست:</b> <b>${coverLabels[settings.ai_cover_mode] || coverLabels.ai_gen}</b>\n` +
      `✍️ <b>امضای پایان پست:</b> <code>${escapeHtml(settings.post_footer)}</code>\n` +
      `🔘 <b>قالب دکمه دانلود:</b> <code>${escapeHtml(settings.dl_button_template)}</code>\n` +
      `🔋 <b>وضعیت هسته AI:</b> ${aiTokenStatus}`;

    const inline_keyboard = [
      [{ text: "📢 اتصال / تغییر کانال مقصد", callback_data: "adm_ai_connect_ch" }],
      [
        {
          text: `🎭 تغییر لحن نگارش (${moodLabels[settings.ai_mood] || "وایرال"})`,
          callback_data: "adm_ai_toggle_mood",
        },
      ],
      [
        {
          text: `🖼 تغییر حالت عکس کاور`,
          callback_data: "adm_ai_toggle_cover",
        },
      ],
      [
        { text: "✍️ ویرایش امضای پست (Footer)", callback_data: "adm_set_key:post_footer:adm_ai_menu" },
        { text: "🔘 ویرایش متن دکمه دانلود", callback_data: "adm_set_key:dl_button_template:adm_ai_menu" },
      ],
      [
        { text: "🔑 تغییر توکن AI اکانت دوم", callback_data: "adm_set_key:ai_api_token:adm_ai_menu" },
        { text: "🆔 تغییر Account ID اکانت دوم", callback_data: "adm_set_key:ai_account_id:adm_ai_menu" },
      ],
      [{ text: "🔙 بازگشت به پنل اصلی", callback_data: "adm_home" }],
    ];

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text,
      reply_markup: { inline_keyboard },
    });
    return;
  }

  if (data === "adm_ai_toggle_mood") {
    const order = ["viral", "official", "minimal"];
    const next = order[(order.indexOf(settings.ai_mood) + 1) % order.length];
    await setSetting(db, "ai_mood", next);
    settings.ai_mood = next;
    cb.data = "adm_ai_menu";
    await handleCallbackQuery(cb, db, env, settings, ctx);
    return;
  }

  if (data === "adm_ai_toggle_cover") {
    const order = ["ai_gen", "internet", "product_photo"];
    const next = order[(order.indexOf(settings.ai_cover_mode) + 1) % order.length];
    await setSetting(db, "ai_cover_mode", next);
    settings.ai_cover_mode = next;
    cb.data = "adm_ai_menu";
    await handleCallbackQuery(cb, db, env, settings, ctx);
    return;
  }

  if (data === "adm_ai_connect_ch") {
    await setUserState(db, userId, "AWAIT_TARGET_CHANNEL", {});
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `📢 <b>اتصال دوطرفه کانال مقصد</b>\n\n` +
        `۱. ابتدا ربات را در کانال خود <b>Admin</b> کنید (با دسترسی ارسال و ویرایش پیام).\n` +
        `۲. سپس یک پیام از کانال خود به اینجا <b>فوروارد</b> کنید یا آیدی کانال (مثلاً <code>@MyChannel</code> یا <code>-100...</code>) را بفرستید:`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: "adm_ai_menu" }]],
      },
    });
    return;
  }

  if (data === "adm_ai_confirm_ch") {
    await setSetting(db, "target_channel_id", settings.pending_channel_id || "");
    await setSetting(db, "target_channel_title", settings.pending_channel_title || "");
    await setSetting(db, "target_channel_username", settings.pending_channel_username || "");
    settings.target_channel_id = settings.pending_channel_id;
    settings.target_channel_title = settings.pending_channel_title;
    settings.target_channel_username = settings.pending_channel_username;
    cb.data = "adm_ai_menu";
    await handleCallbackQuery(cb, db, env, settings, ctx);
    return;
  }

  // ========================================================================
  // Force-Join Locks Management Callbacks
  // ========================================================================

  if (data === "adm_locks_menu") {
    const rows = await db
      .prepare("SELECT * FROM force_locks ORDER BY id ASC")
      .all();
    const locks = (rows && rows.results) || [];

    const inline_keyboard = [
      [
        { text: "➕ افزودن قفل کانال تلگرام", callback_data: "adm_lock_add_ch" },
        { text: "🔗 افزودن قفل لینک/ربات", callback_data: "adm_lock_add_url" },
      ],
    ];

    for (const l of locks) {
      const icon = l.lock_type === "channel" ? "📢" : "🔗";
      const st = Number(l.is_active) === 1 ? "🟢" : "🔴";
      inline_keyboard.push([
        {
          text: `${st} ${icon} ${l.title}`,
          callback_data: `adm_lock_toggle:${l.id}`,
        },
        {
          text: "🗑 حذف",
          callback_data: `adm_lock_del:${l.id}`,
        },
      ]);
    }

    inline_keyboard.push([{ text: "🔙 بازگشت به پنل اصلی", callback_data: "adm_home" }]);

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `🔐 <b>مدیریت قفل‌های عضویت اجباری (${locks.length} قفل)</b>\n\n` +
        `• <b>قفل کانال تلگرام:</b> بررسی واقعی عضویت کاربر با API تلگرام + سیستم ایمنی خودکار در صورت حذف ربات از ادمینی.\n` +
        `• <b>قفل لینک خارجی / ربات:</b> نمایش دکمه شیشه‌ای برای ربات‌های دیگر، اینستاگرام یا وب‌سایت.`,
      reply_markup: { inline_keyboard },
    });
    return;
  }

  if (data === "adm_lock_add_ch") {
    await setUserState(db, userId, "AWAIT_LOCK_CHANNEL", {});
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `📢 <b>افزودن قفل کانال تلگرام (تایید واقعی API)</b>\n\n` +
        `۱. ابتدا ربات را در کانال مورد نظر <b>ادمین</b> کنید.\n` +
        `۲. در خط اول یوزرنیم (<code>@Channel</code>) یا آیدی عددی (<code>-100...</code>) و در خط دوم لینک عضویت کانال را بفرستید:\n\n` +
        `مثال:\n<code>@MySponsorChannel\nhttps://t.me/+AbCdEfGhIjK</code>`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: "adm_locks_menu" }]],
      },
    });
    return;
  }

  if (data === "adm_lock_add_url") {
    await setUserState(db, userId, "AWAIT_LOCK_URL", {});
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `🔗 <b>افزودن قفل لینک خارجی / ربات دیگر</b>\n\n` +
        `لطفاً در خط اول <b>عنوان دکمه شیشه‌ای</b> و در خط دوم <b>لینک کامل</b> را ارسال کنید:\n\n` +
        `مثال:\n<code>🤖 ورود به ربات ویژه\nhttps://t.me/OtherBot?start=ref1</code>`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: "adm_locks_menu" }]],
      },
    });
    return;
  }

  if (data.startsWith("adm_lock_toggle:")) {
    const id = Number(data.split(":")[1]);
    await db
      .prepare("UPDATE force_locks SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?1")
      .bind(id)
      .run();
    cb.data = "adm_locks_menu";
    await handleCallbackQuery(cb, db, env, settings, ctx);
    return;
  }

  if (data.startsWith("adm_lock_del:")) {
    const id = Number(data.split(":")[1]);
    await db.prepare("DELETE FROM force_locks WHERE id = ?1").bind(id).run();
    cb.data = "adm_locks_menu";
    await handleCallbackQuery(cb, db, env, settings, ctx);
    return;
  }

  // ========================================================================
  // Auto-Archive Backup Channel Menu
  // ========================================================================

  if (data === "adm_backup_menu") {
    const currentBackup = settings.backup_chat_id
      ? `✅ فعال روی <code>${escapeHtml(settings.backup_chat_id)}</code>`
      : "⚪ غیرفعال";

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `🗄 <b>کانال / گروه بکاپ خودکار فایل‌ها (Auto-Archive)</b>\n\n` +
        `وضعیت فعلی: ${currentBackup}\n\n` +
        `💡 با فعال‌سازی این بخش، به محض ساخت هر کد کالای جدید، یک نسخه از تمام فایل‌ها به همراه کد کالا در کانال یا سوپرگروه آرشیو شما کپی می‌شود.`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⚙️ تنظیم / تغییر آیدی کانال بکاپ",
              callback_data: "adm_set_key:backup_chat_id:adm_backup_menu",
            },
          ],
          [
            {
              text: "🔴 غیرفعال‌سازی بکاپ خودکار",
              callback_data: "adm_disable_backup",
            },
          ],
          [{ text: "🔙 بازگشت به پنل اصلی", callback_data: "adm_home" }],
        ],
      },
    });
    return;
  }

  if (data === "adm_disable_backup") {
    await setSetting(db, "backup_chat_id", "");
    settings.backup_chat_id = "";
    cb.data = "adm_backup_menu";
    await handleCallbackQuery(cb, db, env, settings, ctx);
    return;
  }

  // ========================================================================
  // Timer & Texts Customization Menu
  // ========================================================================

  if (data === "adm_settings_menu") {
    const t = String(settings.delete_timer || "30");
    const globalProt = String(settings.global_protect_content) === "1" ? "✅ فعال" : "⚪ غیرفعال";

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `⚙️ <b>شخصی‌سازی کامل متون و تایمر حذف خودکار</b>\n\n` +
        `⏱ تایمر فعلی حذف خودکار: <b>${Number(t) > 0 ? `${t} ثانیه` : "خاموش"}</b>\n` +
        `🛡 قفل فوروارد سراسری همه کالاها: <b>${globalProt}</b>\n\n` +
        `از دکمه‌های زیر زمان تایمر یا متون ربات را تغییر دهید:`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: `${t === "15" ? "✅ " : ""}15 ثانیه`, callback_data: "adm_timer:15" },
            { text: `${t === "30" ? "✅ " : ""}30 ثانیه`, callback_data: "adm_timer:30" },
            { text: `${t === "45" ? "✅ " : ""}45 ثانیه`, callback_data: "adm_timer:45" },
          ],
          [
            { text: `${t === "60" ? "✅ " : ""}60 ثانیه`, callback_data: "adm_timer:60" },
            { text: `${t === "0" ? "✅ " : ""}خاموش`, callback_data: "adm_timer:0" },
          ],
          [
            {
              text: `🛡 قفل فوروارد سراسری: ${globalProt}`,
              callback_data: "adm_toggle_global_prot",
            },
          ],
          [
            { text: "📝 متن استارت (/start)", callback_data: "adm_set_key:start_text:adm_settings_menu" },
            { text: "⚠️ متن هشدار حذف خودکار", callback_data: "adm_set_key:delete_warning_text:adm_settings_menu" },
          ],
          [
            { text: "❌ متن کالای یافت نشده", callback_data: "adm_set_key:not_found_text:adm_settings_menu" },
          ],
          [{ text: "🔙 بازگشت به پنل اصلی", callback_data: "adm_home" }],
        ],
      },
    });
    return;
  }

  if (data.startsWith("adm_timer:")) {
    const val = data.split(":")[1];
    await setSetting(db, "delete_timer", val);
    settings.delete_timer = val;
    cb.data = "adm_settings_menu";
    await handleCallbackQuery(cb, db, env, settings, ctx);
    return;
  }

  if (data === "adm_toggle_global_prot") {
    const next = String(settings.global_protect_content) === "1" ? "0" : "1";
    await setSetting(db, "global_protect_content", next);
    settings.global_protect_content = next;
    cb.data = "adm_settings_menu";
    await handleCallbackQuery(cb, db, env, settings, ctx);
    return;
  }

  if (data.startsWith("adm_set_key:")) {
    const parts = data.split(":");
    const key = parts[1];
    const returnMenu = parts[2] || "adm_settings_menu";
    await setUserState(db, userId, "AWAIT_SETTING_VALUE", { key, return_menu: returnMenu });

    const currentVal = settings[key] || "";
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `✏️ <b>ویرایش مقدار تنظیمات (<code>${escapeHtml(key)}</code>)</b>\n\n` +
        `مقدار فعلی:\n<code>${escapeHtml(currentVal || "خالی")}</code>\n\n` +
        `لطفاً مقدار جدید را ارسال کنید (برای پاک کردن، عبارت <code>/off</code> را بفرستید):`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: returnMenu }]],
      },
    });
    return;
  }

  // ========================================================================
  // Stats & Smart Broadcast Menu
  // ========================================================================

  if (data === "adm_stats_menu") {
    const counts = await db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM users) AS total_users,
          (SELECT COUNT(*) FROM products) AS total_products,
          (SELECT COUNT(*) FROM product_files) AS total_files,
          (SELECT COALESCE(SUM(views_count), 0) FROM products) AS total_views`
      )
      .first();

    const topRows = await db
      .prepare("SELECT code, views_count, files_count FROM products ORDER BY views_count DESC LIMIT 5")
      .all();
    const topList = (topRows && topRows.results) || [];

    const topText =
      topList.length > 0
        ? topList
            .map(
              (p, idx) =>
                `${idx + 1}. <code>${escapeHtml(p.code)}</code> — <b>${p.views_count} دانلود</b> (${p.files_count} فایل)`
            )
            .join("\n")
        : "هنوز دانلودی ثبت نشده است.";

    const text =
      `📊 <b>آمار جامع ربات و۵ کد برتر</b>\n\n` +
      `👥 کل کاربران ثبت‌شده: <b>${counts?.total_users || 0} نفر</b>\n` +
      `📦 کل کدهای کالا: <b>${counts?.total_products || 0} کد</b>\n` +
      `📁 کل فایل‌های دیتابیس: <b>${counts?.total_files || 0} فایل</b>\n` +
      `📥 کل دانلودهای انجام‌شده: <b>${counts?.total_views || 0} بار</b>\n\n` +
      `🏆 <b>۵ کد کالای پردانلود:</b>\n${topText}`;

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📢 ارسال پیام همگانی (بدون نام)", callback_data: "adm_bcast:copy" },
            { text: "🔄 فوروارد همگانی", callback_data: "adm_bcast:forward" },
          ],
          [{ text: "🔙 بازگشت به پنل اصلی", callback_data: "adm_home" }],
        ],
      },
    });
    return;
  }

  if (data.startsWith("adm_bcast:")) {
    const mode = data.split(":")[1];
    await setUserState(db, userId, "AWAIT_BROADCAST_MSG", { mode });
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `📢 <b>ارسال همگانی هوشمند (${mode === "forward" ? "فوروارد" : "کپی بدون نام"})</b>\n\n` +
        `لطفاً پیام، عکس، ویدیو یا هر محتوایی که می‌خواهید برای تمام کاربران ارسال شود را بفرستید:`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: "adm_stats_menu" }]],
      },
    });
    return;
  }
}

// ============================================================================
// Worker Entrypoint
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check endpoint called by Master UP-PRO Factory
    if (url.pathname === "/health") {
      try {
        await ensureSchema(env.DB);
        const counts = await env.DB
          .prepare(
            "SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM products) AS p"
          )
          .first();
        return new Response(
          JSON.stringify({
            ok: true,
            worker_name: env.WORKER_NAME || "UP-PROn",
            version: CHILD_VERSION,
            users: counts?.u || 0,
            products: counts?.p || 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: String(err) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Telegram Webhook Endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (env.WEBHOOK_SECRET) {
        const headerSecret = request.headers.get(
          "X-Telegram-Bot-Api-Secret-Token"
        );
        if (headerSecret !== env.WEBHOOK_SECRET) {
          return new Response("Forbidden: Invalid Webhook Secret", {
            status: 403,
          });
        }
      }

      try {
        const update = await request.json();
        await handleUpdate(update, env, ctx);
        return new Response("OK", { status: 200 });
      } catch (err) {
        return new Response(`Webhook Error: ${String(err)}`, { status: 200 });
      }
    }

    return new Response(
      `UP-PRO Child Uploader Worker (${env.WORKER_NAME || "UP-PROn"}) v${CHILD_VERSION} is running.`,
      { status: 200 }
    );
  },
};