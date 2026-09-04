export interface Env {
  DB: D1Database;
  APP_TZ: string;
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINE_CHANNEL_SECRET?: string;
}

type HealthResponse = {
  service: string;
  status: "ok";
  timezone: string;
  now: string;
};

type DiscordWebhookMessage = {
  id?: string;
  content?: string;
  channel_id?: string;
  guild_id?: string | null;
  author?: {
    id?: string;
    bot?: boolean;
  };
};

type DiscordEnvelopePayload = {
  t?: string;
  d?: DiscordWebhookMessage;
  event?: {
    type?: string;
    data?: DiscordWebhookMessage;
  };
  data?: DiscordWebhookMessage;
};

type ParsedWalicaUrl = {
  rawUrl: string;
  normalizedUrl: string;
  groupId: string;
};

type NotificationEventType = "normal" | "pre_interest" | "interest_up";
type NotificationRuleSeed = {
  dayOffset: number;
  eventType: NotificationEventType;
};

type EventRow = {
  id: string;
  session_id: string;
  scheduled_at: string;
  event_type: NotificationEventType;
  retry_count: number;
};

type SessionRow = {
  id: string;
  platform: "discord" | "line";
  conversation_id: string;
  walica_group_id: string;
  walica_url: string;
  status: "active" | "paused" | "closed";
  mode: "group_mode" | "normal_mode";
};

type PaymentReportType = "paid" | "unpaid";
type SessionMode = "group_mode" | "normal_mode";
type SettlementRow = {
  line: string;
  amount: number;
};

const WALICA_HOST = "walica.jp";
const WALICA_GROUP_PATH = "/group/";
const URL_CANDIDATE_REGEX = /https?:\/\/[^\s<>"')]+/gi;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY = 3;
const CLAIM_BATCH_SIZE = 20;
const DEFAULT_NOTIFICATION_RULES: NotificationRuleSeed[] = [
  { dayOffset: 3, eventType: "normal" },
  { dayOffset: 5, eventType: "normal" },
  { dayOffset: 7, eventType: "normal" },
  { dayOffset: 9, eventType: "pre_interest" },
  { dayOffset: 10, eventType: "interest_up" },
  { dayOffset: 19, eventType: "pre_interest" },
  { dayOffset: 20, eventType: "interest_up" }
];
const PAID_KEYWORDS = ["払った", "済み", "支払い完了", "入金した", "振り込んだ", "払いました", "払っといた"];
const UNPAID_KEYWORDS = ["払ってない", "未払い", "まだ", "未入金", "払ってねえ", "払ってないです"];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function normalizeDiscordMessagePayload(input: unknown): DiscordWebhookMessage | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const direct = input as DiscordWebhookMessage;
  if (typeof direct.content === "string" || typeof direct.channel_id === "string") {
    return direct;
  }

  const wrapped = input as DiscordEnvelopePayload;
  if (wrapped.d && (typeof wrapped.d.content === "string" || typeof wrapped.d.channel_id === "string")) {
    return wrapped.d;
  }

  if (
    wrapped.event?.data &&
    (typeof wrapped.event.data.content === "string" || typeof wrapped.event.data.channel_id === "string")
  ) {
    return wrapped.event.data;
  }

  if (wrapped.data && (typeof wrapped.data.content === "string" || typeof wrapped.data.channel_id === "string")) {
    return wrapped.data;
  }

  return null;
}

function extractUrlCandidates(input: string): string[] {
  const matches = input.match(URL_CANDIDATE_REGEX);
  return matches ?? [];
}

function parseWalicaUrl(candidate: string): ParsedWalicaUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== WALICA_HOST) {
    return null;
  }

  const noTrailingSlash = parsed.pathname.replace(/\/+$/, "");
  if (!noTrailingSlash.startsWith(WALICA_GROUP_PATH)) {
    return null;
  }

  const groupId = noTrailingSlash.slice(WALICA_GROUP_PATH.length);
  if (!groupId || groupId.includes("/")) {
    return null;
  }

  return {
    rawUrl: candidate,
    normalizedUrl: `https://${WALICA_HOST}/group/${groupId}`,
    groupId
  };
}

