# Walicaトゴシステム (MVP)

Cloudflare Workers + D1 で動かす、Discord / LINE 対応の督促 bot の開発環境です。
Discord の通常投稿を自動検知するために、Gateway 接続の中継Botも併用します。

## 1) 前提

- Node.js 20 以上
- npm
- Cloudflare アカウント
- Wrangler ログイン済み (`npx wrangler login`)

## 2) 初回セットアップ

```bash
npm install
```

## 3) D1 データベース作成

```bash
npx wrangler d1 create walica_togo_db
```

作成後、表示される `database_id` を `wrangler.toml` の `database_id` に設定してください。

## 4) ローカル開発用シークレット

`.dev.vars.example` をコピーして `.dev.vars` を作成します。

```bash
copy .dev.vars.example .dev.vars
```

必要な値を `.dev.vars` に設定してください。

## 5) スキーマ反映

ローカル D1:

```bash
npm run d1:migrate:local
```

リモート D1:

```bash
npm run d1:migrate:remote
```

## 6) 開発サーバ起動

```bash
npm run dev
```

ヘルスチェック:

```bash
curl http://127.0.0.1:8787/health
```

## 7) Discord Gateway 中継Bot

Discord の通常メッセージ投稿イベント (`MESSAGE_CREATE`) は、Webhook URL単体では受けられません。  
そのため、Gateway接続Botで受信してWorkerへ中継します。

必要な環境変数:

- `DISCORD_BOT_TOKEN`
- `DISCORD_INGEST_URL` (省略時は本番 `.../webhook/discord`)

起動:

```bash
npm run bot:discord
```

Discord Developer Portal 側で以下を有効化してください:

- Bot Privileged Gateway Intents
  - `MESSAGE CONTENT INTENT`
  - `SERVER MEMBERS INTENT` (必要に応じて)

## 8) 現在の実装状況

- `/health` エンドポイント
- `/webhook/discord` でURL検知、監視登録、支払い報告受付
- `/webhook/line` の受け口（未実装）
- `scheduled` で期限到来イベント処理、通知送信（Discord）
- 要件仕様に対応した D1 テーブル定義（`db/schema.sql`）

次は LINE webhook 本実装と、Discord署名検証を追加予定です。
