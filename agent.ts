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

export const SITES: Record<string, Site> = {
  "Mussel Rock": { lat: 37.6335, lon: -122.4897 },
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

  const res = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  return res.json() as Promise<OpenMeteoResponse>;
}

export async function fetchSounding(station: string): Promise<string> {
  // IEM (Iowa State) JSON sounding API — reliable near-real-time data from SPC.
  // Replaces the Wyoming bufrraob endpoint which is consistently unreliable.
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

  interface SoundingLevel {
    pressure: number;
    height: number;
    tmpc: number;
    dwpc: number;
    drct: number;
    speed: number;
    levelcode: number;
  }
  interface SoundingResponse {
    profiles?: Array<{
      station: string;
      valid: string;
      profile: SoundingLevel[];
      sbcape?: number;
      sbcin?: number;
      pwater?: number;
      lcl_hght?: number;
      lfc_pressure?: number;
      el_hght?: number;
      total_totals?: number;
      sweat_index?: number;
      lifted_index?: number;
    }>;
  }

  const tryFetch = async (h: number): Promise<SoundingResponse | null> => {
    try {
            console.log('buildUrl', buildUrl(h));

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
  console.log('data', JSON.stringify(data, undefined, '  '));

  if (!data?.profiles?.length) {
    return `Sounding unavailable for ${station} — both cycles returned no data.`;
  }

  const p = data.profiles[0];
  const lines: string[] = [
    `Station: ${p.station}  Valid: ${p.valid} UTC`,
    `Lifted Index: ${p.lifted_index ?? "N/A"}`,
    `SBCAPE: ${p.sbcape ?? "N/A"} J/kg  SBCIN: ${p.sbcin ?? "N/A"} J/kg`,
    `Precipitable Water: ${p.pwater ?? "N/A"} mm`,
    `LCL Height: ${p.lcl_hght ?? "N/A"}m  LFC: ${p.lfc_pressure ?? "N/A"}mb  EL: ${p.el_hght ?? "N/A"}m`,
    `Total Totals: ${p.total_totals ?? "N/A"}  SWEAT Index: ${p.sweat_index ?? "N/A"}`,
    "",
    "Pres(mb)  Hght(m)  Temp(C)  Dwpt(C)  WindDir  WindKt",
  ];

  // Surface + key pressure levels for paragliding (850mb ~1500m, 700mb ~3000m)
  const keyPressures = [850, 700, 500];
  const relevantLevels = p.profile.filter(
    (l) => l.levelcode === 9 || keyPressures.some((kp) => Math.abs(l.pressure - kp) < 5)
  );

  for (const lvl of relevantLevels) {
    lines.push(
      `${String(lvl.pressure).padStart(8)}  ` +
      `${String(lvl.height).padStart(7)}  ` +
      `${String(lvl.tmpc).padStart(7)}  ` +
      `${String(lvl.dwpc).padStart(7)}  ` +
      `${String(lvl.drct).padStart(7)}  ` +
      `${String(lvl.speed).padStart(6)}`
    );
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
  try {
    const res = await fetchWithTimeout("https://aviationweather.gov/api/data/airmet?format=json");
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

    return relevant.length > 0 ? relevant.join("\n") : "No active AIRMETs for the Bay Area.";
  } catch (e) {
    return `AIRMET fetch failed: ${e}`;
  }
}

// ── Data Formatting ────────────────────────────────────────────────────────────

export function extractDailySummary(data: OpenMeteoResponse, siteName: string): string {
  const { hourly } = data;

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
    if (!dates.includes(t.slice(0, 10))) return;
    const hour = parseInt(t.slice(11, 13), 10);
    if (hour < 7 || hour > 18) return;

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

export async function generateBrief(weatherData: string, apiKey: string): Promise<string> {
  const system = SYSTEM_PROMPT.replace("{date}", formatDate());

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

export async function sendTelegram(
  message: string,
  botToken: string,
  chatId: string
): Promise<void> {
  const chunks: string[] = [];
  for (let i = 0; i < message.length; i += 4000) {
    chunks.push(message.slice(i, i + 4000));
  }

  for (const chunk of chunks) {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
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

  const dataParts: string[] = [];

  for (const [siteName, coords] of Object.entries(SITES)) {
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
//   console.log(`  → Sending ${combined.length} chars to Claude...`);
console.log(combined);

//   const brief = await generateBrief(combined, config.anthropicApiKey);
//   console.log("  → Brief generated.");

  return brief;
}