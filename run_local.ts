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
import path from "path";
import { runAgent, sendTelegram, buildTelegramMessage, localNow } from "./agent.js";

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
    tomorrowIoApiKey: process.env["TOMORROW_IO_API_KEY"] || undefined,
  };

  const brief = await runAgent(config);

  if (isDryRun) {
    console.log("\n─── DRY RUN — not sending or saving ───\n");
    console.log(JSON.stringify(brief, null, 2));
    console.log("\n────────────────────────────────────────\n");
    return;
  }

  // Write dated brief — MM-DD.json rolls over after a year (max 366 files)
  const now = localNow();
  const mmdd = String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  const briefsDir = path.join("docs", "briefs");
  fs.mkdirSync(briefsDir, { recursive: true });
  fs.writeFileSync(path.join(briefsDir, `${mmdd}.json`), JSON.stringify(brief, null, 2));
  console.log(`  → Wrote docs/briefs/${mmdd}.json`);

  // Update manifest
  const manifestPath = path.join(briefsDir, "manifest.json");
  const manifest: string[] = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    : [];
  if (!manifest.includes(mmdd)) manifest.push(mmdd);
  manifest.sort();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`  → Updated manifest (${manifest.length} briefs stored)`);

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