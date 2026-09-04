PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS watch_sessions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('discord', 'line')),
  conversation_id TEXT NOT NULL,
  walica_group_id TEXT NOT NULL,
  walica_url TEXT NOT NULL,
  posted_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
  mode TEXT NOT NULL CHECK (mode IN ('group_mode', 'normal_mode')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS walica_meta (
  session_id TEXT PRIMARY KEY,
  walica_posted_at TEXT NOT NULL,
  walica_member_count INTEGER NOT NULL CHECK (walica_member_count >= 0),
  FOREIGN KEY (session_id) REFERENCES watch_sessions (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payment_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  report_type TEXT NOT NULL CHECK (report_type IN ('paid', 'unpaid')),
  reported_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES watch_sessions (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_rules (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  day_offset INTEGER NOT NULL CHECK (day_offset >= 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('normal', 'pre_interest', 'interest_up')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  FOREIGN KEY (session_id) REFERENCES watch_sessions (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('normal', 'pre_interest', 'interest_up')),
  locked_at TEXT,
  sent_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'locked', 'sent', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  FOREIGN KEY (session_id) REFERENCES watch_sessions (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mode_transition_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  old_mode TEXT NOT NULL CHECK (old_mode IN ('group_mode', 'normal_mode')),
  new_mode TEXT NOT NULL CHECK (new_mode IN ('group_mode', 'normal_mode')),
  judged_at TEXT NOT NULL,
  reason TEXT,
  FOREIGN KEY (session_id) REFERENCES watch_sessions (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS delivery_logs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('discord', 'line')),
  destination_id TEXT NOT NULL,
  provider_message_id TEXT,
  delivered_at TEXT,
  error_code TEXT,
  error_message TEXT,
  FOREIGN KEY (event_id) REFERENCES notification_events (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_events_status_scheduled_at
ON notification_events (status, scheduled_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_sessions_platform_conversation_group
ON watch_sessions (platform, conversation_id, walica_group_id);
