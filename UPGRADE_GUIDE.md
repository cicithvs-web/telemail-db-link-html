# 📧 Email-Send-Main Upgrade Guide

## ✨ Fitur Baru yang Ditambahkan

Upgrade `TeleMail` dengan fitur HTML viewer dari `EmailSend7`:

### 1. **Express HTML Viewer Server**
   - Route viewer digabung ke server yang SAMA dengan webhook Telegram (satu port, dari env var `PORT`) — jadi nggak perlu buka port kedua di firewall/reverse-proxy
   - Email HTML disimpan ke folder `html_cache/`
   - Setiap email mendapat unique ID untuk akses via browser

### 2. **HTML Email Caching**
   - Saat email masuk, HTML body otomatis disimpan
   - Link clickable dikirim ke Telegram untuk membuka di browser
   - Format: `https://yourdomain.com/html/{unique-id}`

### 3. **Better Email Display**
   - User bisa melihat email dengan formatting original
   - Gambar dan styling terawat dengan baik
   - Preview quick + link ke full HTML view

---

## 📦 Perubahan File

### Berikut file yang di-update:

1. **index.js**
   - ✅ Tambah: `const express = require("express")`
   - ✅ Tambah: route `/html/:id`, digabung ke Express app yang sama dengan webhook Telegram (`app.post('/bot<token>', ...)` gantiin server internal bawaan `node-telegram-bot-api`)
   - ✅ Satu `app.listen()` — pakai `PORT` yang sudah ada, gak nambah port baru

2. **inbox.js**
   - ✅ Tambah: `HTML_CACHE_DIR` untuk simpan email HTML
   - ✅ Tambah: Generate unique ID dengan crypto.randomBytes
   - ✅ Update: `processMessage()` untuk simpan + kirim link HTML

3. **package.json**
   - ✅ Tambah: `"express": "^4.18.2"` ke dependencies

4. **.env.example** (file baru)
   - Template konfigurasi lengkap dengan semua env vars

---

## 🚀 Installation Steps

### Step 1: Backup struktur lama
```bash
# Backup jika ada yang penting
cp -r TeleMail TeleMail.backup
```

### Step 2: Replace file yang sudah di-upgrade
```bash
# Copy file baru ke folder project
cp index.js TeleMail/
cp inbox.js TeleMail/
cp package.json TeleMail/
```

### Step 3: Install dependencies baru
```bash
cd TeleMail
npm install
```

### Step 4: Setup .env
```bash
# Copy template
cp .env.example .env

# Edit .env dengan nilai Anda
nano .env
```

**Pastikan .env punya:**
```env
EMAIL_BOT_TOKEN=your_bot_token
OWNER_ID=your_telegram_id
PORT=3001
WEBHOOK_URL=https://yourdomain.com
```

Gak ada env var baru yang wajib ditambah — link HTML viewer numpang di `WEBHOOK_URL` & `PORT` yang sudah ada.

### Step 5: Start aplikasi
```bash
npm start
```

Seharusnya keluar logs seperti ini:
```
✅ Bot Email aktif.
🌐 Server aktif di port 3001 (webhook Telegram + HTML viewer)
📬 Auto-start IDLE inbox user [userId]
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `EMAIL_BOT_TOKEN` | - | Telegram bot token (required) |
| `OWNER_ID` | - | Telegram user ID (required) |
| `PORT` | 3001 | Port webhook Telegram — sekarang juga dipakai HTML viewer |
| `WEBHOOK_URL` | - | Public URL untuk webhook — sekarang juga dasar link HTML viewer |

### Production Setup (VPS/Cloud)

Cuma butuh **1 port** yang kebuka (sama seperti sebelum upgrade ini), gak ada port tambahan buat HTML viewer. Kalau sudah pakai reverse proxy (nginx) buat webhook Telegram, gak perlu nambah location block baru — route `/html/:id` otomatis ikut lewat proxy yang sama:

```nginx
location / {
    proxy_pass http://localhost:3001;
}
```

---

## 📊 Folder Structure

Setelah upgrade, struktur folder jadi:

```
TeleMail/
├── index.js          (✅ updated)
├── inbox.js          (✅ updated)
├── email.js
├── package.json      (✅ updated)
├── .env              (create from .env.example)
├── .env.example      (✅ new)
├── html_cache/       (✅ auto-created)
│   ├── abc123.html
│   ├── def456.html
│   └── ...
├── users/
│   └── [userId]/
│       └── imap_config.json
└── node_modules/
```

---

## 🔧 Troubleshooting

### Port sudah terpakai?
```bash
# Ganti port webhook+viewer di .env (lalu update juga webhook Telegram-nya)
PORT=8080
```

### Email HTML tidak muncul / link gak kebuka?
1. Cek folder `html_cache/` ada isinya atau tidak (artinya proses simpan HTML jalan)
2. Cek `WEBHOOK_URL` di `.env` sudah domain publik yang benar (bukan `localhost`)
3. Pastikan bot memang bisa nerima pesan Telegram seperti biasa — kalau webhook utama aja belum jalan, `/html/:id` juga otomatis belum bisa diakses karena satu server yang sama

### Express server tidak start?
```bash
# Debug mode
node index.js

# Lihat error di console
```

---

## ✅ Testing

Setelah install, kirim test email ke akun yang connected:

1. Email masuk → Telegram terima notifikasi
2. Format: Regular text + subject + time
3. **NEW**: Ada link "Lihat email HTML: [Buka di browser]"
4. Click link → Buka file HTML di browser

---

## 🎯 Main Logic Tetap Sama

**Jangan khawatir**, upgrade ini **TIDAK mengubah** logic utama:
- ✅ Telegram bot commands tetap sama
- ✅ Email sending logic tidak berubah
- ✅ IMAP inbox polling sama
- ✅ User session management intact
- ⚠️ Satu hal yang berubah "di belakang layar": server webhook Telegram sekarang dipegang oleh Express (bukan server internal bawaan `node-telegram-bot-api` lagi), supaya bisa gabung 1 port sama HTML viewer. Perilaku bot dari sisi user sama persis, gak ada command atau flow yang berubah.
- ✅ Selebihnya cuma **ADD** fitur viewer, tidak replace apapun

---

## 📞 Support

Kalau ada issue:
1. Cek logs di console saat run
2. Pastikan port di `PORT` (.env) available & memang itu yang di-expose ke publik
3. Cek internet connection untuk IMAP & Telegram API
4. Backup folder kalau perlu rollback ke versi lama

---

## 🗄️ Upgrade Database (Onlyx REST API Database)

Semua file JSON lokal (`users.json`, `users/<userId>/email.json`, `users/<userId>/imap_config.json`) telah dimigrasikan ke **Onlyx REST API Database**.

### Collection yang Digunakan:
1. `users`: Menyimpan hak akses bot Telegram (`id`, `status: "approved" | "pending"`, `name`, `username`).
2. `user_emails`: Menyimpan konfigurasi pengirim (Gmail/Brevo) dan penerima per user.
3. `imap_configs`: Menyimpan konfigurasi IMAP inbox (host, port, user, app password) per user.

### Konfigurasi `.env`:
```env
ONLYX_DB_URL=https://onlyx.top/v1/db/db_k5kp68k7gj3l
ONLYX_DB_KEY=onlyx_sk_B0rch1WYgLhofkjQrtqHVsln5lFgkKliZePWrM6a
```

---

**Happy emailing! 🚀**
