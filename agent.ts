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
}

/**
 * Parse the SITES env var into a typed map.
 * Format: "Site Name:lat,lon\nSite Name 2:lat,lon"
 * Example: "Mussel Rock:37.6335,-122.4897\nEd Levin:37.4683,-121.853"
 */
export function parseSites(raw: string): Record<string, Site> {
  const sites: Record<string, Site> = {};
  for (const entry of raw.split("\n")) {
    const [name, coords] = entry.split(":");
    if (!name || !coords) continue;
    const [lat, lon] = coords.split(",").map(Number);
    if (isNaN(lat) || isNaN(lon)) {
      console.warn(`  ⚠ Skipping invalid site entry: "${entry}"`);
      continue;
    }
    sites[name.trim()] = { lat, lon };
  }
  if (Object.keys(sites).length === 0) {
    throw new Error("SITES env var parsed to empty — check format: 'Name:lat,lon\nName2:lat,lon\'");
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
    windspeed_180m: number[];
    winddirection_180m: number[];
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

// SITES is no longer hardcoded — parsed from the SITES env var via parseSites()
// Default fallback used only when running tests without env
export const DEFAULT_SITES: Record<string, Site> = {
  "Mussel Rock": { lat: 37.6335, lon: -122.4897 },
  "Ed Levin":    { lat: 37.4683, lon: -121.8530 },
};

export const SOUNDING_STATION = "KOAK"; // Oakland — IEM uses ICAO identifiers
export const METAR_STATIONS = ["KSFO", "KHAF"]; // SFO + Half Moon Bay
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
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
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
      "cape",
      "boundary_layer_height",
      "precipitation_probability",
      "cloudcover",
      "visibility",
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
  // IEM (Iowa State) JSON sounding API — reliable near-real-time data from SPC.
  // Soundings launch at 00Z and 12Z. We try the most recent cycle first,
  // then fall back to the prior one if balloon data isn't uploaded yet.
  const nowUtc = new Date();
  const hour = nowUtc.getUTCHours() >= 12 ? 12 : 0;

  const buildTimestamp = (date: Date, h: number): string => {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}${String(h).padStart(2, "0")}00`;
  };

  // If we're <30 min past cycle launch, data may not be up yet — try prior cycle first
  const minPastCycle = nowUtc.getUTCMinutes() + (nowUtc.getUTCHours() - hour) * 60;
  const primaryHour = minPastCycle < 30 ? (hour === 12 ? 0 : 12) : hour;
  const fallbackHour = primaryHour === 12 ? 0 : 12;

  const buildUrl = (h: number) =>
    `https://mesonet.agron.iastate.edu/json/raob.py` +
    `?ts=${buildTimestamp(nowUtc, h)}&station=${station}&fmt=json`;

  // Actual field names from IEM API response
  interface SoundingLevel {
    pres: number;   // pressure mb
    hght: number;   // height m ASL
    tmpc: number;   // temp C
    dwpc: number;   // dewpoint C
    drct: number;   // wind direction degrees
    sknt: number;   // wind speed knots
  }
  interface SoundingResponse {
    profiles?: Array<{
      profile: SoundingLevel[];
      station: string;
    }>;
  }

  const tryFetch = async (h: number): Promise<SoundingResponse | null> => {
    try {
      const res = await fetchWithTimeout(buildUrl(h));
      if (!res.ok) return null;
      const data = await res.json() as SoundingResponse;
      if (!data.profiles?.length || !data.profiles[0].profile?.length) return null;
      return data;
    } catch {
      return null;
    }
  };

  const data = (await tryFetch(primaryHour)) ?? (await tryFetch(fallbackHour));

  if (!data?.profiles?.length) {
    return `Sounding unavailable for ${station} — both cycles returned no data.`;
  }

  const levels = data.profiles[0].profile;
  const ts = data.profiles[0].station ?? "unknown";

  const lines: string[] = [
    `Station: ${station}  Valid: ${ts} UTC`,
    "",
    "Pres(mb)  Hght(m)  Temp(C)  Dwpt(C)  WindDir  WindKt",
  ];

  // Surface level + key pressure levels for paragliding (850mb ~1500m, 700mb ~3000m, 500mb ~5500m)
  const keyPressures = [850, 700, 500];
  const surface = levels.reduce((a, b) => (a.pres > b.pres ? a : b)); // highest pressure = surface

  const relevantLevels = levels.filter(
    (l) =>
      l.pres === surface.pres ||
      keyPressures.some((kp) => Math.abs(l.pres - kp) < 5)
  );

  for (const lvl of relevantLevels) {
    // Derived: temp/dewpoint spread indicates moisture/cloud base
    const spread = (lvl.tmpc - lvl.dwpc).toFixed(1);
    lines.push(
      `${String(lvl.pres).padStart(8)}  ` +
      `${String(lvl.hght).padStart(7)}  ` +
      `${String(lvl.tmpc).padStart(7)}  ` +
      `${String(lvl.dwpc).padStart(7)}  ` +
      `${String(lvl.drct).padStart(7)}  ` +
      `${String(lvl.sknt).padStart(6)}  spread:${spread}`
    );
  }

  // Surface-based instability: simple lapse rate between surface and 850mb
  const sfc = surface;
  const mb850 = levels.find((l) => Math.abs(l.pres - 850) < 5);
  if (sfc && mb850) {
    const lapseRate = ((sfc.tmpc - mb850.tmpc) / ((mb850.hght - sfc.hght) / 1000)).toFixed(2);
    lines.push(`\nLapse rate surface→850mb: ${lapseRate}°C/km (dry adiabatic = 9.8, moist = ~6.5)`);
  }

  return lines.join("\n").slice(0, 3000);
}

export async function fetchMetars(stations: string[]): Promise<string> {
  const url = `https://aviationweather.gov/api/data/metar?ids=${stations.join(",")}&format=raw&hours=2`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`METAR ${res.status}`);
    return (await res.text()).trim();
  } catch (e) {
    return `METAR unavailable: ${e}`;
  }
}

