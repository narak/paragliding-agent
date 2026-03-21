/**
 * agent.ts — Core paragliding weather agent
 * All data fetching, formatting, and LLM logic lives here.
 * No env loading. No entrypoint. Import from run-local.ts or run-ci.ts.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Site {
  lat: number;
  lon: number;
}

export interface AgentConfig {
  anthropicApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  sites?: string;
  pagesUrl?: string; // e.g. https://username.github.io/paragliding-agent
}

// ── Brief JSON Schema ──────────────────────────────────────────────────────────

export interface HourlyWindow {
  label: string;       // "Morning (8–11 AM)"
  summary: string;     // narrative sentence(s)
}

export interface SiteVerdict {
  verdict: "FLY" | "MARGINAL" | "NO FLY";
  emoji: string;       // ✅ ⚠️ ❌
  bestWindow: string;  // "11 AM – 1 PM" | "No viable window"
  wind: string;        // "8 kts W"
  thermals: string;    // "Moderate" | "N/A (ridge site)"
  hazards: string;     // "Rotor risk on NW, marine layer until 10 AM"
  skillLevel: string;  // "P2+" | "P3+" | "P4+ locals only"
}

export interface SiteBrief {
  name: string;
  locationDescriptor: string;   // "Daly City — coastal ridge, W-facing"
  howItWorks: string;           // 1-2 sentence site mechanics
  todaySetup: string;           // 3-5 sentence narrative
  hourlyWindows: HourlyWindow[];
  verdict: SiteVerdict;
}

export interface BriefJson {
  generatedAt: string;          // ISO timestamp
  date: string;                 // "Saturday, March 21, 2026"
  upperAir: string;             // sounding interpretation
  aviationFlags: string;        // AIRMETs / METARs summary
  sites: SiteBrief[];
  outlook: {
    tomorrow: string;
    day2: string;
    day3: string;
  };
  watchlist: string;
  tldr: string;
}

/**
 * Parse the SITES env var into a typed map.
 * Format: "Site Name:lat,lon\nSite Name 2:lat,lon"
 */
export function parseSites(raw: string): Record<string, Site> {
  const sites: Record<string, Site> = {};
  for (const entry of raw.split("\n")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const name = trimmed.slice(0, colonIdx).trim();
    const coords = trimmed.slice(colonIdx + 1).trim();
    const [lat, lon] = coords.split(",").map(Number);
    if (isNaN(lat) || isNaN(lon)) {
      console.warn(`  ⚠ Skipping invalid site entry: "${entry}"`);
      continue;
    }
    sites[name] = { lat, lon };
  }
  if (Object.keys(sites).length === 0) {
    throw new Error('SITES env var parsed to empty — check format: "Name:lat,lon\\nName2:lat,lon"');
  }
  return sites;
}

interface OpenMeteoResponse {
  hourly: {
    time: string[];
    temperature_2m: number[];
    windspeed_10m: number[];
    winddirection_10m: number[];
    windspeed_80m: number[];
    winddirection_80m: number[];
    windspeed_120m: number[];
    winddirection_120m: number[];
    cape: number[];
    boundary_layer_height: number[];
    precipitation_probability: number[];
    cloudcover: number[];
    visibility: number[];
  };
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
}

// ── Configuration ──────────────────────────────────────────────────────────────

export const DEFAULT_SITES: Record<string, Site> = {
  "Mussel Rock": { lat: 37.6335, lon: -122.4897 },
  "Ed Levin":    { lat: 37.4683, lon: -121.8530 },
};

export const SOUNDING_STATION = "KOAK";
export const METAR_STATIONS = ["KSFO", "KHAF"];
export const LOCAL_TZ = "America/Los_Angeles";

// ── Helpers ────────────────────────────────────────────────────────────────────

export function localNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: LOCAL_TZ }));
}

function localDateString(): string {
  return localNow().toISOString().slice(0, 10);
}

function formatDate(): string {
  return localNow().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: LOCAL_TZ,
  });
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ── Data Fetchers ──────────────────────────────────────────────────────────────

export async function fetchOpenMeteo(lat: number, lon: number): Promise<OpenMeteoResponse> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    hourly: [
      "temperature_2m",
      "windspeed_10m", "winddirection_10m",
      "windspeed_80m", "winddirection_80m",
      "windspeed_120m", "winddirection_120m",
      "cape", "boundary_layer_height",
      "precipitation_probability", "cloudcover", "visibility",
    ].join(","),
    wind_speed_unit: "kn",
    forecast_days: "3",
    timezone: LOCAL_TZ,
  });
  const res = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  return res.json() as Promise<OpenMeteoResponse>;
}

