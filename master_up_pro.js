/**
 * ============================================================================
 * UP-PRO — Master Telegram Bot Factory on Cloudflare Workers
 * ============================================================================
 * Role: Admin-Only Master Factory Bot that dynamically provisions, deploys,
 *       health-checks, updates, and manages standalone Child Uploader Bots
 *       (UP-PRO1, UP-PRO2, ..., UP-PROn) on target Cloudflare accounts via
 *       the Cloudflare REST API (Zero runtime traffic from child bot users).
 * ============================================================================
 */

const FACTORY_VERSION = "2.5.0";

const CF_CORE_TOKEN_DEEPLINK =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{"key":"workers_scripts","type":"edit"},{"key":"d1","type":"edit"},{"key":"workers_kv_storage","type":"edit"},{"key":"account_settings","type":"read"}]&name=UP-PRO_Core_Token';

const CF_AI_TOKEN_DEEPLINK =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{"key":"workers_ai","type":"read"},{"key":"workers_ai","type":"edit"},{"key":"account_settings","type":"read"}]&name=UP-PRO_AI_Token';

const CHILD_INITIAL_SQL = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, joined_at TEXT NOT NULL, last_active_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_states (user_id TEXT PRIMARY KEY, state TEXT NOT NULL, data_json TEXT DEFAULT '{}', updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS staging_files (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id TEXT NOT NULL, file_id TEXT NOT NULL, file_unique_id TEXT NOT NULL, media_type TEXT NOT NULL, file_name TEXT DEFAULT '', file_size INTEGER DEFAULT 0, caption TEXT DEFAULT '', source_chat_id TEXT DEFAULT '', source_message_id INTEGER DEFAULT 0, media_group_id TEXT DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products (code TEXT PRIMARY KEY, title TEXT DEFAULT '', custom_caption TEXT DEFAULT '', password TEXT DEFAULT '', protect_content INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, views_count INTEGER DEFAULT 0, files_count INTEGER DEFAULT 0, channel_chat_id TEXT DEFAULT '', channel_message_id INTEGER DEFAULT 0, created_at TEXT NOT NULL, last_accessed_at TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS product_files (id INTEGER PRIMARY KEY AUTOINCREMENT, product_code TEXT NOT NULL, file_id TEXT NOT NULL, file_unique_id TEXT NOT NULL, media_type TEXT NOT NULL, file_name TEXT DEFAULT '', file_size INTEGER DEFAULT 0, caption TEXT DEFAULT '', source_chat_id TEXT DEFAULT '', source_message_id INTEGER DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS force_locks (id INTEGER PRIMARY KEY AUTOINCREMENT, lock_type TEXT NOT NULL, title TEXT NOT NULL, chat_id TEXT DEFAULT '', invite_link TEXT NOT NULL, is_active INTEGER DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_drafts (product_code TEXT PRIMARY KEY, topic TEXT DEFAULT '', generated_caption TEXT DEFAULT '', cover_file_id TEXT DEFAULT '', cover_url TEXT DEFAULT '', updated_at INTEGER NOT NULL);
`;

const MASTER_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS factory_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    admin_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    data_json TEXT DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS deployed_bots (
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
  );`,
];

let masterSchemaReady = false;

async function ensureMasterSchema(db) {
  if (masterSchemaReady) return;
  for (const sql of MASTER_SCHEMA_STATEMENTS) {
    await db.prepare(sql).run();
  }
  masterSchemaReady = true;
}

// ============================================================================
// Embedded Child Worker Bundle Generator (UP-PRO{n})
// ============================================================================

const CHILD_WORKER_BUNDLE = "/**\n * ============================================================================\n * UP-PRO{n} — Standalone Child Telegram File Uploader & AI Channel Publisher\n * ============================================================================\n * Architecture: Zero-Dependency Cloudflare Worker (ES Module) + Cloudflare D1\n * Features:\n *   1. Zero-Download Upload & Atomic Staging Engine (Single & Album Media Groups)\n *   2. Product Code Generator (PRD_xxxx) + Auto-Archive Backup Channel Support\n *   3. User File Delivery via copyMessage + Fallback Media Send + Password Protection\n *   4. Zero-Cron Auto-Delete Engine via ctx.waitUntil() (15s/30s/45s/60s/Off)\n *   5. Advanced Force-Join Lock System (Real Channel API Check + Auto-Bypass + URL Locks)\n *   6. Dual-Account Cloudflare Workers AI Engine (Account 2 REST API + Account 1 Binding Fallback)\n *   7. Two-Way Target Channel Handshake + 3 AI Moods + 3 Cover Modes + Live Channel Post Edit\n *   8. Full Admin CRUD Panel (/panel), Empty/Broken Product Filter, Stats & Chunked Broadcast\n * ============================================================================\n */\n\nconst CHILD_VERSION = \"2.5.0\";\n\nconst DEFAULT_SETTINGS = {\n  delete_timer: \"30\",\n  global_protect_content: \"0\",\n  start_text:\n    \"👋 سلام {name} عزیز!\\n\\nبه ربات دانلود و اشتراک‌گذاری فایل خوش آمدید.\\nبرای دریافت فایل‌ها، روی لینک اختصاصی هر پست در کانال کلیک کنید.\",\n  delete_warning_text:\n    \"⚠️ توجه: این فایل‌ها تا {delete_timer} ثانیه دیگر به صورت خودکار حذف می‌شوند! لطفاً همین الان آن‌ها را به Saved Messages خود فوروارد کنید.\",\n  not_found_text:\n    \"❌ کد کالای مورد نظر یافت نشد، غیرفعال شده یا هنوز فایلی برای آن ثبت نشده است.\",\n  target_channel_id: \"\",\n  target_channel_title: \"\",\n  target_channel_username: \"\",\n  pending_channel_id: \"\",\n  pending_channel_title: \"\",\n  pending_channel_username: \"\",\n  backup_chat_id: \"\",\n  ai_mood: \"viral\", // viral | official | minimal\n  ai_cover_mode: \"ai_gen\", // ai_gen | internet | product_photo\n  post_footer: \"💎 @MyChannel | #آپلودر_اختصاصی\",\n  dl_button_template: \"📥 دانلود فایل‌ها (کد: {code})\",\n  ai_account_id: \"\",\n  ai_api_token: \"\",\n  bot_id: \"\",\n  bot_username: \"\",\n  admin_id_override: \"\",\n};\n\nconst CHILD_SCHEMA_STATEMENTS = [\n  `CREATE TABLE IF NOT EXISTS settings (\n    key TEXT PRIMARY KEY,\n    value TEXT NOT NULL\n  );`,\n  `CREATE TABLE IF NOT EXISTS users (\n    user_id TEXT PRIMARY KEY,\n    username TEXT,\n    first_name TEXT,\n    joined_at TEXT NOT NULL,\n    last_active_at TEXT NOT NULL\n  );`,\n  `CREATE TABLE IF NOT EXISTS user_states (\n    user_id TEXT PRIMARY KEY,\n    state TEXT NOT NULL,\n    data_json TEXT DEFAULT '{}',\n    updated_at INTEGER NOT NULL\n  );`,\n  `CREATE TABLE IF NOT EXISTS staging_files (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    admin_id TEXT NOT NULL,\n    file_id TEXT NOT NULL,\n    file_unique_id TEXT NOT NULL,\n    media_type TEXT NOT NULL,\n    file_name TEXT DEFAULT '',\n    file_size INTEGER DEFAULT 0,\n    caption TEXT DEFAULT '',\n    source_chat_id TEXT DEFAULT '',\n    source_message_id INTEGER DEFAULT 0,\n    media_group_id TEXT DEFAULT '',\n    created_at INTEGER NOT NULL\n  );`,\n  `CREATE TABLE IF NOT EXISTS products (\n    code TEXT PRIMARY KEY,\n    title TEXT DEFAULT '',\n    custom_caption TEXT DEFAULT '',\n    password TEXT DEFAULT '',\n    protect_content INTEGER DEFAULT 0,\n    is_active INTEGER DEFAULT 1,\n    views_count INTEGER DEFAULT 0,\n    files_count INTEGER DEFAULT 0,\n    channel_chat_id TEXT DEFAULT '',\n    channel_message_id INTEGER DEFAULT 0,\n    created_at TEXT NOT NULL,\n    last_accessed_at TEXT DEFAULT ''\n  );`,\n  `CREATE TABLE IF NOT EXISTS product_files (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    product_code TEXT NOT NULL,\n    file_id TEXT NOT NULL,\n    file_unique_id TEXT NOT NULL,\n    media_type TEXT NOT NULL,\n    file_name TEXT DEFAULT '',\n    file_size INTEGER DEFAULT 0,\n    caption TEXT DEFAULT '',\n    source_chat_id TEXT DEFAULT '',\n    source_message_id INTEGER DEFAULT 0,\n    created_at TEXT NOT NULL\n  );`,\n  `CREATE TABLE IF NOT EXISTS force_locks (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    lock_type TEXT NOT NULL,\n    title TEXT NOT NULL,\n    chat_id TEXT DEFAULT '',\n    invite_link TEXT NOT NULL,\n    is_active INTEGER DEFAULT 1,\n    created_at TEXT NOT NULL\n  );`,\n  `CREATE TABLE IF NOT EXISTS ai_drafts (\n    product_code TEXT PRIMARY KEY,\n    topic TEXT DEFAULT '',\n    generated_caption TEXT DEFAULT '',\n    cover_file_id TEXT DEFAULT '',\n    cover_url TEXT DEFAULT '',\n    updated_at INTEGER NOT NULL\n  );`,\n];\n\nlet schemaInitialized = false;\n\nasync function ensureSchema(db) {\n  if (schemaInitialized) return;\n  for (const sql of CHILD_SCHEMA_STATEMENTS) {\n    await db.prepare(sql).run();\n  }\n  schemaInitialized = true;\n}\n\n// ============================================================================\n// Database & Settings Helpers\n// ============================================================================\n\nasync function getAllSettings(db, env) {\n  const res = await db.prepare(\"SELECT key, value FROM settings\").all();\n  const map = { ...DEFAULT_SETTINGS };\n  if (res && Array.isArray(res.results)) {\n    for (const row of res.results) {\n      map[row.key] = row.value;\n    }\n  }\n  if (!map.ai_account_id && env.AI_ACCOUNT_ID) map.ai_account_id = env.AI_ACCOUNT_ID;\n  if (!map.ai_api_token && env.AI_API_TOKEN) map.ai_api_token = env.AI_API_TOKEN;\n  if (!map.bot_username && env.BOT_USERNAME) map.bot_username = env.BOT_USERNAME;\n  return map;\n}\n\nasync function setSetting(db, key, value) {\n  await db\n    .prepare(\n      \"INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value\"\n    )\n    .bind(String(key), String(value ?? \"\"))\n    .run();\n}\n\nasync function getUserState(db, userId) {\n  const row = await db\n    .prepare(\"SELECT state, data_json FROM user_states WHERE user_id = ?1\")\n    .bind(String(userId))\n    .first();\n  if (!row) return { state: \"IDLE\", data: {} };\n  let parsed = {};\n  try {\n    parsed = JSON.parse(row.data_json || \"{}\");\n  } catch (_) {\n    parsed = {};\n  }\n  return { state: row.state || \"IDLE\", data: parsed };\n}\n\nasync function setUserState(db, userId, state, data = {}) {\n  await db\n    .prepare(\n      \"INSERT INTO user_states (user_id, state, data_json, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data_json = excluded.data_json, updated_at = excluded.updated_at\"\n    )\n    .bind(String(userId), String(state), JSON.stringify(data || {}), Date.now())\n    .run();\n}\n\nasync function clearUserState(db, userId) {\n  await db\n    .prepare(\"DELETE FROM user_states WHERE user_id = ?1\")\n    .bind(String(userId))\n    .run();\n}\n\nasync function trackUser(db, from) {\n  if (!from || !from.id) return;\n  const now = new Date().toISOString();\n  await db\n    .prepare(\n      `INSERT INTO users (user_id, username, first_name, joined_at, last_active_at)\n       VALUES (?1, ?2, ?3, ?4, ?4)\n       ON CONFLICT(user_id) DO UPDATE SET\n         username = excluded.username,\n         first_name = excluded.first_name,\n         last_active_at = excluded.last_active_at`\n    )\n    .bind(\n      String(from.id),\n      from.username ? String(from.username) : \"\",\n      from.first_name ? String(from.first_name) : \"کاربر\",\n      now\n    )\n    .run();\n}\n\nfunction isAdminUser(userId, env, settings) {\n  const primaryAdmin = String(settings.admin_id_override || env.ADMIN_ID || \"\").trim();\n  const envAdmin = String(env.ADMIN_ID || \"\").trim();\n  const uid = String(userId || \"\").trim();\n  return Boolean(uid && (uid === primaryAdmin || uid === envAdmin));\n}\n\n// ============================================================================\n// Telegram Bot API Helpers\n// ============================================================================\n\nasync function tgApi(botToken, method, payload = {}) {\n  const url = `https://api.telegram.org/bot${botToken}/${method}`;\n  const resp = await fetch(url, {\n    method: \"POST\",\n    headers: { \"Content-Type\": \"application/json\" },\n    body: JSON.stringify(payload),\n  });\n  try {\n    return await resp.json();\n  } catch (err) {\n    return { ok: false, description: String(err) };\n  }\n}\n\nasync function tgSendPhotoBinary(botToken, chatId, imageBytes, caption, replyMarkup) {\n  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;\n  const form = new FormData();\n  form.append(\"chat_id\", String(chatId));\n  if (caption) {\n    form.append(\"caption\", caption);\n    form.append(\"parse_mode\", \"HTML\");\n  }\n  if (replyMarkup) {\n    form.append(\"reply_markup\", JSON.stringify(replyMarkup));\n  }\n  const blob = new Blob([imageBytes], { type: \"image/jpeg\" });\n  form.append(\"photo\", blob, \"cover.jpg\");\n  const resp = await fetch(url, { method: \"POST\", body: form });\n  try {\n    return await resp.json();\n  } catch (err) {\n    return { ok: false, description: String(err) };\n  }\n}\n\nasync function ensureBotIdentity(db, env, settings) {\n  if (settings.bot_id && settings.bot_username) {\n    return { id: settings.bot_id, username: settings.bot_username };\n  }\n  const me = await tgApi(env.BOT_TOKEN, \"getMe\", {});\n  if (me && me.ok && me.result) {\n    const id = String(me.result.id);\n    const username = String(me.result.username || \"\");\n    await setSetting(db, \"bot_id\", id);\n    await setSetting(db, \"bot_username\", username);\n    settings.bot_id = id;\n    settings.bot_username = username;\n    return { id, username };\n  }\n  return { id: \"\", username: env.BOT_USERNAME || \"\" };\n}\n\nfunction escapeHtml(str) {\n  return String(str ?? \"\")\n    .replace(/&/g, \"&amp;\")\n    .replace(/</g, \"&lt;\")\n    .replace(/>/g, \"&gt;\");\n}\n\nfunction extractMediaFromMessage(message) {\n  if (!message) return null;\n  const caption = message.caption || \"\";\n  const mediaGroupId = message.media_group_id ? String(message.media_group_id) : \"\";\n\n  if (Array.isArray(message.photo) && message.photo.length > 0) {\n    const bestPhoto = message.photo[message.photo.length - 1];\n    return {\n      file_id: bestPhoto.file_id,\n      file_unique_id: bestPhoto.file_unique_id,\n      media_type: \"photo\",\n      file_name: \"photo.jpg\",\n      file_size: bestPhoto.file_size || 0,\n      caption,\n      media_group_id: mediaGroupId,\n    };\n  }\n  if (message.video) {\n    return {\n      file_id: message.video.file_id,\n      file_unique_id: message.video.file_unique_id,\n      media_type: \"video\",\n      file_name: message.video.file_name || \"video.mp4\",\n      file_size: message.video.file_size || 0,\n      caption,\n      media_group_id: mediaGroupId,\n    };\n  }\n  if (message.document) {\n    return {\n      file_id: message.document.file_id,\n      file_unique_id: message.document.file_unique_id,\n      media_type: \"document\",\n      file_name: message.document.file_name || \"document\",\n      file_size: message.document.file_size || 0,\n      caption,\n      media_group_id: mediaGroupId,\n    };\n  }\n  if (message.audio) {\n    return {\n      file_id: message.audio.file_id,\n      file_unique_id: message.audio.file_unique_id,\n      media_type: \"audio\",\n      file_name: message.audio.file_name || message.audio.title || \"audio.mp3\",\n      file_size: message.audio.file_size || 0,\n      caption,\n      media_group_id: mediaGroupId,\n    };\n  }\n  if (message.animation) {\n    return {\n      file_id: message.animation.file_id,\n      file_unique_id: message.animation.file_unique_id,\n      media_type: \"animation\",\n      file_name: message.animation.file_name || \"animation.gif\",\n      file_size: message.animation.file_size || 0,\n      caption,\n      media_group_id: mediaGroupId,\n    };\n  }\n  if (message.voice) {\n    return {\n      file_id: message.voice.file_id,\n      file_unique_id: message.voice.file_unique_id,\n      media_type: \"voice\",\n      file_name: \"voice.ogg\",\n      file_size: message.voice.file_size || 0,\n      caption,\n      media_group_id: mediaGroupId,\n    };\n  }\n  return null;\n}\n\nasync function deliverSingleFile(botToken, targetChatId, fileRecord, protectContent) {\n  // Primary delivery: Telegram copyMessage API (zero forward header)\n  if (fileRecord.source_chat_id && fileRecord.source_message_id) {\n    const copyRes = await tgApi(botToken, \"copyMessage\", {\n      chat_id: targetChatId,\n      from_chat_id: fileRecord.source_chat_id,\n      message_id: Number(fileRecord.source_message_id),\n      protect_content: Boolean(protectContent),\n    });\n    if (copyRes && copyRes.ok && copyRes.result && copyRes.result.message_id) {\n      return copyRes.result.message_id;\n    }\n  }\n\n  // Fallback delivery by file_id if original chat message was removed\n  const methodMap = {\n    photo: [\"sendPhoto\", \"photo\"],\n    video: [\"sendVideo\", \"video\"],\n    document: [\"sendDocument\", \"document\"],\n    audio: [\"sendAudio\", \"audio\"],\n    animation: [\"sendAnimation\", \"animation\"],\n    voice: [\"sendVoice\", \"voice\"],\n  };\n  const [method, field] = methodMap[fileRecord.media_type] || [\"sendDocument\", \"document\"];\n  const payload = {\n    chat_id: targetChatId,\n    [field]: fileRecord.file_id,\n    protect_content: Boolean(protectContent),\n  };\n  if (fileRecord.caption) {\n    payload.caption = fileRecord.caption;\n  }\n  const res = await tgApi(botToken, method, payload);\n  if (res && res.ok && res.result && res.result.message_id) {\n    return res.result.message_id;\n  }\n  return null;\n}\n\nasync function deleteMessagesBatch(botToken, chatId, messageIds) {\n  if (!Array.isArray(messageIds) || messageIds.length === 0) return;\n  const validIds = messageIds.filter((id) => Number.isInteger(Number(id)) && Number(id) > 0);\n  if (validIds.length === 0) return;\n\n  // Attempt batch deleteMessages first (supports up to 100 messages)\n  const batchRes = await tgApi(botToken, \"deleteMessages\", {\n    chat_id: chatId,\n    message_ids: validIds,\n  });\n  if (batchRes && batchRes.ok) return;\n\n  // Fallback to individual deleteMessage calls\n  for (const msgId of validIds) {\n    await tgApi(botToken, \"deleteMessage\", {\n      chat_id: chatId,\n      message_id: msgId,\n    });\n  }\n}\n\n// ============================================================================\n// Dual-Account Cloudflare Workers AI Helper\n// ============================================================================\n\nasync function runCloudflareAI(env, settings, model, payload, expectBinary = false) {\n  const aiAccountId = (settings.ai_account_id || env.AI_ACCOUNT_ID || \"\").trim();\n  const aiApiToken = (settings.ai_api_token || env.AI_API_TOKEN || \"\").trim();\n\n  // 1. Primary Method: Account 2 (or configured token) via Cloudflare REST API\n  if (aiAccountId && aiApiToken) {\n    try {\n      const url = `https://api.cloudflare.com/client/v4/accounts/${aiAccountId}/ai/run/${model}`;\n      const resp = await fetch(url, {\n        method: \"POST\",\n        headers: {\n          Authorization: `Bearer ${aiApiToken}`,\n          \"Content-Type\": \"application/json\",\n        },\n        body: JSON.stringify(payload),\n      });\n\n      if (resp.ok) {\n        const contentType = resp.headers.get(\"content-type\") || \"\";\n        if (expectBinary && !contentType.includes(\"application/json\")) {\n          const arrayBuf = await resp.arrayBuffer();\n          return { ok: true, binary: new Uint8Array(arrayBuf), source: \"rest_api\" };\n        }\n        const data = await resp.json();\n        if (data && data.success && data.result) {\n          if (expectBinary && data.result.image) {\n            const binStr = atob(data.result.image);\n            const bytes = new Uint8Array(binStr.length);\n            for (let i = 0; i < binStr.length; i++) {\n              bytes[i] = binStr.charCodeAt(i);\n            }\n            return { ok: true, binary: bytes, source: \"rest_api\" };\n          }\n          return { ok: true, result: data.result, source: \"rest_api\" };\n        }\n      }\n    } catch (_) {\n      // Automatically fall through to Account 1 binding\n    }\n  }\n\n  // 2. Automatic Fallback: Account 1 Native Workers AI Binding (env.AI)\n  if (env.AI && typeof env.AI.run === \"function\") {\n    try {\n      const aiRes = await env.AI.run(model, payload);\n      if (expectBinary) {\n        if (aiRes instanceof ReadableStream) {\n          const buf = await new Response(aiRes).arrayBuffer();\n          return { ok: true, binary: new Uint8Array(buf), source: \"binding\" };\n        }\n        if (aiRes instanceof Uint8Array || aiRes instanceof ArrayBuffer) {\n          return {\n            ok: true,\n            binary: aiRes instanceof Uint8Array ? aiRes : new Uint8Array(aiRes),\n            source: \"binding\",\n          };\n        }\n        if (aiRes && aiRes.image) {\n          const binStr = atob(aiRes.image);\n          const bytes = new Uint8Array(binStr.length);\n          for (let i = 0; i < binStr.length; i++) {\n            bytes[i] = binStr.charCodeAt(i);\n          }\n          return { ok: true, binary: bytes, source: \"binding\" };\n        }\n      }\n      return { ok: true, result: aiRes, source: \"binding\" };\n    } catch (err) {\n      return { ok: false, error: String(err) };\n    }\n  }\n\n  return {\n    ok: false,\n    error: \"هیچ توکن هوش مصنوعی یا بایندینگ AI فعالی یافت نشد.\",\n  };\n}\n\n// ============================================================================\n// Force-Join Lock Verification Engine (With Runtime Safety Auto-Bypass)\n// ============================================================================\n\nasync function checkUserForceLocks(db, env, settings, userId) {\n  const locksRes = await db\n    .prepare(\"SELECT * FROM force_locks WHERE is_active = 1 ORDER BY id ASC\")\n    .all();\n  const locks = (locksRes && locksRes.results) || [];\n  if (locks.length === 0) {\n    return { locked: false, missingChannelLocks: [], urlLocks: [] };\n  }\n\n  const missingChannelLocks = [];\n  const urlLocks = [];\n  const primaryAdmin = String(settings.admin_id_override || env.ADMIN_ID || \"\").trim();\n\n  for (const lock of locks) {\n    if (lock.lock_type === \"url\") {\n      urlLocks.push(lock);\n      continue;\n    }\n\n    if (lock.lock_type === \"channel\" && lock.chat_id) {\n      const memberRes = await tgApi(env.BOT_TOKEN, \"getChatMember\", {\n        chat_id: lock.chat_id,\n        user_id: Number(userId),\n      });\n\n      if (!memberRes || !memberRes.ok) {\n        // Runtime Safety: Bot was removed from admin or channel is unreachable -> Auto-bypass & alert admin\n        const errDesc = (memberRes && memberRes.description) || \"Unknown API Error\";\n        await db\n          .prepare(\"UPDATE force_locks SET is_active = 0 WHERE id = ?1\")\n          .bind(lock.id)\n          .run();\n        if (primaryAdmin) {\n          await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n            chat_id: primaryAdmin,\n            parse_mode: \"HTML\",\n            text:\n              `⚠️ <b>هشدار ایمنی خودکار قفل عضویت اجباری</b>\\n\\n` +\n              `ربات هنگام بررسی عضویت کاربران در کانال <b>${escapeHtml(lock.title)}</b> (<code>${escapeHtml(lock.chat_id)}</code>) با خطا مواجه شد:\\n` +\n              `<code>${escapeHtml(errDesc)}</code>\\n\\n` +\n              `✅ برای جلوگیری از قفل شدن ربات روی کاربران، این قفل به صورت خودکار <b>غیرفعال (Bypass)</b> شد. لطفاً دسترسی ادمینی ربات در کانال را بررسی کنید.`,\n          });\n        }\n        continue;\n      }\n\n      const status = memberRes.result && memberRes.result.status;\n      const isJoined =\n        status === \"creator\" ||\n        status === \"administrator\" ||\n        status === \"member\" ||\n        (status === \"restricted\" && memberRes.result.is_member === true);\n\n      if (!isJoined) {\n        missingChannelLocks.push(lock);\n      }\n    }\n  }\n\n  return {\n    locked: missingChannelLocks.length > 0,\n    missingChannelLocks,\n    urlLocks,\n  };\n}\n\nfunction buildForceLockKeyboard(missingChannelLocks, urlLocks, productCode) {\n  const inline_keyboard = [];\n  for (const ch of missingChannelLocks) {\n    inline_keyboard.push([\n      {\n        text: `📢 عضویت در «${ch.title}»`,\n        url: ch.invite_link,\n      },\n    ]);\n  }\n  for (const u of urlLocks) {\n    inline_keyboard.push([\n      {\n        text: `🔗 ${u.title}`,\n        url: u.invite_link,\n      },\n    ]);\n  }\n  inline_keyboard.push([\n    {\n      text: \"✅ عضو شدم / دریافت فایل\",\n      callback_data: `chk_join:${productCode || \"NONE\"}`,\n    },\n  ]);\n  return { inline_keyboard };\n}\n\n// ============================================================================\n// User File Delivery Flow\n// ============================================================================\n\nasync function handleProductDelivery(ctx, db, env, settings, chatId, userId, productCode, skipPassword = false) {\n  // 1. Check Force-Join Locks first\n  const lockStatus = await checkUserForceLocks(db, env, settings, userId);\n  if (lockStatus.locked) {\n    const kb = buildForceLockKeyboard(\n      lockStatus.missingChannelLocks,\n      lockStatus.urlLocks,\n      productCode\n    );\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text:\n        `🔒 <b>تایید عضویت در اسپانسرها</b>\\n\\n` +\n        `کاربر گرامی، برای دریافت فایل‌های کد <code>${escapeHtml(productCode)}</code> ابتدا در کانال‌های زیر عضو شوید و سپس روی دکمه <b>«✅ عضو شدم / دریافت فایل»</b> بزنید:`,\n      reply_markup: kb,\n    });\n    return;\n  }\n\n  // 2. Check if product exists and is active\n  const product = await db\n    .prepare(\"SELECT * FROM products WHERE code = ?1\")\n    .bind(productCode)\n    .first();\n\n  if (!product || Number(product.is_active) !== 1) {\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: settings.not_found_text || DEFAULT_SETTINGS.not_found_text,\n    });\n    return;\n  }\n\n  const filesRes = await db\n    .prepare(\"SELECT * FROM product_files WHERE product_code = ?1 ORDER BY id ASC\")\n    .bind(productCode)\n    .all();\n  const files = (filesRes && filesRes.results) || [];\n\n  if (files.length === 0) {\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: settings.not_found_text || DEFAULT_SETTINGS.not_found_text,\n    });\n    return;\n  }\n\n  // 3. Check Password Protection\n  if (product.password && product.password.trim() !== \"\" && !skipPassword) {\n    await setUserState(db, userId, \"AWAIT_PRODUCT_PASS\", { code: productCode });\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text:\n        `🔐 <b>این بسته دارای رمز عبور است!</b>\\n\\n` +\n        `لطفاً رمز عبور مربوط به کد <code>${escapeHtml(productCode)}</code> را ارسال کنید:`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"❌ انصراف\", callback_data: \"user_cancel\" }]],\n      },\n    });\n    return;\n  }\n\n  // 4. Increment views_count & update last_accessed_at\n  const nowIso = new Date().toISOString();\n  await db\n    .prepare(\n      \"UPDATE products SET views_count = views_count + 1, last_accessed_at = ?1 WHERE code = ?2\"\n    )\n    .bind(nowIso, productCode)\n    .run();\n\n  // 5. Deliver all files using copyMessage (zero forward header)\n  const protectContent =\n    Number(product.protect_content) === 1 ||\n    String(settings.global_protect_content) === \"1\";\n\n  const sentMessageIds = [];\n  for (const fileRec of files) {\n    const msgId = await deliverSingleFile(\n      env.BOT_TOKEN,\n      chatId,\n      fileRec,\n      protectContent\n    );\n    if (msgId) {\n      sentMessageIds.push(msgId);\n    }\n  }\n\n  // 6. Send Warning & Schedule Zero-Cron Auto-Delete via ctx.waitUntil\n  const deleteTimer = parseInt(settings.delete_timer || \"30\", 10);\n  if (deleteTimer > 0 && !protectContent && sentMessageIds.length > 0) {\n    const warningTemplate =\n      settings.delete_warning_text || DEFAULT_SETTINGS.delete_warning_text;\n    const warningText = warningTemplate.replace(\n      /\\{delete_timer\\}/g,\n      String(deleteTimer)\n    );\n\n    const warnRes = await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: warningText,\n    });\n    if (warnRes && warnRes.ok && warnRes.result && warnRes.result.message_id) {\n      sentMessageIds.push(warnRes.result.message_id);\n    }\n\n    if (ctx && typeof ctx.waitUntil === \"function\") {\n      ctx.waitUntil(\n        new Promise((resolve) => setTimeout(resolve, deleteTimer * 1000)).then(\n          () => deleteMessagesBatch(env.BOT_TOKEN, chatId, sentMessageIds)\n        )\n      );\n    }\n  } else if (protectContent && sentMessageIds.length > 0) {\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: `🛡 <b>قفل فوروارد و ذخیره (Protect Content) برای این بسته فعال است.</b>`,\n    });\n  }\n}\n\n// ============================================================================\n// Admin UI Menus & Panels (Fluent Persian + Clean Glass Navigation)\n// ============================================================================\n\nfunction getAdminMainKeyboard() {\n  return {\n    inline_keyboard: [\n      [\n        {\n          text: \"➕ آپلود فایل / ساخت کد کالا\",\n          callback_data: \"adm_start_staging\",\n        },\n      ],\n      [\n        { text: \"📦 مدیریت کامل کالاها (CRUD)\", callback_data: \"adm_crud_list:1\" },\n        { text: \"⚠️ کالاهای ناقص/خالی\", callback_data: \"adm_crud_empty\" },\n      ],\n      [\n        { text: \"🤖 هوش مصنوعی و کانال\", callback_data: \"adm_ai_menu\" },\n        { text: \"🔐 مدیریت قفل‌ها\", callback_data: \"adm_locks_menu\" },\n      ],\n      [\n        { text: \"🗄 کانال/گروه بکاپ خودکار\", callback_data: \"adm_backup_menu\" },\n        { text: \"⚙️ شخصی‌سازی متون و تایمر\", callback_data: \"adm_settings_menu\" },\n      ],\n      [\n        { text: \"📊 آمار و ارسال همگانی هوشمند\", callback_data: \"adm_stats_menu\" },\n      ],\n    ],\n  };\n}\n\nasync function renderAdminHomePanel(db, env, settings, chatId, messageId = null) {\n  const counts = await db\n    .prepare(\n      `SELECT\n        (SELECT COUNT(*) FROM users) AS total_users,\n        (SELECT COUNT(*) FROM products) AS total_products,\n        (SELECT COUNT(*) FROM product_files) AS total_files,\n        (SELECT COALESCE(SUM(views_count), 0) FROM products) AS total_views`\n    )\n    .first();\n\n  const workerName = env.WORKER_NAME || \"UP-PROn\";\n  const channelLabel = settings.target_channel_title\n    ? `✅ متصل به «${escapeHtml(settings.target_channel_title)}»`\n    : \"⚪ متصل نشده\";\n  const timerLabel =\n    Number(settings.delete_timer) > 0\n      ? `${settings.delete_timer} ثانیه`\n      : \"خاموش (بدون حذف)\";\n\n  const text =\n    `🎛 <b>پنل مدیریت پیشرفته آپلودر و ناشر هوشمند (${escapeHtml(workerName)})</b>\\n\\n` +\n    `👥 کل کاربران: <b>${counts?.total_users || 0}</b> نفر\\n` +\n    `📦 کل کدهای کالا: <b>${counts?.total_products || 0}</b> بسته (${counts?.total_files || 0} فایل)\\n` +\n    `📥 مجموع دانلودها: <b>${counts?.total_views || 0}</b> بار\\n` +\n    `📢 کانال مقصد AI: ${channelLabel}\\n` +\n    `⏱ تایمر حذف خودکار: <b>${timerLabel}</b>\\n\\n` +\n    `👇 از دکمه‌های شیشه‌ای زیر بخش مورد نظر خود را انتخاب کنید:`;\n\n  const kb = getAdminMainKeyboard();\n  if (messageId) {\n    const editRes = await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text,\n      reply_markup: kb,\n    });\n    if (editRes && editRes.ok) return;\n  }\n  await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n    chat_id: chatId,\n    parse_mode: \"HTML\",\n    text,\n    reply_markup: kb,\n  });\n}\n\n// ============================================================================\n// Staging & Product Code Generation Engine\n// ============================================================================\n\nasync function getStagingSummary(db, adminId) {\n  const rows = await db\n    .prepare(\"SELECT * FROM staging_files WHERE admin_id = ?1 ORDER BY id ASC\")\n    .bind(String(adminId))\n    .all();\n  const list = (rows && rows.results) || [];\n  const counts = {\n    total: list.length,\n    video: 0,\n    photo: 0,\n    document: 0,\n    audio: 0,\n    animation: 0,\n    voice: 0,\n  };\n  for (const item of list) {\n    if (counts[item.media_type] !== undefined) {\n      counts[item.media_type]++;\n    }\n  }\n  return { list, counts };\n}\n\nfunction buildStagingStatusText(counts, targetCode = null) {\n  const extraParts = [];\n  if (counts.document > 0) extraParts.push(`${counts.document} فایل/سند`);\n  if (counts.audio > 0) extraParts.push(`${counts.audio} موزیک/صوت`);\n  if (counts.animation > 0) extraParts.push(`${counts.animation} گیف`);\n  if (counts.voice > 0) extraParts.push(`${counts.voice} ویس`);\n  const extraStr = extraParts.length > 0 ? `، ${extraParts.join(\"، \")}` : \"\";\n\n  const header = targetCode\n    ? `➕ <b>در حال افزودن فایل به کد کالای <code>${escapeHtml(targetCode)}</code></b>\\n\\n`\n    : `📤 <b>حالت دریافت و آپلود فایل فعال است</b>\\n\\n`;\n\n  return (\n    header +\n    `📊 تعداد فایل‌های دریافت شده تا الان: <b>${counts.total} فایل</b> (${counts.video} ویدیو، ${counts.photo} عکس${extraStr})\\n\\n` +\n    `💡 می‌توانید فایل‌های تکی یا آلبوم‌های چندتایی را ارسال یا فوروارد کنید. پس از ارسال همه فایل‌ها روی دکمه زیر بزنید:`\n  );\n}\n\nfunction buildStagingKeyboard(targetCode = null) {\n  return {\n    inline_keyboard: [\n      [\n        {\n          text: \"✅ اتمام و آنالیز نهایی\",\n          callback_data: targetCode\n            ? `adm_finish_staging:${targetCode}`\n            : \"adm_finish_staging:NEW\",\n        },\n      ],\n      [\n        {\n          text: \"🗑 پاکسازی لیست موقت\",\n          callback_data: \"adm_clear_staging\",\n        },\n      ],\n      [{ text: \"🔙 انصراف و بازگشت به پنل\", callback_data: \"adm_home\" }],\n    ],\n  };\n}\n\nasync function generateUniqueProductCode(db) {\n  for (let attempt = 0; attempt < 15; attempt++) {\n    const num = Math.floor(1000 + Math.random() * 9000);\n    const code = `PRD_${num}`;\n    const existing = await db\n      .prepare(\"SELECT code FROM products WHERE code = ?1\")\n      .bind(code)\n      .first();\n    if (!existing) return code;\n  }\n  return `PRD_${Date.now().toString().slice(-5)}`;\n}\n\nasync function finalizeStagingAndCreateProduct(db, env, settings, chatId, adminId, messageId, existingCode = null) {\n  const { list, counts } = await getStagingSummary(db, adminId);\n  if (list.length === 0) {\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: \"⚠️ هنوز هیچ فایلی در لیست موقت دریافت نشده است! لطفاً ابتدا فایل‌های خود را ارسال کنید.\",\n    });\n    return;\n  }\n\n  const botIdentity = await ensureBotIdentity(db, env, settings);\n  const nowIso = new Date().toISOString();\n  let productCode = existingCode && existingCode !== \"NEW\" ? existingCode : null;\n\n  if (!productCode) {\n    productCode = await generateUniqueProductCode(db);\n    const firstCaption = (list.find((f) => f.caption)?.caption || \"\").slice(0, 120);\n    await db\n      .prepare(\n        `INSERT INTO products (code, title, custom_caption, password, protect_content, is_active, views_count, files_count, created_at)\n         VALUES (?1, ?2, ?3, '', 0, 1, 0, ?4, ?5)`\n      )\n      .bind(productCode, firstCaption || `بسته ${productCode}`, firstCaption, list.length, nowIso)\n      .run();\n  }\n\n  for (const f of list) {\n    await db\n      .prepare(\n        `INSERT INTO product_files (product_code, file_id, file_unique_id, media_type, file_name, file_size, caption, source_chat_id, source_message_id, created_at)\n         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`\n      )\n      .bind(\n        productCode,\n        f.file_id,\n        f.file_unique_id,\n        f.media_type,\n        f.file_name || \"\",\n        f.file_size || 0,\n        f.caption || \"\",\n        f.source_chat_id || \"\",\n        f.source_message_id || 0,\n        nowIso\n      )\n      .run();\n  }\n\n  // Recompute total files_count for product\n  const countRow = await db\n    .prepare(\"SELECT COUNT(*) AS cnt FROM product_files WHERE product_code = ?1\")\n    .bind(productCode)\n    .first();\n  await db\n    .prepare(\"UPDATE products SET files_count = ?1, is_active = 1 WHERE code = ?2\")\n    .bind(countRow?.cnt || list.length, productCode)\n    .run();\n\n  // Clear staging_files and state\n  await db\n    .prepare(\"DELETE FROM staging_files WHERE admin_id = ?1\")\n    .bind(String(adminId))\n    .run();\n  await clearUserState(db, adminId);\n\n  const deepLink = `https://t.me/${botIdentity.username || \"Bot\"}?start=${productCode}`;\n\n  // Optional Auto-Archive to Backup Channel / Group\n  if (settings.backup_chat_id && settings.backup_chat_id.trim() !== \"\") {\n    const bChatId = settings.backup_chat_id.trim();\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: bChatId,\n      parse_mode: \"HTML\",\n      text:\n        `🗄 <b>بکاپ خودکار بسته جدید</b>\\n` +\n        `🔖 کد کالا: <code>${escapeHtml(productCode)}</code>\\n` +\n        `📦 تعداد فایل‌های جدید: <b>${counts.total}</b>\\n` +\n        `🔗 لینک دانلود:\\n${deepLink}`,\n    });\n    for (const f of list) {\n      await deliverSingleFile(env.BOT_TOKEN, bChatId, f, false);\n    }\n  }\n\n  const productRow = await db\n    .prepare(\"SELECT * FROM products WHERE code = ?1\")\n    .bind(productCode)\n    .first();\n\n  const protectIcon = Number(productRow?.protect_content) === 1 ? \"✅ فعال\" : \"⚪ غیرفعال\";\n  const passIcon = productRow?.password ? `✅ تنظیم شده (${productRow.password})` : \"⚪ ندارد\";\n\n  const summaryText =\n    `✅ <b>آنالیز نهایی و ثبت کد کالا با موفقیت انجام شد!</b>\\n\\n` +\n    `🔖 <b>کد اختصاصی کالا:</b> <code>${escapeHtml(productCode)}</code>\\n` +\n    `📊 <b>جزئیات فایل‌های ثبت شده در این مرحله:</b>\\n` +\n    `• کل فایل‌ها: <b>${counts.total} فایل</b>\\n` +\n    `• ویدیو: <b>${counts.video}</b> | عکس: <b>${counts.photo}</b>\\n` +\n    `• سند/فایل: <b>${counts.document}</b> | صوت/ویس: <b>${counts.audio + counts.voice}</b> | گیف: <b>${counts.animation}</b>\\n\\n` +\n    `🔒 رمز عبور: <b>${passIcon}</b>\\n` +\n    `🛡 قفل فوروارد: <b>${protectIcon}</b>\\n\\n` +\n    `🔗 <b>لینک مستقیم اشتراک‌گذاری:</b>\\n<code>${deepLink}</code>\\n\\n` +\n    `👇 عملیات بعدی روی این کد کالا را انتخاب کنید:`;\n\n  const kb = buildProductQuickActionsKeyboard(productCode, productRow);\n\n  if (messageId) {\n    const ed = await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text: summaryText,\n      reply_markup: kb,\n    });\n    if (ed && ed.ok) return;\n  }\n  await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n    chat_id: chatId,\n    parse_mode: \"HTML\",\n    text: summaryText,\n    reply_markup: kb,\n  });\n}\n\nfunction buildProductQuickActionsKeyboard(productCode, productRow) {\n  const protectActive = Number(productRow?.protect_content) === 1;\n  const hasPass = Boolean(productRow?.password && productRow.password.trim() !== \"\");\n  return {\n    inline_keyboard: [\n      [\n        {\n          text: \"🚀 انتشار خودکار در کانال با AI\",\n          callback_data: `adm_ai_pub_auto:${productCode}`,\n        },\n      ],\n      [\n        {\n          text: \"✏️ انتشار با موضوع دلخواه توسط AI\",\n          callback_data: `adm_ai_pub_topic:${productCode}`,\n        },\n      ],\n      [\n        {\n          text: hasPass\n            ? \"🔒 تغییر / حذف رمز عبور این کد\"\n            : \"🔒 تنظیم رمز عبور برای این کد\",\n          callback_data: `adm_prd_pass:${productCode}`,\n        },\n      ],\n      [\n        {\n          text: protectActive\n            ? \"🛡 قفل فوروارد (Protect Content): ✅ فعال\"\n            : \"🛡 قفل فوروارد (Protect Content) برای این کد\",\n          callback_data: `adm_prd_prot:${productCode}`,\n        },\n      ],\n      [\n        {\n          text: \"📦 مدیریت کامل این کالا\",\n          callback_data: `adm_prd_view:${productCode}`,\n        },\n        { text: \"🏠 پنل اصلی\", callback_data: \"adm_home\" },\n      ],\n    ],\n  };\n}\n\n// ============================================================================\n// AI Auto-Publisher, Cover Generator & Live Channel Post Editor\n// ============================================================================\n\nasync function generateAICaptionForProduct(db, env, settings, productCode, customTopic = \"\") {\n  const product = await db\n    .prepare(\"SELECT * FROM products WHERE code = ?1\")\n    .bind(productCode)\n    .first();\n  const filesRes = await db\n    .prepare(\"SELECT media_type, file_name, caption FROM product_files WHERE product_code = ?1\")\n    .bind(productCode)\n    .all();\n  const files = (filesRes && filesRes.results) || [];\n\n  const videoCnt = files.filter((f) => f.media_type === \"video\").length;\n  const photoCnt = files.filter((f) => f.media_type === \"photo\").length;\n  const docCnt = files.filter((f) => f.media_type === \"document\").length;\n  const sampleCaptions = files\n    .map((f) => f.caption || f.file_name || \"\")\n    .filter(Boolean)\n    .slice(0, 3)\n    .join(\" | \");\n\n  const topicDescription =\n    customTopic ||\n    product?.custom_caption ||\n    sampleCaptions ||\n    `بسته ویژه شامل ${files.length} فایل (${videoCnt} ویدیو و ${photoCnt} تصویر)`;\n\n  const mood = settings.ai_mood || \"viral\";\n  let moodInstruction = \"\";\n  if (mood === \"viral\") {\n    moodInstruction =\n      \"با لحن بسیار هیجانی، جذاب، وایرال، پرانرژی، کنجکاوی‌برانگیز و همراه با ایموجی‌های مناسب بنویس تا مخاطب فوراً ترغیب به دانلود شود.\";\n  } else if (mood === \"official\") {\n    moodInstruction =\n      \"با لحن رسمی، تخصصی، ساختارمند، محترمانه و دقیق بنویس و جزئیات بسته را به صورت مرتب معرفی کن.\";\n  } else {\n    moodInstruction =\n      \"بسیار کوتاه، مینیمال و کوبنده فقط در ۱ الی ۲ خط بنویس و مستقیم سر اصل مطلب برو.\";\n  }\n\n  const systemPrompt =\n    \"تو یک نویسنده حرفه‌ای پست‌های کانال تلگرام به زبان فارسی هستی. فقط متن نهایی پست را به زبان فارسی روان و بدون هیچ توضیح اضافه یا مقدمه انگلیسی برگردان.\";\n  const userPrompt =\n    `موضوع پست: ${topicDescription}\\n` +\n    `مشخصات فایل‌ها: مجموعاً ${files.length} فایل (${videoCnt} ویدیو، ${photoCnt} عکس، ${docCnt} سند).\\n` +\n    `سبک نگارش: ${moodInstruction}\\n` +\n    `نکته: در انتهای متن دعوت به کلیک روی دکمه شیشه‌ای زیر پست برای دانلود فایل‌ها بکن.`;\n\n  const aiResponse = await runCloudflareAI(\n    env,\n    settings,\n    \"@cf/meta/llama-3.1-8b-instruct\",\n    {\n      messages: [\n        { role: \"system\", content: systemPrompt },\n        { role: \"user\", content: userPrompt },\n      ],\n      max_tokens: 450,\n      temperature: 0.75,\n    },\n    false\n  );\n\n  let bodyText = \"\";\n  if (aiResponse.ok && aiResponse.result) {\n    bodyText =\n      typeof aiResponse.result === \"string\"\n        ? aiResponse.result\n        : aiResponse.result.response || \"\";\n  }\n\n  if (!bodyText || bodyText.trim().length < 10) {\n    // Graceful fallback copywriting in Persian if AI quota is unreachable\n    if (mood === \"viral\") {\n      bodyText =\n        `🔥 <b>پکیج ویژه و استثنایی آماده دانلود شد!</b>\\n\\n` +\n        `✨ موضوع: <b>${escapeHtml(topicDescription)}</b>\\n` +\n        `📦 محتویات بسته: <b>${files.length} فایل باکیفیت</b> (${videoCnt} ویدیو، ${photoCnt} تصویر)\\n\\n` +\n        `⚡ قبل از حذف شدن، همین الان از طریق دکمه شیشه‌ای زیر تمام فایل‌ها را یکجا دریافت کنید 👇`;\n    } else if (mood === \"official\") {\n      bodyText =\n        `💎 <b>معرفی بسته فایل جدید</b>\\n\\n` +\n        `📌 عنوان: ${escapeHtml(topicDescription)}\\n` +\n        `📁 تعداد کل فایل‌ها: ${files.length} مورد (${videoCnt} ویدیو، ${photoCnt} تصویر)\\n\\n` +\n        `جهت دریافت مستقیم فایل‌ها از دکمه زیر استفاده فرمایید:`;\n    } else {\n      bodyText =\n        `⚡ <b>${escapeHtml(topicDescription)}</b> (${files.length} فایل)\\n` +\n        `👇 دریافت سریع از دکمه زیر:`;\n    }\n  }\n\n  const footer = (settings.post_footer || \"\").trim();\n  const fullCaption = footer\n    ? `${bodyText.trim()}\\n\\n${footer}`\n    : bodyText.trim();\n\n  return fullCaption.slice(0, 1000);\n}\n\nasync function prepareAICoverPhoto(db, env, settings, chatId, productCode, topicText, forceMode = null) {\n  const mode = forceMode || settings.ai_cover_mode || \"ai_gen\";\n\n  // Mode 3: Product's own first photo\n  if (mode === \"product_photo\") {\n    const firstPhoto = await db\n      .prepare(\n        \"SELECT file_id FROM product_files WHERE product_code = ?1 AND media_type = 'photo' ORDER BY id ASC LIMIT 1\"\n      )\n      .bind(productCode)\n      .first();\n    if (firstPhoto && firstPhoto.file_id) {\n      return { cover_file_id: firstPhoto.file_id, cover_url: \"\" };\n    }\n  }\n\n  // Mode 1: Cloudflare AI Image Generation (@cf/black-forest-labs/flux-1-schnell or SDXL Lightning fallback)\n  if (mode === \"ai_gen\") {\n    const promptEn = `High quality modern digital illustration cover art for Telegram channel post, cinematic lighting, vibrant colors, sleek aesthetic, no text, subject: ${\n      topicText || \"digital media package\"\n    }`;\n\n    let imgRes = await runCloudflareAI(\n      env,\n      settings,\n      \"@cf/black-forest-labs/flux-1-schnell\",\n      { prompt: promptEn, num_steps: 4 },\n      true\n    );\n\n    if (!imgRes.ok || !imgRes.binary) {\n      imgRes = await runCloudflareAI(\n        env,\n        settings,\n        \"@cf/bytedance/stable-diffusion-xl-lightning\",\n        { prompt: promptEn },\n        true\n      );\n    }\n\n    if (imgRes.ok && imgRes.binary && imgRes.binary.byteLength > 500) {\n      const uploaded = await tgSendPhotoBinary(\n        env.BOT_TOKEN,\n        chatId,\n        imgRes.binary,\n        \"🎨 کاور تولید شده توسط هوش مصنوعی کلودفلر (در حال آماده‌سازی پیش‌نمایش...)\"\n      );\n      if (uploaded && uploaded.ok && uploaded.result) {\n        const photos = uploaded.result.photo || [];\n        const best = photos[photos.length - 1];\n        if (best && best.file_id) {\n          await tgApi(env.BOT_TOKEN, \"deleteMessage\", {\n            chat_id: chatId,\n            message_id: uploaded.result.message_id,\n          });\n          return { cover_file_id: best.file_id, cover_url: \"\" };\n        }\n      }\n    }\n  }\n\n  // Mode 2 (or fallback): High-res random internet photo\n  const seed = `${productCode}_${Date.now()}`;\n  return {\n    cover_file_id: \"\",\n    cover_url: `https://picsum.photos/seed/${encodeURIComponent(seed)}/1080/720`,\n  };\n}\n\nfunction buildChannelPostKeyboard(botUsername, productCode, settings) {\n  const tpl = settings.dl_button_template || DEFAULT_SETTINGS.dl_button_template;\n  const btnText = tpl.replace(/\\{code\\}/g, productCode);\n  const deepLink = `https://t.me/${botUsername}?start=${productCode}`;\n  return {\n    inline_keyboard: [[{ text: btnText, url: deepLink }]],\n  };\n}\n\nfunction buildAIPreviewAdminKeyboard(productCode) {\n  return {\n    inline_keyboard: [\n      [\n        {\n          text: \"📢 انتشار فوری در کانال\",\n          callback_data: `adm_ai_confirm_pub:${productCode}`,\n        },\n      ],\n      [\n        {\n          text: \"🔄 تولید مجدد متن\",\n          callback_data: `adm_ai_regen_text:${productCode}`,\n        },\n        {\n          text: \"🖼 تعویض عکس کاور\",\n          callback_data: `adm_ai_cycle_cover:${productCode}`,\n        },\n      ],\n      [\n        {\n          text: \"✏️ ویرایش دستی کپشن\",\n          callback_data: `adm_ai_manual_cap:${productCode}`,\n        },\n      ],\n      [\n        {\n          text: \"🔙 بازگشت به مدیریت کالا\",\n          callback_data: `adm_prd_view:${productCode}`,\n        },\n      ],\n    ],\n  };\n}\n\nasync function generateAndShowAIPreview(db, env, settings, chatId, productCode, customTopic = \"\") {\n  const waitMsg = await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n    chat_id: chatId,\n    parse_mode: \"HTML\",\n    text: \"⏳ <b>هوش مصنوعی در حال نگارش کپشن و آماده‌سازی کاور پست است... لطفاً چند لحظه صبر کنید.</b>\",\n  });\n\n  const caption = await generateAICaptionForProduct(\n    db,\n    env,\n    settings,\n    productCode,\n    customTopic\n  );\n  const cover = await prepareAICoverPhoto(\n    db,\n    env,\n    settings,\n    chatId,\n    productCode,\n    customTopic || productCode\n  );\n\n  await db\n    .prepare(\n      `INSERT INTO ai_drafts (product_code, topic, generated_caption, cover_file_id, cover_url, updated_at)\n       VALUES (?1, ?2, ?3, ?4, ?5, ?6)\n       ON CONFLICT(product_code) DO UPDATE SET\n         topic = excluded.topic,\n         generated_caption = excluded.generated_caption,\n         cover_file_id = excluded.cover_file_id,\n         cover_url = excluded.cover_url,\n         updated_at = excluded.updated_at`\n    )\n    .bind(\n      productCode,\n      customTopic || \"\",\n      caption,\n      cover.cover_file_id || \"\",\n      cover.cover_url || \"\",\n      Date.now()\n    )\n    .run();\n\n  if (waitMsg && waitMsg.ok && waitMsg.result) {\n    await tgApi(env.BOT_TOKEN, \"deleteMessage\", {\n      chat_id: chatId,\n      message_id: waitMsg.result.message_id,\n    });\n  }\n\n  await renderAIDraftPreview(db, env, settings, chatId, productCode);\n}\n\nasync function renderAIDraftPreview(db, env, settings, chatId, productCode) {\n  const draft = await db\n    .prepare(\"SELECT * FROM ai_drafts WHERE product_code = ?1\")\n    .bind(productCode)\n    .first();\n  if (!draft) return;\n\n  const previewCaption =\n    `👁‍🗨 <b>پیش‌نمایش پست آماده انتشار (${escapeHtml(productCode)}):</b>\\n` +\n    `━━━━━━━━━━━━━━\\n` +\n    `${draft.generated_caption}`;\n\n  const kb = buildAIPreviewAdminKeyboard(productCode);\n  const photoRef = draft.cover_file_id || draft.cover_url;\n\n  if (photoRef) {\n    const sent = await tgApi(env.BOT_TOKEN, \"sendPhoto\", {\n      chat_id: chatId,\n      photo: photoRef,\n      caption: previewCaption.slice(0, 1024),\n      parse_mode: \"HTML\",\n      reply_markup: kb,\n    });\n    if (sent && sent.ok) return;\n  }\n\n  await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n    chat_id: chatId,\n    text: previewCaption,\n    parse_mode: \"HTML\",\n    reply_markup: kb,\n  });\n}\n\nasync function publishDraftToTargetChannel(db, env, settings, chatId, productCode) {\n  if (!settings.target_channel_id) {\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: \"❌ <b>هنوز هیچ کانال مقصدی متصل نشده است!</b>\\nلطفاً ابتدا از بخش «🤖 هوش مصنوعی و کانال» ⬅️ «📢 اتصال کانال مقصد» کانال خود را متصل کنید.\",\n      reply_markup: {\n        inline_keyboard: [\n          [{ text: \"📢 اتصال کانال مقصد\", callback_data: \"adm_ai_connect_ch\" }],\n          [{ text: \"🔙 بازگشت\", callback_data: `adm_prd_view:${productCode}` }],\n        ],\n      },\n    });\n    return;\n  }\n\n  const draft = await db\n    .prepare(\"SELECT * FROM ai_drafts WHERE product_code = ?1\")\n    .bind(productCode)\n    .first();\n  if (!draft) {\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      text: \"❌ پیش‌نویس پست یافت نشد. لطفاً دوباره تولید کنید.\",\n    });\n    return;\n  }\n\n  const botIdentity = await ensureBotIdentity(db, env, settings);\n  const channelKb = buildChannelPostKeyboard(\n    botIdentity.username || \"Bot\",\n    productCode,\n    settings\n  );\n\n  const photoRef = draft.cover_file_id || draft.cover_url;\n  let pubRes = null;\n\n  if (photoRef) {\n    pubRes = await tgApi(env.BOT_TOKEN, \"sendPhoto\", {\n      chat_id: settings.target_channel_id,\n      photo: photoRef,\n      caption: draft.generated_caption,\n      parse_mode: \"HTML\",\n      reply_markup: channelKb,\n    });\n  } else {\n    pubRes = await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: settings.target_channel_id,\n      text: draft.generated_caption,\n      parse_mode: \"HTML\",\n      reply_markup: channelKb,\n    });\n  }\n\n  if (!pubRes || !pubRes.ok) {\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: `❌ <b>خطا در ارسال پست به کانال:</b>\\n<code>${escapeHtml(\n        pubRes?.description || \"Unknown Error\"\n      )}</code>`,\n    });\n    return;\n  }\n\n  const channelMsgId = pubRes.result.message_id;\n  await db\n    .prepare(\n      \"UPDATE products SET channel_chat_id = ?1, channel_message_id = ?2, custom_caption = ?3 WHERE code = ?4\"\n    )\n    .bind(\n      String(settings.target_channel_id),\n      Number(channelMsgId),\n      draft.generated_caption,\n      productCode\n    )\n    .run();\n\n  await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n    chat_id: chatId,\n    parse_mode: \"HTML\",\n    text:\n      `🎉 <b>پست با موفقیت در کانال «${escapeHtml(\n        settings.target_channel_title || settings.target_channel_id\n      )}» منتشر شد!</b>\\n\\n` +\n      `🆔 شناسه پیام در کانال: <code>${channelMsgId}</code>\\n` +\n      `💡 شما می‌توانید در هر زمان از منوی مدیریت کالا، کپشن یا دکمه این پست را به صورت زنده در کانال ویرایش کنید.`,\n    reply_markup: {\n      inline_keyboard: [\n        [\n          {\n            text: \"📦 مدیریت این کالا\",\n            callback_data: `adm_prd_view:${productCode}`,\n          },\n          { text: \"🏠 پنل اصلی\", callback_data: \"adm_home\" },\n        ],\n      ],\n    },\n  });\n}\n\n// ============================================================================\n// CRUD Product Management Views\n// ============================================================================\n\nasync function renderProductDetailView(db, env, settings, chatId, productCode, messageId = null) {\n  const product = await db\n    .prepare(\"SELECT * FROM products WHERE code = ?1\")\n    .bind(productCode)\n    .first();\n\n  if (!product) {\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      text: \"❌ کد کالای مورد نظر یافت نشد.\",\n    });\n    return;\n  }\n\n  const botIdentity = await ensureBotIdentity(db, env, settings);\n  const deepLink = `https://t.me/${botIdentity.username || \"Bot\"}?start=${productCode}`;\n  const activeStatus = Number(product.is_active) === 1 ? \"✅ فعال\" : \"🔴 غیرفعال\";\n  const protectStatus = Number(product.protect_content) === 1 ? \"✅ فعال\" : \"⚪ غیرفعال\";\n  const passStatus = product.password ? `✅ <code>${escapeHtml(product.password)}</code>` : \"⚪ بدون رمز\";\n  const channelStatus =\n    product.channel_message_id && Number(product.channel_message_id) > 0\n      ? `✅ منتشر شده (پیام #${product.channel_message_id})`\n      : \"⚪ منتشر نشده\";\n\n  const text =\n    `📦 <b>مدیریت اختصاصی کالا: <code>${escapeHtml(productCode)}</code></b>\\n\\n` +\n    `📌 وضعیت: <b>${activeStatus}</b>\\n` +\n    `📁 تعداد فایل‌ها: <b>${product.files_count} فایل</b>\\n` +\n    `👁 تعداد دانلود/بازدید: <b>${product.views_count} بار</b>\\n` +\n    `🔒 رمز عبور: ${passStatus}\\n` +\n    `🛡 قفل فوروارد: <b>${protectStatus}</b>\\n` +\n    `📢 وضعیت پست کانال: <b>${channelStatus}</b>\\n` +\n    `🕒 آخرین دریافت: <code>${product.last_accessed_at || \"ندارد\"}</code>\\n\\n` +\n    `🔗 <b>لینک مستقیم:</b>\\n<code>${deepLink}</code>`;\n\n  const inline_keyboard = [\n    [\n      { text: \"🚀 انتشار خودکار با AI\", callback_data: `adm_ai_pub_auto:${productCode}` },\n      { text: \"✏️ انتشار با موضوع دلخواه\", callback_data: `adm_ai_pub_topic:${productCode}` },\n    ],\n    [\n      { text: \"➕ افزودن فایل جدید\", callback_data: `adm_prd_addf:${productCode}` },\n      { text: \"🗂 مدیریت/حذف تکی فایل‌ها\", callback_data: `adm_prd_files:${productCode}` },\n    ],\n    [\n      { text: \"🔒 تنظیم/حذف رمز عبور\", callback_data: `adm_prd_pass:${productCode}` },\n      { text: \"🛡 تغییر قفل فوروارد\", callback_data: `adm_prd_prot:${productCode}` },\n    ],\n    [\n      { text: \"✏️ ویرایش کپشن/عنوان کالا\", callback_data: `adm_prd_cap:${productCode}` },\n      {\n        text: Number(product.is_active) === 1 ? \"🔴 غیرفعال‌سازی کد\" : \"🟢 فعال‌سازی کد\",\n        callback_data: `adm_prd_toggle:${productCode}`,\n      },\n    ],\n  ];\n\n  if (product.channel_message_id && Number(product.channel_message_id) > 0) {\n    inline_keyboard.push([\n      {\n        text: \"📢 ویرایش زنده پست منتشر شده در کانال\",\n        callback_data: `adm_prd_live_edit:${productCode}`,\n      },\n    ]);\n  }\n\n  inline_keyboard.push([\n    { text: \"🗑 حذف کامل این کد کالا\", callback_data: `adm_prd_del_confirm:${productCode}` },\n  ]);\n  inline_keyboard.push([\n    { text: \"🔙 لیست کالاها\", callback_data: \"adm_crud_list:1\" },\n    { text: \"🏠 پنل اصلی\", callback_data: \"adm_home\" },\n  ]);\n\n  if (messageId) {\n    const ed = await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text,\n      reply_markup: { inline_keyboard },\n    });\n    if (ed && ed.ok) return;\n  }\n\n  await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n    chat_id: chatId,\n    parse_mode: \"HTML\",\n    text,\n    reply_markup: { inline_keyboard },\n  });\n}\n\n// ============================================================================\n// Main Update Router (Messages & Callback Queries)\n// ============================================================================\n\nasync function handleUpdate(update, env, ctx) {\n  const db = env.DB;\n  await ensureSchema(db);\n  const settings = await getAllSettings(db, env);\n\n  if (update.message) {\n    await handleMessage(update.message, db, env, settings, ctx);\n  } else if (update.callback_query) {\n    await handleCallbackQuery(update.callback_query, db, env, settings, ctx);\n  }\n}\n\nasync function handleMessage(message, db, env, settings, ctx) {\n  const chatId = message.chat.id;\n  const userId = message.from?.id;\n  if (!userId) return;\n\n  await trackUser(db, message.from);\n  const text = (message.text || \"\").trim();\n  const isAdmin = isAdminUser(userId, env, settings);\n  const userState = await getUserState(db, userId);\n\n  // 1. Check /start command & Deep-Link Product Codes (PRD_xxxx)\n  if (text.startsWith(\"/start\")) {\n    await clearUserState(db, userId);\n    const parts = text.split(/\\s+/);\n    const payload = parts[1] ? parts[1].trim() : \"\";\n\n    if (payload && payload.startsWith(\"PRD_\")) {\n      await handleProductDelivery(\n        ctx,\n        db,\n        env,\n        settings,\n        chatId,\n        userId,\n        payload,\n        false\n      );\n      return;\n    }\n\n    const welcomeTemplate = settings.start_text || DEFAULT_SETTINGS.start_text;\n    const welcomeText = welcomeTemplate.replace(\n      /\\{name\\}/g,\n      escapeHtml(message.from.first_name || \"کاربر\")\n    );\n\n    const replyMarkup = isAdmin\n      ? {\n          inline_keyboard: [\n            [{ text: \"🎛 ورود به پنل مدیریت (/panel)\", callback_data: \"adm_home\" }],\n          ],\n        }\n      : undefined;\n\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: welcomeText,\n      reply_markup: replyMarkup,\n    });\n    return;\n  }\n\n  // 2. Admin /panel command\n  if (text === \"/panel\" || text === \"/admin\") {\n    if (!isAdmin) {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        text: \"⛔ شما دسترسی ادمین به این ربات را ندارید.\",\n      });\n      return;\n    }\n    await clearUserState(db, userId);\n    await renderAdminHomePanel(db, env, settings, chatId);\n    return;\n  }\n\n  // 3. User Password Entry State for Protected Product\n  if (userState.state === \"AWAIT_PRODUCT_PASS\") {\n    const targetCode = userState.data?.code;\n    const product = await db\n      .prepare(\"SELECT password FROM products WHERE code = ?1\")\n      .bind(targetCode)\n      .first();\n\n    if (product && text === product.password) {\n      await clearUserState(db, userId);\n      await handleProductDelivery(\n        ctx,\n        db,\n        env,\n        settings,\n        chatId,\n        userId,\n        targetCode,\n        true\n      );\n    } else {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        parse_mode: \"HTML\",\n        text: \"❌ <b>رمز عبور اشتباه است!</b> لطفاً دوباره تلاش کنید یا روی دکمه انصراف بزنید:\",\n        reply_markup: {\n          inline_keyboard: [[{ text: \"❌ انصراف\", callback_data: \"user_cancel\" }]],\n        },\n      });\n    }\n    return;\n  }\n\n  // Stop here if non-admin\n  if (!isAdmin) {\n    return;\n  }\n\n  // ========================================================================\n  // Admin State Machine Handlers\n  // ========================================================================\n\n  // A. STAGING_FILES Mode (Zero-Download Atomic Media Capture)\n  if (userState.state === \"STAGING_FILES\") {\n    const media = extractMediaFromMessage(message);\n    if (!media) {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        parse_mode: \"HTML\",\n        text: \"⚠️ لطفاً یک فایل (ویدیو، عکس، سند، موزیک، گیف یا ویس) ارسال کنید یا روی دکمه اتمام بزنید.\",\n        reply_markup: buildStagingKeyboard(userState.data?.target_code),\n      });\n      return;\n    }\n\n    await db\n      .prepare(\n        `INSERT INTO staging_files (admin_id, file_id, file_unique_id, media_type, file_name, file_size, caption, source_chat_id, source_message_id, media_group_id, created_at)\n         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`\n      )\n      .bind(\n        String(userId),\n        media.file_id,\n        media.file_unique_id,\n        media.media_type,\n        media.file_name,\n        media.file_size,\n        media.caption,\n        String(chatId),\n        Number(message.message_id),\n        media.media_group_id,\n        Date.now()\n      )\n      .run();\n\n    const { counts } = await getStagingSummary(db, userId);\n    const statusText = buildStagingStatusText(counts, userState.data?.target_code);\n    const kb = buildStagingKeyboard(userState.data?.target_code);\n\n    if (userState.data?.status_msg_id) {\n      const ed = await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n        chat_id: chatId,\n        message_id: userState.data.status_msg_id,\n        parse_mode: \"HTML\",\n        text: statusText,\n        reply_markup: kb,\n      });\n      if (ed && ed.ok) return;\n    }\n\n    const sent = await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: statusText,\n      reply_markup: kb,\n    });\n    if (sent && sent.ok && sent.result) {\n      await setUserState(db, userId, \"STAGING_FILES\", {\n        ...userState.data,\n        status_msg_id: sent.result.message_id,\n      });\n    }\n    return;\n  }\n\n  // B. Two-Way Target Channel Handshake\n  if (userState.state === \"AWAIT_TARGET_CHANNEL\") {\n    let targetChatId = \"\";\n    if (message.forward_from_chat && message.forward_from_chat.type === \"channel\") {\n      targetChatId = String(message.forward_from_chat.id);\n    } else if (text.startsWith(\"@\") || text.startsWith(\"-100\")) {\n      targetChatId = text.split(/\\s+/)[0].trim();\n    } else {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        parse_mode: \"HTML\",\n        text: \"⚠️ لطفاً یک پست از کانال خود به اینجا <b>فوروارد</b> کنید، یا آیدی کانال (مثلاً <code>@MyChannel</code> یا <code>-100123456789</code>) را ارسال نمایید:\",\n      });\n      return;\n    }\n\n    const botIdentity = await ensureBotIdentity(db, env, settings);\n    const chatInfo = await tgApi(env.BOT_TOKEN, \"getChat\", { chat_id: targetChatId });\n    if (!chatInfo || !chatInfo.ok) {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        parse_mode: \"HTML\",\n        text: `❌ <b>ربات نتوانست کانال را پیدا کند!</b>\\nابتدا ربات را در کانال ادمین کنید و دوباره امتحان کنید.\\n<code>${escapeHtml(\n          chatInfo?.description || \"\"\n        )}</code>`,\n      });\n      return;\n    }\n\n    const memberInfo = await tgApi(env.BOT_TOKEN, \"getChatMember\", {\n      chat_id: chatInfo.result.id,\n      user_id: Number(botIdentity.id),\n    });\n\n    const isAdminInChannel =\n      memberInfo &&\n      memberInfo.ok &&\n      (memberInfo.result.status === \"administrator\" ||\n        memberInfo.result.status === \"creator\");\n\n    if (!isAdminInChannel) {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        parse_mode: \"HTML\",\n        text: \"❌ ربات در این کانال ادمین نیست! ابتدا ربات را ادمین کنید (با دسترسی ارسال پست) و دوباره امتحان کنید.\",\n      });\n      return;\n    }\n\n    const channelTitle = chatInfo.result.title || targetChatId;\n    const channelUsername = chatInfo.result.username ? `@${chatInfo.result.username}` : \"\";\n\n    await setSetting(db, \"pending_channel_id\", String(chatInfo.result.id));\n    await setSetting(db, \"pending_channel_title\", channelTitle);\n    await setSetting(db, \"pending_channel_username\", channelUsername);\n    await clearUserState(db, userId);\n\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: `✅ دسترسی ادمینی ربات در کانال «<b>${escapeHtml(\n        channelTitle\n      )}</b>» تایید شد. آیا اتصال نهایی را تایید می‌کنید؟`,\n      reply_markup: {\n        inline_keyboard: [\n          [\n            { text: \"✅ بله، متصل شود\", callback_data: \"adm_ai_confirm_ch\" },\n            { text: \"❌ انصراف\", callback_data: \"adm_ai_menu\" },\n          ],\n        ],\n      },\n    });\n    return;\n  }\n\n  // C. Add Force-Join Telegram Channel Lock (With Mandatory Bot-Admin Check)\n  if (userState.state === \"AWAIT_LOCK_CHANNEL\") {\n    const lines = text\n      .split(\"\\n\")\n      .map((l) => l.trim())\n      .filter(Boolean);\n    const channelRef = lines[0] || \"\";\n    const customInvite = lines[1] || \"\";\n\n    if (!channelRef.startsWith(\"@\") && !channelRef.startsWith(\"-100\")) {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        parse_mode: \"HTML\",\n        text:\n          \"⚠️ فرمت نامعتبر است!\\n\" +\n          \"لطفاً در خط اول یوزرنیم کانال (مثلاً <code>@MyChannel</code>) یا آیدی عددی (<code>-100...</code>) و در خط دوم لینک عضویت را بفرستید:\",\n      });\n      return;\n    }\n\n    const botIdentity = await ensureBotIdentity(db, env, settings);\n    const chatInfo = await tgApi(env.BOT_TOKEN, \"getChat\", { chat_id: channelRef });\n    if (!chatInfo || !chatInfo.ok) {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        text: \"❌ ربات در این کانال ادمین نیست! ابتدا ربات را ادمین کنید و دوباره امتحان کنید.\",\n      });\n      return;\n    }\n\n    const memberInfo = await tgApi(env.BOT_TOKEN, \"getChatMember\", {\n      chat_id: chatInfo.result.id,\n      user_id: Number(botIdentity.id),\n    });\n\n    const isBotAdmin =\n      memberInfo &&\n      memberInfo.ok &&\n      (memberInfo.result.status === \"administrator\" ||\n        memberInfo.result.status === \"creator\");\n\n    if (!isBotAdmin) {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        text: \"❌ ربات در این کانال ادمین نیست! ابتدا ربات را ادمین کنید و دوباره امتحان کنید.\",\n      });\n      return;\n    }\n\n    const title = chatInfo.result.title || channelRef;\n    const inviteLink =\n      customInvite ||\n      chatInfo.result.invite_link ||\n      (chatInfo.result.username\n        ? `https://t.me/${chatInfo.result.username}`\n        : \"https://t.me/\");\n\n    await db\n      .prepare(\n        `INSERT INTO force_locks (lock_type, title, chat_id, invite_link, is_active, created_at)\n         VALUES ('channel', ?1, ?2, ?3, 1, ?4)`\n      )\n      .bind(title, String(chatInfo.result.id), inviteLink, new Date().toISOString())\n      .run();\n\n    await clearUserState(db, userId);\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: `✅ قفل کانال تلگرامی «<b>${escapeHtml(title)}</b>» با موفقیت تایید و فعال شد!`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔐 بازگشت به مدیریت قفل‌ها\", callback_data: \"adm_locks_menu\" }]],\n      },\n    });\n    return;\n  }\n\n  // D. Add External URL / Bot Link Lock\n  if (userState.state === \"AWAIT_LOCK_URL\") {\n    const lines = text\n      .split(\"\\n\")\n      .map((l) => l.trim())\n      .filter(Boolean);\n    if (lines.length < 2 || !lines[1].startsWith(\"http\")) {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        parse_mode: \"HTML\",\n        text:\n          \"⚠️ لطفاً در <b>خط اول عنوان دکمه</b> و در <b>خط دوم لینک کامل (با https://)</b> را ارسال کنید:\\n\\n\" +\n          \"مثال:\\n<code>ربات دوم ما\\nhttps://t.me/OtherBot?start=vip</code>\",\n      });\n      return;\n    }\n\n    await db\n      .prepare(\n        `INSERT INTO force_locks (lock_type, title, chat_id, invite_link, is_active, created_at)\n         VALUES ('url', ?1, '', ?2, 1, ?3)`\n      )\n      .bind(lines[0], lines[1], new Date().toISOString())\n      .run();\n\n    await clearUserState(db, userId);\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: `✅ قفل لینک خارجی/ربات «<b>${escapeHtml(lines[0])}</b>» با موفقیت اضافه شد!`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔐 بازگشت به مدیریت قفل‌ها\", callback_data: \"adm_locks_menu\" }]],\n      },\n    });\n    return;\n  }\n\n  // E. Product Custom Topic for AI Publishing\n  if (userState.state === \"AWAIT_AI_CUSTOM_TOPIC\") {\n    const productCode = userState.data?.code;\n    await clearUserState(db, userId);\n    await generateAndShowAIPreview(db, env, settings, chatId, productCode, text);\n    return;\n  }\n\n  // F. Manual Edit of AI Draft Caption\n  if (userState.state === \"AWAIT_AI_MANUAL_CAPTION\") {\n    const productCode = userState.data?.code;\n    await db\n      .prepare(\"UPDATE ai_drafts SET generated_caption = ?1, updated_at = ?2 WHERE product_code = ?3\")\n      .bind(text, Date.now(), productCode)\n      .run();\n    await clearUserState(db, userId);\n    await renderAIDraftPreview(db, env, settings, chatId, productCode);\n    return;\n  }\n\n  // G. Set / Remove Product Password\n  if (userState.state === \"AWAIT_SET_PRD_PASS\") {\n    const productCode = userState.data?.code;\n    const newPass = text === \"/off\" || text === \"حذف\" ? \"\" : text;\n    await db\n      .prepare(\"UPDATE products SET password = ?1 WHERE code = ?2\")\n      .bind(newPass, productCode)\n      .run();\n    await clearUserState(db, userId);\n    await renderProductDetailView(db, env, settings, chatId, productCode);\n    return;\n  }\n\n  // H. Edit Product Custom Caption / Title\n  if (userState.state === \"AWAIT_EDIT_PRD_CAPTION\") {\n    const productCode = userState.data?.code;\n    await db\n      .prepare(\"UPDATE products SET title = ?1, custom_caption = ?2 WHERE code = ?3\")\n      .bind(text.slice(0, 100), text, productCode)\n      .run();\n    await clearUserState(db, userId);\n    await renderProductDetailView(db, env, settings, chatId, productCode);\n    return;\n  }\n\n  // I. Live Edit Published Channel Post Caption\n  if (userState.state === \"AWAIT_LIVE_CHANNEL_EDIT\") {\n    const productCode = userState.data?.code;\n    const product = await db\n      .prepare(\"SELECT * FROM products WHERE code = ?1\")\n      .bind(productCode)\n      .first();\n    await clearUserState(db, userId);\n\n    if (product && product.channel_chat_id && product.channel_message_id) {\n      const botIdentity = await ensureBotIdentity(db, env, settings);\n      const channelKb = buildChannelPostKeyboard(\n        botIdentity.username || \"Bot\",\n        productCode,\n        settings\n      );\n\n      let editRes = await tgApi(env.BOT_TOKEN, \"editMessageCaption\", {\n        chat_id: product.channel_chat_id,\n        message_id: Number(product.channel_message_id),\n        caption: text,\n        parse_mode: \"HTML\",\n        reply_markup: channelKb,\n      });\n\n      if (!editRes || !editRes.ok) {\n        editRes = await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n          chat_id: product.channel_chat_id,\n          message_id: Number(product.channel_message_id),\n          text,\n          parse_mode: \"HTML\",\n          reply_markup: channelKb,\n        });\n      }\n\n      if (editRes && editRes.ok) {\n        await db\n          .prepare(\"UPDATE products SET custom_caption = ?1 WHERE code = ?2\")\n          .bind(text, productCode)\n          .run();\n        await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n          chat_id: chatId,\n          parse_mode: \"HTML\",\n          text: `✅ پست منتشر شده در کانال برای کد <code>${escapeHtml(productCode)}</code> به صورت زنده بروزرسانی شد!`,\n        });\n      } else {\n        await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n          chat_id: chatId,\n          parse_mode: \"HTML\",\n          text: `❌ خطا در ویرایش پست کانال:\\n<code>${escapeHtml(editRes?.description || \"\")}</code>`,\n        });\n      }\n    }\n    await renderProductDetailView(db, env, settings, chatId, productCode);\n    return;\n  }\n\n  // J. Search Product by Code or Caption\n  if (userState.state === \"AWAIT_CRUD_SEARCH\") {\n    await clearUserState(db, userId);\n    const q = `%${text}%`;\n    const rows = await db\n      .prepare(\n        \"SELECT * FROM products WHERE code LIKE ?1 OR title LIKE ?1 OR custom_caption LIKE ?1 ORDER BY created_at DESC LIMIT 20\"\n      )\n      .bind(q)\n      .all();\n    const list = (rows && rows.results) || [];\n    if (list.length === 0) {\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        text: \"🔍 هیچ کالایی با این عبارت پیدا نشد.\",\n        reply_markup: {\n          inline_keyboard: [[{ text: \"🔙 بازگشت به لیست کالاها\", callback_data: \"adm_crud_list:1\" }]],\n        },\n      });\n      return;\n    }\n    const inline_keyboard = list.map((p) => [\n      {\n        text: `📦 ${p.code} (${p.files_count} فایل | 👁 ${p.views_count})`,\n        callback_data: `adm_prd_view:${p.code}`,\n      },\n    ]);\n    inline_keyboard.push([{ text: \"🔙 بازگشت\", callback_data: \"adm_crud_list:1\" }]);\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: `🔍 <b>نتایج جستجو برای «${escapeHtml(text)}»:</b>`,\n      reply_markup: { inline_keyboard },\n    });\n    return;\n  }\n\n  // K. Generic Settings Value Update (Footer, Button Template, Texts, Backup Chat, AI Token)\n  if (userState.state === \"AWAIT_SETTING_VALUE\") {\n    const settingKey = userState.data?.key;\n    const returnMenu = userState.data?.return_menu || \"adm_settings_menu\";\n    if (settingKey) {\n      const cleanVal = text === \"/off\" || text === \"حذف\" ? \"\" : text;\n      await setSetting(db, settingKey, cleanVal);\n      settings[settingKey] = cleanVal;\n    }\n    await clearUserState(db, userId);\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: \"✅ <b>تنظیمات جدید با موفقیت ذخیره شد!</b>\",\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 بازگشت\", callback_data: returnMenu }]],\n      },\n    });\n    return;\n  }\n\n  // L. Smart Chunked Broadcast (Copy or Forward to All Users)\n  if (userState.state === \"AWAIT_BROADCAST_MSG\") {\n    const mode = userState.data?.mode || \"copy\";\n    await clearUserState(db, userId);\n\n    const usersRes = await db.prepare(\"SELECT user_id FROM users\").all();\n    const allUsers = (usersRes && usersRes.results) || [];\n\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: `🚀 <b>عملیات ارسال همگانی برای ${allUsers.length} کاربر در پس‌زمینه آغاز شد!</b>\\nپس از اتمام، گزارش نهایی برای شما ارسال می‌شود.`,\n    });\n\n    const runBroadcast = async () => {\n      let success = 0;\n      let failed = 0;\n      for (let i = 0; i < allUsers.length; i++) {\n        const uid = allUsers[i].user_id;\n        const method = mode === \"forward\" ? \"forwardMessage\" : \"copyMessage\";\n        const res = await tgApi(env.BOT_TOKEN, method, {\n          chat_id: uid,\n          from_chat_id: chatId,\n          message_id: message.message_id,\n        });\n        if (res && res.ok) success++;\n        else failed++;\n\n        if ((i + 1) % 20 === 0) {\n          await new Promise((r) => setTimeout(r, 1000));\n        }\n      }\n      await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n        chat_id: chatId,\n        parse_mode: \"HTML\",\n        text:\n          `✅ <b>ارسال همگانی به پایان رسید!</b>\\n\\n` +\n          `🟢 موفق: <b>${success} نفر</b>\\n` +\n          `🔴 ناموفق/بلاک: <b>${failed} نفر</b>`,\n      });\n    };\n\n    if (ctx && typeof ctx.waitUntil === \"function\") {\n      ctx.waitUntil(runBroadcast());\n    } else {\n      await runBroadcast();\n    }\n    return;\n  }\n\n  // Default behaviour if Admin sends a file directly without clicking staging first:\n  const directMedia = extractMediaFromMessage(message);\n  if (directMedia) {\n    await db\n      .prepare(\n        `INSERT INTO staging_files (admin_id, file_id, file_unique_id, media_type, file_name, file_size, caption, source_chat_id, source_message_id, media_group_id, created_at)\n         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`\n      )\n      .bind(\n        String(userId),\n        directMedia.file_id,\n        directMedia.file_unique_id,\n        directMedia.media_type,\n        directMedia.file_name,\n        directMedia.file_size,\n        directMedia.caption,\n        String(chatId),\n        Number(message.message_id),\n        directMedia.media_group_id,\n        Date.now()\n      )\n      .run();\n\n    const { counts } = await getStagingSummary(db, userId);\n    const sent = await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: buildStagingStatusText(counts, null),\n      reply_markup: buildStagingKeyboard(null),\n    });\n    await setUserState(db, userId, \"STAGING_FILES\", {\n      target_code: null,\n      status_msg_id: sent?.result?.message_id || null,\n    });\n  }\n}\n\n// ============================================================================\n// Callback Query Handler\n// ============================================================================\n\nasync function handleCallbackQuery(cb, db, env, settings, ctx) {\n  const chatId = cb.message?.chat?.id;\n  const messageId = cb.message?.message_id;\n  const userId = cb.from?.id;\n  const data = cb.data || \"\";\n\n  if (!chatId || !userId) return;\n\n  // 1. User Force-Join Check Callback\n  if (data.startsWith(\"chk_join:\")) {\n    const productCode = data.split(\":\")[1];\n    const lockStatus = await checkUserForceLocks(db, env, settings, userId);\n    if (lockStatus.locked) {\n      await tgApi(env.BOT_TOKEN, \"answerCallbackQuery\", {\n        callback_query_id: cb.id,\n        text: \"❌ شما هنوز در تمام کانال‌های مشخص شده عضو نشده‌اید!\",\n        show_alert: true,\n      });\n      return;\n    }\n\n    await tgApi(env.BOT_TOKEN, \"answerCallbackQuery\", {\n      callback_query_id: cb.id,\n      text: \"✅ عضویت شما تایید شد! در حال ارسال فایل‌ها...\",\n    });\n    await tgApi(env.BOT_TOKEN, \"deleteMessage\", {\n      chat_id: chatId,\n      message_id: messageId,\n    });\n\n    if (productCode && productCode !== \"NONE\") {\n      await handleProductDelivery(\n        ctx,\n        db,\n        env,\n        settings,\n        chatId,\n        userId,\n        productCode,\n        false\n      );\n    }\n    return;\n  }\n\n  if (data === \"user_cancel\") {\n    await clearUserState(db, userId);\n    await tgApi(env.BOT_TOKEN, \"answerCallbackQuery\", {\n      callback_query_id: cb.id,\n      text: \"لغو شد.\",\n    });\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      text: \"❌ عملیات لغو شد.\",\n    });\n    return;\n  }\n\n  // Verify Admin Access for all `adm_*` callbacks\n  if (!isAdminUser(userId, env, settings)) {\n    await tgApi(env.BOT_TOKEN, \"answerCallbackQuery\", {\n      callback_query_id: cb.id,\n      text: \"⛔ مخصوص ادمین ربات!\",\n      show_alert: true,\n    });\n    return;\n  }\n\n  await tgApi(env.BOT_TOKEN, \"answerCallbackQuery\", { callback_query_id: cb.id });\n\n  // Home Panel\n  if (data === \"adm_home\") {\n    await clearUserState(db, userId);\n    await renderAdminHomePanel(db, env, settings, chatId, messageId);\n    return;\n  }\n\n  // Start File Staging\n  if (data === \"adm_start_staging\") {\n    await db\n      .prepare(\"DELETE FROM staging_files WHERE admin_id = ?1\")\n      .bind(String(userId))\n      .run();\n    await setUserState(db, userId, \"STAGING_FILES\", {\n      target_code: null,\n      status_msg_id: messageId,\n    });\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text: buildStagingStatusText({ total: 0, video: 0, photo: 0, document: 0, audio: 0, animation: 0, voice: 0 }, null),\n      reply_markup: buildStagingKeyboard(null),\n    });\n    return;\n  }\n\n  // Clear Staging List\n  if (data === \"adm_clear_staging\") {\n    await db\n      .prepare(\"DELETE FROM staging_files WHERE admin_id = ?1\")\n      .bind(String(userId))\n      .run();\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `🗑 <b>لیست موقت پاکسازی شد!</b>\\n\\n` +\n        buildStagingStatusText({ total: 0, video: 0, photo: 0, document: 0, audio: 0, animation: 0, voice: 0 }, null),\n      reply_markup: buildStagingKeyboard(null),\n    });\n    return;\n  }\n\n  // Finish Staging & Generate Product Code\n  if (data.startsWith(\"adm_finish_staging:\")) {\n    const targetCode = data.split(\":\")[1];\n    await finalizeStagingAndCreateProduct(\n      db,\n      env,\n      settings,\n      chatId,\n      userId,\n      messageId,\n      targetCode\n    );\n    return;\n  }\n\n  // ========================================================================\n  // CRUD Products Management Callbacks\n  // ========================================================================\n\n  if (data.startsWith(\"adm_crud_list:\")) {\n    const page = Math.max(1, parseInt(data.split(\":\")[1] || \"1\", 10));\n    const pageSize = 8;\n    const offset = (page - 1) * pageSize;\n\n    const totalRow = await db\n      .prepare(\"SELECT COUNT(*) AS cnt FROM products\")\n      .first();\n    const total = totalRow?.cnt || 0;\n    const totalPages = Math.max(1, Math.ceil(total / pageSize));\n\n    const rows = await db\n      .prepare(\"SELECT * FROM products ORDER BY created_at DESC LIMIT ?1 OFFSET ?2\")\n      .bind(pageSize, offset)\n      .all();\n    const list = (rows && rows.results) || [];\n\n    const inline_keyboard = [\n      [\n        { text: \"🔍 جستجوی کالا (کد/کپشن)\", callback_data: \"adm_crud_search\" },\n        { text: \"⚠️ کالاهای ناقص/خالی\", callback_data: \"adm_crud_empty\" },\n      ],\n    ];\n\n    for (const p of list) {\n      const statusDot = Number(p.is_active) === 1 && Number(p.files_count) > 0 ? \"🟢\" : \"🔴\";\n      inline_keyboard.push([\n        {\n          text: `${statusDot} ${p.code} | 📁 ${p.files_count} فایل | 👁 ${p.views_count}`,\n          callback_data: `adm_prd_view:${p.code}`,\n        },\n      ]);\n    }\n\n    const navRow = [];\n    if (page > 1) {\n      navRow.push({ text: \"⬅️ صفحه قبل\", callback_data: `adm_crud_list:${page - 1}` });\n    }\n    if (page < totalPages) {\n      navRow.push({ text: \"صفحه بعد ➡️\", callback_data: `adm_crud_list:${page + 1}` });\n    }\n    if (navRow.length > 0) inline_keyboard.push(navRow);\n    inline_keyboard.push([{ text: \"🔙 بازگشت به پنل اصلی\", callback_data: \"adm_home\" }]);\n\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `📦 <b>مدیریت کامل کالاها (CRUD)</b>\\n` +\n        `صفحه <b>${page}</b> از <b>${totalPages}</b> (مجموع: ${total} کالا)\\n\\n` +\n        `برای مشاهده جزئیات، ویرایش فایل‌ها یا انتشار در کانال، روی کد کالای مورد نظر کلیک کنید:`,\n      reply_markup: { inline_keyboard },\n    });\n    return;\n  }\n\n  if (data === \"adm_crud_search\") {\n    await setUserState(db, userId, \"AWAIT_CRUD_SEARCH\", {});\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text: \"🔍 <b>جستجوی کالا</b>\\n\\nلطفاً کد کالا (مثلاً <code>PRD_1042</code>) یا بخشی از عنوان/کپشن آن را ارسال کنید:\",\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 انصراف\", callback_data: \"adm_crud_list:1\" }]],\n      },\n    });\n    return;\n  }\n\n  if (data === \"adm_crud_empty\") {\n    const rows = await db\n      .prepare(\n        \"SELECT * FROM products WHERE files_count = 0 OR is_active = 0 ORDER BY created_at DESC LIMIT 25\"\n      )\n      .all();\n    const list = (rows && rows.results) || [];\n\n    const inline_keyboard = list.map((p) => [\n      {\n        text: `⚠️ ${p.code} (فایل: ${p.files_count} | وضعیت: ${\n          Number(p.is_active) === 1 ? \"فعال\" : \"غیرفعال\"\n        })`,\n        callback_data: `adm_prd_view:${p.code}`,\n      },\n    ]);\n    inline_keyboard.push([\n      { text: \"📦 همه کالاها\", callback_data: \"adm_crud_list:1\" },\n      { text: \"🏠 پنل اصلی\", callback_data: \"adm_home\" },\n    ]);\n\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        list.length > 0\n          ? `⚠️ <b>لیست کالاهای ناقص (بدون فایل) یا غیرفعال (${list.length} مورد):</b>\\nبرای تکمیل فایل‌ها یا حذف کامل روی هر مورد بزنید:`\n          : `✅ <b>هیچ کالای ناقص یا غیرفعالی وجود ندارد!</b> تمام بسته‌های شما سالم و دارای فایل هستند.`,\n      reply_markup: { inline_keyboard },\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_view:\")) {\n    const code = data.split(\":\")[1];\n    await renderProductDetailView(db, env, settings, chatId, code, messageId);\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_prot:\")) {\n    const code = data.split(\":\")[1];\n    await db\n      .prepare(\n        \"UPDATE products SET protect_content = CASE WHEN protect_content = 1 THEN 0 ELSE 1 END WHERE code = ?1\"\n      )\n      .bind(code)\n      .run();\n    await renderProductDetailView(db, env, settings, chatId, code, messageId);\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_toggle:\")) {\n    const code = data.split(\":\")[1];\n    await db\n      .prepare(\n        \"UPDATE products SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE code = ?1\"\n      )\n      .bind(code)\n      .run();\n    await renderProductDetailView(db, env, settings, chatId, code, messageId);\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_pass:\")) {\n    const code = data.split(\":\")[1];\n    await setUserState(db, userId, \"AWAIT_SET_PRD_PASS\", { code });\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `🔒 <b>تنظیم رمز عبور برای کد <code>${escapeHtml(code)}</code></b>\\n\\n` +\n        `لطفاً رمز عبور جدید را ارسال کنید (یا برای حذف رمز، عبارت <code>/off</code> را بفرستید):`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 انصراف\", callback_data: `adm_prd_view:${code}` }]],\n      },\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_cap:\")) {\n    const code = data.split(\":\")[1];\n    await setUserState(db, userId, \"AWAIT_EDIT_PRD_CAPTION\", { code });\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text: `✏️ <b>ویرایش عنوان/کپشن کالای <code>${escapeHtml(code)}</code></b>\\n\\nلطفاً متن جدید را ارسال کنید:`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 انصراف\", callback_data: `adm_prd_view:${code}` }]],\n      },\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_addf:\")) {\n    const code = data.split(\":\")[1];\n    await db\n      .prepare(\"DELETE FROM staging_files WHERE admin_id = ?1\")\n      .bind(String(userId))\n      .run();\n    await setUserState(db, userId, \"STAGING_FILES\", {\n      target_code: code,\n      status_msg_id: messageId,\n    });\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text: buildStagingStatusText({ total: 0, video: 0, photo: 0, document: 0, audio: 0, animation: 0, voice: 0 }, code),\n      reply_markup: buildStagingKeyboard(code),\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_files:\")) {\n    const code = data.split(\":\")[1];\n    const filesRes = await db\n      .prepare(\"SELECT * FROM product_files WHERE product_code = ?1 ORDER BY id ASC\")\n      .bind(code)\n      .all();\n    const files = (filesRes && filesRes.results) || [];\n\n    const inline_keyboard = files.map((f, idx) => [\n      {\n        text: `🗑 حذف فایل #${idx + 1} (${f.media_type} - ${f.file_name || \"بدون نام\"})`,\n        callback_data: `adm_prd_delf:${code}:${f.id}`,\n      },\n    ]);\n    inline_keyboard.push([{ text: \"🔙 بازگشت به کالا\", callback_data: `adm_prd_view:${code}` }]);\n\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `🗂 <b>فایل‌های موجود در بسته <code>${escapeHtml(code)}</code> (${files.length} فایل):</b>\\n` +\n        `برای حذف هر فایل از این بسته، روی آن کلیک کنید:`,\n      reply_markup: { inline_keyboard },\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_delf:\")) {\n    const parts = data.split(\":\");\n    const code = parts[1];\n    const fileRowId = Number(parts[2]);\n\n    await db\n      .prepare(\"DELETE FROM product_files WHERE id = ?1 AND product_code = ?2\")\n      .bind(fileRowId, code)\n      .run();\n    const cntRow = await db\n      .prepare(\"SELECT COUNT(*) AS cnt FROM product_files WHERE product_code = ?1\")\n      .bind(code)\n      .first();\n    await db\n      .prepare(\"UPDATE products SET files_count = ?1 WHERE code = ?2\")\n      .bind(cntRow?.cnt || 0, code)\n      .run();\n\n    await renderProductDetailView(db, env, settings, chatId, code, messageId);\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_live_edit:\")) {\n    const code = data.split(\":\")[1];\n    await setUserState(db, userId, \"AWAIT_LIVE_CHANNEL_EDIT\", { code });\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `📢 <b>ویرایش زنده پست کانال برای <code>${escapeHtml(code)}</code></b>\\n\\n` +\n        `لطفاً متن جدید کپشن پست کانال را ارسال کنید تا فوراً در کانال آپدیت شود:`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 انصراف\", callback_data: `adm_prd_view:${code}` }]],\n      },\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_del_confirm:\")) {\n    const code = data.split(\":\")[1];\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text: `⚠️ <b>آیا از حذف کامل کد کالای <code>${escapeHtml(code)}</code> و تمام فایل‌های آن اطمینان دارید؟</b>`,\n      reply_markup: {\n        inline_keyboard: [\n          [\n            { text: \"🗑 بله، کاملاً حذف شود\", callback_data: `adm_prd_del_exec:${code}` },\n            { text: \"❌ خیر، بازگشت\", callback_data: `adm_prd_view:${code}` },\n          ],\n        ],\n      },\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_prd_del_exec:\")) {\n    const code = data.split(\":\")[1];\n    await db.prepare(\"DELETE FROM product_files WHERE product_code = ?1\").bind(code).run();\n    await db.prepare(\"DELETE FROM ai_drafts WHERE product_code = ?1\").bind(code).run();\n    await db.prepare(\"DELETE FROM products WHERE code = ?1\").bind(code).run();\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text: `✅ کد کالای <code>${escapeHtml(code)}</code> با موفقیت حذف شد.`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"📦 بازگشت به لیست کالاها\", callback_data: \"adm_crud_list:1\" }]],\n      },\n    });\n    return;\n  }\n\n  // ========================================================================\n  // AI Auto-Publisher & Channel Settings Callbacks\n  // ========================================================================\n\n  if (data.startsWith(\"adm_ai_pub_auto:\")) {\n    const code = data.split(\":\")[1];\n    await generateAndShowAIPreview(db, env, settings, chatId, code, \"\");\n    return;\n  }\n\n  if (data.startsWith(\"adm_ai_pub_topic:\")) {\n    const code = data.split(\":\")[1];\n    await setUserState(db, userId, \"AWAIT_AI_CUSTOM_TOPIC\", { code });\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text:\n        `✏️ <b>انتشار با موضوع دلخواه توسط هوش مصنوعی (${escapeHtml(code)})</b>\\n\\n` +\n        `لطفاً موضوع یا توضیحات کلیدی این پست را بنویسید تا هوش مصنوعی بر اساس آن کپشن و کاور تولید کند:`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 انصراف\", callback_data: `adm_prd_view:${code}` }]],\n      },\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_ai_regen_text:\")) {\n    const code = data.split(\":\")[1];\n    const draft = await db\n      .prepare(\"SELECT topic FROM ai_drafts WHERE product_code = ?1\")\n      .bind(code)\n      .first();\n    const newCaption = await generateAICaptionForProduct(\n      db,\n      env,\n      settings,\n      code,\n      draft?.topic || \"\"\n    );\n    await db\n      .prepare(\"UPDATE ai_drafts SET generated_caption = ?1, updated_at = ?2 WHERE product_code = ?3\")\n      .bind(newCaption, Date.now(), code)\n      .run();\n    await renderAIDraftPreview(db, env, settings, chatId, code);\n    return;\n  }\n\n  if (data.startsWith(\"adm_ai_cycle_cover:\")) {\n    const code = data.split(\":\")[1];\n    const draft = await db\n      .prepare(\"SELECT topic FROM ai_drafts WHERE product_code = ?1\")\n      .bind(code)\n      .first();\n    const cover = await prepareAICoverPhoto(\n      db,\n      env,\n      settings,\n      chatId,\n      code,\n      draft?.topic || code\n    );\n    await db\n      .prepare(\n        \"UPDATE ai_drafts SET cover_file_id = ?1, cover_url = ?2, updated_at = ?3 WHERE product_code = ?4\"\n      )\n      .bind(cover.cover_file_id || \"\", cover.cover_url || \"\", Date.now(), code)\n      .run();\n    await renderAIDraftPreview(db, env, settings, chatId, code);\n    return;\n  }\n\n  if (data.startsWith(\"adm_ai_manual_cap:\")) {\n    const code = data.split(\":\")[1];\n    await setUserState(db, userId, \"AWAIT_AI_MANUAL_CAPTION\", { code });\n    await tgApi(env.BOT_TOKEN, \"sendMessage\", {\n      chat_id: chatId,\n      parse_mode: \"HTML\",\n      text: `✏️ لطفاً کپشن دلخواه خود را برای کد <code>${escapeHtml(code)}</code> ارسال کنید:`,\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_ai_confirm_pub:\")) {\n    const code = data.split(\":\")[1];\n    await publishDraftToTargetChannel(db, env, settings, chatId, code);\n    return;\n  }\n\n  if (data === \"adm_ai_menu\") {\n    const moodLabels = {\n      viral: \"🔥 هیجانی و وایرال\",\n      official: \"💎 رسمی و تخصصی\",\n      minimal: \"⚡ کوتاه و مینیمال\",\n    };\n    const coverLabels = {\n      ai_gen: \"🎨 تولید تصویر هوشمند با AI کلودفلر\",\n      internet: \"🌐 دانلود عکس رندوم باکیفیت از اینترنت\",\n      product_photo: \"📸 استفاده از عکس خود فایل‌ها\",\n    };\n\n    const chStatus = settings.target_channel_title\n      ? `✅ ${escapeHtml(settings.target_channel_title)} (<code>${escapeHtml(\n          settings.target_channel_id\n        )}</code>)`\n      : \"⚪ متصل نشده\";\n\n    const aiTokenStatus = settings.ai_api_token\n      ? `✅ اکانت دوم فعال (${escapeHtml(settings.ai_account_id.slice(0, 8))}...)`\n      : \"⚡ استفاده از بایندینگ اکانت اول\";\n\n    const text =\n      `🤖 <b>تنظیمات هوش مصنوعی و اتصال کانال مقصد</b>\\n\\n` +\n      `📢 <b>کانال مقصد:</b> ${chStatus}\\n` +\n      `🎭 <b>حالت نگارش AI:</b> <b>${moodLabels[settings.ai_mood] || moodLabels.viral}</b>\\n` +\n      `🖼 <b>حالت کاور پست:</b> <b>${coverLabels[settings.ai_cover_mode] || coverLabels.ai_gen}</b>\\n` +\n      `✍️ <b>امضای پایان پست:</b> <code>${escapeHtml(settings.post_footer)}</code>\\n` +\n      `🔘 <b>قالب دکمه دانلود:</b> <code>${escapeHtml(settings.dl_button_template)}</code>\\n` +\n      `🔋 <b>وضعیت هسته AI:</b> ${aiTokenStatus}`;\n\n    const inline_keyboard = [\n      [{ text: \"📢 اتصال / تغییر کانال مقصد\", callback_data: \"adm_ai_connect_ch\" }],\n      [\n        {\n          text: `🎭 تغییر لحن نگارش (${moodLabels[settings.ai_mood] || \"وایرال\"})`,\n          callback_data: \"adm_ai_toggle_mood\",\n        },\n      ],\n      [\n        {\n          text: `🖼 تغییر حالت عکس کاور`,\n          callback_data: \"adm_ai_toggle_cover\",\n        },\n      ],\n      [\n        { text: \"✍️ ویرایش امضای پست (Footer)\", callback_data: \"adm_set_key:post_footer:adm_ai_menu\" },\n        { text: \"🔘 ویرایش متن دکمه دانلود\", callback_data: \"adm_set_key:dl_button_template:adm_ai_menu\" },\n      ],\n      [\n        { text: \"🔑 تغییر توکن AI اکانت دوم\", callback_data: \"adm_set_key:ai_api_token:adm_ai_menu\" },\n        { text: \"🆔 تغییر Account ID اکانت دوم\", callback_data: \"adm_set_key:ai_account_id:adm_ai_menu\" },\n      ],\n      [{ text: \"🔙 بازگشت به پنل اصلی\", callback_data: \"adm_home\" }],\n    ];\n\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text,\n      reply_markup: { inline_keyboard },\n    });\n    return;\n  }\n\n  if (data === \"adm_ai_toggle_mood\") {\n    const order = [\"viral\", \"official\", \"minimal\"];\n    const next = order[(order.indexOf(settings.ai_mood) + 1) % order.length];\n    await setSetting(db, \"ai_mood\", next);\n    settings.ai_mood = next;\n    cb.data = \"adm_ai_menu\";\n    await handleCallbackQuery(cb, db, env, settings, ctx);\n    return;\n  }\n\n  if (data === \"adm_ai_toggle_cover\") {\n    const order = [\"ai_gen\", \"internet\", \"product_photo\"];\n    const next = order[(order.indexOf(settings.ai_cover_mode) + 1) % order.length];\n    await setSetting(db, \"ai_cover_mode\", next);\n    settings.ai_cover_mode = next;\n    cb.data = \"adm_ai_menu\";\n    await handleCallbackQuery(cb, db, env, settings, ctx);\n    return;\n  }\n\n  if (data === \"adm_ai_connect_ch\") {\n    await setUserState(db, userId, \"AWAIT_TARGET_CHANNEL\", {});\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `📢 <b>اتصال دوطرفه کانال مقصد</b>\\n\\n` +\n        `۱. ابتدا ربات را در کانال خود <b>Admin</b> کنید (با دسترسی ارسال و ویرایش پیام).\\n` +\n        `۲. سپس یک پیام از کانال خود به اینجا <b>فوروارد</b> کنید یا آیدی کانال (مثلاً <code>@MyChannel</code> یا <code>-100...</code>) را بفرستید:`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 انصراف\", callback_data: \"adm_ai_menu\" }]],\n      },\n    });\n    return;\n  }\n\n  if (data === \"adm_ai_confirm_ch\") {\n    await setSetting(db, \"target_channel_id\", settings.pending_channel_id || \"\");\n    await setSetting(db, \"target_channel_title\", settings.pending_channel_title || \"\");\n    await setSetting(db, \"target_channel_username\", settings.pending_channel_username || \"\");\n    settings.target_channel_id = settings.pending_channel_id;\n    settings.target_channel_title = settings.pending_channel_title;\n    settings.target_channel_username = settings.pending_channel_username;\n    cb.data = \"adm_ai_menu\";\n    await handleCallbackQuery(cb, db, env, settings, ctx);\n    return;\n  }\n\n  // ========================================================================\n  // Force-Join Locks Management Callbacks\n  // ========================================================================\n\n  if (data === \"adm_locks_menu\") {\n    const rows = await db\n      .prepare(\"SELECT * FROM force_locks ORDER BY id ASC\")\n      .all();\n    const locks = (rows && rows.results) || [];\n\n    const inline_keyboard = [\n      [\n        { text: \"➕ افزودن قفل کانال تلگرام\", callback_data: \"adm_lock_add_ch\" },\n        { text: \"🔗 افزودن قفل لینک/ربات\", callback_data: \"adm_lock_add_url\" },\n      ],\n    ];\n\n    for (const l of locks) {\n      const icon = l.lock_type === \"channel\" ? \"📢\" : \"🔗\";\n      const st = Number(l.is_active) === 1 ? \"🟢\" : \"🔴\";\n      inline_keyboard.push([\n        {\n          text: `${st} ${icon} ${l.title}`,\n          callback_data: `adm_lock_toggle:${l.id}`,\n        },\n        {\n          text: \"🗑 حذف\",\n          callback_data: `adm_lock_del:${l.id}`,\n        },\n      ]);\n    }\n\n    inline_keyboard.push([{ text: \"🔙 بازگشت به پنل اصلی\", callback_data: \"adm_home\" }]);\n\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `🔐 <b>مدیریت قفل‌های عضویت اجباری (${locks.length} قفل)</b>\\n\\n` +\n        `• <b>قفل کانال تلگرام:</b> بررسی واقعی عضویت کاربر با API تلگرام + سیستم ایمنی خودکار در صورت حذف ربات از ادمینی.\\n` +\n        `• <b>قفل لینک خارجی / ربات:</b> نمایش دکمه شیشه‌ای برای ربات‌های دیگر، اینستاگرام یا وب‌سایت.`,\n      reply_markup: { inline_keyboard },\n    });\n    return;\n  }\n\n  if (data === \"adm_lock_add_ch\") {\n    await setUserState(db, userId, \"AWAIT_LOCK_CHANNEL\", {});\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `📢 <b>افزودن قفل کانال تلگرام (تایید واقعی API)</b>\\n\\n` +\n        `۱. ابتدا ربات را در کانال مورد نظر <b>ادمین</b> کنید.\\n` +\n        `۲. در خط اول یوزرنیم (<code>@Channel</code>) یا آیدی عددی (<code>-100...</code>) و در خط دوم لینک عضویت کانال را بفرستید:\\n\\n` +\n        `مثال:\\n<code>@MySponsorChannel\\nhttps://t.me/+AbCdEfGhIjK</code>`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 انصراف\", callback_data: \"adm_locks_menu\" }]],\n      },\n    });\n    return;\n  }\n\n  if (data === \"adm_lock_add_url\") {\n    await setUserState(db, userId, \"AWAIT_LOCK_URL\", {});\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `🔗 <b>افزودن قفل لینک خارجی / ربات دیگر</b>\\n\\n` +\n        `لطفاً در خط اول <b>عنوان دکمه شیشه‌ای</b> و در خط دوم <b>لینک کامل</b> را ارسال کنید:\\n\\n` +\n        `مثال:\\n<code>🤖 ورود به ربات ویژه\\nhttps://t.me/OtherBot?start=ref1</code>`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 انصراف\", callback_data: \"adm_locks_menu\" }]],\n      },\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_lock_toggle:\")) {\n    const id = Number(data.split(\":\")[1]);\n    await db\n      .prepare(\"UPDATE force_locks SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?1\")\n      .bind(id)\n      .run();\n    cb.data = \"adm_locks_menu\";\n    await handleCallbackQuery(cb, db, env, settings, ctx);\n    return;\n  }\n\n  if (data.startsWith(\"adm_lock_del:\")) {\n    const id = Number(data.split(\":\")[1]);\n    await db.prepare(\"DELETE FROM force_locks WHERE id = ?1\").bind(id).run();\n    cb.data = \"adm_locks_menu\";\n    await handleCallbackQuery(cb, db, env, settings, ctx);\n    return;\n  }\n\n  // ========================================================================\n  // Auto-Archive Backup Channel Menu\n  // ========================================================================\n\n  if (data === \"adm_backup_menu\") {\n    const currentBackup = settings.backup_chat_id\n      ? `✅ فعال روی <code>${escapeHtml(settings.backup_chat_id)}</code>`\n      : \"⚪ غیرفعال\";\n\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `🗄 <b>کانال / گروه بکاپ خودکار فایل‌ها (Auto-Archive)</b>\\n\\n` +\n        `وضعیت فعلی: ${currentBackup}\\n\\n` +\n        `💡 با فعال‌سازی این بخش، به محض ساخت هر کد کالای جدید، یک نسخه از تمام فایل‌ها به همراه کد کالا در کانال یا سوپرگروه آرشیو شما کپی می‌شود.`,\n      reply_markup: {\n        inline_keyboard: [\n          [\n            {\n              text: \"⚙️ تنظیم / تغییر آیدی کانال بکاپ\",\n              callback_data: \"adm_set_key:backup_chat_id:adm_backup_menu\",\n            },\n          ],\n          [\n            {\n              text: \"🔴 غیرفعال‌سازی بکاپ خودکار\",\n              callback_data: \"adm_disable_backup\",\n            },\n          ],\n          [{ text: \"🔙 بازگشت به پنل اصلی\", callback_data: \"adm_home\" }],\n        ],\n      },\n    });\n    return;\n  }\n\n  if (data === \"adm_disable_backup\") {\n    await setSetting(db, \"backup_chat_id\", \"\");\n    settings.backup_chat_id = \"\";\n    cb.data = \"adm_backup_menu\";\n    await handleCallbackQuery(cb, db, env, settings, ctx);\n    return;\n  }\n\n  // ========================================================================\n  // Timer & Texts Customization Menu\n  // ========================================================================\n\n  if (data === \"adm_settings_menu\") {\n    const t = String(settings.delete_timer || \"30\");\n    const globalProt = String(settings.global_protect_content) === \"1\" ? \"✅ فعال\" : \"⚪ غیرفعال\";\n\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `⚙️ <b>شخصی‌سازی کامل متون و تایمر حذف خودکار</b>\\n\\n` +\n        `⏱ تایمر فعلی حذف خودکار: <b>${Number(t) > 0 ? `${t} ثانیه` : \"خاموش\"}</b>\\n` +\n        `🛡 قفل فوروارد سراسری همه کالاها: <b>${globalProt}</b>\\n\\n` +\n        `از دکمه‌های زیر زمان تایمر یا متون ربات را تغییر دهید:`,\n      reply_markup: {\n        inline_keyboard: [\n          [\n            { text: `${t === \"15\" ? \"✅ \" : \"\"}15 ثانیه`, callback_data: \"adm_timer:15\" },\n            { text: `${t === \"30\" ? \"✅ \" : \"\"}30 ثانیه`, callback_data: \"adm_timer:30\" },\n            { text: `${t === \"45\" ? \"✅ \" : \"\"}45 ثانیه`, callback_data: \"adm_timer:45\" },\n          ],\n          [\n            { text: `${t === \"60\" ? \"✅ \" : \"\"}60 ثانیه`, callback_data: \"adm_timer:60\" },\n            { text: `${t === \"0\" ? \"✅ \" : \"\"}خاموش`, callback_data: \"adm_timer:0\" },\n          ],\n          [\n            {\n              text: `🛡 قفل فوروارد سراسری: ${globalProt}`,\n              callback_data: \"adm_toggle_global_prot\",\n            },\n          ],\n          [\n            { text: \"📝 متن استارت (/start)\", callback_data: \"adm_set_key:start_text:adm_settings_menu\" },\n            { text: \"⚠️ متن هشدار حذف خودکار\", callback_data: \"adm_set_key:delete_warning_text:adm_settings_menu\" },\n          ],\n          [\n            { text: \"❌ متن کالای یافت نشده\", callback_data: \"adm_set_key:not_found_text:adm_settings_menu\" },\n          ],\n          [{ text: \"🔙 بازگشت به پنل اصلی\", callback_data: \"adm_home\" }],\n        ],\n      },\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_timer:\")) {\n    const val = data.split(\":\")[1];\n    await setSetting(db, \"delete_timer\", val);\n    settings.delete_timer = val;\n    cb.data = \"adm_settings_menu\";\n    await handleCallbackQuery(cb, db, env, settings, ctx);\n    return;\n  }\n\n  if (data === \"adm_toggle_global_prot\") {\n    const next = String(settings.global_protect_content) === \"1\" ? \"0\" : \"1\";\n    await setSetting(db, \"global_protect_content\", next);\n    settings.global_protect_content = next;\n    cb.data = \"adm_settings_menu\";\n    await handleCallbackQuery(cb, db, env, settings, ctx);\n    return;\n  }\n\n  if (data.startsWith(\"adm_set_key:\")) {\n    const parts = data.split(\":\");\n    const key = parts[1];\n    const returnMenu = parts[2] || \"adm_settings_menu\";\n    await setUserState(db, userId, \"AWAIT_SETTING_VALUE\", { key, return_menu: returnMenu });\n\n    const currentVal = settings[key] || \"\";\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `✏️ <b>ویرایش مقدار تنظیمات (<code>${escapeHtml(key)}</code>)</b>\\n\\n` +\n        `مقدار فعلی:\\n<code>${escapeHtml(currentVal || \"خالی\")}</code>\\n\\n` +\n        `لطفاً مقدار جدید را ارسال کنید (برای پاک کردن، عبارت <code>/off</code> را بفرستید):`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 انصراف\", callback_data: returnMenu }]],\n      },\n    });\n    return;\n  }\n\n  // ========================================================================\n  // Stats & Smart Broadcast Menu\n  // ========================================================================\n\n  if (data === \"adm_stats_menu\") {\n    const counts = await db\n      .prepare(\n        `SELECT\n          (SELECT COUNT(*) FROM users) AS total_users,\n          (SELECT COUNT(*) FROM products) AS total_products,\n          (SELECT COUNT(*) FROM product_files) AS total_files,\n          (SELECT COALESCE(SUM(views_count), 0) FROM products) AS total_views`\n      )\n      .first();\n\n    const topRows = await db\n      .prepare(\"SELECT code, views_count, files_count FROM products ORDER BY views_count DESC LIMIT 5\")\n      .all();\n    const topList = (topRows && topRows.results) || [];\n\n    const topText =\n      topList.length > 0\n        ? topList\n            .map(\n              (p, idx) =>\n                `${idx + 1}. <code>${escapeHtml(p.code)}</code> — <b>${p.views_count} دانلود</b> (${p.files_count} فایل)`\n            )\n            .join(\"\\n\")\n        : \"هنوز دانلودی ثبت نشده است.\";\n\n    const text =\n      `📊 <b>آمار جامع ربات و۵ کد برتر</b>\\n\\n` +\n      `👥 کل کاربران ثبت‌شده: <b>${counts?.total_users || 0} نفر</b>\\n` +\n      `📦 کل کدهای کالا: <b>${counts?.total_products || 0} کد</b>\\n` +\n      `📁 کل فایل‌های دیتابیس: <b>${counts?.total_files || 0} فایل</b>\\n` +\n      `📥 کل دانلودهای انجام‌شده: <b>${counts?.total_views || 0} بار</b>\\n\\n` +\n      `🏆 <b>۵ کد کالای پردانلود:</b>\\n${topText}`;\n\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text,\n      reply_markup: {\n        inline_keyboard: [\n          [\n            { text: \"📢 ارسال پیام همگانی (بدون نام)\", callback_data: \"adm_bcast:copy\" },\n            { text: \"🔄 فوروارد همگانی\", callback_data: \"adm_bcast:forward\" },\n          ],\n          [{ text: \"🔙 بازگشت به پنل اصلی\", callback_data: \"adm_home\" }],\n        ],\n      },\n    });\n    return;\n  }\n\n  if (data.startsWith(\"adm_bcast:\")) {\n    const mode = data.split(\":\")[1];\n    await setUserState(db, userId, \"AWAIT_BROADCAST_MSG\", { mode });\n    await tgApi(env.BOT_TOKEN, \"editMessageText\", {\n      chat_id: chatId,\n      message_id: messageId,\n      parse_mode: \"HTML\",\n      text:\n        `📢 <b>ارسال همگانی هوشمند (${mode === \"forward\" ? \"فوروارد\" : \"کپی بدون نام\"})</b>\\n\\n` +\n        `لطفاً پیام، عکس، ویدیو یا هر محتوایی که می‌خواهید برای تمام کاربران ارسال شود را بفرستید:`,\n      reply_markup: {\n        inline_keyboard: [[{ text: \"🔙 انصراف\", callback_data: \"adm_stats_menu\" }]],\n      },\n    });\n    return;\n  }\n}\n\n// ============================================================================\n// Worker Entrypoint\n// ============================================================================\n\nexport default {\n  async fetch(request, env, ctx) {\n    const url = new URL(request.url);\n\n    // Health check endpoint called by Master UP-PRO Factory\n    if (url.pathname === \"/health\") {\n      try {\n        await ensureSchema(env.DB);\n        const counts = await env.DB\n          .prepare(\n            \"SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM products) AS p\"\n          )\n          .first();\n        return new Response(\n          JSON.stringify({\n            ok: true,\n            worker_name: env.WORKER_NAME || \"UP-PROn\",\n            version: CHILD_VERSION,\n            users: counts?.u || 0,\n            products: counts?.p || 0,\n          }),\n          { status: 200, headers: { \"Content-Type\": \"application/json\" } }\n        );\n      } catch (err) {\n        return new Response(\n          JSON.stringify({ ok: false, error: String(err) }),\n          { status: 500, headers: { \"Content-Type\": \"application/json\" } }\n        );\n      }\n    }\n\n    // Telegram Webhook Endpoint\n    if (url.pathname === \"/webhook\" && request.method === \"POST\") {\n      if (env.WEBHOOK_SECRET) {\n        const headerSecret = request.headers.get(\n          \"X-Telegram-Bot-Api-Secret-Token\"\n        );\n        if (headerSecret !== env.WEBHOOK_SECRET) {\n          return new Response(\"Forbidden: Invalid Webhook Secret\", {\n            status: 403,\n          });\n        }\n      }\n\n      try {\n        const update = await request.json();\n        await handleUpdate(update, env, ctx);\n        return new Response(\"OK\", { status: 200 });\n      } catch (err) {\n        return new Response(`Webhook Error: ${String(err)}`, { status: 200 });\n      }\n    }\n\n    return new Response(\n      `UP-PRO Child Uploader Worker (${env.WORKER_NAME || \"UP-PROn\"}) v${CHILD_VERSION} is running.`,\n      { status: 200 }\n    );\n  },\n};\n";

export function getChildWorkerScript() {
  return CHILD_WORKER_BUNDLE;
}

// ============================================================================
// Master Utility & Telegram API Helpers
// ============================================================================

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isMasterAdmin(userId, env) {
  const configured = String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length === 0) return true;
  return configured.includes(String(userId));
}

async function tgApi(botToken, method, payload = {}) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
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

async function getAdminSession(db, adminId) {
  const row = await db
    .prepare("SELECT state, data_json FROM admin_sessions WHERE admin_id = ?1")
    .bind(String(adminId))
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

async function setAdminSession(db, adminId, state, data = {}) {
  await db
    .prepare(
      `INSERT INTO admin_sessions (admin_id, state, data_json, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(admin_id) DO UPDATE SET
         state = excluded.state,
         data_json = excluded.data_json,
         updated_at = excluded.updated_at`
    )
    .bind(String(adminId), String(state), JSON.stringify(data || {}), Date.now())
    .run();
}

async function clearAdminSession(db, adminId) {
  await db
    .prepare("DELETE FROM admin_sessions WHERE admin_id = ?1")
    .bind(String(adminId))
    .run();
}

async function getNextBotNumber(db) {
  const row = await db
    .prepare("SELECT value FROM factory_meta WHERE key = 'last_bot_index'")
    .first();
  const maxRow = await db
    .prepare("SELECT COALESCE(MAX(bot_index), 0) AS max_idx FROM deployed_bots")
    .first();
  const current = Math.max(
    parseInt(row?.value || "0", 10),
    Number(maxRow?.max_idx || 0)
  );
  const next = current + 1;
  await db
    .prepare(
      "INSERT INTO factory_meta (key, value) VALUES ('last_bot_index', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .bind(String(next))
    .run();
  return next;
}

function generateWebhookSecret() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  let out = "uppro_sec_";
  for (let i = 0; i < 28; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// ============================================================================
// Cloudflare REST API Provisioning & Deployment Engine
// ============================================================================

async function verifyCloudflareTokenAndGetAccount(apiToken) {
  const cleanToken = String(apiToken || "").trim();
  const resp = await fetch("https://api.cloudflare.com/client/v4/accounts?page=1&per_page=10", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${cleanToken}`,
      "Content-Type": "application/json",
    },
  });

  let data = null;
  try {
    data = await resp.json();
  } catch (err) {
    return { ok: false, error: `خطا در خواندن پاسخ کلودفلر: ${String(err)}` };
  }

  if (!resp.ok || !data || !data.success || !Array.isArray(data.result) || data.result.length === 0) {
    const errMsg =
      data?.errors?.map((e) => e.message).join(" | ") ||
      "توکن نامعتبر است یا دسترسی Account Settings: Read ندارد.";
    return { ok: false, error: errMsg };
  }

  const primaryAccount = data.result[0];
  return {
    ok: true,
    account_id: primaryAccount.id,
    account_name: primaryAccount.name || "Cloudflare Account",
  };
}

async function createOrGetD1Database(accountId, apiToken, dbName) {
  // 1. Attempt to create D1 database
  const createResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: dbName }),
    }
  );
  const createData = await createResp.json().catch(() => null);
  if (createResp.ok && createData?.success && createData?.result?.uuid) {
    return { ok: true, uuid: createData.result.uuid, name: dbName };
  }

  // 2. If already exists, look up existing D1 database by name
  const listResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${encodeURIComponent(
      dbName
    )}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    }
  );
  const listData = await listResp.json().catch(() => null);
  if (listResp.ok && listData?.success && Array.isArray(listData.result)) {
    const found = listData.result.find((d) => d.name === dbName);
    if (found && found.uuid) {
      return { ok: true, uuid: found.uuid, name: dbName };
    }
  }

  const errStr =
    createData?.errors?.map((e) => e.message).join(" | ") ||
    "عدم توانایی در ساخت دیتابیس D1";
  return { ok: false, error: errStr };
}

async function runD1SchemaMigration(accountId, apiToken, d1Uuid) {
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${d1Uuid}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql: CHILD_INITIAL_SQL }),
    }
  );
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.success) {
    const errStr =
      data?.errors?.map((e) => e.message).join(" | ") ||
      "خطا در اجرای جداول اولیه D1";
    return { ok: false, error: errStr };
  }
  return { ok: true };
}

async function deployChildWorkerScript({
  accountId,
  apiToken,
  workerName,
  d1Uuid,
  botToken,
  botUsername,
  adminId,
  aiAccountId,
  aiApiToken,
  webhookSecret,
}) {
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2024-09-23",
    bindings: [
      {
        type: "d1",
        name: "DB",
        id: d1Uuid,
      },
      {
        type: "ai",
        name: "AI",
      },
      {
        type: "plain_text",
        name: "BOT_TOKEN",
        text: String(botToken),
      },
      {
        type: "plain_text",
        name: "BOT_USERNAME",
        text: String(botUsername || ""),
      },
      {
        type: "plain_text",
        name: "ADMIN_ID",
        text: String(adminId),
      },
      {
        type: "plain_text",
        name: "AI_ACCOUNT_ID",
        text: String(aiAccountId || ""),
      },
      {
        type: "plain_text",
        name: "AI_API_TOKEN",
        text: String(aiApiToken || ""),
      },
      {
        type: "plain_text",
        name: "WORKER_NAME",
        text: String(workerName),
      },
      {
        type: "plain_text",
        name: "WEBHOOK_SECRET",
        text: String(webhookSecret),
      },
    ],
  };

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );
  form.append(
    "worker.js",
    new Blob([getChildWorkerScript()], {
      type: "application/javascript+module",
    }),
    "worker.js"
  );

  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(
      workerName
    )}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: form,
    }
  );

  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.success) {
    const errStr =
      data?.errors?.map((e) => e.message).join(" | ") ||
      "خطا در آپلود اسکریپت ورکر روی کلودفلر";
    return { ok: false, error: errStr };
  }
  return { ok: true };
}

async function enableWorkersDevSubdomain(accountId, apiToken, workerName) {
  // 1. Fetch account's workers.dev subdomain prefix
  const subResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    }
  );
  const subData = await subResp.json().catch(() => null);
  const subdomain = subData?.result?.subdomain;
  if (!subdomain) {
    return {
      ok: false,
      error:
        "ساب‌دامین workers.dev در این اکانت کلودفلر فعال نشده است! ابتدا یک بار در داشبورد کلودفلر بخش Workers & Pages را باز کنید تا ساب‌دامین ساخته شود.",
    };
  }

  // 2. Enable workers.dev route for this specific child worker
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(
      workerName
    )}/subdomain`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    }
  );

  return {
    ok: true,
    subdomain,
    workerUrl: `https://${workerName}.${subdomain}.workers.dev`,
  };
}

// ============================================================================
// Master Admin Panel UI & Keyboards (Persian)
// ============================================================================

function getMasterMainKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "🤖 ساخت ربات جدید (UP-PROn)",
          callback_data: "m_new_bot",
        },
      ],
      [
        {
          text: "📋 لیست ربات‌های ساخته شده",
          callback_data: "m_list_bots:1",
        },
      ],
      [
        {
          text: "🚀 بروزرسانی همگانی (Push Update to All UP-PROn)",
          callback_data: "m_push_all_confirm",
        },
      ],
    ],
  };
}