export async function fetchAirmets(): Promise<string> {
  // Bay Area falls under SFO ARTCC. The API uses two-letter region codes.
  // From observed responses: "SF" = San Francisco region (ZOA ARTCC).
  const BAY_AREA_REGIONS = ["SF", "SFO"];
  const RELEVANT_HAZARDS = ["TURB", "IFR", "LLWS", "SFC-WIND", "MT-OBSC", "ICE"];

  interface AirmetItem {
    region: string;
    airmetType: string;
    hazard: string;
    validTimeFrom: number;
    validTimeTo: number;
    top?: number;
    base?: number;
    receiptTime?: string;
  }

  try {
    const res = await fetchWithTimeout(
      "https://aviationweather.gov/api/data/airmet?format=json"
    );
    if (!res.ok) throw new Error(`AIRMET HTTP ${res.status}`);

    const raw = await res.json() as unknown;

    if (!Array.isArray(raw)) {
      console.warn("  ⚠ Unexpected AIRMET shape:", JSON.stringify(raw).slice(0, 200));
      return "AIRMETs: unexpected response format.";
    }

    if (raw.length === 0) return "No active AIRMETs.";

    const items = raw as AirmetItem[];

    const relevant = items.filter(
      (item) =>
        BAY_AREA_REGIONS.includes(item.region?.toUpperCase()) &&
        RELEVANT_HAZARDS.includes(item.hazard?.toUpperCase())
    );

    if (relevant.length === 0) {
      const regions = [...new Set(items.map((i) => i.region))].join(", ");
      return `No active AIRMETs for Bay Area (SF region). Active regions: ${regions}`;
    }

    const now = Date.now() / 1000;
    return relevant
      .map((item) => {
        const validTo = new Date(item.validTimeTo * 1000).toUTCString().slice(17, 22);
        const altRange =
          item.base != null && item.top != null
            ? ` FL${item.base}–FL${item.top}`
            : item.top != null
            ? ` below FL${item.top}`
            : "";
        const active = item.validTimeTo > now ? "" : " [EXPIRED]";
        return `AIRMET ${item.hazard}${altRange} — region ${item.region}, valid until ${validTo}Z${active}`;
      })
      .join("\n");
  } catch (e) {
    return `AIRMETs unavailable: ${e}`;
  }
}

