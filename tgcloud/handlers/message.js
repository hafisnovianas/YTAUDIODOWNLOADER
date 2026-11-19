import { api } from 'sdk';
import { db } from 'sdk';
import {
  extractVideoId,
  handleDownload,
  handleTestIP,
  handleStats,
  handleErrors,
  handleHistory,
  ADMIN_TG_ID,
} from '../lib/ytaudio.js';
import { errorLogs } from '../schema.js';

function parseCommandAndArgs(text) {
  if (typeof text !== 'string') return { cmd: null, arg: '' };
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { cmd: null, arg: '' };
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase().split('@')[0];
  const arg = parts.slice(1).join(' ').trim();
  return { cmd, arg };
}

async function sendSafe(params) {
  try {
    await api.sendMessage(params);
  } catch {
    // Ignore delivery failures
  }
}

async function reportError({ tgId, context, err }) {
  const errMessage = String(err?.message ?? err ?? 'Unknown').slice(0, 500);
  const stack = typeof err?.stack === 'string'
    ? err.stack.split('\n').slice(0, 6).join('\n').slice(0, 1500)
    : null;

  console.error(`[message] Error user=${tgId} ctx=${context}`, err);

  try {
    await db.insert(errorLogs).values({
      handler: 'message',
      tgId,
      context,
      message: errMessage,
      stack,
    });
  } catch {
    // Ignore logging failures
  }

  try {
    await sendSafe({
      chat_id: ADMIN_TG_ID,
      text: `🚨 Error\nUser: ${tgId}\nCtx: ${context}\n${errMessage}`,
    });
  } catch {
    // Ignore alert delivery failures
  }
}

export default async function (message) {
  if (!message || message.chat?.type !== 'private') return;
  if (message.from?.is_bot) return;

  const tgId = message.from?.id ?? message.chat.id;
  const text = message.text;
  const { cmd, arg } = parseCommandAndArgs(text);

  try {
    // ── Commands ──
    if (cmd === '/start') {
      await sendSafe({
        chat_id: tgId,
        text:
          '🎵 YT Audio Downloader\n\n' +
          'Kirimkan link YouTube, dan saya akan mengekstrak audionya untuk Anda.\n\n' +
          'Perintah:\n' +
          '/help — Bantuan & panduan penggunaan\n' +
          '/testip — Cek koneksi IP server ke YouTube\n\n' +
          'Perintah Khusus Admin:\n' +
          '/stats — Ringkasan jumlah unduhan\n' +
          '/errors [n] — Rincian error runtime terakhir (contoh: /errors 20)\n' +
          '/history [n] — Riwayat unduhan terakhir (contoh: /history 25)',
      });
      return;
    }

    if (cmd === '/help') {
      await sendSafe({
        chat_id: tgId,
        text:
          '📖 Cara Pakai\n\n' +
          '1. Salin link video YouTube\n' +
          '2. Kirim ke chat ini\n' +
          '3. Tunggu audio terkirim\n\n' +
          'Format link yang didukung:\n' +
          '• youtube.com/watch?v=...\n' +
          '• youtu.be/...\n' +
          '• youtube.com/shorts/...\n\n' +
          'Batasan:\n' +
          '• Maks ukuran audio: 50 MB\n' +
          '• Video musik resmi (VEVO) didukung via track AAC\n' +
          '• Konten DRM berbayar tidak bisa diunduh\n\n' +
          'Perintah Admin:\n' +
          '• /stats — Statistik agregat\n' +
          '• /errors [n] — Cek rincian error terakhir\n' +
          '• /history [n] — Cek riwayat unduhan terakhir',
      });
      return;
    }

    if (cmd === '/testip') {
      await handleTestIP(tgId);
      return;
    }

    if (cmd === '/stats') {
      await handleStats(tgId);
      return;
    }

    if (cmd === '/errors') {
      await handleErrors(tgId, arg);
      return;
    }

    if (cmd === '/history') {
      await handleHistory(tgId, arg);
      return;
    }

    // ── YouTube Link Detection ──
    if (typeof text === 'string') {
      const videoId = extractVideoId(text);
      if (videoId) {
        await handleDownload(tgId, videoId);
        return;
      }
    }

    // ── Pesan lain ──
    await sendSafe({
      chat_id: tgId,
      text: '🔗 Kirimkan link YouTube untuk mengunduh audionya.\nContoh: https://youtu.be/jNQXAC9IVRw',
    });

  } catch (err) {
    await reportError({ tgId, context: cmd || 'link', err });
    await sendSafe({
      chat_id: tgId,
      text: '⚠️ Terjadi gangguan teknis. Silakan coba lagi.',
    });
  }
}
