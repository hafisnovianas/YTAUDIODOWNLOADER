import { api, fetch, InputFile } from 'sdk';
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { downloads } from '../schema.js';

export const ADMIN_TG_ID = 8738554818;
const MAX_AUDIO_BYTES = 48 * 1024 * 1024; // 48 MB safety margin (limit 50 MB)

// ─── YouTube Innertube API ───

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

// Konfigurasi client modern yang kompatibel dengan protokol Innertube
export const CLIENT_CONFIGS = [
  {
    name: 'ANDROID',
    userAgent: 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip',
    buildPayload: (videoId) => ({
      videoId,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '21.26.364',
          androidSdkVersion: 30,
          osName: 'Android',
          osVersion: '11',
          hl: 'en',
          gl: 'US',
        },
      },
    }),
  },
  {
    name: 'IOS',
    userAgent: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    buildPayload: (videoId) => ({
      videoId,
      context: {
        client: {
          clientName: 'IOS',
          clientVersion: '21.26.4',
          deviceMake: 'Apple',
          deviceModel: 'iPhone16,2',
          osName: 'iPhone',
          osVersion: '18.3.2.22D82',
          hl: 'en',
          gl: 'US',
        },
      },
    }),
  },
  {
    name: 'WEB_EMBEDDED',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    buildPayload: (videoId) => ({
      videoId,
      context: {
        client: {
          clientName: 'WEB_EMBEDDED_PLAYER',
          clientVersion: '2.20260708.00.00',
          hl: 'en',
          gl: 'US',
        },
        thirdParty: {
          embedUrl: 'https://www.google.com/',
        },
      },
    }),
  },
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
  let lastReason = 'Tidak diketahui';

  for (const client of CLIENT_CONFIGS) {
    const payload = client.buildPayload(videoId);

    let res;
    try {
      res = await fetch(INNERTUBE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': client.userAgent,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      lastReason = `Koneksi gagal: ${err.message}`;
      continue;
    }

    if (!res.ok) {
      lastReason = `HTTP ${res.status} ${res.statusText}`;
      continue;
    }

    const data = await res.json();
    const status = data.playabilityStatus?.status;

    if (status === 'OK' && data.streamingData) {
      return { ok: true, data, clientUsed: client.name };
    }

    // Catat alasan kegagalan
    lastReason = data.playabilityStatus?.reason || `Status: ${status}`;

    // Coba client berikutnya jika status bukan OK
    if (status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE' || status === 'ERROR') {
      continue;
    }

    return {
      ok: false,
      reason: lastReason,
    };
  }

  return {
    ok: false,
    reason: `Semua client config gagal. Terakhir: ${lastReason}`,
  };
}

/**
 * Pilih stream audio terbaik dari streamingData.
 * Prioritas:
 * 1. Audio murni di adaptiveFormats dengan .url langsung
 * 2. Progressive format (itag 18 dll) dengan .url langsung (mengandung track AAC)
 * 3. URL terkunci cipher
 */
function pickBestAudio(streamingData) {
  const adaptive = streamingData?.adaptiveFormats || [];
  const formats = streamingData?.formats || [];

  // 1. Cek audio murni di adaptiveFormats
  const audioStreams = adaptive.filter((f) => f.mimeType?.startsWith('audio/'));
  const directAudio = audioStreams.filter((f) => f.url && !f.signatureCipher && !f.cipher);
  if (directAudio.length > 0) {
    directAudio.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const picked = directAudio[0];
    return {
      url: picked.url,
      cipher: null,
      itag: picked.itag,
      mimeType: picked.mimeType,
      bitrate: picked.bitrate,
      contentLength: picked.contentLength ? Number(picked.contentLength) : null,
    };
  }

  // 2. Cek format progresif (itag 18 dll) yang punya AAC audio + direct URL
  const directProg = formats.filter((f) => f.url && !f.signatureCipher && !f.cipher);
  if (directProg.length > 0) {
    // Ambil yang paling ringkas (itag 18) agar hemat kuota dan memori Telegram
    directProg.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
    const picked = directProg[0];
    return {
      url: picked.url,
      cipher: null,
      itag: picked.itag,
      mimeType: 'audio/mp4', // Container MP4/AAC untuk Telegram sendAudio
      bitrate: picked.audioBitrate || 128000,
      contentLength: picked.contentLength ? Number(picked.contentLength) : null,
    };
  }

  // 3. Jika ada audio tapi terkunci cipher
  const cipherAudio = audioStreams.find((f) => f.signatureCipher || f.cipher);
  if (cipherAudio) {
    return {
      url: null,
      cipher: cipherAudio.signatureCipher || cipherAudio.cipher,
      itag: cipherAudio.itag,
      mimeType: cipherAudio.mimeType,
      bitrate: cipherAudio.bitrate,
      contentLength: cipherAudio.contentLength ? Number(cipherAudio.contentLength) : null,
    };
  }

  return null;
}

/**
 * Unduh bytes audio dari URL googlevideo.com.
 */
async function downloadAudioBytes(audioUrl) {
  const res = await fetch(audioUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
    },
  });

  if (!res.ok) {
    throw new Error(`Download gagal: HTTP ${res.status} ${res.statusText}`);
  }

  // Jika runtime TGCloud menyediakan helper bytes()
  if (typeof res.bytes === 'function') {
    return await res.bytes();
  }

  // Kumpulkan chunk dari async iterator res.body
  const chunks = [];
  let totalLength = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
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
  // 1. Kirim pesan status awal
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
    const audio = pickBestAudio(data.streamingData);

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

    // 5. Download audio bytes
    await editStatus(tgId, statusMsgId,
      `⬇️ Mengunduh audio via [${clientUsed}]...\n📺 ${title}\n🎵 ${audio.mimeType}`
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
  const testVideoId = 'jNQXAC9IVRw'; // "Me at the zoo"

  await api.sendMessage({ chat_id: tgId, text: '🔍 Menguji koneksi YouTube dari IP server...' });

  for (const client of CLIENT_CONFIGS) {
    const payload = client.buildPayload(testVideoId);

    try {
      const res = await fetch(INNERTUBE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': client.userAgent,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      const status = data.playabilityStatus?.status;
      const reason = data.playabilityStatus?.reason || '-';
      const hasStreaming = Boolean(data.streamingData);

      const adaptive = data.streamingData?.adaptiveFormats || [];
      const formats = data.streamingData?.formats || [];

      const audioStreams = adaptive.filter((f) => f.mimeType?.startsWith('audio/'));
      const directAudio = audioStreams.filter((f) => f.url).length;
      const directProg = formats.filter((f) => f.url).length;

      const lines = [
        `📡 Client: ${client.name}`,
        `• HTTP: ${res.status}`,
        `• Status: ${status}`,
        `• Reason: ${reason}`,
        `• streamingData: ${hasStreaming ? '✅ Ada' : '❌ Tidak ada'}`,
        `• Audio Murni (URL langsung): ${directAudio}/${audioStreams.length}`,
        `• Format Progresif (URL langsung): ${directProg}/${formats.length}`,
      ];

      if (status === 'OK' && (directAudio > 0 || directProg > 0)) {
        lines.push('', '✅ Client ini SIAP DIGUNAKAN!');
      } else if (status === 'OK') {
        lines.push('', '⚠️ Status OK, format URL ditahan/cipher');
      } else {
        lines.push('', '🚫 Client ini dibatasi YouTube');
      }

      await api.sendMessage({ chat_id: tgId, text: lines.join('\n') });
    } catch (err) {
      await api.sendMessage({
        chat_id: tgId,
        text: `📡 Client: ${client.name}\n❌ Error: ${err.message}`,
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
