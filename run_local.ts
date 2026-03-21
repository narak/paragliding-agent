/**
 * run-local.ts — Local development entrypoint
 *
 * Loads secrets from .env and runs the agent.
 * Pass --dry-run to print the brief to console instead of sending to Telegram.
 *
 * Usage:
 *   npx tsx run-local.ts            # sends to Telegram
 *   npx tsx run-local.ts --dry-run  # prints to console only
 */

import "dotenv/config";
import { runAgent, sendTelegram } from "./agent.js";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key} — check your .env file`);
  return val;
}

const isDryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const config = {
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramChatId: requireEnv("TELEGRAM_CHAT_ID"),
  };

  const brief = await runAgent(config);

  if (isDryRun) {
    console.log("\n─── DRY RUN — brief not sent to Telegram ───\n");
    console.log(brief);
    console.log("\n────────────────────────────────────────────\n");
  } else {
    await sendTelegram(brief, config.telegramBotToken, config.telegramChatId);
    console.log("  → Sent to Telegram. Done.");
  }
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});