function uniqueByNormalizedUrl(urls: ParsedWalicaUrl[]): ParsedWalicaUrl[] {
  const seen = new Set<string>();
  const unique: ParsedWalicaUrl[] = [];
  for (const item of urls) {
    if (seen.has(item.normalizedUrl)) {
      continue;
    }
    seen.add(item.normalizedUrl);
    unique.push(item);
  }
  return unique;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

async function isWalicaUrlReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow"
    });
    return res.ok;
  } catch {
    return false;
  }
}

function tryExtractMemberCount(html: string): number | null {
  const patterns = [
    /登録メンバー[^0-9]{0,20}([0-9]{1,4})\s*人/u,
    /メンバー[^0-9]{0,20}([0-9]{1,4})\s*人/u,
    />\s*([0-9]{1,4})\s*人\s*</u
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) {
      continue;
    }
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

async function fetchWalicaMemberCount(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow" });
    if (!response.ok) {
      return null;
    }
    const html = await response.text();
    return tryExtractMemberCount(html);
  } catch {
    return null;
  }
}

function extractSettlementRowsFromText(text: string): SettlementRow[] {
  const chunks = text.split(/(?=[^\d]{0,12}\d[\d,]{0,12}\s*円)/u);
  const rows: SettlementRow[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const amountMatch = chunk.match(/([0-9][0-9,]{0,12})\s*円/u);
    if (!amountMatch) {
      continue;
    }

    const amount = Number.parseInt(amountMatch[1].replaceAll(",", ""), 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    const compact = chunk.replace(/\s+/g, " ").trim();
    if (!compact) {
      continue;
    }

    // Walicaページ全体の金額ノイズを減らすため、短すぎる文を除外
    if (compact.length < 6) {
      continue;
    }

    const line = compact.slice(0, 90);
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    rows.push({ line, amount });
  }

  return rows.slice(0, 8);
}

async function fetchSettlementRows(url: string): Promise<SettlementRow[]> {
  const response = await fetch(url, { method: "GET", redirect: "follow" });
  if (!response.ok) {
    throw new Error(`walica_fetch_failed status=${response.status}`);
  }
  const html = await response.text();
  const text = stripHtml(html);
  return extractSettlementRowsFromText(text);
}

async function fetchWalicaPostedAt(db: D1Database, sessionId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT walica_posted_at
       FROM walica_meta
       WHERE session_id = ?1
       LIMIT 1`
    )
    .bind(sessionId)
    .first<{ walica_posted_at: string }>();
  return row?.walica_posted_at ?? null;
}

function calcElapsedDays(fromIso: string, toIso: string): number {
  const deltaMs = Date.parse(toIso) - Date.parse(fromIso);
  return Math.max(0, Math.floor(deltaMs / DAY_MS));
}

function calcInterest(principal: number, elapsedDays: number): { interestCount: number; interest: number; total: number } {
  const interestCount = Math.floor(elapsedDays / 10);
  const interest = Math.ceil(principal * 0.5 * interestCount);
  return {
    interestCount,
    interest,
    total: principal + interest
  };
}

function eventTypeLabel(eventType: NotificationEventType): string {
  if (eventType === "pre_interest") {
    return "利息前日";
  }
  if (eventType === "interest_up") {
    return "利息発生日";
  }
  return "通常";
}

async function countPaidUsers(db: D1Database, sessionId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM (
         SELECT reporter_user_id, MAX(reported_at) AS latest_at
         FROM payment_reports
         WHERE session_id = ?1
         GROUP BY reporter_user_id
       ) latest
       JOIN payment_reports pr
         ON pr.session_id = ?1
        AND pr.reporter_user_id = latest.reporter_user_id
        AND pr.reported_at = latest.latest_at
       WHERE pr.report_type = 'paid'`
    )
    .bind(sessionId)
    .first<{ cnt: number }>();
  return Number(row?.cnt ?? 0);
}

