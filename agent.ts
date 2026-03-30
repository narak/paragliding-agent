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
  tomorrowIoApiKey?: string;
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

export interface OutlookEntry {
  name: string;
  analysis: string;
}

export interface BriefJson {
  generatedAt: string;          // ISO timestamp
  date: string;                 // "Saturday, March 21, 2026"
  upperAir: string;             // sounding interpretation
  aviationFlags: string;        // AIRMETs / METARs summary
  sites: SiteBrief[];
  outlook: {
    tomorrow: OutlookEntry[];
    day2: OutlookEntry[];
    day3: OutlookEntry[];
  };
  watchlist: string[];
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
export const METAR_STATIONS = ["KSFO", "KHAF", "KRHV", "KAPC", "KWVI"];
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

/** Returns the local clock hour of sunset (approximate, ±10 min) for a given lat/lon and date. */
function sunsetLocalHour(lat: number, lon: number, localDate: Date): number {
  const startOfYear = new Date(localDate.getFullYear(), 0, 0);
  const dayOfYear = Math.round((localDate.getTime() - startOfYear.getTime()) / 86400000);
  const decl = 23.45 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81));
  const cosHa = -Math.tan(lat * Math.PI / 180) * Math.tan(decl * Math.PI / 180);
  const hourAngle = cosHa >= 1 ? 0 : cosHa <= -1 ? 180 : Math.acos(cosHa) * 180 / Math.PI;
  const sunsetUtc = (12 - lon / 15) + hourAngle / 15;
  // Derive local UTC offset from the runtime timezone
  const utcMs = new Date(localDate.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const localMs = new Date(localDate.toLocaleString("en-US", { timeZone: LOCAL_TZ })).getTime();
  const utcOffsetHours = (localMs - utcMs) / 3600000;
  return sunsetUtc + utcOffsetHours;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchWithTimeout(url, options, timeoutMs);
    if (res.status !== 429 || attempt === maxRetries) return res;
    const delay = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
    console.warn(`  ⚠ 429 rate limit, retrying in ${delay / 1000}s...`);
    await new Promise(r => setTimeout(r, delay));
  }
  throw new Error("fetchWithRetry: unreachable");
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
  const res = await fetchWithRetry(`https://api.open-meteo.com/v1/forecast?${params}`);
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
    "pres_mb,hght_m,temp_c,dwpt_c,wind_dir,wind_kt,spread_c",
    ...relevantLevels.map(lvl => {
      const spread = (lvl.tmpc - lvl.dwpc).toFixed(1);
      return `${lvl.pres},${lvl.hght},${lvl.tmpc},${lvl.dwpc},${lvl.drct},${lvl.sknt},${spread}`;
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

export async function fetchHrrrSummary(lat: number, lon: number, siteName: string): Promise<string> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    hourly: [
      "windspeed_10m", "winddirection_10m",
      "windspeed_80m", "winddirection_80m",
      "cape", "boundary_layer_height",
      "precipitation_probability", "cloudcover",
    ].join(","),
    wind_speed_unit: "kn",
    forecast_days: "2",  // HRRR only reliable 0-48h
    timezone: LOCAL_TZ,
    models: "gfs_hrrr",
  });
  try {
    const res = await fetchWithRetry(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as OpenMeteoResponse;
    const { hourly } = data;
    const today = localDateString();
    const dates = [today, (() => { const d = new Date(localNow()); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })()];

    const sunset = Math.floor(sunsetLocalHour(lat, lon, localNow()));
    const lines = [`\n=== HRRR Model: ${siteName} ===`, "date,hour,wind10_kn,wind10_dir,wind80_kn,bl_m,cape,precip_pct,cloud_pct"];
    hourly.time.forEach((t, i) => {
      if (!dates.includes(t.slice(0, 10))) return;
      const hour = parseInt(t.slice(11, 13), 10);
      if (hour < 8 || hour > sunset) return;
      if (t.slice(0, 10) !== today && hour % 2 !== 0) return;
      const v = (key: keyof typeof hourly): string => {
        const arr = hourly[key] as number[];
        return arr[i] != null ? String(Math.round(arr[i] * 10) / 10) : "N/A";
      };
      lines.push(
        `${t.slice(0, 10)},${hour},` +
        `${v("windspeed_10m")},${v("winddirection_10m")},${v("windspeed_80m")},` +
        `${v("boundary_layer_height")},${v("cape")},` +
        `${v("precipitation_probability")},${v("cloudcover")}`
      );
    });
    return lines.join("\n");
  } catch (e) {
    return `\n=== HRRR Model: ${siteName} ===\nUnavailable: ${e}`;
  }
}