async function renderMasterHome(db, env, chatId, messageId = null) {
  const stats = await db
    .prepare("SELECT COUNT(*) AS cnt FROM deployed_bots")
    .first();

  const text =
    `🏭 <b>کارخانه مرکزی ساخت و مدیریت ربات‌های آپلودر (UP-PRO)</b>\n` +
    `نسخه هسته مرکزی: <code>v${FACTORY_VERSION}</code>\n\n` +
    `🤖 تعداد ربات‌های مستقل مستقر شده: <b>${stats?.cnt || 0} ربات</b>\n` +
    `⚡ معماری: <b>Two-Tier Zero-Traffic Provisioner</b> (بدون مصرف درخواست روزانه از ترافیک کاربران ربات‌های فرزند)\n\n` +
    `👇 از دکمه‌های شیشه‌ای زیر عملیات مورد نظر را انتخاب کنید:`;

  const kb = getMasterMainKeyboard();
  if (messageId) {
    const ed = await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text,
      reply_markup: kb,
    });
    if (ed && ed.ok) return;
  }

  await tgApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text,
    reply_markup: kb,
  });
}

async function renderBotManageCard(db, env, chatId, botId, messageId = null) {
  const bot = await db
    .prepare("SELECT * FROM deployed_bots WHERE id = ?1")
    .bind(Number(botId))
    .first();

  if (!bot) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "❌ ربات مورد نظر در دیتابیس یافت نشد.",
    });
    return;
  }

  const aiMode =
    bot.ai_account_id && bot.ai_account_id !== bot.cf_account_id
      ? `🔋 اکانت دوم مجزا (${escapeHtml(bot.ai_account_id.slice(0, 8))}...)`
      : `⚡ اکانت اول (${escapeHtml(bot.cf_account_id.slice(0, 8))}...)`;

  const text =
    `🤖 <b>شناسنامه و پنل مدیریت ربات <code>${escapeHtml(bot.worker_name)}</code></b>\n\n` +
    `🏷 نام ربات: <b>${escapeHtml(bot.bot_first_name || bot.worker_name)}</b>\n` +
    `🔗 یوزرنیم: @${escapeHtml(bot.bot_username)}\n` +
    `👤 آیدی عددی ادمین: <code>${escapeHtml(bot.admin_id)}</code>\n` +
    `☁️ اکانت کلودفلر (Worker & D1): <code>${escapeHtml(bot.cf_account_id)}</code>\n` +
    `🗄 دیتابیس اختصاصی D1: <code>${escapeHtml(bot.d1_name)}</code>\n` +
    `🧠 هسته هوش مصنوعی: ${aiMode}\n` +
    `📦 نسخه مستقر شده: <code>v${escapeHtml(bot.version)}</code>\n` +
    `🌐 آدرس وبهوک:\n<code>${escapeHtml(bot.webhook_url)}</code>\n` +
    `📅 تاریخ ساخت: <code>${escapeHtml(bot.created_at.slice(0, 19))}</code>`;

  const inline_keyboard = [
    [
      {
        text: "🔍 تست سلامت وبهوک و ورکر",
        callback_data: `m_bot_health:${bot.id}`,
      },
    ],
    [
      {
        text: "🔄 آپدیت کد این ربات به آخرین نسخه",
        callback_data: `m_bot_update:${bot.id}`,
      },
    ],
    [
      {
        text: "👤 تغییر ادمین ربات",
        callback_data: `m_bot_chadmin:${bot.id}`,
      },
    ],
    [
      {
        text: "🗑 حذف کامل ورکر و دیتابیس از کلودفلر",
        callback_data: `m_bot_del_confirm:${bot.id}`,
      },
    ],
    [
      { text: "🔙 بازگشت به لیست ربات‌ها", callback_data: "m_list_bots:1" },
      { text: "🏠 منوی اصلی", callback_data: "m_home" },
    ],
  ];

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
// Step 4: Automated Zero-Touch Provisioning Executor
// ============================================================================

