-- Seed default value for the internal_auth_disabled setting.
-- ON CONFLICT DO NOTHING is a no-op for existing installs — their current
-- behaviour (password login enabled) is preserved without any override.
INSERT INTO system_settings (key, value, updated_at)
VALUES ('internal_auth_disabled', 'false', NOW())
ON CONFLICT (key) DO NOTHING;
