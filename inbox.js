const Imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  getImapConfig: dbGetImapConfig,
  setImapConfig: dbSetImapConfig,
  getAllImapConfigs,
} = require("./db");

// HTML Cache directory
const HTML_CACHE_DIR = path.join(__dirname, "html_cache");
if (!fs.existsSync(HTML_CACHE_DIR)) fs.mkdirSync(HTML_CACHE_DIR, { recursive: true });

// State per-user
const userSessions = {};

// Map: telegramMessageId -> { to, subject, msgId }
const replyMeta = new Map();

let botInstance = null;

function init(bot) {
  botInstance = bot;
}

function getSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = { imapConfig: null, imap: null, isConnected: false };
  }
  return userSessions[userId];
}

async function setImapConfig(userId, config) {
  const session = getSession(userId);
  session.imapConfig = config;
  await dbSetImapConfig(userId, config);
}

async function getImapConfig(userId) {
  const session = getSession(userId);
  if (!session.imapConfig) {
    try {
      session.imapConfig = await dbGetImapConfig(userId);
    } catch (e) {
      console.error(`❌ Gagal ambil IMAP config user ${userId}:`, e.message);
    }
  }
  return session.imapConfig;
}

function escapeMd(str) {
  return String(str || "").replace(/[_*`[]/g, (c) => "\\" + c);
}

function formatIncomingEmail({ from, to, subject, body, date }) {
  const fromStr = escapeMd(from || "unknown");
  const toStr = escapeMd(to || "unknown");
  const subjectStr = escapeMd(subject || "(tanpa subjek)");
  const rawBody = (body || "(kosong)").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const bodyStr = escapeMd(rawBody.substring(0, 2000));
  const dateStr = date ? new Date(date).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "-";

  return (
    `📥 *EMAIL MASUK*\n\n` +
    `👤 *Dari:* ${fromStr}\n` +
    `📧 *Untuk:* ${toStr}\n` +
    `📌 *Subjek:* ${subjectStr}\n` +
    `🕐 *Waktu:* ${dateStr}\n\n` +
    `💬 *Isi:*\n${bodyStr}`
  );
}

function extractEmail(fromStr) {
  if (!fromStr) return null;
  const match = fromStr.match(/<([^>]+)>/);
  if (match) return match[1].trim();
  const plain = fromStr.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plain)) return plain;
  return null;
}

// Fetch & proses satu email berdasarkan UID, lalu kirim ke Telegram
function processMessage(imap, uid, userId) {
  return new Promise((resolve) => {
    const f = imap.fetch(uid, { bodies: "", markSeen: true });

    f.on("message", (msg) => {
      const chunks = [];
      msg.on("body", (stream) => {
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", async () => {
          try {
            const raw = Buffer.concat(chunks);
            const parsed = await simpleParser(raw);

            const fromRaw = parsed.from?.text || "";
            const fromEmail = extractEmail(fromRaw);
            const toRaw = parsed.to?.text || "";
            const subject = parsed.subject || "";
            const htmlBody = parsed.html || "";
            const body = parsed.text || htmlBody || "";
            const date = parsed.date;

            const telegramText = formatIncomingEmail({ from: fromRaw, to: toRaw, subject, body, date });

            await botInstance.sendMessage(userId, telegramText, { parse_mode: "Markdown" });

            // Simpan HTML dan kirim link viewer
            if (htmlBody) {
              const emailId = crypto.randomBytes(8).toString("hex"); // unique ID
              const filePath = path.join(HTML_CACHE_DIR, `${emailId}.html`);
              fs.writeFileSync(filePath, htmlBody, "utf8");

              const webhookBase = (process.env.WEBHOOK_URL || "").replace(/\/+$/, "");
              const htmlViewerUrl = `${webhookBase}/html/${emailId}`;
              await botInstance.sendMessage(userId, `📄 *Lihat email HTML:* [Buka di browser](${htmlViewerUrl})`, {
                parse_mode: "Markdown",
              });
            }

            const replyPrompt = await botInstance.sendMessage(
              userId,
              `↩️ Balas pesan ini untuk membalas email ke ${fromEmail}`,
              { reply_markup: { force_reply: true, selective: true } }
            );

            replyMeta.set(replyPrompt.message_id, {
              to: fromEmail,
              subject: subject,
              msgId: parsed.messageId || "",
            });
          } catch (err) {
            console.error(`❌ Gagal proses email (user ${userId}):`, err.message);
          }
          resolve();
        });
      });
    });

    f.once("error", (err) => {
      console.error(`❌ Fetch error (user ${userId}):`, err.message);
      resolve();
    });
  });
}

// Fetch semua UNSEEN saat pertama connect
function fetchUnseen(imap, userId) {
  imap.search(["UNSEEN"], (err, uids) => {
    if (err || !uids || !uids.length) return;
    console.log(`📬 ${uids.length} email unseen ditemukan (user ${userId})`);
    // Proses satu per satu supaya tidak flood Telegram
    uids.reduce((chain, uid) => {
      return chain.then(() => processMessage(imap, uid, userId));
    }, Promise.resolve());
  });
}

function startIdleLoop(imap, userId) {
  // Buka INBOX lalu mulai IDLE
  imap.openBox("INBOX", false, (err) => {
    if (err) {
      console.error(`❌ Gagal buka INBOX (user ${userId}):`, err.message);
      return scheduleReconnect(userId);
    }

    console.log(`📬 IMAP IDLE aktif (user ${userId})`);

    // Cek email yang sudah ada tapi belum dibaca
    fetchUnseen(imap, userId);

    // Tiap ada email baru, Gmail kirim event 'mail'
    imap.on("mail", () => {
      console.log(`📩 Email baru masuk (user ${userId})`);
      fetchUnseen(imap, userId);
    });
  });
}

function scheduleReconnect(userId) {
  const session = getSession(userId);
  if (!session.imapConfig) return;
  if (session.reconnectScheduled) return; // sudah ada reconnect antre, jangan dobel
  session.isConnected = false;
  session.reconnectScheduled = true;
  console.log(`🔄 Reconnect dalam 15 detik (user ${userId})...`);
  setTimeout(() => {
    session.reconnectScheduled = false;
    connect(userId);
  }, 15000);
}

function connect(userId) {
  const session = getSession(userId);
  if (!session.imapConfig) return;
  if (session.isConnected) return;

  const cfg = session.imapConfig;

  const imap = new Imap({
    user: cfg.user,
    password: cfg.password,
    host: cfg.host,
    port: cfg.port || 993,
    tls: cfg.tls !== false,
    tlsOptions: { rejectUnauthorized: false },
    keepalive: {
      interval: 10000, // ping tiap 10 detik
      idleInterval: 300000, // re-IDLE tiap 5 menit
      forceNoop: true,
    },
    authTimeout: 15000,
  });

  session.imap = imap;

  imap.once("ready", () => {
    session.isConnected = true;
    startIdleLoop(imap, userId);
  });

  imap.on("error", (err) => {
    console.error(`❌ IMAP error (user ${userId}):`, err.message);
    if (botInstance) {
      botInstance.sendMessage(userId, `⚠️ Koneksi inbox terputus: ${err.message}\nMencoba reconnect...`).catch(() => {});
    }
    scheduleReconnect(userId);
  });

  imap.once("end", () => {
    console.log(`📭 Koneksi IMAP ditutup (user ${userId})`);
    const wasConnected = session.isConnected;
    session.isConnected = false;
    if (wasConnected) scheduleReconnect(userId);
  });

  imap.connect();
}

function startPolling(userId) {
  const session = getSession(userId);
  if (session.isConnected) return;
  connect(userId);
}

function stopPolling(userId) {
  const session = getSession(userId);
  if (session.imap) {
    try {
      session.imap.end();
    } catch (e) {}
    session.imap = null;
  }
  session.isConnected = false;
  console.log(`📭 Inbox dihentikan (user ${userId})`);
}

function isActive(userId) {
  return !!getSession(userId).isConnected;
}

async function loadAllAndStart() {
  try {
    const configs = await getAllImapConfigs();
    if (!configs || !configs.length) return;
    for (const doc of configs) {
      const userId = Number(doc.id);
      const cfg = {
        host: doc.host,
        port: doc.port,
        tls: doc.tls !== false,
        user: doc.user,
        password: doc.password,
      };
      getSession(userId).imapConfig = cfg;
      startPolling(userId);
      console.log(`📬 Auto-start IDLE inbox user ${userId}`);
    }
  } catch (err) {
    console.error("❌ Gagal load all IMAP configs dari Onlyx DB:", err.message);
  }
}

module.exports = {
  init,
  setImapConfig,
  getImapConfig,
  startPolling,
  stopPolling,
  isActive,
  loadAllAndStart,
  extractEmail,
  replyMeta,
};