async function executeZeroTouchProvisioning(db, env, chatId, sessionData) {
  const statusMsg = await tgApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      `⚙️ <b>شروع عملیات استقرار خودکار (Zero-Touch Provisioning)...</b>\n\n` +
      `⏳ مرحله ۱/۵: تخصیص شماره ربات و ساخت دیتابیس اختصاصی D1...`,
  });
  const statusMsgId = statusMsg?.result?.message_id;

  const updateProgress = async (stepText) => {
    if (!statusMsgId) return;
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsgId,
      parse_mode: "HTML",
      text: stepText,
    });
  };

  // 1. Assign sequential number n -> UP-PRO{n} & up_pro_{n}_db
  const n = await getNextBotNumber(db);
  const workerName = `UP-PRO${n}`;
  const d1Name = `up_pro_${n}_db`;

  // 2. Create D1 Database on Account 1
  const d1Res = await createOrGetD1Database(
    sessionData.cf_account_id,
    sessionData.cf_token,
    d1Name
  );
  if (!d1Res.ok) {
    await updateProgress(
      `❌ <b>خطا در ساخت دیتابیس D1 (<code>${escapeHtml(d1Name)}</code>):</b>\n<code>${escapeHtml(
        d1Res.error
      )}</code>`
    );
    return;
  }

  // 3. Execute Initial SQL Schema Migration
  await updateProgress(
    `⚙️ <b>استقرار خودکار <code>${escapeHtml(workerName)}</code>...</b>\n\n` +
      `✅ دیتابیس <code>${escapeHtml(d1Name)}</code> ساخته شد.\n` +
      `⏳ مرحله ۲/۵: اجرای جداول اولیه SQL روی دیتابیس D1...`
  );

  const migRes = await runD1SchemaMigration(
    sessionData.cf_account_id,
    sessionData.cf_token,
    d1Res.uuid
  );
  if (!migRes.ok) {
    await updateProgress(
      `❌ <b>خطا در اجرای SQL اولیه روی D1:</b>\n<code>${escapeHtml(migRes.error)}</code>`
    );
    return;
  }

  // 4. Upload Bundled Child Worker ES Module Script
  await updateProgress(
    `⚙️ <b>استقرار خودکار <code>${escapeHtml(workerName)}</code>...</b>\n\n` +
      `✅ دیتابیس و جداول D1 آماده شدند.\n` +
      `⏳ مرحله ۳/۵: آپلود سورس کامل ورکر فرزند و اتصال متغیرهای محیطی...`
  );

  const webhookSecret = generateWebhookSecret();
  const deployRes = await deployChildWorkerScript({
    accountId: sessionData.cf_account_id,
    apiToken: sessionData.cf_token,
    workerName,
    d1Uuid: d1Res.uuid,
    botToken: sessionData.target_bot_token,
    botUsername: sessionData.target_bot_username,
    adminId: sessionData.target_admin_id,
    aiAccountId: sessionData.ai_account_id,
    aiApiToken: sessionData.ai_api_token,
    webhookSecret,
  });

  if (!deployRes.ok) {
    await updateProgress(
      `❌ <b>خطا در آپلود اسکریپت ورکر <code>${escapeHtml(workerName)}</code>:</b>\n<code>${escapeHtml(
        deployRes.error
      )}</code>`
    );
    return;
  }

  // 5. Enable workers.dev Subdomain & Set Telegram Webhook
  await updateProgress(
    `⚙️ <b>استقرار خودکار <code>${escapeHtml(workerName)}</code>...</b>\n\n` +
      `✅ ورکر <code>${escapeHtml(workerName)}</code> با موفقیت مستقر شد.\n` +
      `⏳ مرحله ۴/۵: فعال‌سازی دامنه workers.dev و اتصال وبهوک تلگرام...`
  );

  const subRes = await enableWorkersDevSubdomain(
    sessionData.cf_account_id,
    sessionData.cf_token,
    workerName
  );
  if (!subRes.ok) {
    await updateProgress(
      `❌ <b>خطا در فعال‌سازی ساب‌دامین workers.dev:</b>\n<code>${escapeHtml(subRes.error)}</code>`
    );
    return;
  }

  const webhookUrl = `${subRes.workerUrl}/webhook`;
  const whRes = await tgApi(sessionData.target_bot_token, "setWebhook", {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query", "channel_post"],
    drop_pending_updates: true,
  });

  if (!whRes || !whRes.ok) {
    await updateProgress(
      `❌ <b>ورکر ساخته شد اما تنظیم وبهوک تلگرام با خطا مواجه شد:</b>\n<code>${escapeHtml(
        whRes?.description || "Unknown Telegram Error"
      )}</code>\nآدرس: <code>${escapeHtml(webhookUrl)}</code>`
    );
    return;
  }

  // 6. Save Deployed Bot Metadata in UP-PRO Master D1
  const nowIso = new Date().toISOString();
  const ins = await db
    .prepare(
      `INSERT INTO deployed_bots (
        bot_index, worker_name, bot_token, bot_username, bot_first_name,
        cf_account_id, cf_token, d1_id, d1_name,
        ai_account_id, ai_api_token, admin_id,
        webhook_url, webhook_secret, version, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`
    )
    .bind(
      n,
      workerName,
      sessionData.target_bot_token,
      sessionData.target_bot_username,
      sessionData.target_bot_name || workerName,
      sessionData.cf_account_id,
      sessionData.cf_token,
      d1Res.uuid,
      d1Name,
      sessionData.ai_account_id || sessionData.cf_account_id,
      sessionData.ai_api_token || sessionData.cf_token,
      String(sessionData.target_admin_id),
      webhookUrl,
      webhookSecret,
      FACTORY_VERSION,
      nowIso
    )
    .run();

  const newBotId = ins?.meta?.last_row_id;

  // Send welcome notification inside the newly deployed child bot to its Admin
  await tgApi(sessionData.target_bot_token, "sendMessage", {
    chat_id: sessionData.target_admin_id,
    parse_mode: "HTML",
    text:
      `🎉 <b>ربات آپلودر و ناشر هوشمند شما (<code>${escapeHtml(
        workerName
      )}</code>) با موفقیت راه‌اندازی شد!</b>\n\n` +
      `برای ورود به پنل مدیریت، دستور /panel را ارسال کنید یا روی دکمه شیشه‌ای زیر بزنید:`,
    reply_markup: {
      inline_keyboard: [[{ text: "🎛 ورود به پنل مدیریت (/panel)", callback_data: "adm_home" }]],
    },
  });

  await updateProgress(
    `🎉 <b>ربات مستقل <code>${escapeHtml(workerName)}</code> با موفقیت کامل ساخته و فعال شد!</b>\n\n` +
      `🤖 <b>یوزرنیم ربات:</b> @${escapeHtml(sessionData.target_bot_username)}\n` +
      `☁️ <b>نام ورکر:</b> <code>${escapeHtml(workerName)}</code>\n` +
      `🗄 <b>دیتابیس D1:</b> <code>${escapeHtml(d1Name)}</code> (<code>${escapeHtml(
        d1Res.uuid
      )}</code>)\n` +
      `👤 <b>ادمین ربات:</b> <code>${escapeHtml(sessionData.target_admin_id)}</code>\n` +
      `🌐 <b>آدرس وبهوک فعال:</b>\n<code>${escapeHtml(webhookUrl)}</code>\n\n` +
      `✅ تمام ترافیک کاربران این ربات به صورت ۱۰۰٪ مستقیم روی ورکر خودش پردازش می‌شود.`
  );

  if (newBotId) {
    await renderBotManageCard(db, env, chatId, newBotId);
  } else {
    await renderMasterHome(db, env, chatId);
  }
}

