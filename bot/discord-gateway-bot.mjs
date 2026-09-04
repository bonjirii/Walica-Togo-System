import { Client, GatewayIntentBits, Partials } from "discord.js";

const botToken = process.env.DISCORD_BOT_TOKEN;
const ingestUrl =
  process.env.DISCORD_INGEST_URL ??
  "https://walica-togo-system.bonjiri-qq.workers.dev/webhook/discord";

if (!botToken) {
  console.error("DISCORD_BOT_TOKEN is required.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

function toPayload(message) {
  return {
    id: message.id,
    content: message.content ?? "",
    channel_id: message.channelId,
    guild_id: message.guildId ?? null,
    author: {
      id: message.author?.id,
      bot: Boolean(message.author?.bot)
    }
  };
}

async function forwardMessage(message) {
  const payload = toPayload(message);
  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ingest_failed status=${response.status} body=${body}`);
  }
}

client.once("ready", () => {
  console.log(`[gateway] logged in as ${client.user?.tag ?? "unknown-user"}`);
});

client.on("messageCreate", async (message) => {
  if (message.author?.bot) {
    return;
  }

  if (!message.content || !message.channelId || !message.author?.id) {
    return;
  }

  try {
    await forwardMessage(message);
    console.log(`[gateway] forwarded message=${message.id} channel=${message.channelId}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown_error";
    console.error(`[gateway:error] message=${message.id} ${msg}`);
  }
});

client.login(botToken).catch((error) => {
  const msg = error instanceof Error ? error.message : "unknown_error";
  console.error(`[gateway:login:error] ${msg}`);
  process.exit(1);
});
