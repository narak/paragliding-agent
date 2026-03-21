/**
 * run-ci.ts — GitHub Actions entrypoint
 *
 * Reads secrets from process.env, generates brief, writes docs/brief.json,
 * and sends the compact summary to Telegram.
 * GitHub Actions then commits docs/brief.json so GitHub Pages serves it.
 */

import fs from "fs";
import { runAgent, sendTelegram, buildTelegramMessage, parseSites } from "./agent.js";

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
    pagesUrl: process.env["PAGES_URL"],
  };

  const brief = await runAgent(config);

  // Write for GitHub Pages
  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync("docs/brief.json", JSON.stringify(brief, null, 2));
  console.log("  → Wrote docs/brief.json");

  // Send compact summary to Telegram
  const telegramMsg = buildTelegramMessage(brief, config.pagesUrl);
  await sendTelegram(telegramMsg, config.telegramBotToken, config.telegramChatId);
  console.log("  → Sent to Telegram. Done.");
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});