// ============================================================================
// Master Update Handlers (Messages & Callbacks)
// ============================================================================

async function handleMasterMessage(message, db, env) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!userId) return;

  if (!isMasterAdmin(userId, env)) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "⛔ این ربات مخصوص مدیر کارخانه UP-PRO است.",
    });
    return;
  }

  const text = (message.text || "").trim();
  const session = await getAdminSession(db, userId);

  if (text === "/start" || text === "/panel") {
    await clearAdminSession(db, userId);
    await renderMasterHome(db, env, chatId);
    return;
  }

  // Step 1: Receive Cloudflare Core API Token (Account 1)
  if (session.state === "STEP_1_CF_CORE_TOKEN") {
    const waitMsg = await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "⏳ در حال بررسی اعتبار توکن کلودفلر و استخراج خودکار Account ID...",
    });

    const check = await verifyCloudflareTokenAndGetAccount(text);
    if (waitMsg?.result?.message_id) {
      await tgApi(env.BOT_TOKEN, "deleteMessage", {
        chat_id: chatId,
        message_id: waitMsg.result.message_id,
      });
    }

    if (!check.ok) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `❌ <b>توکن کلودفلر تایید نشد!</b>\n` +
          `علت: <code>${escapeHtml(check.error)}</code>\n\n` +
          `لطفاً با استفاده از دکمه زیر توکن را دقیقاً با دسترسی‌های از پیش تعیین‌شده بسازید و ارسال کنید:`,
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔑 ساخت سریع توکن Core کلودفلر (۱ کلیک)", url: CF_CORE_TOKEN_DEEPLINK }],
            [{ text: "🔙 انصراف", callback_data: "m_home" }],
          ],
        },
      });
      return;
    }

    const updatedData = {
      ...session.data,
      cf_token: text,
      cf_account_id: check.account_id,
      cf_account_name: check.account_name,
    };
    await setAdminSession(db, userId, "STEP_2_CHOOSE_AI_MODE", updatedData);

    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `✅ <b>اکانت اول کلودفلر با موفقیت متصل شد!</b>\n` +
        `🏢 نام اکانت: <b>${escapeHtml(check.account_name)}</b>\n` +
        `🆔 شناسه اکانت (<code>CF_ACCOUNT_ID</code>): <code>${escapeHtml(check.account_id)}</code>\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `🧠 <b>گام ۲ از ۴ — تنظیم توکن هوش مصنوعی (Cloudflare Workers AI):</b>\n` +
        `آیا می‌خواهید پردازش‌های سنگین هوش مصنوعی (تولید کپشن و تولید تصویر کاور) روی یک اکانت دوم کلودفلر انجام شود تا سهمیه رایگان روزانه اکانت اول کاملاً آزاد بماند؟`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔋 استفاده از اکانت دوم برای AI (پیشنهادی - مصرف بهینه)",
              callback_data: "m_ai_use_second",
            },
          ],
          [
            {
              text: "⚡ استفاده از همان اکانت اول برای AI",
              callback_data: "m_ai_use_first",
            },
          ],
          [{ text: "🔙 انصراف", callback_data: "m_home" }],
        ],
      },
    });
    return;
  }

  // Step 2B: Receive Account 2 AI API Token
  if (session.state === "STEP_2_CF_AI_TOKEN") {
    const waitMsg = await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "⏳ در حال بررسی توکن هوش مصنوعی اکانت دوم و استخراج AI_ACCOUNT_ID...",
    });

    const check = await verifyCloudflareTokenAndGetAccount(text);
    if (waitMsg?.result?.message_id) {
      await tgApi(env.BOT_TOKEN, "deleteMessage", {
        chat_id: chatId,
        message_id: waitMsg.result.message_id,
      });
    }

    if (!check.ok) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `❌ <b>توکن اکانت دوم تایید نشد!</b>\n` +
          `علت: <code>${escapeHtml(check.error)}</code>\n\n` +
          `لطفاً دوباره توکن را ارسال کنید یا از دکمه زیر استفاده نمایید:`,
        reply_markup: {
          inline_keyboard: [
            [{ text: "🤖 ساخت توکن Workers AI (۱ کلیک)", url: CF_AI_TOKEN_DEEPLINK }],
            [{ text: "⚡ استفاده از همان اکانت اول", callback_data: "m_ai_use_first" }],
            [{ text: "🔙 انصراف", callback_data: "m_home" }],
          ],
        },
      });
      return;
    }

    const updatedData = {
      ...session.data,
      ai_api_token: text,
      ai_account_id: check.account_id,
    };
    await setAdminSession(db, userId, "STEP_3_BOT_TOKEN", updatedData);

    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `✅ <b>اکانت دوم هوش مصنوعی با موفقیت تایید شد!</b>\n` +
        `🆔 شناسه اکانت AI (<code>AI_ACCOUNT_ID</code>): <code>${escapeHtml(
          check.account_id
        )}</code>\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `🤖 <b>گام ۳ از ۴ — توکن ربات تلگرام مقصد:</b>\n` +
        `لطفاً توکن ربات تلگرامی که از <b>@BotFather</b> دریافت کرده‌اید را ارسال کنید:`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: "m_home" }]],
      },
    });
    return;
  }

  // Step 3A: Receive Target Telegram Bot Token
  if (session.state === "STEP_3_BOT_TOKEN") {
    const meRes = await tgApi(text, "getMe", {});
    if (!meRes || !meRes.ok || !meRes.result) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: "❌ <b>توکن ربات تلگرام نامعتبر است!</b>\nلطفاً توکن صحیح دریافتی از @BotFather را ارسال کنید:",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 انصراف", callback_data: "m_home" }]],
        },
      });
      return;
    }

    const updatedData = {
      ...session.data,
      target_bot_token: text,
      target_bot_username: meRes.result.username || "",
      target_bot_name: meRes.result.first_name || "UP-PRO Bot",
    };
    await setAdminSession(db, userId, "STEP_3_ADMIN_ID", updatedData);

    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `✅ <b>ربات تلگرام شناسایی شد!</b>\n` +
        `🏷 نام: <b>${escapeHtml(updatedData.target_bot_name)}</b>\n` +
        `🔗 یوزرنیم: @${escapeHtml(updatedData.target_bot_username)}\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `👤 <b>گام نهایی — آیدی عددی ادمین ربات (ADMIN_ID):</b>\n` +
        `لطفاً آیدی عددی تلگرام فردی که قرار است ادمین این ربات باشد را بفرستید، یا روی دکمه زیر بزنید تا آیدی خودتان تنظیم شود:`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `👤 استفاده از آیدی خودم (${userId})`,
              callback_data: `m_set_my_admin:${userId}`,
            },
          ],
          [{ text: "🔙 انصراف", callback_data: "m_home" }],
        ],
      },
    });
    return;
  }

  // Step 3B: Receive Target Admin Numerical ID
  if (session.state === "STEP_3_ADMIN_ID") {
    if (!/^\d+$/.test(text)) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ آیدی ادمین باید فقط شامل اعداد باشد (مثال: 123456789). لطفاً مجدداً ارسال کنید:",
      });
      return;
    }

    const finalData = {
      ...session.data,
      target_admin_id: text,
    };
    await clearAdminSession(db, userId);
    await executeZeroTouchProvisioning(db, env, chatId, finalData);
    return;
  }

  // Change Child Bot Admin ID State
  if (session.state === "AWAIT_NEW_BOT_ADMIN") {
    if (!/^\d+$/.test(text)) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ لطفاً یک آیدی عددی معتبر ارسال کنید:",
      });
      return;
    }

    const botId = session.data?.bot_id;
    await clearAdminSession(db, userId);
    const bot = await db
      .prepare("SELECT * FROM deployed_bots WHERE id = ?1")
      .bind(Number(botId))
      .first();

    if (!bot) return;

    const waitMsg = await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "⏳ در حال بروزرسانی ADMIN_ID روی ورکر کلودفلر و دیتابیس...",
    });

    const redeploy = await deployChildWorkerScript({
      accountId: bot.cf_account_id,
      apiToken: bot.cf_token,
      workerName: bot.worker_name,
      d1Uuid: bot.d1_id,
      botToken: bot.bot_token,
      botUsername: bot.bot_username,
      adminId: text,
      aiAccountId: bot.ai_account_id,
      aiApiToken: bot.ai_api_token,
      webhookSecret: bot.webhook_secret,
    });

    if (waitMsg?.result?.message_id) {
      await tgApi(env.BOT_TOKEN, "deleteMessage", {
        chat_id: chatId,
        message_id: waitMsg.result.message_id,
      });
    }

    if (redeploy.ok) {
      await db
        .prepare("UPDATE deployed_bots SET admin_id = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(text, new Date().toISOString(), bot.id)
        .run();
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `✅ ادمین ربات <code>${escapeHtml(bot.worker_name)}</code> با موفقیت به <code>${escapeHtml(
          text
        )}</code> تغییر یافت!`,
      });
    } else {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `❌ خطا در تغییر ادمین روی کلودفلر:\n<code>${escapeHtml(redeploy.error)}</code>`,
      });
    }

    await renderBotManageCard(db, env, chatId, bot.id);
    return;
  }
}

async function handleMasterCallback(cb, db, env) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const userId = cb.from?.id;
  const data = cb.data || "";

  if (!chatId || !userId) return;

  if (!isMasterAdmin(userId, env)) {
    await tgApi(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "⛔ دسترسی غیرمجاز!",
      show_alert: true,
    });
    return;
  }

  await tgApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });

  if (data === "m_home") {
    await clearAdminSession(db, userId);
    await renderMasterHome(db, env, chatId, messageId);
    return;
  }

  // Start Step 1 of Onboarding Wizard
  if (data === "m_new_bot") {
    await setAdminSession(db, userId, "STEP_1_CF_CORE_TOKEN", {});
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `🚀 <b>شروع ویزارد ساخت ربات آپلودر جدید (UP-PROn)</b>\n\n` +
        `☁️ <b>گام ۱ از ۴ — توکن اصلی کلودفلر (اکانت اول - Worker & D1):</b>\n` +
        `۱. روی دکمه شیشه‌ای زیر کلیک کنید تا صفحه ساخت توکن کلودفلر با دسترسی‌های آماده باز شود.\n` +
        `۲. دکمه <b>Continue to summary</b> و سپس <b>Create Token</b> را بزنید.\n` +
        `۳. توکن ساخته شده را کپی کرده و همین‌جا ارسال کنید:`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔑 ساخت توکن Core کلودفلر با ۱ کلیک (Deep Link)",
              url: CF_CORE_TOKEN_DEEPLINK,
            },
          ],
          [{ text: "🔙 انصراف و بازگشت", callback_data: "m_home" }],
        ],
      },
    });
    return;
  }

  // Step 2 Choice: Use Account 2 for AI
  if (data === "m_ai_use_second") {
    const session = await getAdminSession(db, userId);
    await setAdminSession(db, userId, "STEP_2_CF_AI_TOKEN", session.data);
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `🔋 <b>اتصال اکانت دوم کلودفلر برای هوش مصنوعی (Workers AI)</b>\n\n` +
        `۱. اکانت دوم کلودفلر خود را در مرورگر باز کنید.\n` +
        `۲. روی دکمه زیر کلیک کنید تا لینک مستقیم ساخت توکن AI باز شود.\n` +
        `۳. توکن ساخته شده را کپی کرده و در همین چت ارسال کنید:`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🤖 ساخت توکن Workers AI با ۱ کلیک (Deep Link)",
              url: CF_AI_TOKEN_DEEPLINK,
            },
          ],
          [
            {
              text: "⚡ منصرف شدم؛ استفاده از همان اکانت اول",
              callback_data: "m_ai_use_first",
            },
          ],
          [{ text: "🔙 لغو کامل", callback_data: "m_home" }],
        ],
      },
    });
    return;
  }

  // Step 2 Choice: Use Account 1 for AI
  if (data === "m_ai_use_first") {
    const session = await getAdminSession(db, userId);
    const updatedData = {
      ...session.data,
      ai_account_id: session.data.cf_account_id,
      ai_api_token: session.data.cf_token,
    };
    await setAdminSession(db, userId, "STEP_3_BOT_TOKEN", updatedData);
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `⚡ <b>هوش مصنوعی روی همان اکانت اول تنظیم شد.</b>\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `🤖 <b>گام ۳ از ۴ — توکن ربات تلگرام مقصد:</b>\n` +
        `لطفاً توکن ربات تلگرامی که از <b>@BotFather</b> دریافت کرده‌اید را ارسال کنید:`,
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 انصراف", callback_data: "m_home" }]],
      },
    });
    return;
  }

  // Step 3B Shortcut: Use current admin's own Telegram ID
  if (data.startsWith("m_set_my_admin:")) {
    const adminIdStr = data.split(":")[1];
    const session = await getAdminSession(db, userId);
    if (!session.data?.target_bot_token) {
      await renderMasterHome(db, env, chatId, messageId);
      return;
    }
    const finalData = {
      ...session.data,
      target_admin_id: adminIdStr,
    };
    await clearAdminSession(db, userId);
    await executeZeroTouchProvisioning(db, env, chatId, finalData);
    return;
  }

  // List Deployed Child Bots
  if (data.startsWith("m_list_bots:")) {
    const page = Math.max(1, parseInt(data.split(":")[1] || "1", 10));
    const pageSize = 8;
    const offset = (page - 1) * pageSize;

    const cntRow = await db
      .prepare("SELECT COUNT(*) AS cnt FROM deployed_bots")
      .first();
    const total = cntRow?.cnt || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const rows = await db
      .prepare(
        "SELECT * FROM deployed_bots ORDER BY bot_index ASC LIMIT ?1 OFFSET ?2"
      )
      .bind(pageSize, offset)
      .all();
    const bots = (rows && rows.results) || [];

    const inline_keyboard = bots.map((b) => [
      {
        text: `🤖 ${b.worker_name} (@${b.bot_username}) — v${b.version}`,
        callback_data: `m_bot_view:${b.id}`,
      },
    ]);

    const nav = [];
    if (page > 1) {
      nav.push({ text: "⬅️ قبلی", callback_data: `m_list_bots:${page - 1}` });
    }
    if (page < totalPages) {
      nav.push({ text: "بعدی ➡️", callback_data: `m_list_bots:${page + 1}` });
    }
    if (nav.length > 0) inline_keyboard.push(nav);
    inline_keyboard.push([{ text: "🔙 بازگشت به منوی اصلی", callback_data: "m_home" }]);

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        total > 0
          ? `📋 <b>لیست ربات‌های آپلودر ساخته شده (${total} ربات):</b>\nبرای تست سلامت، آپدیت کد، تغییر ادمین یا حذف کامل، روی نام هر ربات کلیک کنید:`
          : `📭 <b>هنوز هیچ ربات فرزندی ساخته نشده است!</b>\nاز منوی اصلی روی «🤖 ساخت ربات جدید (UP-PROn)» کلیک کنید.`,
      reply_markup: { inline_keyboard },
    });
    return;
  }

  if (data.startsWith("m_bot_view:")) {
    const botId = Number(data.split(":")[1]);
    await renderBotManageCard(db, env, chatId, botId, messageId);
    return;
  }

  // Health Check Webhook & Worker
  if (data.startsWith("m_bot_health:")) {
    const botId = Number(data.split(":")[1]);
    const bot = await db
      .prepare("SELECT * FROM deployed_bots WHERE id = ?1")
      .bind(botId)
      .first();
    if (!bot) return;

    const whInfo = await tgApi(bot.bot_token, "getWebhookInfo", {});
    const healthUrl = bot.webhook_url.replace(/\/webhook$/, "/health");
    let workerHealth = null;
    try {
      const hResp = await fetch(healthUrl, { method: "GET" });
      workerHealth = await hResp.json();
    } catch (err) {
      workerHealth = { ok: false, error: String(err) };
    }

    const whOk =
      whInfo?.ok &&
      whInfo?.result?.url === bot.webhook_url &&
      !whInfo?.result?.last_error_message;

    const report =
      `🔍 <b>گزارش تست سلامت ربات <code>${escapeHtml(bot.worker_name)}</code></b>\n\n` +
      `🌐 <b>وضعیت ورکر کلودفلر:</b> ${
        workerHealth?.ok ? "✅ آنلاین و سالم" : "🔴 خطا در پاسخگویی"
      }\n` +
      `📦 <b>نسخه فعال ورکر:</b> <code>${escapeHtml(
        workerHealth?.version || bot.version
      )}</code>\n` +
      `👥 <b>کاربران ثبت‌شده در D1:</b> <b>${workerHealth?.users ?? "نامشخص"}</b>\n` +
      `📁 <b>کدهای کالای ثبت‌شده:</b> <b>${workerHealth?.products ?? "نامشخص"}</b>\n\n` +
      `🔗 <b>وضعیت وبهوک تلگرام:</b> ${whOk ? "✅ متصل و بدون خطا" : "⚠️ نیازمند بررسی"}\n` +
      `📬 <b>آپدیت‌های در صف انتظار:</b> <code>${
        whInfo?.result?.pending_update_count || 0
      }</code>\n` +
      (whInfo?.result?.last_error_message
        ? `⚠️ <b>آخرین خطای تلگرام:</b>\n<code>${escapeHtml(
            whInfo.result.last_error_message
          )}</code>`
        : `✨ هیچ خطایی در وبهوک تلگرام ثبت نشده است.`);

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: report,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 بازگشت به مدیریت ربات", callback_data: `m_bot_view:${bot.id}` }],
        ],
      },
    });
    return;
  }

  // Push Update to Single Bot
  if (data.startsWith("m_bot_update:")) {
    const botId = Number(data.split(":")[1]);
    const bot = await db
      .prepare("SELECT * FROM deployed_bots WHERE id = ?1")
      .bind(botId)
      .first();
    if (!bot) return;

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: `⏳ در حال آپدیت کد ورکر <code>${escapeHtml(bot.worker_name)}</code> به نسخه <code>v${FACTORY_VERSION}</code>...`,
    });

    await runD1SchemaMigration(bot.cf_account_id, bot.cf_token, bot.d1_id);
    const upRes = await deployChildWorkerScript({
      accountId: bot.cf_account_id,
      apiToken: bot.cf_token,
      workerName: bot.worker_name,
      d1Uuid: bot.d1_id,
      botToken: bot.bot_token,
      botUsername: bot.bot_username,
      adminId: bot.admin_id,
      aiAccountId: bot.ai_account_id,
      aiApiToken: bot.ai_api_token,
      webhookSecret: bot.webhook_secret,
    });

    if (upRes.ok) {
      await db
        .prepare("UPDATE deployed_bots SET version = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(FACTORY_VERSION, new Date().toISOString(), bot.id)
        .run();
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `✅ ربات <code>${escapeHtml(bot.worker_name)}</code> با موفقیت به نسخه <code>v${FACTORY_VERSION}</code> بروزرسانی شد!`,
      });
    } else {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `❌ خطا در آپدیت <code>${escapeHtml(bot.worker_name)}</code>:\n<code>${escapeHtml(
          upRes.error
        )}</code>`,
      });
    }

    await renderBotManageCard(db, env, chatId, bot.id);
    return;
  }

  // Change Bot Admin ID
  if (data.startsWith("m_bot_chadmin:")) {
    const botId = Number(data.split(":")[1]);
    await setAdminSession(db, userId, "AWAIT_NEW_BOT_ADMIN", { bot_id: botId });
    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: "👤 <b>تغییر ادمین ربات</b>\n\nلطفاً آیدی عددی ادمین جدید را ارسال کنید:",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 انصراف", callback_data: `m_bot_view:${botId}` }],
        ],
      },
    });
    return;
  }

  // Delete Bot Confirmation
  if (data.startsWith("m_bot_del_confirm:")) {
    const botId = Number(data.split(":")[1]);
    const bot = await db
      .prepare("SELECT * FROM deployed_bots WHERE id = ?1")
      .bind(botId)
      .first();
    if (!bot) return;

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `⚠️ <b>هشدار حذف کامل از کلودفلر!</b>\n\n` +
        `آیا مطمئن هستید که می‌خواهید ورکر <code>${escapeHtml(
          bot.worker_name
        )}</code> و دیتابیس <code>${escapeHtml(
          bot.d1_name
        )}</code> را به طور کامل از اکانت کلودفلر حذف کنید؟\n` +
        `<i>این عملیات غیرقابل بازگشت است.</i>`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🗑 بله، ورکر و دیتابیس کاملاً حذف شوند",
              callback_data: `m_bot_del_exec:${bot.id}`,
            },
          ],
          [{ text: "❌ خیر، بازگشت", callback_data: `m_bot_view:${bot.id}` }],
        ],
      },
    });
    return;
  }

  // Execute Full Deletion of Worker + D1 + Webhook
  if (data.startsWith("m_bot_del_exec:")) {
    const botId = Number(data.split(":")[1]);
    const bot = await db
      .prepare("SELECT * FROM deployed_bots WHERE id = ?1")
      .bind(botId)
      .first();
    if (!bot) return;

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: `⏳ در حال حذف کامل ورکر <code>${escapeHtml(bot.worker_name)}</code>، دیتابیس D1 و وبهوک تلگرام...`,
    });

    // 1. Delete Telegram Webhook
    await tgApi(bot.bot_token, "deleteWebhook", { drop_pending_updates: true });

    // 2. Delete Cloudflare Worker Script
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${bot.cf_account_id}/workers/scripts/${encodeURIComponent(
        bot.worker_name
      )}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bot.cf_token}` },
      }
    );

    // 3. Delete Cloudflare D1 Database
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${bot.cf_account_id}/d1/database/${bot.d1_id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bot.cf_token}` },
      }
    );

    // 4. Delete Record from Master D1
    await db.prepare("DELETE FROM deployed_bots WHERE id = ?1").bind(bot.id).run();

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: `✅ ورکر <code>${escapeHtml(bot.worker_name)}</code> و دیتابیس <code>${escapeHtml(
        bot.d1_name
      )}</code> به طور کامل از کلودفلر و لیست کارخانه حذف شدند.`,
      reply_markup: {
        inline_keyboard: [[{ text: "📋 بازگشت به لیست ربات‌ها", callback_data: "m_list_bots:1" }]],
      },
    });
    return;
  }

  // Push Update to All UP-PROn Confirmation
  if (data === "m_push_all_confirm") {
    const cntRow = await db
      .prepare("SELECT COUNT(*) AS cnt FROM deployed_bots")
      .first();
    const total = cntRow?.cnt || 0;

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `🚀 <b>بروزرسانی همگانی تمام ربات‌های فرزند (Push Update to All)</b>\n\n` +
        `تعداد کل ربات‌های ثبت‌شده: <b>${total} ربات</b>\n` +
        `نسخه هدف: <code>v${FACTORY_VERSION}</code>\n\n` +
        `آیا مایلید آخرین نسخه کد ورکر فرزند به صورت خودکار روی تمام ربات‌های مستقر شده آپلود شود؟ (اطلاعات و فایل‌های دیتابیس هیچ رباتی پاک نمی‌شود)`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🚀 بله، بروزرسانی همگانی آغاز شود",
              callback_data: "m_push_all_exec",
            },
          ],
          [{ text: "🔙 انصراف", callback_data: "m_home" }],
        ],
      },
    });
    return;
  }

  if (data === "m_push_all_exec") {
    const rows = await db
      .prepare("SELECT * FROM deployed_bots ORDER BY bot_index ASC")
      .all();
    const bots = (rows && rows.results) || [];

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: `⏳ در حال ارسال آپدیت همگانی به <b>${bots.length} ربات</b>... لطفاً صبر کنید.`,
    });

    let okCount = 0;
    let failCount = 0;
    const details = [];

    for (const bot of bots) {
      await runD1SchemaMigration(bot.cf_account_id, bot.cf_token, bot.d1_id);
      const res = await deployChildWorkerScript({
        accountId: bot.cf_account_id,
        apiToken: bot.cf_token,
        workerName: bot.worker_name,
        d1Uuid: bot.d1_id,
        botToken: bot.bot_token,
        botUsername: bot.bot_username,
        adminId: bot.admin_id,
        aiAccountId: bot.ai_account_id,
        aiApiToken: bot.ai_api_token,
        webhookSecret: bot.webhook_secret,
      });

      if (res.ok) {
        okCount++;
        await db
          .prepare("UPDATE deployed_bots SET version = ?1, updated_at = ?2 WHERE id = ?3")
          .bind(FACTORY_VERSION, new Date().toISOString(), bot.id)
          .run();
        details.push(`✅ <code>${escapeHtml(bot.worker_name)}</code> (@${escapeHtml(bot.bot_username)})`);
      } else {
        failCount++;
        details.push(
          `❌ <code>${escapeHtml(bot.worker_name)}</code>: ${escapeHtml(res.error.slice(0, 50))}`
        );
      }
    }

    await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text:
        `🚀 <b>گزارش نهایی بروزرسانی همگانی (v${FACTORY_VERSION})</b>\n\n` +
        `🟢 موفق: <b>${okCount} ربات</b>\n` +
        `🔴 ناموفق: <b>${failCount} ربات</b>\n\n` +
        details.slice(0, 25).join("\n"),
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 بازگشت به منوی اصلی", callback_data: "m_home" }]],
      },
    });
    return;
  }
}

// ============================================================================
// Master Worker Fetch Entrypoint
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    await ensureMasterSchema(env.DB);

    // One-click Master Webhook Setup Helper: GET /setup-webhook
    if (url.pathname === "/setup-webhook") {
      const webhookUrl = `${url.origin}/webhook`;
      const res = await tgApi(env.BOT_TOKEN, "setWebhook", {
        url: webhookUrl,
        allowed_updates: ["message", "callback_query"],
      });
      return new Response(JSON.stringify({ webhookUrl, telegram_response: res }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json();
        if (update.message) {
          await handleMasterMessage(update.message, env.DB, env);
        } else if (update.callback_query) {
          await handleMasterCallback(update.callback_query, env.DB, env);
        }
        return new Response("OK", { status: 200 });
      } catch (err) {
        return new Response(`Master Error: ${String(err)}`, { status: 200 });
      }
    }

    return new Response(
      `UP-PRO Master Bot Factory v${FACTORY_VERSION} is active. Visit /setup-webhook once to bind Telegram webhook.`,
      { status: 200 }
    );
  },
};