require("dotenv").config();

// Jangan biarkan satu error nyasar bikin seluruh bot (termasuk semua sesi IMAP) mati total.
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

const TelegramBot = require("node-telegram-bot-api");
const {
  readEmailData,
  saveEmailData,
  addGmailSender,
  addBrevoAccount,
  addBrevoFromEmail,
  addReceiver,
  getAllSenders,
  sendEmail,
} = require("./email");

const {
  initUserCache,
  readUsers,
  isApproved,
  isPending,
  requestAccess,
  approveUser,
  rejectUser,
  revokeUser,
} = require("./db");

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const AdmZip = require("adm-zip");
const express = require("express");
const inbox = require("./inbox");
const { replyMeta } = inbox;

// ==================== Konfigurasi ====================
const BOT_TOKEN = process.env.EMAIL_BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID, 10);

if (!BOT_TOKEN || !OWNER_ID) {
  console.error("❌ EMAIL_BOT_TOKEN dan OWNER_ID harus diatur di .env");
  process.exit(1);
}

const WEBHOOK_PORT = process.env.PORT || 3001;
const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").replace(/\/+$/, "");

const bot = new TelegramBot(BOT_TOKEN);
const app = express();

// ==================== HTML Viewer ====================
const HTML_CACHE_DIR = path.join(__dirname, "html_cache");
if (!fs.existsSync(HTML_CACHE_DIR)) fs.mkdirSync(HTML_CACHE_DIR, { recursive: true });

app.get("/html/:id", (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9-]/g, ""); // sanitasi
  const filePath = path.join(HTML_CACHE_DIR, `${id}.html`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("<h2>404 - Email tidak ditemukan atau sudah dihapus.</h2>");
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.sendFile(filePath);
});

app.listen(WEBHOOK_PORT, () => {
  console.log(`🌐 HTML viewer aktif di port ${WEBHOOK_PORT}`);
});

// Hapus webhook LAMA dulu lalu mulai polling
bot.deleteWebHook()
  .then(() => {
    bot.startPolling();
    console.log("✅ Bot mode: POLLING aktif (bukan webhook lagi)");
  })
  .catch((err) => console.error("❌ Gagal hapus webhook lama / mulai polling:", err.message));

const chatState = {};

// Inisialisasi DB Cache dan Inbox Auto-Start
(async () => {
  await initUserCache();
  inbox.init(bot);
  await inbox.loadAllAndStart();
})();

const BACK_BUTTON = { text: "⬅️", callback_data: "back_to_menu" };

// ==================== Helper: Sender Picker ====================
function buildPickSendersMessage(allSenders, selectedIdxs) {
  const senderRows = allSenders.map((s, i) => {
    const checked = selectedIdxs.includes(i) ? "✅" : "⬜";
    const label = s.email.length > 28 ? s.email.slice(0, 25) + "…" : s.email;
    return [{ text: `${checked} ${label}`, callback_data: `toggle_sender_${i}` }];
  });

  const allSelected = selectedIdxs.length === allSenders.length;
  senderRows.push([
    { text: allSelected ? "✅ Semua Dipilih" : "☑️ Pilih Semua", callback_data: "toggle_all_senders" },
  ]);
  senderRows.push([
    { text: `📨 Lanjut (${selectedIdxs.length} dipilih)`, callback_data: "confirm_senders" },
  ]);
  senderRows.push([BACK_BUTTON]);

  const text =
    `📤 *Pilih Email Pengirim*\n\nCentang pengirim yang ingin digunakan:\n` +
    `_(${selectedIdxs.length} dari ${allSenders.length} dipilih)_`;

  return [text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: senderRows } }];
}

// ==================== Helper: Receiver Picker ====================
function buildPickReceiversMessage(allReceivers, selectedIdxs) {
  const receiverRows = allReceivers.map((email, i) => {
    const checked = selectedIdxs.includes(i) ? "✅" : "⬜";
    const label = email.length > 28 ? email.slice(0, 25) + "…" : email;
    return [{ text: `${checked} ${label}`, callback_data: `toggle_receiver_${i}` }];
  });

  const allSelected = selectedIdxs.length === allReceivers.length;
  receiverRows.push([
    { text: allSelected ? "✅ Semua Dipilih" : "☑️ Pilih Semua", callback_data: "toggle_all_receivers" },
  ]);
  receiverRows.push([
    { text: `📩 Lanjut (${selectedIdxs.length} dipilih)`, callback_data: "confirm_receivers" },
  ]);
  senderRows = receiverRows; // alias
  receiverRows.push([BACK_BUTTON]);

  const text =
    `📥 *Pilih Email Penerima*\n\nCentang penerima yang ingin dikirimi:\n` +
    `_(${selectedIdxs.length} dari ${allReceivers.length} dipilih)_`;

  return [text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: receiverRows } }];
}

