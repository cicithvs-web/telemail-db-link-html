const BASE = (process.env.ONLYX_DB_URL || "https://onlyx.top/v1/db/db_k5kp68k7gj3l").replace(/\/+$/, "");
const KEY = process.env.ONLYX_DB_KEY || "onlyx_sk_B0rch1WYgLhofkjQrtqHVsln5lFgkKliZePWrM6a";

/**
 * Helper dasar untuk request ke Onlyx REST API Database
 */
async function db(method, path, body = undefined) {
  const url = `${BASE}${path}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
  };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);

  if (!res.ok) {
    // Jika 404 pada operasi GET, anggap data belum ada
    if (res.status === 404 && method === "GET") {
      return null;
    }

    let errMsg = res.statusText;
    try {
      const errData = await res.json();
      errMsg = errData.error || errData.message || JSON.stringify(errData);
    } catch {}

    const err = new Error(`Onlyx DB Error [${res.status}] ${method} ${path}: ${errMsg}`);
    err.status = res.status;
    throw err;
  }

  const text = await res.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ==================== User Authorization & Cache ====================
const userCache = {
  approved: new Set(),
  pending: new Set(),
};

/**
 * Inisialisasi cache user dari Onlyx DB saat bot pertama kali menyala.
 */
async function initUserCache() {
  try {
    const res = await db("GET", "/users?limit=1000");
    userCache.approved.clear();
    userCache.pending.clear();

    if (res && Array.isArray(res.data)) {
      for (const u of res.data) {
        const uid = Number(u.id);
        if (u.status === "approved") {
          userCache.approved.add(uid);
        } else if (u.status === "pending") {
          userCache.pending.add(uid);
        }
      }
    }
    console.log(`👥 Cache user dimuat: ${userCache.approved.size} approved, ${userCache.pending.size} pending`);
  } catch (err) {
    console.error("❌ Gagal inisialisasi cache user dari Onlyx DB:", err.message);
  }
}

function readUsers() {
  return {
    approved: Array.from(userCache.approved),
    pending: Array.from(userCache.pending),
  };
}

function isApproved(userId) {
  return userCache.approved.has(Number(userId));
}

function isPending(userId) {
  return userCache.pending.has(Number(userId));
}

async function requestAccess(userId, userDetails = {}) {
  const uid = Number(userId);
  if (userCache.approved.has(uid) || userCache.pending.has(uid)) {
    return false;
  }

  userCache.pending.add(uid);
  try {
    await db("POST", "/users?upsert=true", {
      id: String(uid),
      status: "pending",
      ...userDetails,
      updated_at: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.error(`❌ Gagal request access user ${userId}:`, err.message);
    return false;
  }
}

async function approveUser(userId) {
  const uid = Number(userId);
  userCache.pending.delete(uid);
  userCache.approved.add(uid);

  try {
    await db("POST", "/users?upsert=true", {
      id: String(uid),
      status: "approved",
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`❌ Gagal approve user ${userId}:`, err.message);
  }
}

async function rejectUser(userId) {
  const uid = Number(userId);
  userCache.pending.delete(uid);

  try {
    await db("DELETE", `/users/${uid}`);
  } catch (err) {
    console.error(`❌ Gagal reject user ${userId}:`, err.message);
  }
}

async function revokeUser(userId) {
  const uid = Number(userId);
  userCache.approved.delete(uid);

  try {
    await db("DELETE", `/users/${uid}`);
  } catch (err) {
    console.error(`❌ Gagal revoke user ${userId}:`, err.message);
  }
}

// ==================== User Email Data ====================
const userEmailCache = new Map();

async function getUserEmailData(userId) {
  const uid = String(userId);
  if (userEmailCache.has(uid)) {
    return userEmailCache.get(uid);
  }

  let doc = await db("GET", `/user_emails/${uid}`);
  if (!doc) {
    doc = { id: uid, senders: [], brevoAccounts: [], receivers: [] };
  }

  if (!Array.isArray(doc.senders)) doc.senders = [];
  if (!Array.isArray(doc.brevoAccounts)) doc.brevoAccounts = [];
  if (!Array.isArray(doc.receivers)) doc.receivers = [];

  // Migrasi format sender lama jika type kosong
  doc.senders = doc.senders.map((s) => (s.type ? s : { ...s, type: "gmail" }));

  userEmailCache.set(uid, doc);
  return doc;
}

async function saveUserEmailData(userId, data) {
  const uid = String(userId);
  const payload = {
    id: uid,
    senders: data.senders || [],
    brevoAccounts: data.brevoAccounts || [],
    receivers: data.receivers || [],
    updated_at: new Date().toISOString(),
  };

  userEmailCache.set(uid, payload);
  await db("POST", "/user_emails?upsert=true", payload);
}

// ==================== IMAP Configs ====================
async function getImapConfig(userId) {
  const uid = String(userId);
  const doc = await db("GET", `/imap_configs/${uid}`);
  if (!doc) return null;
  return {
    host: doc.host,
    port: doc.port,
    tls: doc.tls,
    user: doc.user,
    password: doc.password,
  };
}

async function setImapConfig(userId, config) {
  const uid = String(userId);
  const payload = {
    id: uid,
    host: config.host,
    port: config.port,
    tls: config.tls,
    user: config.user,
    password: config.password,
    updated_at: new Date().toISOString(),
  };
  await db("POST", "/imap_configs?upsert=true", payload);
}

async function deleteImapConfig(userId) {
  const uid = String(userId);
  await db("DELETE", `/imap_configs/${uid}`);
}

async function getAllImapConfigs() {
  const res = await db("GET", "/imap_configs?limit=1000");
  if (!res || !Array.isArray(res.data)) return [];
  return res.data;
}

module.exports = {
  db,
  initUserCache,
  readUsers,
  isApproved,
  isPending,
  requestAccess,
  approveUser,
  rejectUser,
  revokeUser,
  getUserEmailData,
  saveUserEmailData,
  getImapConfig,
  setImapConfig,
  deleteImapConfig,
  getAllImapConfigs,
};
