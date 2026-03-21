/**
 * run-ci.ts — GitHub Actions entrypoint
 *
 * Reads secrets from process.env, generates brief, writes docs/briefs/MM-DD.json,
 * updates docs/briefs/manifest.json, and sends compact summary to Telegram.
 */

import fs from "fs";
import path from "path";
import { runAgent, sendTelegram, buildTelegramMessage, localNow } from "./agent.js";

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
    sites: process.env["SITES"] || undefined,
    pagesUrl: process.env["PAGES_URL"],
  };

  const brief = await runAgent(config);

  // Write dated brief — MM-DD.json rolls over after a year (max 366 files)
  const now = localNow();
  const mmdd = String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  const briefsDir = path.join("docs", "briefs");
  fs.mkdirSync(briefsDir, { recursive: true });
  fs.writeFileSync(path.join(briefsDir, `${mmdd}.json`), JSON.stringify(brief, null, 2));
  console.log(`  → Wrote docs/briefs/${mmdd}.json`);

  // Update manifest so the frontend knows which dates are available
  const manifestPath = path.join(briefsDir, "manifest.json");
  const manifest: string[] = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    : [];
  if (!manifest.includes(mmdd)) manifest.push(mmdd);
  manifest.sort();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`  → Updated manifest (${manifest.length} briefs stored)`);

  // Send compact summary to Telegram
  const telegramMsg = buildTelegramMessage(brief, config.pagesUrl);
  await sendTelegram(telegramMsg, config.telegramBotToken, config.telegramChatId);
  console.log("  → Sent to Telegram. Done.");
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});