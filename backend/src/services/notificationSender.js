/**
 * Multi-channel notification sender.
 * Fires webhooks / Feishu cards / DingTalk / WeCom bots when new mail arrives.
 */
import { query } from './db.js';

// ── Message templates per platform ──────────────────────────────────────────

function buildFeishuPayload(data) {
  const { title, body, fromName, fromEmail, subject, snippet, count, url } = data;
  const sender = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const snip = snippet && snippet.length > 200 ? snippet.slice(0, 200) + '...' : snippet;
  const singleBody = count === 1
    ? `**发件人：**${sender}\n**主题：**${subject || '(无主题)'}${snip ? '\n\n' + snip : ''}`
    : `${count} 封新邮件`;

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { content: '📬 MailFlow 新邮件', tag: 'plain_text' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: { content: singleBody, tag: 'lark_md' },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { content: '打开 MailFlow', tag: 'plain_text' },
              url: url || process.env.APP_URL || '',
              type: 'default',
            },
          ],
        },
      ],
    },
  };
}

function buildWebhookPayload(data) {
  return {
    event: 'new_mail',
    timestamp: new Date().toISOString(),
    title: data.title,
    body: data.body,
    fromName: data.fromName,
    fromEmail: data.fromEmail,
    subject: data.subject,
    count: data.count,
    snippet: data.snippet || '',
    url: data.url || '',
    unreadCount: data.unreadCount,
  };
}

function buildDingTalkPayload(data) {
  const { title, body, fromName, fromEmail, subject, snippet, count } = data;
  const sender = fromName ? `${fromName} (${fromEmail})` : fromEmail;
  const snip = snippet && snippet.length > 200 ? snippet.slice(0, 200) + '...' : snippet;
  const text = count === 1
    ? `## MailFlow 新邮件\n\n**发件人：**${sender}\n**主题：**${subject || '(无主题)'}${snip ? '\n\n> ' + snip : ''}`
    : `## MailFlow 新邮件\n\n${count} 封新邮件`;

  return {
    msgtype: 'markdown',
    markdown: {
      title: 'MailFlow 新邮件',
      text,
    },
  };
}

const PAYLOAD_BUILDERS = {
  feishu: buildFeishuPayload,
  dingtalk: buildDingTalkPayload,
  webhook: buildWebhookPayload,
  wecom: buildWebhookPayload, // WeCom uses standard webhook format
};

// ── Send to a single channel ────────────────────────────────────────────────

async function sendToChannel(channel, data) {
  const builder = PAYLOAD_BUILDERS[channel.type] || buildWebhookPayload;
  const payload = builder(data);
  const body = JSON.stringify(payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errorBody.slice(0, 200)}`);
    }

    // Feishu returns {"code":0,"msg":"success"} on success
    const result = await res.json().catch(() => null);
    if (result && result.code !== undefined && result.code !== 0) {
      throw new Error(`Feishu error code ${result.code}: ${result.msg || 'unknown'}`);
    }

    // DingTalk returns {"errcode":0,"errmsg":"ok"}
    if (result && result.errcode !== undefined && result.errcode !== 0) {
      throw new Error(`DingTalk error code ${result.errcode}: ${result.errmsg || 'unknown'}`);
    }

    return { success: true };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out after 10s');
    }
    throw err;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send new-mail notification to all configured channels for a user.
 * Non-blocking — errors are logged but never thrown.
 *
 * @param {string} userId
 * @param {object} data - { title, body, fromName, fromEmail, subject, count, url }
 */
export async function sendNotificationsToUser(userId, data) {
  try {
    const result = await query(
      `SELECT id, type, name, url, config
       FROM notification_channels
       WHERE user_id = $1 AND enabled = true`,
      [userId]
    );

    if (result.rows.length === 0) return;

    const dataWithUrl = {
      ...data,
      url: data.url || process.env.APP_URL || '',
    };

    // Fire all channels in parallel, log results
    const outcomes = await Promise.allSettled(
      result.rows.map(channel =>
        sendToChannel(channel, dataWithUrl).catch(err => {
          console.warn(
            `[notify] Channel "${channel.name}" (${channel.type}) failed:`,
            err.message
          );
          throw err; // re-throw so allSettled records it as rejected
        })
      )
    );
  } catch (err) {
    console.error('[notify] Error fetching channels:', err.message);
  }
}

/**
 * Send a test notification to a specific channel URL to verify configuration.
 */
export async function sendTestNotification(type, url) {
  const builder = PAYLOAD_BUILDERS[type] || buildWebhookPayload;
  const testData = {
    title: 'Test',
    body: 'This is a test notification from MailFlow',
    fromName: 'MailFlow',
    fromEmail: 'test@mailflow.local',
    subject: 'Test Notification',
    count: 1,
    url: process.env.APP_URL || '',
  };
  const payload = builder(testData);
  const body = JSON.stringify(payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${errorBody.slice(0, 200)}` };
    }

    const result = await res.json().catch(() => null);
    return { ok: true, result };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, error: err.message };
  }
}
