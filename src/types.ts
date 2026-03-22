export interface HourlyWindow {
  label: string;
  summary: string;
}

export interface SiteVerdict {
  verdict: 'FLY' | 'MARGINAL' | 'NO FLY';
  emoji: string;
  bestWindow: string;
  wind: string;
  thermals: string;
  hazards: string;
  skillLevel: string;
}

export interface SiteEntry {
  name: string;
  locationDescriptor: string;
  verdict: SiteVerdict;
  todaySetup: string;
  hourlyWindows: HourlyWindow[];
  howItWorks: string;
}

export interface OutlookEntry {
  name: string;
  analysis: string;
}

export interface Outlook {
  tomorrow: OutlookEntry[];
  day2: OutlookEntry[];
  day3: OutlookEntry[];
}

export interface BriefJson {
  date: string;
  generatedAt: string;
  tldr: string;
  upperAir: string;
  aviationFlags: string;
  sites: SiteEntry[];
  outlook: Outlook;
  watchlist: string;
}