export async function fetchSounding(station: string): Promise<string> {
  const nowUtc = new Date();
  const hour = nowUtc.getUTCHours() >= 12 ? 12 : 0;

  const buildTimestamp = (date: Date, h: number): string => {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}${String(h).padStart(2, "0")}00`;
  };

  const minPastCycle = nowUtc.getUTCMinutes() + (nowUtc.getUTCHours() - hour) * 60;
  const primaryHour = minPastCycle < 30 ? (hour === 12 ? 0 : 12) : hour;
  const fallbackHour = primaryHour === 12 ? 0 : 12;

  const buildUrl = (h: number) =>
    `https://mesonet.agron.iastate.edu/json/raob.py?ts=${buildTimestamp(nowUtc, h)}&station=${station}&fmt=json`;

  interface SoundingLevel { pres: number; hght: number; tmpc: number; dwpc: number; drct: number; sknt: number; }
  interface SoundingResponse { profiles?: Array<{ profile: SoundingLevel[]; station: string; }>; }

  const tryFetch = async (h: number): Promise<SoundingResponse | null> => {
    try {
      const res = await fetchWithTimeout(buildUrl(h));
      if (!res.ok) return null;
      const data = await res.json() as SoundingResponse;
      if (!data.profiles?.length || !data.profiles[0].profile?.length) return null;
      return data;
    } catch { return null; }
  };

  const data = (await tryFetch(primaryHour)) ?? (await tryFetch(fallbackHour));
  if (!data?.profiles?.length) return `Sounding unavailable for ${station} — both cycles returned no data.`;

  const levels = data.profiles[0].profile;
  const surface = levels.reduce((a, b) => (a.pres > b.pres ? a : b));
  const keyPressures = [850, 700, 500];

  const relevantLevels = levels.filter(
    (l) => l.pres === surface.pres || keyPressures.some((kp) => Math.abs(l.pres - kp) < 5)
  );

  const lines = [
    `Station: ${station}  Valid: ${data.profiles[0].station ?? "unknown"} UTC`,
    "Pres(mb)  Hght(m)  Temp(C)  Dwpt(C)  WindDir  WindKt",
    ...relevantLevels.map(lvl => {
      const spread = (lvl.tmpc - lvl.dwpc).toFixed(1);
      return `${String(lvl.pres).padStart(8)}  ${String(lvl.hght).padStart(7)}  ${String(lvl.tmpc).padStart(7)}  ${String(lvl.dwpc).padStart(7)}  ${String(lvl.drct).padStart(7)}  ${String(lvl.sknt).padStart(6)}  spread:${spread}`;
    }),
  ];

  const mb850 = levels.find((l) => Math.abs(l.pres - 850) < 5);
  if (mb850) {
    const lapseRate = ((surface.tmpc - mb850.tmpc) / ((mb850.hght - surface.hght) / 1000)).toFixed(2);
    lines.push(`Lapse rate sfc→850mb: ${lapseRate}°C/km (dry adiabatic=9.8, moist=~6.5)`);
  }

  return lines.join("\n").slice(0, 3000);
}

export async function fetchMetars(stations: string[]): Promise<string> {
  const url = `https://aviationweather.gov/api/data/metar?ids=${stations.join(",")}&format=raw&hours=2`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`METAR ${res.status}`);
    return (await res.text()).trim();
  } catch (e) { return `METAR unavailable: ${e}`; }
}

export async function fetchAirmets(): Promise<string> {
  const BAY_AREA_REGIONS = ["SF", "SFO"];
  const RELEVANT_HAZARDS = ["TURB", "IFR", "LLWS", "SFC-WIND", "MT-OBSC", "ICE"];
  interface AirmetItem { region: string; airmetType: string; hazard: string; validTimeFrom: number; validTimeTo: number; top?: number; base?: number; }

  try {
    const res = await fetchWithTimeout("https://aviationweather.gov/api/data/airmet?format=json");
    if (!res.ok) throw new Error(`AIRMET HTTP ${res.status}`);
    const raw = await res.json() as unknown;

    if (!Array.isArray(raw)) {
      console.warn("  ⚠ Unexpected AIRMET shape:", JSON.stringify(raw).slice(0, 200));
      return "AIRMETs: unexpected response format.";
    }
    if (raw.length === 0) return "No active AIRMETs.";

    const items = raw as AirmetItem[];
    const relevant = items.filter(
      (item) => BAY_AREA_REGIONS.includes(item.region?.toUpperCase()) &&
        RELEVANT_HAZARDS.includes(item.hazard?.toUpperCase())
    );

    if (relevant.length === 0) {
      const regions = [...new Set(items.map((i) => i.region))].join(", ");
      return `No active AIRMETs for Bay Area (SF region). Active regions: ${regions}`;
    }

    const now = Date.now() / 1000;
    return relevant.map((item) => {
      const validTo = new Date(item.validTimeTo * 1000).toUTCString().slice(17, 22);
      const altRange = item.base != null && item.top != null ? ` FL${item.base}–FL${item.top}` : item.top != null ? ` below FL${item.top}` : "";
      const active = item.validTimeTo > now ? "" : " [EXPIRED]";
      return `AIRMET ${item.hazard}${altRange} — region ${item.region}, valid until ${validTo}Z${active}`;
    }).join("\n");
  } catch (e) { return `AIRMETs unavailable: ${e}`; }
}

