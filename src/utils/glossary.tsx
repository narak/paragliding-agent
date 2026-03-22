import { ReactNode, Fragment } from "react"
import GlossaryTerm from "@/components/GlossaryTerm"

const GLOSSARY: Record<string, string> = {
  CAPE: "Convective Available Potential Energy — measures atmospheric instability. Higher values (>500 J/kg) indicate stronger thermal potential.",
  BLH: "Boundary Layer Height — the altitude to which thermals can rise before being capped. Sets the effective thermal ceiling for the day.",
  "boundary layer": "The lowest part of the atmosphere, directly influenced by the ground. Thermals form and stay within this layer.",
  AIRMET: "Airmen's Meteorological Information — advisory issued for conditions hazardous to light aircraft (turbulence, IFR, icing, strong surface winds).",
  METAR: "Meteorological Aerodrome Report — routine aviation weather observation from an airport station, updated hourly.",
  "lapse rate": "The rate at which temperature decreases with altitude. A steep lapse rate (>7°C/km) favours strong thermals; a shallow/inverted rate suppresses them.",
  inversion: "A layer where temperature increases with altitude, trapping thermals and limiting how high you can climb.",
  "sea breeze": "An onshore wind driven by daytime heating of the land. Brings cooler, denser marine air inland and is the primary wind source for coastal sites.",
  "marine layer": "A shallow layer of cool, moist air that forms over the ocean and pushes inland. Can suppress thermals and reduce visibility until it burns off.",
  rotor: "Turbulent, reversing air on the lee side of a ridge or terrain feature. Hazardous for launches and low-level flight.",
  "wind shear": "A rapid change in wind speed or direction over a short distance, creating turbulence and unpredictable conditions.",
  "ridge lift": "Lift generated when wind strikes a slope or ridge and deflects upward. The primary lift source at coastal cliff sites.",
  "thermal": "A rising column of warm air. The primary lift source at inland sites. Strength depends on surface heating and lapse rate.",
  "kts": "Knots — nautical miles per hour. 1 knot ≈ 1.15 mph or 0.51 m/s.",
  "850mb": "The 850 millibar pressure level, roughly 1,500 m (5,000 ft) above sea level. A standard reference for mid-level winds and temperature.",
  "700mb": "The 700 millibar pressure level, roughly 3,000 m (10,000 ft) above sea level.",
  "P2": "USHPA Pilot 2 — intermediate certification. Qualified for unsupervised flight at approved sites in suitable conditions.",
  "P3": "USHPA Pilot 3 — advanced certification. Qualified for more demanding sites and conditions.",
}

// Case-insensitive regex that matches whole words/phrases
const TERM_PATTERN = new RegExp(
  `\\b(${Object.keys(GLOSSARY)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length) // longest first to avoid partial matches
    .join("|")})\\b`,
  "gi"
)

export function highlightGlossary(text: string): ReactNode {
  if (!text) return text
  const parts = text.split(TERM_PATTERN)
  const nodes: ReactNode[] = []
  // Track which terms we've already highlighted to avoid multiple occurrences
  const seen = new Set<string>()

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    const lower = part.toLowerCase()
    // Check if this part matches a glossary term
    const key = Object.keys(GLOSSARY).find(k => k.toLowerCase() === lower)
    if (key && !seen.has(lower)) {
      seen.add(lower)
      nodes.push(<GlossaryTerm key={i} term={part} definition={GLOSSARY[key]} />)
    } else {
      nodes.push(<Fragment key={i}>{part}</Fragment>)
    }
  }
  return <>{nodes}</>
}
