/**
 * run-local.ts — Local development entrypoint
 *
 * Loads secrets from .env and runs the agent.
 * --dry-run  → prints brief JSON to console, no Telegram, no file write
 * --no-send  → writes brief.json but skips Telegram
 *
 * Usage:
 *   npx tsx run-local.ts --dry-run
 *   npx tsx run-local.ts --no-send
 *   npx tsx run-local.ts
 */

import "dotenv/config";
import fs from "fs";
import { runAgent, sendTelegram, buildTelegramMessage, parseSites, DEFAULT_SITES } from "./agent.js";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key} — check your .env file`);
  return val;
}

const isDryRun = process.argv.includes("--dry-run");
const noSend = process.argv.includes("--no-send");

async function main(): Promise<void> {
  const rawSites = process.env["SITES"] ?? "";

  const config = {
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramChatId: requireEnv("TELEGRAM_CHAT_ID"),
    sites: rawSites || undefined,
    pagesUrl: process.env["PAGES_URL"],
  };

  const brief = await runAgent(config);

  if (isDryRun) {
    console.log("\n─── DRY RUN — not sending or saving ───\n");
    console.log(JSON.stringify(brief, null, 2));
    console.log("\n────────────────────────────────────────\n");
    return;
  }

  // Write brief.json for the web UI
  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync("docs/brief.json", JSON.stringify(brief, null, 2));
  console.log("  → Wrote docs/brief.json");

  if (!noSend) {
    const telegramMsg = buildTelegramMessage(brief, config.pagesUrl);
    await sendTelegram(telegramMsg, config.telegramBotToken, config.telegramChatId);
    console.log("  → Sent to Telegram. Done.");
  } else {
    console.log("  → Skipped Telegram (--no-send). Done.");
  }
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});