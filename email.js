const nodemailer = require("nodemailer");
const { getUserEmailData, saveUserEmailData } = require("./db");

async function readEmailData(userId) {
  return await getUserEmailData(userId);
}

async function saveEmailData(userId, data) {
  return await saveUserEmailData(userId, data);
}

// Tambah pengirim Gmail
async function addGmailSender(userId, email, appPassword) {
  const data = await readEmailData(userId);
  if (data.senders.find((s) => s.email === email)) return false;
  data.senders.push({ type: "gmail", email, appPassword });
  await saveEmailData(userId, data);
  return true;
}

// Tambah akun Brevo baru (brevoEmail + apiKey)
// Return: { created: true } jika akun baru, { created: false } jika sudah ada
async function addBrevoAccount(userId, brevoEmail, apiKey) {
  const data = await readEmailData(userId);
  const existing = data.brevoAccounts.find((a) => a.brevoEmail === brevoEmail);
  if (existing) {
    return { created: false, account: existing };
  }
  const account = { brevoEmail, apiKey, fromEmails: [] };
  data.brevoAccounts.push(account);
  await saveEmailData(userId, data);
  return { created: true, account };
}

// Tambah fromEmail ke akun Brevo yang sudah ada
async function addBrevoFromEmail(userId, brevoEmail, fromEmail) {
  const data = await readEmailData(userId);
  const account = data.brevoAccounts.find((a) => a.brevoEmail === brevoEmail);
  if (!account) return "no_account";
  if (account.fromEmails.includes(fromEmail)) return "duplicate";
  account.fromEmails.push(fromEmail);
  await saveEmailData(userId, data);
  return "ok";
}

async function addReceiver(userId, email) {
  const data = await readEmailData(userId);
  if (data.receivers.includes(email)) return false;
  data.receivers.push(email);
  await saveEmailData(userId, data);
  return true;
}

// Kembalikan semua "sender" dalam format flat untuk keperluan kirim & list
// Gmail: { type, email, appPassword }
// Brevo: { type, brevoEmail, apiKey, fromEmail } — 1 entry per fromEmail
async function getAllSenders(userId) {
  const data = await readEmailData(userId);
  const result = [];

  for (const s of data.senders) {
    result.push(s);
  }

  for (const acc of data.brevoAccounts) {
    for (const fromEmail of acc.fromEmails) {
      result.push({
        type: "brevo",
        brevoEmail: acc.brevoEmail,
        apiKey: acc.apiKey,
        fromEmail,
        email: fromEmail, // alias untuk display
      });
    }
  }

  return result;
}

async function sendEmail(sender, to, subject, text, inReplyToMsgId = null) {
  let transportConfig;

  if (sender.type === "brevo") {
    transportConfig = {
      host: "smtp-relay.brevo.com",
      port: 587,
      secure: false,
      auth: {
        user: sender.brevoEmail,
        pass: sender.apiKey,
      },
    };
  } else {
    transportConfig = {
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: sender.email,
        pass: sender.appPassword,
      },
    };
  }

  const transporter = nodemailer.createTransport(transportConfig);
  const fromAddress = sender.type === "brevo" ? sender.fromEmail : sender.email;

  const mailOptions = { from: fromAddress, to, subject, text };

  // Kalau ini balasan, tambah header reply supaya masuk thread yang sama
  if (inReplyToMsgId) {
    mailOptions["In-Reply-To"] = inReplyToMsgId;
    mailOptions["References"] = inReplyToMsgId;
  }

  return transporter.sendMail(mailOptions);
}

module.exports = {
  readEmailData,
  saveEmailData,
  addGmailSender,
  addBrevoAccount,
  addBrevoFromEmail,
  addReceiver,
  getAllSenders,
  sendEmail,
};
