/**
 * run-ci.ts — GitHub Actions entrypoint
 *
 * Reads secrets from process.env (injected by GitHub Actions secrets).
 * No .env loading. Fails fast if any secret is missing.
 */

import { runAgent, sendTelegram } from "./agent.js";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required secret: ${key} — check GitHub Actions secrets`);
  return val;
}

async function main(): Promise<void> {
  const config = {
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramChatId: requireEnv("TELEGRAM_CHAT_ID"),
    sites: requireEnv("SITES"),
  };

  const brief = await runAgent(config);
  await sendTelegram(brief, config.telegramBotToken, config.telegramChatId);
  console.log("  → Sent to Telegram. Done.");
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});