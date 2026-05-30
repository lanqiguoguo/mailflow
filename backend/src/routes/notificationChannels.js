import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendTestNotification } from '../services/notificationSender.js';
import { validateHost } from '../services/hostValidation.js';

const router = Router();
router.use(requireAuth);

const VALID_TYPES = ['webhook', 'feishu', 'dingtalk', 'wecom'];

// ── List channels ──────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const result = await query(
    `SELECT id, type, name, url, config, enabled, created_at, updated_at
     FROM notification_channels
     WHERE user_id = $1
     ORDER BY created_at`,
    [req.session.userId]
  );
  res.json({ channels: result.rows });
});

// ── Create channel ─────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { type, name, url, config } = req.body;

  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate URL
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'URL must use HTTP or HTTPS' });
  }

  // For webhook type, validate the host to prevent SSRF
  if (type === 'webhook') {
    const hostErr = await validateHost(parsedUrl.hostname);
    if (hostErr) return res.status(400).json({ error: `URL host: ${hostErr}` });
  }

  try {
    const result = await query(
      `INSERT INTO notification_channels (user_id, type, name, url, config)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, type, name, url, config, enabled, created_at`,
      [req.session.userId, type, name.trim(), url, JSON.stringify(config || {})]
    );
    res.json({ channel: result.rows[0] });
  } catch (err) {
    console.error('create notification channel error:', err.message);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// ── Update channel ─────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { type, name, url, config, enabled } = req.body;

  // Verify ownership
  const existing = await query(
    'SELECT id FROM notification_channels WHERE id = $1 AND user_id = $2',
    [id, req.session.userId]
  );
  if (!existing.rows.length) return res.status(404).json({ error: 'Channel not found' });

  if (type && !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
  }

  try {
    const result = await query(
      `UPDATE notification_channels SET
        type = COALESCE($2, type),
        name = COALESCE($3, name),
        url = COALESCE($4, url),
        config = COALESCE($5::jsonb, config),
        enabled = COALESCE($6, enabled),
        updated_at = NOW()
       WHERE id = $1 AND user_id = $7
       RETURNING id, type, name, url, config, enabled, created_at, updated_at`,
      [
        id,
        type || null,
        name?.trim() || null,
        url || null,
        config ? JSON.stringify(config) : null,
        enabled !== undefined ? enabled : null,
        req.session.userId,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Channel not found' });
    res.json({ channel: result.rows[0] });
  } catch (err) {
    console.error('update notification channel error:', err.message);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// ── Delete channel ─────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  const result = await query(
    'DELETE FROM notification_channels WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.session.userId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Channel not found' });
  res.json({ ok: true });
});

// ── Test channel ───────────────────────────────────────────────────────────

router.post('/test', async (req, res) => {
  const { type, url } = req.body;
  if (!type || !url) return res.status(400).json({ error: 'type and url required' });

  const result = await sendTestNotification(type, url);
  if (result.ok) {
    res.json({ ok: true });
  } else {
    res.status(400).json({ ok: false, error: result.error });
  }
});

export default router;
