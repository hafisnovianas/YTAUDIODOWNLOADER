import { api, fetch, InputFile } from 'sdk';
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { downloads } from '../schema.js';

export const ADMIN_TG_ID = 8738554818;
const MAX_AUDIO_BYTES = 48 * 1024 * 1024; // 48 MB safety margin (limit 50 MB)

// ─── YouTube Innertube API ───

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Client configs yang dicoba berurutan jika WEB diblokir
const CLIENT_CONFIGS = [
  { clientName: 'WEB', clientVersion: '2.20261101.00.00' },
  { clientName: 'ANDROID', clientVersion: '19.29.37', androidSdkVersion: 30 },
  { clientName: 'IOS', clientVersion: '19.29.1' },
];

/**
 * Ekstrak videoId dari berbagai format URL YouTube.
 * Return null jika bukan URL YouTube valid.
 */
export function extractVideoId(text) {
  if (typeof text !== 'string') return null;
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = text.trim().match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * Panggil YouTube Innertube Player API.
 * Coba beberapa client config jika yang pertama diblokir.
 */
async function fetchPlayerData(videoId) {
  for (const client of CLIENT_CONFIGS) {
    const payload = {
      videoId,
      context: {
        client: { ...client, hl: 'en', gl: 'US' },
      },
    };

    let res;
    try {
      res = await fetch(INNERTUBE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      continue;
    }

    if (!res.ok) continue;

    const data = await res.json();
    const status = data.playabilityStatus?.status;

    if (status === 'OK' && data.streamingData) {
      return { ok: true, data, clientUsed: client.clientName };
    }

    // LOGIN_REQUIRED → coba client berikutnya
    if (status === 'LOGIN_REQUIRED' || status === 'ERROR') continue;

    // Status lain (UNPLAYABLE, dsb) → langsung return error
    return {
      ok: false,
      reason: data.playabilityStatus?.reason || `Status: ${status}`,
    };
  }

  return {
    ok: false,
    reason: 'Semua client config ditolak YouTube. IP server kemungkinan diblokir.',
  };
}

/**
 * Pilih stream audio terbaik dari adaptiveFormats.
 * Prioritas: yang punya URL langsung, bitrate tertinggi.
 */
function pickBestAudio(adaptiveFormats) {
  const audioStreams = (adaptiveFormats || [])
    .filter(f => f.mimeType?.startsWith('audio/'));

  if (audioStreams.length === 0) return null;

  // Prioritaskan yang punya .url langsung (bukan signatureCipher)
  const directStreams = audioStreams.filter(f => f.url && !f.signatureCipher && !f.cipher);
  const pool = directStreams.length > 0 ? directStreams : audioStreams;

  // Sort by bitrate descending
  pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  const picked = pool[0];
  return {
    url: picked.url || null,
    cipher: picked.signatureCipher || picked.cipher || null,
    itag: picked.itag,
    mimeType: picked.mimeType,
    bitrate: picked.bitrate,
    contentLength: picked.contentLength ? Number(picked.contentLength) : null,
  };
}

/**
 * Unduh bytes audio dari URL googlevideo.com.
 */
async function downloadAudioBytes(audioUrl) {
  const res = await fetch(audioUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!res.ok) {
    throw new Error(`Download gagal: HTTP ${res.status} ${res.statusText}`);
  }

  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Tentukan ekstensi file berdasarkan mimeType.
 */
function audioExtension(mimeType) {
  if (!mimeType) return 'mp4';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'mp4';
}

// ─── Helper functions ───

async function editStatus(chatId, messageId, text) {
  try {
    await api.editMessageText({ chat_id: chatId, message_id: messageId, text });
  } catch {
    // Ignore edit failures
  }
}

async function deleteMessageSafe(chatId, messageId) {
  try {
    await api.deleteMessage({ chat_id: chatId, message_id: messageId });
  } catch {
    // Ignore delete failures
  }
}

async function logDownload(tgId, videoId, title, itag, size, status, errorMsg) {
  try {
    await db.insert(downloads).values({
      tgId,
      videoId,
      title: title || null,
      audioItag: itag || null,
      audioSize: size || null,
      status,
      errorMsg: errorMsg || null,
    });
  } catch {
    // Ignore logging failures
  }
}

/**
 * Fungsi utama: proses permintaan download audio.
 */
export async function handleDownload(tgId, videoId) {
  // 1. Kirim pesan "sedang memproses"
  const statusMsg = await api.sendMessage({
    chat_id: tgId,
    text: '⏳ Mengambil informasi video...',
  });
  const statusMsgId = statusMsg.message_id;

  try {
    // 2. Ambil data player dari YouTube
    const player = await fetchPlayerData(videoId);

    if (!player.ok) {
      await logDownload(tgId, videoId, null, null, null, 'ip_blocked', player.reason);
      await editStatus(tgId, statusMsgId, `❌ Gagal mengambil data video.\n${player.reason}`);
      return;
    }

    const { data, clientUsed } = player;
    const title = data.videoDetails?.title || 'Unknown';
    const author = data.videoDetails?.author || '';
    const durationSec = Number(data.videoDetails?.lengthSeconds || 0);

    // 3. Pilih stream audio terbaik
    const formats = data.streamingData?.adaptiveFormats || [];
    const audio = pickBestAudio(formats);

    if (!audio) {
      await logDownload(tgId, videoId, title, null, null, 'error', 'Tidak ada stream audio ditemukan');
      await editStatus(tgId, statusMsgId, '❌ Tidak ada stream audio yang tersedia untuk video ini.');
      return;
    }

    if (!audio.url) {
      await logDownload(tgId, videoId, title, audio.itag, null, 'cipher', 'URL terkunci signatureCipher');
      await editStatus(tgId, statusMsgId,
        '⚠️ URL audio video ini terkunci di balik Signature Cipher.\n' +
        'Fitur dekripsi cipher belum tersedia. Coba video lain yang bukan musik resmi/VEVO.'
      );
      return;
    }

    // 4. Cek estimasi ukuran
    if (audio.contentLength && audio.contentLength > MAX_AUDIO_BYTES) {
      const sizeMB = (audio.contentLength / (1024 * 1024)).toFixed(1);
      await logDownload(tgId, videoId, title, audio.itag, audio.contentLength, 'too_large', `${sizeMB} MB`);
      await editStatus(tgId, statusMsgId,
        `❌ Audio terlalu besar (${sizeMB} MB). Batas Telegram: 50 MB.`
      );
      return;
    }

    // 5. Download audio
    await editStatus(tgId, statusMsgId,
      `⬇️ Mengunduh audio...\n📺 ${title}\n🎵 ${audio.mimeType} • ${Math.round((audio.bitrate || 0) / 1000)} kbps`
    );

    const audioBytes = await downloadAudioBytes(audio.url);

    if (audioBytes.byteLength > MAX_AUDIO_BYTES) {
      const sizeMB = (audioBytes.byteLength / (1024 * 1024)).toFixed(1);
      await logDownload(tgId, videoId, title, audio.itag, audioBytes.byteLength, 'too_large', `${sizeMB} MB actual`);
      await editStatus(tgId, statusMsgId,
        `❌ Audio terunduh tapi terlalu besar (${sizeMB} MB). Batas Telegram: 50 MB.`
      );
      return;
    }

    // 6. Kirim audio ke Telegram
    await editStatus(tgId, statusMsgId, '📤 Mengirim audio ke chat...');

    const ext = audioExtension(audio.mimeType);
    const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 60);
    const filename = `${safeTitle}.${ext}`;

    await api.sendAudio({
      chat_id: tgId,
      audio: new InputFile(audioBytes, filename, {
        type: audio.mimeType?.split(';')[0] || 'audio/mp4',
      }),
      title: title,
      performer: author || undefined,
      duration: durationSec > 0 ? durationSec : undefined,
    });

    // 7. Hapus status message, log sukses
    await deleteMessageSafe(tgId, statusMsgId);
    await logDownload(tgId, videoId, title, audio.itag, audioBytes.byteLength, 'ok', null);

  } catch (err) {
    await logDownload(tgId, videoId, null, null, null, 'error', String(err?.message || err).slice(0, 500));
    await editStatus(tgId, statusMsgId,
      `❌ Terjadi error saat memproses.\n${String(err?.message || 'Unknown error').slice(0, 200)}`
    );
    throw err;
  }
}

// ─── Tes IP (command /testip) ───

export async function handleTestIP(tgId) {
  const testVideoId = 'jNQXAC9IVRw'; // "Me at the zoo" — video non-musik pertama di YouTube

  await api.sendMessage({ chat_id: tgId, text: '🔍 Menguji koneksi ke YouTube dari IP server...' });

  for (const client of CLIENT_CONFIGS) {
    const payload = {
      videoId: testVideoId,
      context: { client: { ...client, hl: 'en', gl: 'US' } },
    };

    try {
      const res = await fetch(INNERTUBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      const status = data.playabilityStatus?.status;
      const reason = data.playabilityStatus?.reason || '-';
      const hasStreaming = Boolean(data.streamingData);
      const audioCount = (data.streamingData?.adaptiveFormats || [])
        .filter(f => f.mimeType?.startsWith('audio/')).length;
      const directAudio = (data.streamingData?.adaptiveFormats || [])
        .filter(f => f.mimeType?.startsWith('audio/') && f.url).length;

      const lines = [
        `📡 Client: ${client.clientName}`,
        `• HTTP: ${res.status}`,
        `• Status: ${status}`,
        `• Reason: ${reason}`,
        `• streamingData: ${hasStreaming ? '✅ Ada' : '❌ Tidak ada'}`,
        `• Audio streams: ${audioCount} (${directAudio} dengan URL langsung)`,
      ];

      if (status === 'OK' && directAudio > 0) {
        lines.push('', '✅ Client ini bisa digunakan!');
      } else if (status === 'OK' && audioCount > 0) {
        lines.push('', '⚠️ Audio ada tapi terkunci cipher');
      } else if (status !== 'OK') {
        lines.push('', '🚫 Client ini diblokir');
      }

      await api.sendMessage({ chat_id: tgId, text: lines.join('\n') });
    } catch (err) {
      await api.sendMessage({
        chat_id: tgId,
        text: `📡 Client: ${client.clientName}\n❌ Error: ${err.message}`,
      });
    }
  }
}

// ─── Admin commands ───

export async function handleStats(tgId) {
  if (tgId !== ADMIN_TG_ID) {
    await api.sendMessage({ chat_id: tgId, text: '⛔ Perintah ini khusus admin.' });
    return;
  }

  const [total, ok, blocked, cipher, errors] = await Promise.all([
    db.$count(downloads),
    db.$count(downloads, eq(downloads.status, 'ok')),
    db.$count(downloads, eq(downloads.status, 'ip_blocked')),
    db.$count(downloads, eq(downloads.status, 'cipher')),
    db.$count(downloads, eq(downloads.status, 'error')),
  ]);

  const lines = [
    '📊 Statistik YT Audio Bot',
    '',
    `• Total request: ${total}`,
    `• Berhasil: ${ok}`,
    `• IP Blocked: ${blocked}`,
    `• Cipher Locked: ${cipher}`,
    `• Error: ${errors}`,
  ];

  await api.sendMessage({ chat_id: tgId, text: lines.join('\n') });
}