const MAX_SEND_COUNT = 500; // batas maksimal jumlah kirim per sesi

// ==================== Utility ====================
function safeEdit(chatId, messageId, text, extra = {}) {
  return bot
    .editMessageText(text, { chat_id: chatId, message_id: messageId, ...extra })
    .catch((err) => {
      if (err.code === 400) return;
      console.error("Gagal edit pesan:", err.message);
    });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ==================== Menu Utama ====================
function showMainMenu(chatId, messageId = null) {
  const text = "📧 *Pilih menu di bawah:*";
  const keyboard = {
    inline_keyboard: [
      [
        { text: "➕ pengirim", callback_data: "add_sender" },
        { text: "➕ penerima", callback_data: "add_receiver" },
      ],
      [
        { text: "➖ pengirim", callback_data: "delete_sender" },
        { text: "➖ penerima", callback_data: "delete_receiver" },
      ],
      [{ text: "📋 List Pengirim & Penerima", callback_data: "list_all" }],
      [{ text: "📨 Send Email", callback_data: "send_email" }],
      [{ text: "📬 Inbox (Email Masuk)", callback_data: "inbox_menu" }],
    ],
  };

  if (messageId) {
    safeEdit(chatId, messageId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  } else {
    bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  }
}

// ==================== /start ====================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (userId === OWNER_ID || isApproved(userId)) {
    return showMainMenu(chatId);
  }

  if (isPending(userId)) {
    return bot.sendMessage(chatId, "⏳ Permintaanmu sudah dikirim ke owner. Mohon tunggu persetujuan.");
  }

  const name = `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim() || "Tidak ada nama";
  const username = msg.from.username || "Tidak ada";

  await requestAccess(userId, { name, username });
  bot.sendMessage(
    chatId,
    "❌ Maaf, kamu belum memiliki izin menggunakan bot ini.\n\n" +
      "Permintaan akses sudah dikirim ke owner. Mohon tunggu persetujuan."
  );

  bot.sendMessage(
    OWNER_ID,
    `📩 *Permintaan Akses Baru*\n\n` +
      `User ID: \`${userId}\`\n` +
      `Nama: ${name}\n` +
      `Username: @${username}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve_${userId}` },
            { text: "❌ Reject", callback_data: `reject_${userId}` },
          ],
        ],
      },
    }
  );
});

// ==================== Command Owner ====================
bot.onText(/\/listusers/, (msg) => {
  if (msg.from.id !== OWNER_ID) return;

  const users = readUsers();
  let text = `📋 *Daftar User*\n\n`;

  text += `*✅ Approved (${users.approved.length}):*\n`;
  if (users.approved.length) {
    users.approved.forEach((id, i) => {
      text += `${i + 1}. \`${id}\`\n`;
    });
  } else {
    text += "_Tidak ada_\n";
  }

  text += `\n*⏳ Pending (${users.pending.length}):*\n`;
  if (users.pending.length) {
    users.pending.forEach((id, i) => {
      text += `${i + 1}. \`${id}\`\n`;
    });
  } else {
    text += "_Tidak ada_\n";
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/revoke (.+)/, async (msg, match) => {
  if (msg.from.id !== OWNER_ID) return;

  const targetId = parseInt(match[1].trim(), 10);
  if (isNaN(targetId)) {
    return bot.sendMessage(msg.chat.id, "❌ ID tidak valid.");
  }

  const users = readUsers();
  if (!users.approved.includes(targetId)) {
    return bot.sendMessage(msg.chat.id, `❌ User \`${targetId}\` tidak ditemukan di daftar approved.`, {
      parse_mode: "Markdown",
    });
  }

  await revokeUser(targetId);
  bot.sendMessage(msg.chat.id, `✅ Akses user \`${targetId}\` telah dicabut.`, { parse_mode: "Markdown" });
  bot.sendMessage(targetId, "❌ Akses kamu ke bot telah dicabut oleh owner.").catch(() => {});
});

bot.onText(/\/approve (.+)/, async (msg, match) => {
  if (msg.from.id !== OWNER_ID) return;

  const targetId = parseInt(match[1].trim(), 10);
  if (isNaN(targetId)) {
    return bot.sendMessage(msg.chat.id, "❌ ID tidak valid.");
  }

  const users = readUsers();
  if (users.approved.includes(targetId)) {
    return bot.sendMessage(msg.chat.id, `⚠️ User \`${targetId}\` sudah di-approve sebelumnya.`, {
      parse_mode: "Markdown",
    });
  }

  await approveUser(targetId);
  bot.sendMessage(msg.chat.id, `✅ User \`${targetId}\` berhasil di-approve secara manual.`, {
    parse_mode: "Markdown",
  });
  bot.sendMessage(targetId, "✅ Kamu telah di-approve oleh owner! Silakan gunakan bot dengan /start ulang.").catch(() => {});
});

// ==================== /backup ====================
bot.onText(/\/backup/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (userId !== OWNER_ID && !isApproved(userId)) return;

  const emailData = await readEmailData(userId);
  const imapConfig = await inbox.getImapConfig(userId);

  const hasData =
    (emailData.senders && emailData.senders.length > 0) ||
    (emailData.receivers && emailData.receivers.length > 0) ||
    (emailData.brevoAccounts && emailData.brevoAccounts.length > 0) ||
    !!imapConfig;

  if (!hasData) {
    return bot.sendMessage(chatId, "⚠️ Belum ada data yang tersimpan untuk akun kamu.");
  }

  const tmpDir = path.join(__dirname, "tmp_backup");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, `backup_${userId}_${Date.now()}.zip`);

  const statusMsg = await bot.sendMessage(chatId, "⏳ Sedang membuat file backup...");

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", resolve);
      archive.on("error", reject);

      archive.pipe(output);
      archive.append(JSON.stringify(emailData, null, 2), { name: "email.json" });
      if (imapConfig) {
        archive.append(JSON.stringify(imapConfig, null, 2), { name: "imap_config.json" });
      }
      archive.finalize();
    });

    await bot.sendDocument(
      chatId,
      zipPath,
      {
        caption:
          "✅ Backup berhasil dibuat (sender, receiver, config IMAP).\n\n" +
          "Kirim ulang file ini kapan saja untuk *restore* data kamu.\n" +
          "⚠️ Restore akan *menimpa total* data yang ada saat itu, bukan menggabungkan.",
      },
      { filename: `backup_${userId}.zip`, contentType: "application/zip" }
    );
  } catch (err) {
    console.error("❌ Gagal membuat backup:", err.message);
    bot.sendMessage(chatId, `❌ Gagal membuat backup: ${err.message}`);
  } finally {
    fs.unlink(zipPath, () => {});
    bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
  }
});