// ── Data Formatting ────────────────────────────────────────────────────────────

export function extractDailySummary(data: OpenMeteoResponse, siteName: string): string {
  const { hourly } = data;

  const dates = Array.from({ length: 3 }, (_, i) => {
    const d = new Date(localNow());
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  const lines: string[] = [
    `\n=== Open-Meteo: ${siteName} ===`,
    "Date        Hour  Wind10m        Wind80m   Wind120m  BL_Ht   CAPE  Precip  Cloud",
  ];

  const today = localDateString();
  hourly.time.forEach((t, i) => {
    if (!dates.includes(t.slice(0, 10))) return;
    const hour = parseInt(t.slice(11, 13), 10);
    if (hour < 8 || hour > 17) return; // 8 AM–5 PM flying window
    // For days 2+, only emit every 2 hours to keep context size manageable
    if (t.slice(0, 10) !== today && hour % 2 !== 0) return;

    const v = (key: keyof typeof hourly): string => {
      const arr = hourly[key] as number[];
      return arr[i] != null ? String(Math.round(arr[i] * 10) / 10) : "N/A";
    };

    lines.push(
      `${t.slice(0, 10)}  ${String(hour).padStart(2, "0")}:00  ` +
      `${v("windspeed_10m")}kn@${v("winddirection_10m")}°  ` +
      `${v("windspeed_80m")}kn  ` +
      `${v("windspeed_120m")}kn  ` +
      `${v("boundary_layer_height")}m  ` +
      `${v("cape")}  ` +
      `${v("precipitation_probability")}%  ` +
      `${v("cloudcover")}%`
    );
  });

  return lines.join("\n");
}

// ── LLM Brief Generation ───────────────────────────────────────────────────────

const buildSystemPrompt = (sites: Record<string, Site>, date: string): string => {
  const siteList = Object.entries(sites)
    .map(([name]) => `- ${name}`)
    .join("\n");

  return `You are an expert paragliding conditions analyst delivering a daily morning brief to a USHPA P2/P3 pilot flying Bay Area sites.

Today is ${date}.

Sites to cover:
${siteList}

You will be given raw meteorological data (Open-Meteo forecasts, upper-air sounding, METARs, AIRMETs) for each site.

Write a rich, narrative-style brief in the following format. Use emoji sparingly for verdicts only.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🪂 PARAGLIDING BRIEF — ${date}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

UPPER AIR & SOUNDING (OAK):
[2-3 sentences interpreting the sounding: inversion height, lapse rate, thermal ceiling, wind shear between surface and 850/700mb. This sets context for all sites.]

AVIATION FLAGS:
[Active AIRMETs or METAR anomalies. State "Clear" if none.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Then for EACH site, write a section in this format:

[EMOJI] [SITE NAME] ([location descriptor])

How it works: [1-2 sentences on what conditions this site needs — ridge lift vs thermal, ideal wind direction/speed, key terrain features that matter]

Today's setup:
[3-5 sentences of narrative analysis — how the forecast data plays out for this specific site, what the wind profile looks like through the day, what the sea breeze or thermal cycle will do, what to watch for. Reference specific numbers from the data.]

Hour-by-hour outlook:
Morning ([time range]): [1-2 sentences]
Midday ([time range]): [1-2 sentences]
Afternoon ([time range]): [1-2 sentences]

[SITE NAME] Verdict: [FLY ✅ / MARGINAL ⚠️ / NO FLY ❌] — [1 sentence summary with recommended pilot skill level and best window]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SITE COMPARISON:
[A pipe-delimited table. First row is the header, each subsequent row is one site. Columns: Site | Best Window | Wind | Thermals | Hazards | Verdict]
[Every row must start and end with a pipe character like: | Mussel Rock | 11am-1pm | 8kts W | N/A | Rotor risk | MARGINAL ⚠️ |]

3-DAY OUTLOOK:
Tomorrow: [one sentence per site, comma-separated]
Day 2: [same]
Day 3: [same]

WATCHLIST:
[Anything worth a call to the site pilot or extra monitoring. "Nothing flagged" if clean.]

TL;DR:
[2-3 sentences max. Best site today, best window, one-line reason. Written like a text to a friend who has 10 seconds to read it.]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Rules:
- Be direct, specific and succinct. Reference actual numbers from the data.
- Do not pad with generic safety disclaimers. This pilot knows the sites.
- Coastal sites (Mussel Rock, Fort Funston): focus on ridge lift mechanics, marine layer, sea breeze timing, rotor risk from NW/NE winds.
- Thermal sites (Ed Levin, inland): focus on thermal quality, valley breeze cycle, sea breeze front arrival, afternoon instability.
- P2 can handle light-moderate conditions in benign air — flag anything punchy, gusty, or requiring active piloting as beyond their limits.
- P3 can handle moderate-strong conditions — calibrate language accordingly.
- If a site has no viable window, say so clearly and move on.`;
};

export async function generateBrief(
  weatherData: string,
  apiKey: string,
  sites: Record<string, Site>
): Promise<string> {
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
        messages: [
          {
            role: "user",
            content: `Generate my morning paragliding brief from this data:\n\n${weatherData}`,
          },
        ],
      }),
    },
    240000
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as AnthropicResponse;
  return data.content.find((b) => b.type === "text")?.text ?? "No brief generated.";
}