async function disablePendingEvents(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_events
       SET status = 'failed'
       WHERE session_id = ?1
         AND status IN ('pending', 'locked')`
    )
    .bind(sessionId)
    .run();
}

async function closeSession(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare(`UPDATE watch_sessions SET status = 'closed', updated_at = ?1 WHERE id = ?2`)
    .bind(new Date().toISOString(), sessionId)
    .run();
}

async function ensureGroupModeFutureEvents(params: {
  db: D1Database;
  sessionId: string;
  baseScheduledAt: string;
}): Promise<void> {
  const baseMs = Date.parse(params.baseScheduledAt);
  const nextPairs: Array<{ dayDelta: number; eventType: NotificationEventType }> = [
    { dayDelta: 9, eventType: "pre_interest" },
    { dayDelta: 10, eventType: "interest_up" }
  ];

  for (const pair of nextPairs) {
    const targetIso = new Date(baseMs + pair.dayDelta * DAY_MS).toISOString();
    const exists = await params.db
      .prepare(
        `SELECT id
         FROM notification_events
         WHERE session_id = ?1
           AND scheduled_at = ?2
           AND event_type = ?3
         LIMIT 1`
      )
      .bind(params.sessionId, targetIso, pair.eventType)
      .first<{ id: string }>();

    if (exists?.id) {
      continue;
    }

    await params.db
      .prepare(
        `INSERT INTO notification_events (
           id, session_id, scheduled_at, event_type, locked_at, sent_at, status, retry_count
         ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, 'pending', 0)`
      )
      .bind(crypto.randomUUID(), params.sessionId, targetIso, pair.eventType)
      .run();
  }
}

function buildScaryMessage(params: {
  elapsedDays: number;
  eventType: NotificationEventType;
  rows: SettlementRow[];
  principal: number;
  interest: number;
  total: number;
  mode: SessionMode;
  unpaidCount?: number;
}): string {
  const lines: string[] = [];
  lines.push(`⏰ ${params.elapsedDays}日経過 (${eventTypeLabel(params.eventType)})`);
  lines.push("怖いセンパイから連絡だ。まだ終わってねえなら今すぐ清算しろ。");
  lines.push("");
  lines.push("【清算方法】");
  if (params.rows.length === 0) {
    lines.push("- 取得失敗。Walicaを直接確認してくれ。");
  } else {
    for (const row of params.rows) {
      lines.push(`- ${row.line}`);
    }
  }
  lines.push("");
  lines.push(`元本: ${params.principal.toLocaleString("ja-JP")}円`);
  lines.push(`利息: ${params.interest.toLocaleString("ja-JP")}円`);
  lines.push(`請求額: ${params.total.toLocaleString("ja-JP")}円`);

  if (params.mode === "group_mode") {
    const unpaid = Math.max(0, params.unpaidCount ?? 0);
    lines.push("");
    lines.push(`@all あと${unpaid}人払ってねえなあ？払ったやつは「@bot 払った」で報告しな。`);
  }
  return lines.join("\n");
}

async function fetchWalicaMemberCountFromMeta(db: D1Database, sessionId: string): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT walica_member_count
       FROM walica_meta
       WHERE session_id = ?1
       LIMIT 1`
    )
    .bind(sessionId)
    .first<{ walica_member_count: number }>();
  return row?.walica_member_count ?? null;
}

async function fetchDiscordConversationHumanCount(params: {
  botToken: string;
  conversationId: string;
}): Promise<number | null> {
  const response = await fetch(`https://discord.com/api/v10/channels/${params.conversationId}`, {
    method: "GET",
    headers: {
      Authorization: `Bot ${params.botToken}`
    }
  });

  if (!response.ok) {
    return null;
  }

  const channel = (await response.json()) as {
    type?: number;
    recipients?: Array<{ id?: string; bot?: boolean }>;
    owner_id?: string;
  };

  const channelType = channel.type;
  const recipients = channel.recipients ?? [];
  if (channelType === 1) {
    // DMは相手ユーザー1名を人間数として扱う
    return 1;
  }

  if (channelType === 3) {
    const userIds = new Set<string>();
    for (const user of recipients) {
      if (user.id && !user.bot) {
        userIds.add(user.id);
      }
    }
    if (channel.owner_id) {
      userIds.add(channel.owner_id);
    }
    return userIds.size;
  }

  // ギルドチャンネルでは正確な「チャット実人数」を取得しにくいため未対応
  return null;
}

function decideMode(chatMemberCount: number, walicaMemberCount: number): SessionMode {
  return chatMemberCount <= walicaMemberCount ? "group_mode" : "normal_mode";
}

async function evaluateModeForSession(params: {
  env: Env;
  session: SessionRow;
}): Promise<SessionMode> {
  const walicaMemberCount = await fetchWalicaMemberCountFromMeta(params.env.DB, params.session.id);
  if (walicaMemberCount === null) {
    return params.session.mode;
  }

  let chatMemberCount: number | null = null;
  if (params.session.platform === "discord" && params.env.DISCORD_BOT_TOKEN) {
    chatMemberCount = await fetchDiscordConversationHumanCount({
      botToken: params.env.DISCORD_BOT_TOKEN,
      conversationId: params.session.conversation_id
    });
  }

  if (chatMemberCount === null) {
    return params.session.mode;
  }

  return decideMode(chatMemberCount, walicaMemberCount);
}