// NDBC buoys offshore SF: 46026 (SF Bar), 46013 (Bodega Bay), 46012 (Half Moon Bay)
export const NDBC_BUOYS = [
  { id: "46026", name: "SF Bar" },
  { id: "46013", name: "Bodega Bay" },
  { id: "46012", name: "Half Moon Bay" },
];

export async function fetchNdbcBuoys(buoys: { id: string; name: string }[]): Promise<string> {
  const results: string[] = ["\n=== NDBC Ocean Buoys ==="];
  results.push("buoy_id,buoy_name,sst_c,wave_ht_m,wave_period_s,wind_kn,wind_dir,pressure_hpa");

  await Promise.all(buoys.map(async ({ id, name }) => {
    try {
      const res = await fetchWithTimeout(`https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const lines = text.trim().split("\n");
      // Line 0: header, Line 1: units, Line 2+: data (most recent first)
      const dataLine = lines[2];
      if (!dataLine) throw new Error("no data");
      const cols = dataLine.trim().split(/\s+/);
      // Columns: YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
      const wdir   = cols[5]  !== "MM" ? cols[5]  : "N/A";
      const wspd   = cols[6]  !== "MM" ? `${(parseFloat(cols[6]) * 1.944).toFixed(1)}` : "N/A"; // m/s→kts
      const wvht   = cols[8]  !== "MM" ? cols[8]  : "N/A";
      const dpd    = cols[9]  !== "MM" ? cols[9]  : "N/A";
      const pres   = cols[12] !== "MM" ? cols[12] : "N/A";
      const wtmp   = cols[14] !== "MM" ? cols[14] : "N/A";
      results.push(`${id},${name},${wtmp},${wvht},${dpd},${wspd},${wdir},${pres}`);
    } catch (e) {
      results.push(`${(name + " " + id).padEnd(16)}  unavailable: ${e}`);
    }
  }));

  return results.join("\n");
}

interface TomorrowIoResponse {
  timelines: {
    hourly: Array<{
      time: string;
      values: {
        windSpeed: number;
        windDirection: number;
        windGust: number;
        temperature: number;
        cloudCover: number;
        precipitationProbability: number;
        visibility: number;
        pressureSurfaceLevel: number;
      };
    }>;
  };
}

export async function fetchTomorrowIo(lat: number, lon: number, siteName: string, apiKey: string): Promise<string> {
  const params = new URLSearchParams({
    location: `${lat},${lon}`,
    timesteps: "1h",
    units: "metric",
    apikey: apiKey,
  });
  try {
    const res = await fetchWithRetry(`https://api.tomorrow.io/v4/weather/forecast?${params}`, {}, 20000);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json() as TomorrowIoResponse;

    const today = localDateString();
    const dates = Array.from({ length: 2 }, (_, i) => {
      const d = new Date(localNow());
      d.setDate(d.getDate() + i);
      return d.toISOString().slice(0, 10);
    });

    const sunset = Math.floor(sunsetLocalHour(lat, lon, localNow()));
    const lines = [
      `\n=== Tomorrow.io: ${siteName} ===`,
      "date,hour,wind10_kn,wind10_dir,gust_kn,temp_c,cloud_pct,precip_pct,vis_km,pressure_hpa",
    ];

    for (const hour of data.timelines.hourly) {
      const dateStr = hour.time.slice(0, 10);
      if (!dates.includes(dateStr)) continue;
      const h = parseInt(hour.time.slice(11, 13), 10);
      if (h < 8 || h > sunset) continue;
      if (dateStr !== today && h % 2 !== 0) continue;
      const v = hour.values;
      const windKts = (v.windSpeed * 1.944).toFixed(1);
      const gustKts = (v.windGust * 1.944).toFixed(1);
      lines.push(
        `${dateStr},${h},` +
        `${windKts},${Math.round(v.windDirection)},${gustKts},` +
        `${v.temperature.toFixed(1)},${Math.round(v.cloudCover)},` +
        `${Math.round(v.precipitationProbability)},${v.visibility.toFixed(1)},${Math.round(v.pressureSurfaceLevel)}`
      );
    }
    return lines.join("\n");
  } catch (e) {
    return `\n=== Tomorrow.io: ${siteName} ===\nUnavailable: ${e}`;
  }
}

// ── Data Formatting ────────────────────────────────────────────────────────────

export function extractDailySummary(data: OpenMeteoResponse, siteName: string, lat: number, lon: number): string {
  const { hourly } = data;
  const today = localDateString();
  const sunset = Math.floor(sunsetLocalHour(lat, lon, localNow()));
  const dates = Array.from({ length: 3 }, (_, i) => {
    const d = new Date(localNow());
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  const lines = [`\n=== Open-Meteo: ${siteName} ===`, "date,hour,wind10_kn,wind10_dir,wind80_kn,wind120_kn,bl_m,cape,precip_pct,cloud_pct"];

  hourly.time.forEach((t, i) => {
    if (!dates.includes(t.slice(0, 10))) return;
    const hour = parseInt(t.slice(11, 13), 10);
    if (hour < 8 || hour > sunset) return;
    if (t.slice(0, 10) !== today && hour % 2 !== 0) return;

    const v = (key: keyof typeof hourly): string => {
      const arr = hourly[key] as number[];
      return arr[i] != null ? String(Math.round(arr[i] * 10) / 10) : "N/A";
    };

    lines.push(
      `${t.slice(0, 10)},${hour},` +
      `${v("windspeed_10m")},${v("winddirection_10m")},${v("windspeed_80m")},` +
      `${v("windspeed_120m")},${v("boundary_layer_height")},${v("cape")},` +
      `${v("precipitation_probability")},${v("cloudcover")}`
    );
  });

  return lines.join("\n");
}

// ── LLM Brief Generation ───────────────────────────────────────────────────────

const buildSystemPrompt = (sites: Record<string, Site>): string => {
  const siteList = Object.keys(sites).map(name => `- ${name}`).join("\n");

  return `You are an expert paragliding conditions analyst delivering a daily morning brief to a USHPA P2/P3 pilot flying Bay Area sites.

Sites to cover:
${siteList}

You will be given raw meteorological data from multiple sources:
- Open-Meteo (GFS model): 4-day hourly forecast per site
- HRRR model (via Open-Meteo): high-resolution 0-48h forecast per site — prefer HRRR over GFS for today/tomorrow when they disagree, as HRRR is 3km resolution and updated hourly
- Tomorrow.io: independent mesoscale model, hourly surface wind/gust, temperature, cloud, precip, visibility, pressure for today/tomorrow — use gust values to flag punchy conditions
- Upper-air sounding (KOAK): radiosonde profile
- METARs: KSFO (SF Airport), KHAF (Half Moon Bay — key marine layer indicator), KRHV (Reid-Hillview, near Ed Levin), KAPC (Napa, inland gradient), KWVI (Watsonville, south bay marine)
- AIRMETs: aviation hazard advisories
- NDBC ocean buoys: SST, wave height/period, surface wind offshore SF — use sea surface temp and marine wind to assess marine layer depth and burn-off timing for coastal sites

CRITICAL: Respond with ONLY a valid JSON object. No markdown, no backticks, no explanation. The response must be parseable by JSON.parse().

The JSON must match this exact schema:
{
  "generatedAt": "<ISO timestamp>",
  "date": "<the date from the user message, e.g. Saturday, March 21, 2026>",
  "upperAir": "<2-3 sentence sounding interpretation: inversion height, lapse rate, thermal ceiling, wind shear>",
  "aviationFlags": "<active AIRMETs and METAR anomalies, or 'Clear'>",
  "sites": [
    {
      "name": "<site name>",
      "locationDescriptor": "<e.g. Daly City — coastal ridge, W-facing>",
      "howItWorks": "<1-2 sentences on site mechanics: ridge vs thermal, ideal wind dir/speed>",
      "todaySetup": "<3-5 sentence narrative. Lead with the key reason(s) this site is FLY/MARGINAL/NO FLY today — the deciding factor(s) first (e.g. wind too light for ridge lift, marine layer holding, thermals capped). Then give the supporting detail with specific numbers. Do NOT just repeat the hourly windows in prose; explain the underlying atmospheric story.>",
      "hourlyWindows": [
        { "label": "Morning (8–11 AM)", "summary": "<1-2 sentences>" },
        { "label": "Midday (11 AM–2 PM)", "summary": "<1-2 sentences>" },
        { "label": "Afternoon (2 PM–sunset)", "summary": "<1-2 sentences>" }
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
    "tomorrow": [
      {
        "name": "<sitename>",
        "analysis": "<brief site analysis>"
      }
    ],
    "day2": [
      {
        "name": "<sitename>",
        "analysis": "<brief site analysis>"
      }
    ],
    "day3": [
      {
        "name": "<sitename>",
        "analysis": "<brief site analysis>"
      }
    ]
  },
  "watchlist": ["<item worth monitoring, e.g. 'Marine layer may linger past noon'>", "<another item or omit if nothing>"],
  "tldr": "<2-3 sentences. Best site, best window, one-line reason. Casual tone.>"
}

Rules:
- Every site in the list must appear in the sites array.
- Watchlist must be a JSON array of strings (one item per watch item). Use an empty array [] if nothing warrants monitoring.
- Be direct and specific. Reference actual numbers from the data.
- Coastal sites (Mussel Rock, Fort Funston): ridge lift mechanics, marine layer, sea breeze timing, rotor risk. Use KHAF METAR and buoy SST/wave data to assess marine layer depth and burn-off.
- Thermal sites (Ed Levin, inland): thermal quality, valley breeze cycle, sea breeze front arrival. Use KRHV and KAPC METARs for local inland conditions.
- When GFS and HRRR disagree on wind speed or direction for today/tomorrow, note the discrepancy and weight HRRR more heavily.
- Cold SST + high wave period on buoys → stronger/deeper marine layer, later burn-off. Warm SST → shallower layer, earlier clearing.
- P2: light-moderate conditions in benign air only. Flag anything punchy or gusty as beyond their limits.
- P3: moderate-strong conditions. Calibrate language accordingly.
- If a site has no viable window, say so clearly in todaySetup and set verdict to NO FLY.`;
};

export async function generateBrief(
  weatherData: string,
  apiKey: string,
  sites: Record<string, Site>
): Promise<BriefJson> {
  const numSites = Object.keys(sites).length;
  const maxTokens = Math.min(8192, numSites * 2000 + 1000);

  const res = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system: [
          {
            type: "text",
            text: buildSystemPrompt(sites),
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: `Today is ${formatDate()}.\n\nGenerate my paragliding brief from this data:\n\n${weatherData}` }],
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
    console.log(raw);
    throw new Error(`Failed to parse Claude response as JSON: ${e}\n\nRaw response:\n${raw}`);
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
    lines.push("");
    lines.push(`${v.emoji} <b>${escapeHtml(site.name)}</b>`);
    lines.push(`   🕐 ${escapeHtml(v.bestWindow)}  💨 ${escapeHtml(v.wind)}  👤 ${escapeHtml(v.skillLevel)}`);
    if (v.hazards && v.hazards.toLowerCase() !== "none") {
      lines.push(`   ⚠️ ${escapeHtml(v.hazards)}`);
    }
  }

  // Watchlist
  const watchItems = (brief.watchlist ?? []).filter(Boolean);
  if (watchItems.length > 0) {
    lines.push("");
    lines.push("<b>Watchlist:</b>");
    for (const item of watchItems) {
      lines.push(`   • ${escapeHtml(item)}`);
    }
  }

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

export interface WeatherPayload {
  combined: string;
  sites: Record<string, Site>;
}

export async function gatherWeatherData(config: Pick<AgentConfig, "sites" | "tomorrowIoApiKey">): Promise<WeatherPayload> {
  const sites = config.sites ? parseSites(config.sites) : DEFAULT_SITES;
  console.log(`  → Sites: ${Object.keys(sites).join(", ")}`);

  const dataParts: string[] = [];

  // Fetch GFS then HRRR sequentially per site to avoid Open-Meteo rate limits
  // Tomorrow.io runs in parallel (different API, no shared rate limit)
  console.log("  → Fetching Open-Meteo (GFS), HRRR, and Tomorrow.io per site...");
  for (const [siteName, coords] of Object.entries(sites)) {
    const tomorrowPromise = config.tomorrowIoApiKey
      ? fetchTomorrowIo(coords.lat, coords.lon, siteName, config.tomorrowIoApiKey)
      : Promise.resolve(null);

    const omData = await fetchOpenMeteo(coords.lat, coords.lon);
    dataParts.push(extractDailySummary(omData, siteName, coords.lat, coords.lon));
    const hrrrSummary = await fetchHrrrSummary(coords.lat, coords.lon, siteName);
    dataParts.push(hrrrSummary);

    const tomorrowSummary = await tomorrowPromise;
    if (tomorrowSummary) dataParts.push(tomorrowSummary);
  }

  console.log("  → Fetching OAK sounding...");
  const sounding = await fetchSounding(SOUNDING_STATION);
  dataParts.push(`\n=== Sounding Data (${SOUNDING_STATION}) ===\n${sounding}`);

  console.log("  → Fetching METARs, AIRMETs, NDBC buoys...");
  const [metars, airmets, buoys] = await Promise.all([
    fetchMetars(METAR_STATIONS),
    fetchAirmets(),
    fetchNdbcBuoys(NDBC_BUOYS),
  ]);
  dataParts.push(`\n=== METARs (${METAR_STATIONS.join(", ")}) ===\n${metars}`);
  dataParts.push(`\n=== AIRMETs (Bay Area) ===\n${airmets}`);
  dataParts.push(buoys);

  return { combined: dataParts.join("\n"), sites };
}

export async function runAgent(config: AgentConfig): Promise<BriefJson> {
  const startTime = new Date().toLocaleTimeString("en-US", { timeZone: LOCAL_TZ });
  console.log(`[${startTime}] Starting paragliding weather agent...`);

  const { combined, sites } = await gatherWeatherData(config);

  console.log(`  → Sending ${combined.length} chars to Claude...`);

  const brief = await generateBrief(combined, config.anthropicApiKey, sites);
  console.log("  → Brief generated.");

  return brief;
}