# 🪂 Paragliding Weather Agent

A fully cloud-native agent that delivers a personalized paragliding conditions brief 
to your Telegram every morning at 6:30 AM — no local machine required.

**Stack:** TypeScript · Node 24 · GitHub Actions · Claude Haiku 3.5  
**Data:** Open-Meteo · UWyoming Soundings (OAK) · METAR (SFO/HAF) · NOAA AIRMETs  
**Delivery:** Telegram  
**Cost:** ~$1/month (Anthropic API only — everything else is free)

---

## Setup (~25 min total)

### Step 1 — Telegram Bot (10 min)

1. Open Telegram → search **@BotFather** → send `/newbot`
2. Follow prompts → you'll receive a **bot token** like `7312456789:AAFx...`
   → Save as `TELEGRAM_BOT_TOKEN`

3. Get your **Chat ID:**
   - Send any message to your new bot first
   - Open in browser (replace YOUR_TOKEN):
     ```
     https://api.telegram.org/botYOUR_TOKEN/getUpdates
     ```
   - Find `"chat":{"id": 123456789}` in the JSON
   → Save the number as `TELEGRAM_CHAT_ID`

---

### Step 2 — Anthropic API Key (5 min)

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. **API Keys → Create Key** → copy it (shown once)
   → Save as `ANTHROPIC_API_KEY`
3. Add a payment method — you'll spend ~$1/month

---

### Step 3 — GitHub Repo (5 min)

1. Create a **private** repo at [github.com/new](https://github.com/new)
   - Name: `paragliding-agent`

2. Clone and add files:
   ```bash
   git clone https://github.com/YOUR_USERNAME/paragliding-agent.git
   cd paragliding-agent
   ```

3. Your repo structure should look like this:
   ```
   paragliding-agent/
   ├── weather_agent.ts
   ├── tsconfig.json
   ├── package.json
   └── .github/
       └── workflows/
           └── daily_brief.yml
   ```

4. Generate the lockfile locally (requires Node 18+ installed):
   ```bash
   npm install
   ```

5. Push everything:
   ```bash
   git add .
   git commit -m "Initial setup"
   git push origin main
   ```

---

### Step 4 — GitHub Secrets (3 min)

Repo → **Settings → Secrets and variables → Actions → New repository secret**

Add all three:

| Secret Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | From Step 2 |
| `TELEGRAM_BOT_TOKEN` | From Step 1 |
| `TELEGRAM_CHAT_ID` | From Step 1 |
| `SITES` | Pipe-separated site list (see format below) |

**SITES format:** One site per line, `Name:lat,lon`

```
Mussel Rock:37.6335,-122.4897
Ed Levin:37.4683,-121.853
Fort Funston:37.7223,-122.5024
```

In GitHub Secrets, use actual newlines — the secret editor accepts multiline values.

For local dev, if `SITES` is not set in `.env`, the agent falls back to the default sites (Mussel Rock + Ed Levin).

---

### Step 5 — Test Manually (2 min)

1. GitHub repo → **Actions** tab
2. Click **Paragliding Daily Brief** in the sidebar
3. **Run workflow → Run workflow**
4. Watch it run (~30 sec) → check Telegram

If it fails, click into the run to see the exact error.

---

## Customization

### Add More Sites
Edit the `SITES` object in `weather_agent.ts`:
```typescript
const SITES: Record<string, Site> = {
  "Mussel Rock": { lat: 37.6335, lon: -122.4897 },
  "Ed Levin":    { lat: 37.4683, lon: -121.8530 },
  "Funston":     { lat: 37.7223, lon: -122.5024 },
};
```

### Change Delivery Time
Edit the cron lines in `.github/workflows/daily_brief.yml`:
```yaml
- cron: "00 14 * * *"   # 7:00 AM PDT
- cron: "00 15 * * *"   # 7:00 AM PST
```
Use [crontab.guru](https://crontab.guru) to calculate UTC offsets.

---

## Running Locally

### Option A — `.env` file (recommended)

1. Create a `.env` file in the project root and add it to `.gitignore`:
   ```bash
   touch .env
   echo ".env" >> .gitignore
   ```

2. Add your three secrets to `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   TELEGRAM_BOT_TOKEN=7312456789:AAFx...
   TELEGRAM_CHAT_ID=123456789
   ```

3. Install `dotenv` and `tsx` (TypeScript runner — no compile step needed):
   ```bash
   npm install --save-dev dotenv tsx
   ```

4. Add this line to the **very top** of `weather_agent.ts`:
   ```typescript
   import "dotenv/config";
   ```

5. Update the `dev` script in `package.json`:
   ```json
   "dev": "tsx weather_agent.ts"
   ```

6. Run it:
   ```bash
   npm run dev
   ```

---

### Option B — Inline env vars (no extra deps)

Prefix the command directly — no changes to source files needed:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
TELEGRAM_BOT_TOKEN=7312456789:AAFx... \
TELEGRAM_CHAT_ID=123456789 \
npx tsx weather_agent.ts
```

---

### Dry run — no Telegram message

To test the data pipeline and brief generation without sending to Telegram,
temporarily swap the last two lines in `main()`:

```typescript
// await sendTelegram(brief);       // comment this out
console.log("\n--- BRIEF PREVIEW ---\n");
console.log(brief);                 // print to terminal instead
```

Iterate on the prompt or data sources this way before re-enabling delivery.

---

## Troubleshooting

**Workflow doesn't trigger on schedule**  
GitHub delays scheduled workflows up to 15 min. Also: repos with no activity 
for 60 days get their schedules paused — re-enable from the Actions tab.

**Telegram not receiving messages**  
Make sure you sent at least one message to your bot before running. 
Bots can't initiate conversations with users who haven't messaged them first.

**`npm ci` fails in Actions**  
Make sure you committed the `package-lock.json` file (generated by `npm install` 
in Step 3). The `ci` command requires it.

**Sounding data shows "unavailable"**  
Wyoming soundings are occasionally delayed. The script auto-falls back to the 
prior cycle. The brief will still generate using Open-Meteo data.

**TypeScript build errors**  
Run `npm run build` locally to catch type errors before pushing.