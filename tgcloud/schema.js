import { table, integer, text, index, sql } from 'sdk/db';

export const downloads = table('downloads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tgId: integer('tg_id').notNull(),
  videoId: text('video_id').notNull(),
  title: text('title'),
  audioItag: integer('audio_itag'),
  audioSize: integer('audio_size'),
  status: text('status').notNull(),       // 'ok' | 'ip_blocked' | 'cipher' | 'too_large' | 'error'
  errorMsg: text('error_msg'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  tgIdx: index('idx_downloads_tg').on(t.tgId),
  createdIdx: index('idx_downloads_created').on(t.createdAt),
}));

export const errorLogs = table('error_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  handler: text('handler').notNull(),
  tgId: integer('tg_id'),
  context: text('context'),
  message: text('message').notNull(),
  stack: text('stack'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  createdIdx: index('idx_error_logs_created').on(t.createdAt),
}));