// ── Data Formatting ────────────────────────────────────────────────────────────

export function extractDailySummary(data: OpenMeteoResponse, siteName: string): string {
  const { hourly } = data;
  const today = localDateString();
  const dates = Array.from({ length: 3 }, (_, i) => {
    const d = new Date(localNow());
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  const lines = [`\n=== Open-Meteo: ${siteName} ===`, "Date        Hour  Wind10m        Wind80m   Wind120m  BL_Ht   CAPE  Precip  Cloud"];

  hourly.time.forEach((t, i) => {
    if (!dates.includes(t.slice(0, 10))) return;
    const hour = parseInt(t.slice(11, 13), 10);
    if (hour < 8 || hour > 17) return;
    if (t.slice(0, 10) !== today && hour % 2 !== 0) return;

    const v = (key: keyof typeof hourly): string => {
      const arr = hourly[key] as number[];
      return arr[i] != null ? String(Math.round(arr[i] * 10) / 10) : "N/A";
    };

    lines.push(
      `${t.slice(0, 10)}  ${String(hour).padStart(2, "0")}:00  ` +
      `${v("windspeed_10m")}kn@${v("winddirection_10m")}°  ${v("windspeed_80m")}kn  ` +
      `${v("windspeed_120m")}kn  ${v("boundary_layer_height")}m  ${v("cape")}  ` +
      `${v("precipitation_probability")}%  ${v("cloudcover")}%`
    );
  });

  return lines.join("\n");
}

// ── LLM Brief Generation ───────────────────────────────────────────────────────

const buildSystemPrompt = (sites: Record<string, Site>, date: string): string => {
  const siteList = Object.keys(sites).map(name => `- ${name}`).join("\n");

  return `You are an expert paragliding conditions analyst delivering a daily morning brief to a USHPA P2/P3 pilot flying Bay Area sites.

Today is ${date}.
Sites to cover:
${siteList}

You will be given raw meteorological data (Open-Meteo forecasts, upper-air sounding, METARs, AIRMETs).

CRITICAL: Respond with ONLY a valid JSON object. No markdown, no backticks, no explanation. The response must be parseable by JSON.parse().

The JSON must match this exact schema:
{
  "generatedAt": "<ISO timestamp>",
  "date": "${date}",
  "upperAir": "<2-3 sentence sounding interpretation: inversion height, lapse rate, thermal ceiling, wind shear>",
  "aviationFlags": "<active AIRMETs and METAR anomalies, or 'Clear'>",
  "sites": [
    {
      "name": "<site name>",
      "locationDescriptor": "<e.g. Daly City — coastal ridge, W-facing>",
      "howItWorks": "<1-2 sentences on site mechanics: ridge vs thermal, ideal wind dir/speed>",
      "todaySetup": "<3-5 sentence narrative referencing specific numbers from the data>",
      "hourlyWindows": [
        { "label": "Morning (8–11 AM)", "summary": "<1-2 sentences>" },
        { "label": "Midday (11 AM–2 PM)", "summary": "<1-2 sentences>" },
        { "label": "Afternoon (2–5 PM)", "summary": "<1-2 sentences>" }
      ],
      "verdict": {
        "verdict": "<FLY|MARGINAL|NO FLY>",
        "emoji": "<✅|⚠️|❌>",
        "bestWindow": "<e.g. 11 AM – 1 PM or No viable window>",
        "wind": "<e.g. 8 kts W>",
        "thermals": "<Weak|Moderate|Strong|N/A (ridge site)>",
        "hazards": "<concise hazard summary>",
        "skillLevel": "<e.g. P2+|P3+|P4+ locals only>"
      }
    }
  ],
  "outlook": {
    "tomorrow": "<one sentence per site, site name first>",
    "day2": "<same format>",
    "day3": "<same format>"
  },
  "watchlist": "<anything worth monitoring or 'Nothing flagged'>",
  "tldr": "<2-3 sentences. Best site, best window, one-line reason. Casual tone.>"
}

Rules:
- Every site in the list must appear in the sites array.
- Be direct and specific. Reference actual numbers from the data.
- Coastal sites (Mussel Rock, Fort Funston): ridge lift mechanics, marine layer, sea breeze timing, rotor risk.
- Thermal sites (Ed Levin, inland): thermal quality, valley breeze cycle, sea breeze front arrival.
- P2: light-moderate conditions in benign air only. Flag anything punchy or gusty as beyond their limits.
- P3: moderate-strong conditions. Calibrate language accordingly.
- If a site has no viable window, say so clearly in todaySetup and set verdict to NO FLY.`;
};

export async function generateBrief(
  weatherData: string,
  apiKey: string,
  sites: Record<string, Site>
): Promise<BriefJson> {
  const system = buildSystemPrompt(sites, formatDate());

  const res = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: `Generate my paragliding brief from this data:\n\n${weatherData}` }],
      }),
    },
    240000
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as AnthropicResponse;
  const raw = data.content.find((b) => b.type === "text")?.text ?? "";

  // Strip any accidental markdown fences before parsing
  const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

  try {
    return JSON.parse(cleaned) as BriefJson;
  } catch (e) {
    throw new Error(`Failed to parse Claude response as JSON: ${e}\n\nRaw response:\n${raw.slice(0, 500)}`);
  }
}

