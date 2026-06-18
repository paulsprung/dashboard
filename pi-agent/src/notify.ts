// ── Notifications ────────────────────────────────────────────────────────────
// Fan out alerts to whatever channels are configured via env. All channel secrets
// (ntfy topic, webhook URL, Telegram token) live here on the Pi, never on the
// dashboard — consistent with the zero-knowledge design, and it keeps working even
// if the public dashboard is down.
//
//   NTFY_URL            full ntfy topic URL, e.g. https://ntfy.sh/my-secret-topic
//   ALERT_WEBHOOK_URL   any endpoint that accepts a JSON POST
//   TELEGRAM_BOT_TOKEN  + TELEGRAM_CHAT_ID

import { logEvent } from './audit.js';

export type NotifyPriority = 'default' | 'high' | 'low';
export type NotifyOptions = { title: string; message: string; priority?: NotifyPriority; tags?: string[] };

const ntfyUrl = process.env.NTFY_URL?.trim();
const webhookUrl = process.env.ALERT_WEBHOOK_URL?.trim();
const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
const tgChat = process.env.TELEGRAM_CHAT_ID?.trim();

export function configuredChannels(): string[] {
  const c: string[] = [];
  if (ntfyUrl) c.push('ntfy');
  if (webhookUrl) c.push('webhook');
  if (tgToken && tgChat) c.push('telegram');
  return c;
}

export const notificationsEnabled = () => configuredChannels().length > 0;

const timeout = (ms: number) => AbortSignal.timeout(ms);

async function toNtfy(o: NotifyOptions) {
  if (!ntfyUrl) return;
  const prio = o.priority === 'high' ? '5' : o.priority === 'low' ? '2' : '3';
  await fetch(ntfyUrl, {
    method: 'POST',
    headers: { Title: o.title, Priority: prio, ...(o.tags?.length ? { Tags: o.tags.join(',') } : {}) },
    body: o.message,
    signal: timeout(5000),
  });
}

async function toWebhook(o: NotifyOptions) {
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: o.title, message: o.message, priority: o.priority ?? 'default', tags: o.tags ?? [], ts: Date.now() }),
    signal: timeout(5000),
  });
}

async function toTelegram(o: NotifyOptions) {
  if (!tgToken || !tgChat) return;
  const text = `*${o.title}*\n${o.message}`;
  await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: tgChat, text, parse_mode: 'Markdown' }),
    signal: timeout(5000),
  });
}

// Best-effort: try every configured channel, never throw, log the outcome to the audit ring.
export async function sendNotification(o: NotifyOptions): Promise<{ ok: boolean; channels: string[] }> {
  const channels = configuredChannels();
  if (channels.length === 0) return { ok: false, channels: [] };
  const results = await Promise.allSettled([toNtfy(o), toWebhook(o), toTelegram(o)]);
  const failed = results.filter((r) => r.status === 'rejected').length;
  logEvent({
    kind: 'alert',
    ok: failed === 0,
    message: `${o.title} — ${o.message}`,
    target: channels.join(', '),
  });
  return { ok: failed < channels.length, channels };
}
