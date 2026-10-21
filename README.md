# 📧 TeleMail - Telegram Email Bot

Bot Telegram berbasis **Node.js** untuk mengirim email massal/personal dan menerima email masuk secara *real-time* via IMAP IDLE, terintegrasi dengan **Onlyx REST API Database** dan fitur **HTML Viewer**.

---

## ✨ Fitur Utama

- 📨 **Kirim Email Fleksibel**:
  - Dukungan **Gmail SMTP** (dengan App Password)
  - Dukungan **Brevo SMTP** (dengan API Key dan multi-from email)
  - Multi-select pengirim & penerima via inline keyboard
  - Progress bar pengiriman interaktif & anti rate-limit
- 📬 **Inbox Dua Arah (Real-Time IMAP IDLE)**:
  - Notifikasi instan saat email baru masuk
  - Parsing email otomatis (`mailparser`)
  - **Quick Reply**: Balas pesan notifikasi di Telegram untuk langsung membalas email ke pengirim asli (dilengkapi threading `In-Reply-To`)
- 📄 **HTML Viewer Server**:
  - Route `/html/:id` untuk menampilkan tampilan email HTML original lengkap di browser
- 🗄️ **Database Terpusat (Onlyx REST API)**:
  - Bebas dari ketergantungan file JSON lokal
  - Menggunakan collection `users`, `user_emails`, dan `imap_configs`
  - In-memory caching untuk akses cepat dan hemat kuota request
- 🛡️ **Otorisasi User**:
  - Sistem perizinan bertingkat (Owner & Approved users)
  - Notifikasi persetujuan (Approve/Reject) langsung ke Telegram Owner
- 💾 **Backup & Restore**:
  - Perintah `/backup` untuk mengekspor data akun ke file `.zip`
  - Kirim balik file `.zip` ke bot untuk restore data secara instan

---

## 🛠️ Instalasi & Setup

### 1. Clone Repository & Install Dependencies
```bash
git clone https://github.com/cicithvs-web/telemail-db-link-html.git
cd telemail-db-link-html
npm install
```

### 2. Konfigurasi Lingkungan (`.env`)
Salin file template `.env.example`:
```bash
cp .env.example .env
```

Sesuaikan nilai di dalam `.env`:
```env
# Telegram Bot
EMAIL_BOT_TOKEN=your_telegram_bot_token_here
OWNER_ID=your_telegram_user_id

# Webhook / HTML Viewer
PORT=3001
WEBHOOK_URL=https://yourdomain.com

# Onlyx Database REST API
ONLYX_DB_URL=https://onlyx.top/v1/db/your_database_id
ONLYX_DB_KEY=your_onlyx_api_key_here
```

### 3. Jalankan Aplikasi
```bash
npm start
```

---

## 📂 Struktur Project

```text
├── db.js             # Client Onlyx REST API Database & Cache
├── email.js          # Pengelola SMTP (Gmail & Brevo) via Nodemailer
├── inbox.js          # IMAP Client & IDLE Loop
├── index.js          # Entry point bot Telegram & Express HTML server
├── package.json      # Dependencies project
├── .env.example      # Template konfigurasi environment
├── UPGRADE_GUIDE.md  # Catatan upgrade & migrasi
└── README.md         # Dokumentasi project
```

---

## 📜 Lisensi
MIT License