// ── Telegram Delivery ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build the compact Telegram message: TL;DR + site verdicts table only */
export function buildTelegramMessage(brief: BriefJson, pagesUrl?: string): string {
  const lines: string[] = [];

  lines.push(`🪂 <b>Paragliding Brief — ${brief.date}</b>`);
  lines.push("");

  // TL;DR
  lines.push(`<b>TL;DR:</b> ${escapeHtml(brief.tldr)}`);
  lines.push("");

  // Compact verdict per site
  lines.push("<b>Site Verdicts:</b>");
  for (const site of brief.sites) {
    const v = site.verdict;
    lines.push(`${v.emoji} <b>${escapeHtml(site.name)}</b> — ${escapeHtml(v.bestWindow)} | ${escapeHtml(v.wind)} | ${escapeHtml(v.skillLevel)}`);
    if (v.hazards && v.hazards.toLowerCase() !== "none") {
      lines.push(`   ⚠ ${escapeHtml(v.hazards)}`);
    }
  }

  lines.push("");
  if (pagesUrl) {
    lines.push("");
    lines.push(`🔗 <a href="${escapeHtml(pagesUrl)}">Full brief & site details</a>`);
  }

  return lines.join("\n");
}

export async function sendTelegram(
  message: string,
  botToken: string,
  chatId: string
): Promise<void> {
  const LIMIT = 3800;
  const chunks: string[] = [];

  if (message.length <= LIMIT) {
    chunks.push(message);
  } else {
    let remaining = message;
    while (remaining.length > LIMIT) {
      let splitAt = remaining.lastIndexOf("\n\n", LIMIT);
      if (splitAt === -1) splitAt = remaining.lastIndexOf("\n", LIMIT);
      if (splitAt === -1) splitAt = LIMIT;
      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining.length > 0) chunks.push(remaining);
  }

  for (const chunk of chunks) {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "HTML" }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram error ${res.status}: ${err}`);
    }
  }
}

// ── Shared Pipeline ────────────────────────────────────────────────────────────

export async function runAgent(config: AgentConfig): Promise<BriefJson> {
  const startTime = new Date().toLocaleTimeString("en-US", { timeZone: LOCAL_TZ });
  console.log(`[${startTime}] Starting paragliding weather agent...`);
  const sites = config.sites ? parseSites(config.sites) : DEFAULT_SITES;
  console.log(`  → Sites: ${Object.keys(sites).join(", ")}`);

  const dataParts: string[] = [];

  for (const [siteName, coords] of Object.entries(sites)) {
    console.log(`  → Fetching Open-Meteo for ${siteName}...`);
    const omData = await fetchOpenMeteo(coords.lat, coords.lon);
    dataParts.push(extractDailySummary(omData, siteName));
  }

  console.log("  → Fetching OAK sounding...");
  const sounding = await fetchSounding(SOUNDING_STATION);
  dataParts.push(`\n=== Sounding Data (OAK ${SOUNDING_STATION}) ===\n${sounding}`);

  console.log("  → Fetching METARs...");
  const metars = await fetchMetars(METAR_STATIONS);
  dataParts.push(`\n=== METARs (${METAR_STATIONS.join(", ")}) ===\n${metars}`);

  console.log("  → Fetching AIRMETs...");
  const airmets = await fetchAirmets();
  dataParts.push(`\n=== AIRMETs (Bay Area) ===\n${airmets}`);

  const combined = dataParts.join("\n");
  console.log(`  → Sending ${combined.length} chars to Claude...`);

  const brief = await generateBrief(combined, config.anthropicApiKey, sites);
  console.log("  → Brief generated.");

  return brief;
}