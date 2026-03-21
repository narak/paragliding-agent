#!/usr/bin/env node
/**
 * Paragliding Weather Agent (TypeScript)
 * Fetches multi-source weather data and generates a daily flying brief via Claude.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

interface Site {
  lat: number;
  lon: number;
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

const SITES: Record<string, Site> = {
  "Mussel Rock": { lat: 37.6335, lon: -122.4897},
};

const SOUNDING_STATION = "72493"; // Oakland upper-air station
const METAR_STATIONS = ["KSFO", "KHAF"]; // SFO + Half Moon Bay
const LOCAL_TZ = "America/Los_Angeles";

// Required env vars — fail fast if missing
const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");
const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = requireEnv("TELEGRAM_CHAT_ID");

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function localNow(): Date {
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

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// ── Data Fetchers ──────────────────────────────────────────────────────────────

async function fetchOpenMeteo(lat: number, lon: number): Promise<OpenMeteoResponse> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    hourly: [
      "temperature_2m",
      "windspeed_10m", "winddirection_10m",
      "windspeed_80m", "winddirection_80m",
      "windspeed_120m", "winddirection_120m",
      "windspeed_180m", "winddirection_180m",
      "cape",
      "boundary_layer_height",
      "precipitation_probability",
      "cloudcover",
      "visibility",
    ].join(","),
    wind_speed_unit: "kn",
    forecast_days: "4",
    timezone: LOCAL_TZ,
  });

  const res = await fetchWithTimeout(
    `https://api.open-meteo.com/v1/forecast?${params}`
  );
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  return res.json() as Promise<OpenMeteoResponse>;
}

async function fetchSounding(station: string): Promise<string> {
  const nowUtc = new Date();
  const hour = nowUtc.getUTCHours() >= 12 ? 12 : 0;
  const dateStr = nowUtc.toISOString().slice(0, 10).replace(/-/g, "");

  const buildUrl = (h: number) =>
    `https://weather.uwyo.edu/cgi-bin/bufrraob.py` +
    `?station=${station}&time=${dateStr}${String(h).padStart(2, "0")}00&type=TEXT%3ALIST`;

  try {
    let res = await fetchWithTimeout(buildUrl(hour));
    if (!res.ok || (await res.clone().text()).length < 200) {
      // Fallback to alternate cycle
      res = await fetchWithTimeout(buildUrl(hour === 12 ? 0 : 12));
    }
    const text = await res.text();
    return text.slice(0, 4000); // Trim to avoid token overflow
  } catch (e) {
    return `Sounding unavailable: ${e}`;
  }
}

async function fetchMetars(stations: string[]): Promise<string> {
  const ids = stations.join(",");
  const url = `https://aviationweather.gov/api/data/metar?ids=${ids}&format=raw&hours=2`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`METAR ${res.status}`);
    return (await res.text()).trim();
  } catch (e) {
    return `METAR unavailable: ${e}`;
  }
}

async function fetchAirmets(): Promise<string> {
  try {
    const res = await fetchWithTimeout(
      "https://aviationweather.gov/api/data/airmet?format=json"
    );
    if (!res.ok) throw new Error(`AIRMET ${res.status}`);
    const data = await res.json() as { features: Array<{ properties: Record<string, string> }> };

    const relevant = data.features
      .map((f) => f.properties)
      .filter((p) => {
        const hazard = p.hazard ?? "";
        const area = JSON.stringify(p.area ?? "");
        return (
          ["TURB", "IFR", "LLWS"].includes(hazard) &&
          ["SFO", "OAK", "ZOA"].some((id) => area.includes(id))
        );
      })
      .map((p) => `AIRMET ${p.hazard}: ${p.synopsis ?? "See full advisory"}`);

    return relevant.length > 0
      ? relevant.join("\n")
      : "No active AIRMETs for the Bay Area.";
  } catch (e) {
    return `AIRMET fetch failed: ${e}`;
  }
}

// ── Data Formatting ────────────────────────────────────────────────────────────

function extractDailySummary(data: OpenMeteoResponse, siteName: string): string {
  const { hourly } = data;
  const today = localDateString();

  // Build next 4 date strings
  const dates = Array.from({ length: 4 }, (_, i) => {
    const d = new Date(localNow());
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  const lines: string[] = [
    `\n=== Open-Meteo: ${siteName} ===`,
    "Date        Hour  Wind10m        Wind80m   Wind120m  BL_Ht   CAPE  Precip  Cloud",
  ];

  hourly.time.forEach((t, i) => {
    const date = t.slice(0, 10);
    if (!dates.includes(date)) return;

    const hour = parseInt(t.slice(11, 13), 10);
    if (hour < 7 || hour > 18) return; // Flying window only

    const v = (key: keyof typeof hourly): string => {
      const arr = hourly[key] as number[];
      return arr[i] != null ? String(Math.round(arr[i] * 10) / 10) : "N/A";
    };

    lines.push(
      `${date}  ${String(hour).padStart(2, "0")}:00  ` +
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

const SYSTEM_PROMPT = `You are a paragliding conditions analyst for a USHPA P2/P3 pilot 
flying coastal sites (primarily Mussel Rock, Daly City, CA) and thermal/desert sites.

Given raw meteorological data from multiple sources, produce a concise morning brief.

Format your response EXACTLY as follows (use plain text, no markdown):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🪂 PARAGLIDING BRIEF — {date}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TODAY — MUSSEL ROCK
Verdict: [FLY ✅ / MARGINAL ⚠️ / NO FLY ❌]  Confidence: [High/Med/Low]
Window: [e.g., 11 AM – 2 PM PDT or "No viable window"]
Surface wind: [X kts @ Y° — characterize: onshore/offshore/cross]
Wind at 80m: [X kts @ Y°]
Wind at 120m: [X kts @ Y°]
Boundary layer: [Xm AGL — what this means for soaring ceiling]
CAPE: [value + instability assessment]
Thermal quality: [Weak/Moderate/Strong + reasoning]
Sea breeze onset: [estimated time or N/A]
Precip risk: [X%]
Hazards: [rotor risk, gradient issues, overdevelopment, marine layer burn-off time]

SOUNDING (OAK):
[2-3 sentences: inversion layers, lifted index, wind shear, thermal ceiling implication]

AVIATION FLAGS:
[Any active AIRMETs or METAR anomalies worth noting. "Clear" if none.]

3-DAY OUTLOOK:
Tomorrow: [one sentence verdict + key factor]
Day 2: [one sentence]
Day 3: [one sentence]

WATCHLIST:
[Anything worth monitoring or calling the site pilot about. "Nothing flagged" if clean.]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Be direct. No filler sentences. Prioritize safety without being overly conservative.
A P3 pilot can handle moderate conditions — call them accurately.`;

async function generateBrief(weatherData: string): Promise<string> {
  const system = SYSTEM_PROMPT.replace("{date}", formatDate());

  const res = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system,
        messages: [
          {
            role: "user",
            content: `Generate my morning paragliding brief from this data:\n\n${weatherData}`,
          },
        ],
      }),
    },
    30000
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as AnthropicResponse;
  return data.content.find((b) => b.type === "text")?.text ?? "No brief generated.";
}

// ── Telegram Delivery ──────────────────────────────────────────────────────────

async function sendTelegram(message: string): Promise<void> {
  // Telegram hard limit is 4096 chars — chunk if needed
  const chunks: string[] = [];
  for (let i = 0; i < message.length; i += 4000) {
    chunks.push(message.slice(i, i + 4000));
  }

  for (const chunk of chunks) {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: chunk }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram error ${res.status}: ${err}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = new Date().toLocaleTimeString("en-US", { timeZone: LOCAL_TZ });
  console.log(`[${startTime}] Starting paragliding weather agent...`);

  const dataParts: string[] = [];

  // 1. Open-Meteo for each site
  for (const [siteName, coords] of Object.entries(SITES)) {
    console.log(`  → Fetching Open-Meteo for ${siteName}...`);
    const omData = await fetchOpenMeteo(coords.lat, coords.lon);
    dataParts.push(extractDailySummary(omData, siteName));
  }

  // 2. Sounding data
  console.log("  → Fetching OAK sounding...");
  const sounding = await fetchSounding(SOUNDING_STATION);
  dataParts.push(`\n=== Sounding Data (OAK ${SOUNDING_STATION}) ===\n${sounding}`);

  // 3. METARs
  console.log("  → Fetching METARs...");
  const metars = await fetchMetars(METAR_STATIONS);
  dataParts.push(`\n=== METARs (${METAR_STATIONS.join(", ")}) ===\n${metars}`);

  // 4. AIRMETs
  console.log("  → Fetching AIRMETs...");
  const airmets = await fetchAirmets();
  dataParts.push(`\n=== AIRMETs (Bay Area) ===\n${airmets}`);

  // Combine all data
  const combined = dataParts.join("\n");
  console.log(`  → Sending ${combined.length} chars to Claude...`);

  // 5. Generate brief
  const brief = await generateBrief(combined);
  console.log("  → Brief generated.");

  // 6. Deliver
  await sendTelegram(brief);
  console.log("  → Sent to Telegram. Done.");
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});
