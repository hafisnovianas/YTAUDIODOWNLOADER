# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Inisialisasi awal proyek Telegram Serverless Bot (`@tgcloud/cli`) untuk YT Audio Downloader.
- Router pesan `tgcloud/handlers/message.js` untuk penanganan perintah `/start`, `/help`, `/testip`, `/stats`, dan pengenalan URL YouTube otomatis.
- Core downloader library `tgcloud/lib/ytaudio.js` dengan integrasi YouTube Innertube API, fallback multi-client (`WEB`, `ANDROID`, `IOS`), pemilihan stream audio kualitas tertinggi, dan pengiriman via `api.sendAudio`.
- Skema database SQLite `tgcloud/schema.js` mencakup tabel `downloads` dan `error_logs`.
- Konfigurasi `tgcloud.jsonc`, `package.json`, dan `.gitignore`.
- Dokumentasi referensi SDK `docs/tgcloud-sdk.md`.