// ── Telegram Delivery ──────────────────────────────────────────────────────────

/** Escape special HTML chars so Telegram's HTML parse_mode doesn't choke */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wrap the brief in Telegram HTML formatting:
 * - SITE COMPARISON table rows → <pre> for monospace (fixes column wrapping)
 * - Everything else → plain escaped text
 */
function formatForTelegram(message: string): string {
  const lines = message.split("\n");
  const out: string[] = [];
  let inTable = false;

  for (const line of lines) {
    const isTableRow = line.trim().startsWith("|") && line.trim().endsWith("|");

    if (isTableRow) {
      if (!inTable) { out.push("<pre>"); inTable = true; }
      out.push(escapeHtml(line));
    } else {
      if (inTable) { out.push("</pre>"); inTable = false; }
      out.push(escapeHtml(line));
    }
  }
  if (inTable) out.push("</pre>");

  return out.join("\n");
}

export async function sendTelegram(
  message: string,
  botToken: string,
  chatId: string
): Promise<void> {
  // Split on paragraph boundaries so messages never cut mid-sentence.
  // Telegram hard limit is 4096 chars — we target 3800 to leave headroom.
  const chunks: string[] = [];
  const LIMIT = 3800;

  if (message.length <= LIMIT) {
    chunks.push(message);
  } else {
    let remaining = message;
    while (remaining.length > LIMIT) {
      // Find the last double-newline within the limit
      let splitAt = remaining.lastIndexOf("\n\n", LIMIT);
      // Fall back to last single newline if no paragraph break found
      if (splitAt === -1) splitAt = remaining.lastIndexOf("\n", LIMIT);
      // Last resort: hard cut at limit
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
        body: JSON.stringify({
          chat_id: chatId,
          text: formatForTelegram(chunk),
          parse_mode: "HTML",
        }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram error ${res.status}: ${err}`);
    }
  }
}

// ── Shared Pipeline ────────────────────────────────────────────────────────────

export async function runAgent(config: AgentConfig): Promise<string> {
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