async function persistModeIfChanged(params: {
  db: D1Database;
  sessionId: string;
  oldMode: SessionMode;
  newMode: SessionMode;
  reason: string;
}): Promise<void> {
  if (params.oldMode === params.newMode) {
    return;
  }

  const now = new Date().toISOString();
  await params.db.batch([
    params.db
      .prepare(`UPDATE watch_sessions SET mode = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(params.newMode, now, params.sessionId),
    params.db
      .prepare(
        `INSERT INTO mode_transition_logs (id, session_id, old_mode, new_mode, judged_at, reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(crypto.randomUUID(), params.sessionId, params.oldMode, params.newMode, now, params.reason)
  ]);
}

function buildDefaultEventsFromPostedAt(postedAtIso: string): Array<{
  dayOffset: number;
  eventType: NotificationEventType;
  scheduledAt: string;
}> {
  const postedAtMs = Date.parse(postedAtIso);
  return DEFAULT_NOTIFICATION_RULES.map((rule) => ({
    dayOffset: rule.dayOffset,
    eventType: rule.eventType,
    scheduledAt: new Date(postedAtMs + rule.dayOffset * DAY_MS).toISOString()
  }));
}

async function createWatchSession(params: {
  env: Env;
  platform: "discord";
  conversationId: string;
  postedBy: string;
  walica: ParsedWalicaUrl;
  walicaMemberCount: number;
  mode: SessionMode;
}): Promise<"created" | "already_exists"> {
  const existing = await params.env.DB.prepare(
    `SELECT id
     FROM watch_sessions
     WHERE platform = ?1
       AND conversation_id = ?2
       AND walica_group_id = ?3
     LIMIT 1`
  )
    .bind(params.platform, params.conversationId, params.walica.groupId)
    .first<{ id: string }>();

  if (existing?.id) {
    return "already_exists";
  }

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const seedEvents = buildDefaultEventsFromPostedAt(now);
  const statements: D1PreparedStatement[] = [];

  statements.push(
    params.env.DB.prepare(
      `INSERT INTO watch_sessions (
         id, platform, conversation_id, walica_group_id, walica_url,
         posted_by, status, mode, timezone, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9, ?10)`
    ).bind(
      sessionId,
      params.platform,
      params.conversationId,
      params.walica.groupId,
      params.walica.normalizedUrl,
      params.postedBy,
      params.mode,
      params.env.APP_TZ ?? "Asia/Tokyo",
      now,
      now
    )
  );

  statements.push(
    params.env.DB.prepare(
      `INSERT INTO walica_meta (session_id, walica_posted_at, walica_member_count)
       VALUES (?1, ?2, ?3)`
    ).bind(sessionId, now, params.walicaMemberCount)
  );

  for (const seed of seedEvents) {
    statements.push(
      params.env.DB.prepare(
        `INSERT INTO notification_rules (id, session_id, day_offset, event_type, enabled)
         VALUES (?1, ?2, ?3, ?4, 1)`
      ).bind(crypto.randomUUID(), sessionId, seed.dayOffset, seed.eventType)
    );

    statements.push(
      params.env.DB.prepare(
        `INSERT INTO notification_events (
           id, session_id, scheduled_at, event_type, locked_at, sent_at, status, retry_count
         ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, 'pending', 0)`
      ).bind(crypto.randomUUID(), sessionId, seed.scheduledAt, seed.eventType)
    );
  }

  await params.env.DB.batch(statements);

  return "created";
}

async function claimDueEvents(db: D1Database, nowIso: string): Promise<EventRow[]> {
  const due = await db
    .prepare(
      `SELECT id, session_id, scheduled_at, event_type, retry_count
       FROM notification_events
       WHERE status = 'pending' AND scheduled_at <= ?1
       ORDER BY scheduled_at ASC
       LIMIT ?2`
    )
    .bind(nowIso, CLAIM_BATCH_SIZE)
    .all<EventRow>();

  const rows = due.results ?? [];
  const claimed: EventRow[] = [];

  for (const row of rows) {
    const lockedAt = new Date().toISOString();
    const lockResult = await db
      .prepare(
        `UPDATE notification_events
         SET status = 'locked', locked_at = ?1
         WHERE id = ?2 AND status = 'pending'`
      )
      .bind(lockedAt, row.id)
      .run();

    if ((lockResult.meta.changes ?? 0) > 0) {
      claimed.push(row);
    }
  }

  return claimed;
}

async function markEventSent(db: D1Database, eventId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_events
       SET status = 'sent', sent_at = ?1
       WHERE id = ?2`
    )
    .bind(new Date().toISOString(), eventId)
    .run();
}

async function markEventFailed(db: D1Database, event: EventRow, errorMessage: string): Promise<void> {
  const nextRetry = event.retry_count + 1;
  const nextStatus = nextRetry >= MAX_RETRY ? "failed" : "pending";
  console.error(`[notify:error] event=${event.id} retry=${nextRetry} error=${errorMessage}`);
  await db
    .prepare(
      `UPDATE notification_events
       SET status = ?1,
           retry_count = ?2,
           locked_at = NULL
       WHERE id = ?3`
    )
    .bind(nextStatus, nextRetry, event.id)
    .run();
}

async function loadSession(db: D1Database, sessionId: string): Promise<SessionRow | null> {
  const session = await db
    .prepare(
      `SELECT id, platform, conversation_id, walica_group_id, walica_url, status, mode
       FROM watch_sessions
       WHERE id = ?1
       LIMIT 1`
    )
    .bind(sessionId)
    .first<SessionRow>();
  return session ?? null;
}

async function loadLatestActiveSessionByConversation(params: {
  db: D1Database;
  platform: "discord";
  conversationId: string;
}): Promise<SessionRow | null> {
  const session = await params.db
    .prepare(
      `SELECT id, platform, conversation_id, walica_group_id, walica_url, status, mode
       FROM watch_sessions
       WHERE platform = ?1
         AND conversation_id = ?2
         AND status = 'active'
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .bind(params.platform, params.conversationId)
    .first<SessionRow>();
  return session ?? null;
}

function detectPaymentReportType(content: string): PaymentReportType | null {
  const normalized = content.toLowerCase().replace(/\s+/g, "");

  // 否定を優先して誤認識を防ぐ
  for (const keyword of UNPAID_KEYWORDS) {
    if (normalized.includes(keyword)) {
      return "unpaid";
    }
  }
  for (const keyword of PAID_KEYWORDS) {
    if (normalized.includes(keyword)) {
      return "paid";
    }
  }
  return null;
}

async function savePaymentReport(params: {
  db: D1Database;
  sessionId: string;
  reporterUserId: string;
  reportType: PaymentReportType;
}): Promise<void> {
  const now = new Date().toISOString();
  await params.db
    .prepare(
      `INSERT INTO payment_reports (id, session_id, reporter_user_id, report_type, reported_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(crypto.randomUUID(), params.sessionId, params.reporterUserId, params.reportType, now)
    .run();

  await params.db
    .prepare(`UPDATE watch_sessions SET updated_at = ?1 WHERE id = ?2`)
    .bind(now, params.sessionId)
    .run();
}

async function sendDiscordChannelMessage(params: {
  botToken: string;
  channelId: string;
  content: string;
}): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/channels/${params.channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${params.botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: params.content
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`discord_send_failed status=${response.status} body=${body}`);
  }
}

async function safeSendDiscordChannelMessage(params: {
  botToken: string;
  channelId: string;
  content: string;
}): Promise<void> {
  try {
    await sendDiscordChannelMessage(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    console.error(`[discord:send:warn] channel=${params.channelId} error=${message}`);
  }
}

async function sendNotificationStub(params: {
  session: SessionRow;
  event: EventRow;
  env: Env;
}): Promise<void> {
  const postedAt = await fetchWalicaPostedAt(params.env.DB, params.session.id);
  if (!postedAt) {
    throw new Error("walica_posted_at_not_found");
  }

  const elapsedDays = calcElapsedDays(postedAt, params.event.scheduled_at);
  const rows = await fetchSettlementRows(params.session.walica_url);
  const principal = rows.reduce((sum, row) => sum + row.amount, 0);
  const interestInfo = calcInterest(principal, elapsedDays);

  let unpaidCount: number | undefined;
  if (params.session.mode === "group_mode") {
    const memberCount = await fetchWalicaMemberCountFromMeta(params.env.DB, params.session.id);
    const paidCount = await countPaidUsers(params.env.DB, params.session.id);
    unpaidCount = Math.max(0, (memberCount ?? 0) - paidCount);
  }

  const message = buildScaryMessage({
    elapsedDays,
    eventType: params.event.event_type,
    rows,
    principal,
    interest: interestInfo.interest,
    total: interestInfo.total,
    mode: params.session.mode,
    unpaidCount
  });

  if (params.session.platform === "discord") {
    if (!params.env.DISCORD_BOT_TOKEN) {
      throw new Error("missing_discord_bot_token");
    }
    await sendDiscordChannelMessage({
      botToken: params.env.DISCORD_BOT_TOKEN,
      channelId: params.session.conversation_id,
      content: message
    });
    await params.env.DB
      .prepare(
        `INSERT INTO delivery_logs (
           id, event_id, platform, destination_id, provider_message_id, delivered_at, error_code, error_message
         ) VALUES (?1, ?2, 'discord', ?3, NULL, ?4, NULL, NULL)`
      )
      .bind(crypto.randomUUID(), params.event.id, params.session.conversation_id, new Date().toISOString())
      .run();
  } else {
    // TODO: LINE送信実装
    console.log(`[notify:line:stub] session=${params.session.id} event=${params.event.id}`);
  }

  if (params.session.mode === "group_mode" && (unpaidCount ?? 0) <= 0) {
    await disablePendingEvents(params.env.DB, params.session.id);
    await closeSession(params.env.DB, params.session.id);
    return;
  }

  if (params.session.mode === "normal_mode" && params.event.event_type === "interest_up" && elapsedDays >= 10) {
    await disablePendingEvents(params.env.DB, params.session.id);
    await closeSession(params.env.DB, params.session.id);
    return;
  }

  if (params.session.mode === "group_mode" && params.event.event_type === "interest_up" && elapsedDays >= 20) {
    await ensureGroupModeFutureEvents({
      db: params.env.DB,
      sessionId: params.session.id,
      baseScheduledAt: params.event.scheduled_at
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const body: HealthResponse = {
        service: "walica-togo-system",
        status: "ok",
        timezone: env.APP_TZ ?? "Asia/Tokyo",
        now: new Date().toISOString()
      };
      return json(body);
    }

    if (url.pathname === "/webhook/discord" && request.method === "POST") {
      let rawPayload: unknown;
      try {
        rawPayload = (await request.json()) as unknown;
      } catch {
        return json({ ok: false, error: "invalid_json" }, 400);
      }

      const payload = normalizeDiscordMessagePayload(rawPayload);
      if (!payload) {
        const topLevelKeys =
          rawPayload && typeof rawPayload === "object" ? Object.keys(rawPayload as Record<string, unknown>) : [];
        console.warn(`[discord:webhook] unsupported payload keys=${topLevelKeys.join(",")}`);
        return json({ ok: false, error: "unsupported_payload" }, 400);
      }

      // bot自身や他botの投稿はスキップ
      if (payload.author?.bot) {
        return json({ ok: true, ignored: "bot_message" }, 200);
      }

      const content = payload.content ?? "";
      if (!content) {
        return json({ ok: true, processed: 0, reason: "no_content" }, 200);
      }

      const conversationId = payload.channel_id;
      const postedBy = payload.author?.id;
      if (!conversationId || !postedBy) {
        return json({ ok: false, error: "missing_discord_context" }, 400);
      }

      const reportType = detectPaymentReportType(content);
      if (reportType !== null) {
        const activeSession = await loadLatestActiveSessionByConversation({
          db: env.DB,
          platform: "discord",
          conversationId
        });

        if (!activeSession) {
          return json(
            {
              ok: true,
              platform: "discord",
              paymentReportAccepted: false,
              reason: "no_active_session"
            },
            200
          );
        }

        await savePaymentReport({
          db: env.DB,
          sessionId: activeSession.id,
          reporterUserId: postedBy,
          reportType
        });

        if (env.DISCORD_BOT_TOKEN) {
          const reply =
            reportType === "paid"
              ? "報告受理。払ったんだな、確認した。"
              : "報告受理。まだ払ってない扱いに戻した。";
          await safeSendDiscordChannelMessage({
            botToken: env.DISCORD_BOT_TOKEN,
            channelId: conversationId,
            content: reply
          });
        }

        return json(
          {
            ok: true,
            platform: "discord",
            paymentReportAccepted: true,
            reportType,
            sessionId: activeSession.id
          },
          200
        );
      }

      const walicaUrls = uniqueByNormalizedUrl(
        extractUrlCandidates(content)
          .map(parseWalicaUrl)
          .filter((v): v is ParsedWalicaUrl => v !== null)
      );

      if (walicaUrls.length === 0) {
        return json({ ok: true, processed: 0, reason: "no_walica_url" }, 200);
      }

      const results: Array<{
        rawUrl: string;
        normalizedUrl: string;
        groupId: string;
        status: "registered" | "already_exists" | "registration_failed";
        reason?: string;
      }> = [];

      for (const walica of walicaUrls) {
        const reachable = await isWalicaUrlReachable(walica.normalizedUrl);
        if (!reachable) {
          results.push({
            rawUrl: walica.rawUrl,
            normalizedUrl: walica.normalizedUrl,
            groupId: walica.groupId,
            status: "registration_failed",
            reason: "unreachable"
          });
          continue;
        }

        const memberCount = await fetchWalicaMemberCount(walica.normalizedUrl);
        if (memberCount === null) {
          results.push({
            rawUrl: walica.rawUrl,
            normalizedUrl: walica.normalizedUrl,
            groupId: walica.groupId,
            status: "registration_failed",
            reason: "member_count_not_found"
          });
          continue;
        }

        const created = await createWatchSession({
          env,
          platform: "discord",
          conversationId,
          postedBy,
          walica,
          walicaMemberCount: memberCount,
          mode: env.DISCORD_BOT_TOKEN
            ? decideMode(
                (await fetchDiscordConversationHumanCount({
                  botToken: env.DISCORD_BOT_TOKEN,
                  conversationId
                })) ?? Number.MAX_SAFE_INTEGER,
                memberCount
              )
            : "normal_mode"
        });

        results.push({
          rawUrl: walica.rawUrl,
          normalizedUrl: walica.normalizedUrl,
          groupId: walica.groupId,
          status: created === "created" ? "registered" : "already_exists"
        });
      }

      if (env.DISCORD_BOT_TOKEN) {
        const successCount = results.filter((r) => r.status === "registered").length;
        const existsCount = results.filter((r) => r.status === "already_exists").length;
        const failedCount = results.filter((r) => r.status === "registration_failed").length;
        const reply = `監視設定結果: 新規${successCount}件 / 既存${existsCount}件 / 失敗${failedCount}件`;
        await safeSendDiscordChannelMessage({
          botToken: env.DISCORD_BOT_TOKEN,
          channelId: conversationId,
          content: reply
        });
      }

      return json(
        {
          ok: true,
          platform: "discord",
          detected: walicaUrls.length,
          results
        },
        200
      );
    }

    if (url.pathname === "/webhook/line" && request.method === "POST") {
      // TODO: LINE署名検証とWebhook受理を実装
      return json({ ok: true, platform: "line", message: "not implemented yet" }, 202);
    }

    return json({ error: "Not Found" }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const nowIso = new Date(controller.scheduledTime).toISOString();
    const dueEvents = await claimDueEvents(env.DB, nowIso);
    if (dueEvents.length === 0) {
      console.log(`[cron] no due events at ${nowIso}`);
      return;
    }

    for (const event of dueEvents) {
      try {
        const session = await loadSession(env.DB, event.session_id);
        if (!session || session.status !== "active") {
          await markEventSent(env.DB, event.id);
          continue;
        }

        const nextMode = await evaluateModeForSession({
          env,
          session
        });
        await persistModeIfChanged({
          db: env.DB,
          sessionId: session.id,
          oldMode: session.mode,
          newMode: nextMode,
          reason: "re-evaluated-before-notification"
        });

        const resolvedSession: SessionRow = {
          ...session,
          mode: nextMode
        };

        // FR-09 通知本文生成・送信
        await sendNotificationStub({
          session: resolvedSession,
          event,
          env
        });
        await markEventSent(env.DB, event.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        await markEventFailed(env.DB, event, message);
      }
    }

    console.log(`[cron] processed ${dueEvents.length} due events at ${nowIso}`);
  }
};