// ==================== Callback Query ====================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const userId = query.from.id;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ---------- Owner: Approve / Reject ----------
  if (userId === OWNER_ID) {
    if (data.startsWith("approve_")) {
      const targetId = parseInt(data.split("_")[1], 10);
      if (!isNaN(targetId)) {
        await approveUser(targetId);
        safeEdit(chatId, messageId, `✅ User \`${targetId}\` telah di-approve.`, { parse_mode: "Markdown" });
        bot.sendMessage(targetId, "✅ Permintaanmu telah disetujui! Silakan gunakan bot dengan /start ulang.").catch(() => {});
      }
      return;
    }

    if (data.startsWith("reject_")) {
      const targetId = parseInt(data.split("_")[1], 10);
      if (!isNaN(targetId)) {
        await rejectUser(targetId);
        safeEdit(chatId, messageId, `❌ User \`${targetId}\` telah ditolak.`, { parse_mode: "Markdown" });
        bot.sendMessage(targetId, "❌ Permintaanmu ditolak oleh owner.").catch(() => {});
      }
      return;
    }
  }

  // ---------- Cek akses ----------
  if (userId !== OWNER_ID && !isApproved(userId)) {
    return bot.answerCallbackQuery(query.id, {
      text: "❌ Kamu belum memiliki izin.",
      show_alert: true,
    });
  }

  // ---------- Back to menu ----------
  if (data === "back_to_menu") {
    delete chatState[chatId];
    return showMainMenu(chatId, messageId);
  }

  // ---------- Fitur ----------
  const currentUserId = userId === OWNER_ID ? OWNER_ID : userId;

  // Tambah pengirim
  if (data === "add_sender") {
    chatState[chatId] = { flow: "email", step: "add_sender_type", userId: currentUserId };
    return safeEdit(chatId, messageId, "Pilih *tipe pengirim*:", {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📧 Gmail SMTP", callback_data: "sender_type_gmail" },
            { text: "📨 Brevo SMTP", callback_data: "sender_type_brevo" },
          ],
          [BACK_BUTTON],
        ],
      },
    });
  }

  if (data === "sender_type_gmail") {
    const state = chatState[chatId];
    if (!state || state.step !== "add_sender_type") return;
    state.senderType = "gmail";
    state.step = "add_sender_email";
    return safeEdit(chatId, messageId, "Masukkan *email Gmail* pengirim:", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  if (data === "sender_type_brevo") {
    const state = chatState[chatId];
    if (!state || state.step !== "add_sender_type") return;
    state.senderType = "brevo";

    // Cek apakah sudah ada akun Brevo tersimpan
    const emailData = await readEmailData(currentUserId);
    const brevoAccounts = emailData.brevoAccounts || [];

    if (brevoAccounts.length > 0) {
      const accountButtons = brevoAccounts.map((acc, i) => [
        { text: `📨 ${acc.brevoEmail} (${acc.fromEmails.length} from)`, callback_data: `brevo_pick_acc_${i}` },
      ]);
      accountButtons.push([{ text: "➕ Tambah akun Brevo baru", callback_data: "brevo_new_acc" }]);
      accountButtons.push([BACK_BUTTON]);
      state.step = "brevo_pick_or_new";
      return safeEdit(chatId, messageId, "Pilih *akun Brevo* yang mau dipakai, atau tambah baru:", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: accountButtons },
      });
    }

    state.step = "add_sender_brevo_email";
    return safeEdit(chatId, messageId, "Masukkan *email akun Brevo* kamu (untuk login SMTP):", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // Pilih akun Brevo existing
  if (data.startsWith("brevo_pick_acc_")) {
    const state = chatState[chatId];
    if (!state) return;
    const idx = parseInt(data.split("_")[3], 10);
    const emailData = await readEmailData(currentUserId);
    const acc = (emailData.brevoAccounts || [])[idx];
    if (!acc) return safeEdit(chatId, messageId, "❌ Akun tidak ditemukan.", { reply_markup: { inline_keyboard: [[BACK_BUTTON]] } });
    state.brevoEmail = acc.brevoEmail;
    state.step = "add_sender_brevo_from";
    return safeEdit(
      chatId,
      messageId,
      `Akun: \`${acc.brevoEmail}\`\n\nMasukkan *email pengirim (from)* yang sudah diverifikasi di Brevo:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
    );
  }

  // Tambah akun Brevo baru
  if (data === "brevo_new_acc") {
    const state = chatState[chatId];
    if (!state) return;
    state.step = "add_sender_brevo_email";
    return safeEdit(chatId, messageId, "Masukkan *email akun Brevo* kamu (untuk login SMTP):", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // Tambah penerima
  if (data === "add_receiver") {
    chatState[chatId] = { flow: "email", step: "add_receiver", userId: currentUserId };
    return safeEdit(chatId, messageId, "Kirim *email penerima*:", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // Hapus pengirim
  if (data === "delete_sender") {
    const emailData = await readEmailData(currentUserId);
    if (!emailData.senders.length) {
      return safeEdit(chatId, messageId, "Tidak ada pengirim untuk dihapus.", {
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    const inline_keyboard = emailData.senders.map((s, i) => [
      { text: `🗑️ ${s.email}`, callback_data: `del_sender_${i}` },
    ]);
    inline_keyboard.push([BACK_BUTTON]);

    return safeEdit(chatId, messageId, "Pilih pengirim yang ingin dihapus:", {
      reply_markup: { inline_keyboard },
    });
  }

  if (data.startsWith("del_sender_")) {
    const index = parseInt(data.split("_")[2], 10);
    const emailData = await readEmailData(currentUserId);
    if (!isNaN(index) && emailData.senders[index]) {
      const deleted = emailData.senders[index].email;
      emailData.senders.splice(index, 1);
      await saveEmailData(currentUserId, emailData);
      return safeEdit(
        chatId,
        messageId,
        `✅ Pengirim \`${deleted}\` berhasil dihapus.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
      );
    }
    return safeEdit(chatId, messageId, "❌ Gagal menghapus pengirim.", {
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // Hapus penerima
  if (data === "delete_receiver") {
    const emailData = await readEmailData(currentUserId);
    if (!emailData.receivers.length) {
      return safeEdit(chatId, messageId, "Tidak ada penerima untuk dihapus.", {
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    const inline_keyboard = emailData.receivers.map((email, i) => [
      { text: `🗑️ ${email}`, callback_data: `del_receiver_${i}` },
    ]);
    inline_keyboard.push([BACK_BUTTON]);

    return safeEdit(chatId, messageId, "Pilih penerima yang ingin dihapus:", {
      reply_markup: { inline_keyboard },
    });
  }

  if (data.startsWith("del_receiver_")) {
    const index = parseInt(data.split("_")[2], 10);
    const emailData = await readEmailData(currentUserId);
    if (!isNaN(index) && emailData.receivers[index]) {
      const deleted = emailData.receivers[index];
      emailData.receivers.splice(index, 1);
      await saveEmailData(currentUserId, emailData);
      return safeEdit(
        chatId,
        messageId,
        `✅ Penerima \`${deleted}\` berhasil dihapus.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
      );
    }
    return safeEdit(chatId, messageId, "❌ Gagal menghapus penerima.", {
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // List semua
  if (data === "list_all") {
    const emailData = await readEmailData(currentUserId);
    let text = "📋 *Daftar Pengirim & Penerima*\n\n";

    // Gmail senders
    text += "*📧 Gmail:*\n";
    const gmailSenders = emailData.senders.filter((s) => s.type === "gmail");
    if (gmailSenders.length) {
      gmailSenders.forEach((s, i) => {
        text += `${i + 1}. \`${s.email}\`\n`;
      });
    } else {
      text += "_Belum ada_\n";
    }

    // Brevo accounts
    text += "\n*📨 Brevo:*\n";
    const brevoAccounts = emailData.brevoAccounts || [];
    if (brevoAccounts.length) {
      brevoAccounts.forEach((acc) => {
        text += `• Login: \`${acc.brevoEmail}\`\n`;
        if (acc.fromEmails.length) {
          acc.fromEmails.forEach((f, j) => {
            text += `  ${j + 1}. \`${f}\`\n`;
          });
        } else {
          text += "  _Belum ada from email_\n";
        }
      });
    } else {
      text += "_Belum ada_\n";
    }

    text += "\n*Penerima:*\n";
    if (emailData.receivers.length) {
      emailData.receivers.forEach((email, i) => {
        text += `${i + 1}. \`${email}\`\n`;
      });
    } else {
      text += "_Belum ada_\n";
    }

    return safeEdit(chatId, messageId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // ========== Inbox Menu ==========
  if (data === "inbox_menu") {
    const cfg = await inbox.getImapConfig(currentUserId);
    const active = inbox.isActive(currentUserId);
    const status = active ? "🟢 Aktif" : "🔴 Mati";
    const cfgInfo = cfg ? `\nAkun: \`${cfg.user}\`` : "\n_Belum dikonfigurasi_";
    return safeEdit(
      chatId,
      messageId,
      `📬 *Inbox Email Masuk*\n\nStatus: ${status}${cfgInfo}\n\nEmail masuk akan diteruskan ke sini. Balas pesan notifikasinya untuk membalas email langsung dari Telegram.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚙️ Setup IMAP", callback_data: "inbox_setup" }],
            [
              active
                ? { text: "🔌 Disconnect", callback_data: "inbox_stop" }
                : { text: "🔌 Connect", callback_data: "inbox_start" },
            ],
            [BACK_BUTTON],
          ],
        },
      }
    );
  }

  if (data === "inbox_setup") {
    chatState[chatId] = { flow: "inbox", step: "imap_host", userId: currentUserId };
    return safeEdit(
      chatId,
      messageId,
      "⚙️ *Setup IMAP*\n\nMasukkan *IMAP host*:\n_Contoh Gmail: imap.gmail.com_\n_Contoh Outlook: outlook.office365.com_",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
    );
  }

  if (data === "inbox_start") {
    const currentCfg = await inbox.getImapConfig(currentUserId);
    if (!currentCfg) {
      return safeEdit(chatId, messageId, "❌ Belum ada konfigurasi IMAP. Setup dulu.", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚙️ Setup IMAP", callback_data: "inbox_setup" }],
            [BACK_BUTTON],
          ],
        },
      });
    }
    inbox.startPolling(currentUserId);
    return safeEdit(
      chatId,
      messageId,
      "✅ Inbox *connect*. Email masuk akan diteruskan ke sini.",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
    );
  }

  if (data === "inbox_stop") {
    inbox.stopPolling(currentUserId);
    return safeEdit(chatId, messageId, "⏹ Inbox *disconnect*.", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // Send email — step 1: pilih pengirim
  if (data === "send_email") {
    const emailData = await readEmailData(currentUserId);
    const allSenders = await getAllSenders(currentUserId);
    if (!allSenders.length || !emailData.receivers.length) {
      return safeEdit(chatId, messageId, "❌ Harus ada minimal 1 pengirim dan 1 penerima.", {
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }
    chatState[chatId] = {
      flow: "email",
      step: "pick_senders",
      userId: currentUserId,
      selectedSenders: allSenders.map((_, i) => i),
    };
    return safeEdit(chatId, messageId, ...buildPickSendersMessage(allSenders, allSenders.map((_, i) => i)));
  }

  // Toggle pilihan pengirim
  if (data.startsWith("toggle_sender_")) {
    const state = chatState[chatId];
    if (!state || state.step !== "pick_senders") return;
    const idx = parseInt(data.split("_")[2], 10);
    const allSenders = await getAllSenders(state.userId);
    const sel = state.selectedSenders;
    if (sel.includes(idx)) {
      state.selectedSenders = sel.filter((i) => i !== idx);
    } else {
      state.selectedSenders = [...sel, idx].sort((a, b) => a - b);
    }
    return safeEdit(chatId, messageId, ...buildPickSendersMessage(allSenders, state.selectedSenders));
  }

  // Toggle semua pengirim
  if (data === "toggle_all_senders") {
    const state = chatState[chatId];
    if (!state || state.step !== "pick_senders") return;
    const allSenders = await getAllSenders(state.userId);
    if (state.selectedSenders.length === allSenders.length) {
      state.selectedSenders = [];
    } else {
      state.selectedSenders = allSenders.map((_, i) => i);
    }
    return safeEdit(chatId, messageId, ...buildPickSendersMessage(allSenders, state.selectedSenders));
  }

  // Konfirmasi pilihan pengirim → lanjut ke pick_receivers
  if (data === "confirm_senders") {
    const state = chatState[chatId];
    if (!state || state.step !== "pick_senders") return;
    if (!state.selectedSenders.length) {
      return bot.answerCallbackQuery(query.id, { text: "⚠️ Pilih minimal 1 pengirim!", show_alert: true });
    }
    const emailData = await readEmailData(state.userId);
    const allReceivers = emailData.receivers;
    state.step = "pick_receivers";
    state.selectedReceivers = allReceivers.map((_, i) => i);
    return safeEdit(chatId, messageId, ...buildPickReceiversMessage(allReceivers, state.selectedReceivers));
  }

  // Toggle pilihan penerima
  if (data.startsWith("toggle_receiver_")) {
    const state = chatState[chatId];
    if (!state || state.step !== "pick_receivers") return;
    const idx = parseInt(data.split("_")[2], 10);
    const emailData = await readEmailData(state.userId);
    const allReceivers = emailData.receivers;
    const sel = state.selectedReceivers;
    if (sel.includes(idx)) {
      state.selectedReceivers = sel.filter((i) => i !== idx);
    } else {
      state.selectedReceivers = [...sel, idx].sort((a, b) => a - b);
    }
    return safeEdit(chatId, messageId, ...buildPickReceiversMessage(allReceivers, state.selectedReceivers));
  }

  // Toggle semua penerima
  if (data === "toggle_all_receivers") {
    const state = chatState[chatId];
    if (!state || state.step !== "pick_receivers") return;
    const emailData = await readEmailData(state.userId);
    const allReceivers = emailData.receivers;
    if (state.selectedReceivers.length === allReceivers.length) {
      state.selectedReceivers = [];
    } else {
      state.selectedReceivers = allReceivers.map((_, i) => i);
    }
    return safeEdit(chatId, messageId, ...buildPickReceiversMessage(allReceivers, state.selectedReceivers));
  }

  // Konfirmasi pilihan penerima → lanjut ke subjek
  if (data === "confirm_receivers") {
    const state = chatState[chatId];
    if (!state || state.step !== "pick_receivers") return;
    if (!state.selectedReceivers.length) {
      return bot.answerCallbackQuery(query.id, { text: "⚠️ Pilih minimal 1 penerima!", show_alert: true });
    }
    state.step = "send_subject";
    return safeEdit(chatId, messageId, "Masukkan *Subjek / Judul* email:", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }
});

// ==================== Message Handler ====================
bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (msg.text && msg.text.startsWith("/")) return;

  // ========== Restore dari file backup .zip ==========
  if (msg.document && msg.document.file_name && msg.document.file_name.toLowerCase().endsWith(".zip")) {
    if (userId !== OWNER_ID && !isApproved(userId)) return;

    const statusMsg = await bot.sendMessage(chatId, "⏳ Sedang memproses restore...");
    const tmpDir = path.join(__dirname, "tmp_backup");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const downloadPath = path.join(tmpDir, `restore_${userId}_${Date.now()}.zip`);

    try {
      const fileLink = await bot.getFileLink(msg.document.file_id);
      const res = await fetch(fileLink);
      if (!res.ok) throw new Error("Gagal mengunduh file dari Telegram.");
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(downloadPath, buffer);

      const zip = new AdmZip(downloadPath);
      const entries = zip.getEntries();

      // Cari email.json
      const emailEntry = entries.find((e) => e.entryName === "email.json" || e.entryName.endsWith("/email.json"));
      if (!emailEntry) {
        throw new Error("File ini bukan backup yang valid (email.json tidak ditemukan).");
      }

      const emailJsonData = JSON.parse(emailEntry.getData().toString("utf8"));
      await saveEmailData(userId, emailJsonData);

      // Cari imap_config.json
      const imapEntry = entries.find(
        (e) => e.entryName === "imap_config.json" || e.entryName.endsWith("/imap_config.json")
      );
      if (imapEntry) {
        const imapCfg = JSON.parse(imapEntry.getData().toString("utf8"));
        inbox.stopPolling(userId);
        await inbox.setImapConfig(userId, imapCfg);
        inbox.startPolling(userId);
      }

      await bot.editMessageText(
        "✅ Restore berhasil! Data kamu sudah dipulihkan ke Onlyx DB dan inbox langsung aktif kembali.\n\n" +
          "⚠️ Catatan: restore ini *menimpa* data lama secara penuh, bukan menggabungkan.",
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("❌ Gagal restore:", err.message);
      await bot.editMessageText(`❌ Gagal restore: ${err.message}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
    } finally {
      fs.unlink(downloadPath, () => {});
    }
    return;
  }

  // ========== Reply ke email masuk ==========
  if (
    msg.reply_to_message &&
    msg.reply_to_message.text &&
    msg.reply_to_message.text.startsWith("↩️ Balas pesan ini untuk membalas email ke")
  ) {
    const repliedMsgId = msg.reply_to_message.message_id;

    const meta = replyMeta.get(repliedMsgId);
    let toEmail, replySubject, replyMsgId;

    if (meta) {
      toEmail = meta.to;
      replySubject = meta.subject ? (meta.subject.startsWith("Re:") ? meta.subject : `Re: ${meta.subject}`) : "Re:";
      replyMsgId = meta.msgId || null;
      replyMeta.delete(repliedMsgId);
    } else {
      const match = msg.reply_to_message.text.match(/ke\s+([^\s@]+@[^\s@]+\.[^\s]+)/);
      if (!match) return bot.sendMessage(chatId, "❌ Tidak bisa membaca alamat email tujuan dari pesan itu.");
      toEmail = match[1];
      replySubject = "Re:";
      replyMsgId = null;
    }

    const replyBody = msg.text.trim();

    const allSenders = await getAllSenders(userId);
    if (!allSenders.length) {
      return bot.sendMessage(chatId, "❌ Belum ada pengirim terdaftar. Tambahkan dulu via menu.");
    }
    const sender = allSenders.find((s) => s.type === "brevo") || allSenders[0];

    try {
      await sendEmail(sender, toEmail, replySubject, replyBody, replyMsgId);
      return bot.sendMessage(chatId, `✅ Balasan terkirim ke \`${toEmail}\``, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("❌ Gagal kirim balasan:", err.message);
      return bot.sendMessage(chatId, `❌ Gagal kirim: ${err.message}`);
    }
  }

  const state = chatState[chatId];
  if (!state) return;

  if (userId !== OWNER_ID && !isApproved(userId)) {
    delete chatState[chatId];
    return;
  }

  const text = msg.text ? msg.text.trim() : "";

  try {
    // ---------- Add Pengirim ----------
    if (state.step === "add_sender_email") {
      if (!isValidEmail(text)) {
        return bot.sendMessage(chatId, "❌ Format email tidak valid. Masukkan email yang benar (contoh: user@gmail.com).");
      }
      state.senderEmail = text;
      state.step = "add_sender_password";
      return bot.sendMessage(chatId, "Masukkan *App Password* Gmail (16 digit):", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    if (state.step === "add_sender_password") {
      if (text.length < 8) {
        return bot.sendMessage(chatId, "❌ Password terlalu pendek (minimal 8 karakter).");
      }
      const success = await addGmailSender(state.userId, state.senderEmail, text);
      delete chatState[chatId];
      return bot.sendMessage(chatId, success ? "✅ Pengirim Gmail berhasil ditambahkan." : "⚠️ Email sudah terdaftar.");
    }

    if (state.step === "add_sender_brevo_email") {
      if (!isValidEmail(text)) {
        return bot.sendMessage(chatId, "❌ Format email tidak valid.");
      }
      state.brevoEmail = text;
      state.step = "add_sender_brevo_apikey";
      return bot.sendMessage(chatId, "Masukkan *SMTP API Key* Brevo kamu:\n\n_(Brevo → SMTP & API → SMTP → Generate a new SMTP key)_", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    if (state.step === "add_sender_brevo_apikey") {
      if (text.length < 8) {
        return bot.sendMessage(chatId, "❌ API Key terlalu pendek.");
      }
      state.apiKey = text;
      await addBrevoAccount(state.userId, state.brevoEmail, state.apiKey);
      state.step = "add_sender_brevo_from";
      return bot.sendMessage(chatId, "Akun Brevo disimpan! ✅\n\nSekarang masukkan *email pengirim (from)* yang sudah diverifikasi di Brevo:", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    if (state.step === "add_sender_brevo_from") {
      if (!isValidEmail(text)) {
        return bot.sendMessage(chatId, "❌ Format email tidak valid.");
      }
      const result = await addBrevoFromEmail(state.userId, state.brevoEmail, text);
      delete chatState[chatId];
      if (result === "ok") return bot.sendMessage(chatId, `✅ Email pengirim \`${text}\` berhasil ditambahkan ke akun Brevo.`, { parse_mode: "Markdown" });
      if (result === "duplicate") return bot.sendMessage(chatId, "⚠️ Email pengirim sudah terdaftar di akun ini.");
      return bot.sendMessage(chatId, "❌ Akun Brevo tidak ditemukan.");
    }

    // ---------- Add Penerima ----------
    if (state.step === "add_receiver") {
      if (!isValidEmail(text)) {
        return bot.sendMessage(chatId, "❌ Format email tidak valid.");
      }
      const success = await addReceiver(state.userId, text);
      delete chatState[chatId];
      return bot.sendMessage(chatId, success ? "✅ Penerima berhasil ditambahkan." : "⚠️ Email sudah terdaftar.");
    }

    // ---------- Send Email ----------
    if (state.step === "send_subject") {
      state.subject = text;
      state.step = "send_body";
      return bot.sendMessage(chatId, "Masukkan *Isi Pesan* email:", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    if (state.step === "send_body") {
      state.body = text;
      state.step = "send_count";
      return bot.sendMessage(chatId, "Masukkan *Jumlah kirim per pengirim* (contoh: 3, maks 500):", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    // ========== Setup IMAP ==========
    if (state.flow === "inbox") {
      if (state.step === "imap_host") {
        state.imapHost = text;
        state.step = "imap_user";
        return bot.sendMessage(chatId, "Masukkan *email akun IMAP* (email yang diteruskan Cloudflare):", {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
        });
      }

      if (state.step === "imap_user") {
        if (!isValidEmail(text)) return bot.sendMessage(chatId, "❌ Format email tidak valid.");
        state.imapUser = text;
        state.step = "imap_password";
        return bot.sendMessage(chatId, "Masukkan *App Password* akun tersebut:", {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
        });
      }

      if (state.step === "imap_password") {
        if (text.length < 8) return bot.sendMessage(chatId, "❌ Password terlalu pendek.");
        const isGmail = state.imapHost.includes("gmail");
        const cfg = {
          host: state.imapHost,
          port: isGmail ? 993 : 993,
          tls: true,
          user: state.imapUser,
          password: text,
        };
        await inbox.setImapConfig(state.userId, cfg);
        inbox.startPolling(state.userId);
        delete chatState[chatId];
        return bot.sendMessage(
          chatId,
          `✅ IMAP dikonfigurasi ke Onlyx DB!\n\n📬 Polling aktif — email masuk ke \`${cfg.user}\` akan diteruskan ke sini.\n\nBalas pesan notifikasi email untuk membalas langsung.`,
          { parse_mode: "Markdown" }
        );
      }
    }

    if (state.step === "send_count") {
      const count = parseInt(text, 10);
      if (isNaN(count) || count < 1) {
        return bot.sendMessage(chatId, "❌ Jumlah harus angka minimal 1.");
      }
      if (count > MAX_SEND_COUNT) {
        return bot.sendMessage(chatId, `❌ Jumlah terlalu besar. Maksimal ${MAX_SEND_COUNT}.`);
      }

      const emailData = await readEmailData(state.userId);
      const allSenders = await getAllSenders(state.userId);

      const senders =
        state.selectedSenders && state.selectedSenders.length
          ? state.selectedSenders.map((i) => allSenders[i]).filter(Boolean)
          : allSenders;

      const allReceivers = emailData.receivers;
      const receivers =
        state.selectedReceivers && state.selectedReceivers.length
          ? state.selectedReceivers.map((i) => allReceivers[i]).filter(Boolean)
          : allReceivers;

      delete chatState[chatId];

      const totalEmails = senders.length * receivers.length * count;
      const statusMsg = await bot.sendMessage(chatId, `⏳ Memulai pengiriman...\n📊 Total: 0 / ${totalEmails}`);

      let success = 0,
        failed = 0;
      let lastEditTime = 0;

      for (const sender of senders) {
        for (const receiver of receivers) {
          for (let i = 0; i < count; i++) {
            try {
              await sendEmail(sender, receiver, state.subject, state.body);
              success++;
            } catch (err) {
              console.error(`Gagal kirim ke ${receiver}:`, err.message);
              failed++;
            }

            const now = Date.now();
            if (now - lastEditTime >= 3000) {
              lastEditTime = now;
              const done = success + failed;
              const pct = Math.round((done / totalEmails) * 100);
              const bar = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
              bot.editMessageText(
                `⏳ *Sedang mengirim...*\n\n${bar} ${pct}%\n✅ Berhasil: ${success}\n❌ Gagal: ${failed}\n📨 Total: ${done} / ${totalEmails}`,
                { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
              ).catch(() => {});
            }

            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }

      await bot.editMessageText(
        `✅ *Pengiriman Selesai!*\n\nBerhasil: ${success}\nGagal: ${failed}`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
      ).catch(() => {});
    }
  } catch (error) {
    console.error("Error di message handler:", error);
    delete chatState[chatId];
    bot.sendMessage(chatId, "❌ Terjadi kesalahan. Silakan coba lagi.").catch(() => {});
  }
});

console.log("✅ Bot Email aktif.");
