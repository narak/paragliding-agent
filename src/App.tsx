import { useState, useEffect } from "react"
import { Wind, Radio, Eye, TriangleAlert } from "lucide-react"
import { BriefJson } from "@/types"
import { todayMmdd, mmddToLabel } from "@/utils"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import DateNav from "@/components/DateNav"
import StateMsg from "@/components/StateMsg"
import SiteCard from "@/components/SiteCard"
import OutlookMatrix from "@/components/OutlookMatrix"
import { highlightGlossary } from "@/utils/glossary"

export default function App() {
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [currentIdx, setCurrentIdx] = useState(-1)
  const [brief, setBrief] = useState<BriefJson | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function init() {
      try {
        const res = await fetch("./briefs/manifest.json?t=" + Date.now())
        if (!res.ok) throw new Error("manifest not found — has the agent run yet?")
        const dates: string[] = await res.json()
        setAvailableDates(dates)
        const today = todayMmdd()
        const todayIdx = dates.indexOf(today)
        setCurrentIdx(todayIdx !== -1 ? todayIdx : dates.length - 1)
      } catch (e) {
        setError(String(e))
        setLoading(false)
      }
    }
    init()
  }, [])

  useEffect(() => {
    if (currentIdx < 0 || availableDates.length === 0) return
    async function loadBrief() {
      setLoading(true)
      setError(null)
      setBrief(null)
      const mmdd = availableDates[currentIdx]
      try {
        const res = await fetch(`./briefs/${mmdd}.json?t=` + Date.now())
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setBrief(await res.json())
      } catch (e) {
        setError(`Could not load brief for ${mmddToLabel(mmdd)}: ${String(e)}`)
      } finally {
        setLoading(false)
      }
    }
    loadBrief()
  }, [currentIdx, availableDates])

  const today = todayMmdd()
  const currentMmdd = availableDates[currentIdx] ?? ""

  const generatedAt = brief?.generatedAt
    ? new Date(brief.generatedAt).toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      }) + " PT"
    : ""

  return (
    <div className="min-h-screen bg-background">
      {/* Top nav bar */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="text-xl">🪂</span>
            <span className="font-bold text-base tracking-tight">Paragliding Brief</span>
          </div>
          <div className="flex items-center gap-3">
            <DateNav
              availableDates={availableDates}
              currentIdx={currentIdx}
              onNavigate={setCurrentIdx}
              today={today}
            />
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-5xl mx-auto px-4 py-6 pb-20">
        {loading && (
          <StateMsg icon="⏳" message={currentMmdd ? `Loading ${mmddToLabel(currentMmdd)}…` : "Loading…"} />
        )}
        {!loading && error && <StateMsg icon="⚠️" message={error} />}
        {!loading && brief && (
          <BriefView brief={brief} isToday={currentMmdd === today} mmdd={currentMmdd} generatedAt={generatedAt} />
        )}
      </main>
    </div>
  )
}

function BriefView({
  brief,
  isToday,
  mmdd,
  generatedAt,
}: {
  brief: BriefJson
  isToday: boolean
  mmdd: string
  generatedAt: string
}) {
  const flagsClear = (brief.aviationFlags ?? "").toLowerCase().trim() === "clear"
  const watchClear = (brief.watchlist ?? []).length === 0

  return (
    <div className="space-y-4">
      {/* Historical banner */}
      {!isToday && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-4 py-2.5 text-sm text-muted-foreground">
          <span>📅</span>
          <span>
            Historical brief for <strong className="text-foreground">{brief.date ?? mmddToLabel(mmdd)}</strong> — compare with actual conditions to calibrate accuracy
          </span>
        </div>
      )}

      {/* TL;DR */}
      <div className="rounded-lg border border-primary/30 bg-gradient-to-br from-primary/5 to-primary/10 px-5 py-4">
        <div className="text-[10px] font-bold uppercase tracking-widest text-primary mb-2">TL;DR</div>
        <p className="text-sm leading-relaxed">{brief.tldr}</p>
      </div>

      {/* Site cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(brief.sites ?? []).map(site => (
          <SiteCard key={site.name} site={site} />
        ))}
      </div>

      {/* 3-Day Outlook */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-1.5">
            <Eye className="h-3 w-3" /> 3-Day Outlook
          </CardTitle>
        </CardHeader>
        <CardContent>
          <OutlookMatrix outlook={brief.outlook} />
        </CardContent>
      </Card>

      {/* Watchlist */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-1.5">
            <TriangleAlert className="h-3 w-3" /> Watchlist
          </CardTitle>
        </CardHeader>
        <CardContent>
          {watchClear ? (
            <p className="text-sm text-muted-foreground">Nothing flagged.</p>
          ) : (
            <ul className="space-y-1.5">
              {brief.watchlist.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-marginal">
                  <span className="mt-0.5 shrink-0">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      
      {/* Upper air + aviation flags */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-1.5">
              <Wind className="h-3 w-3" /> Upper Air &amp; Sounding (OAK)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed">{highlightGlossary(brief.upperAir)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-1.5">
              <Radio className="h-3 w-3" /> Aviation Flags
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-sm leading-relaxed ${flagsClear ? "text-muted-foreground" : "text-marginal"}`}>
              {brief.aviationFlags}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Footer */}
      <p className="text-center text-xs text-muted-foreground pt-4 border-t border-border">
        Open-Meteo · IEM Sounding · aviationweather.gov · Analysis by Claude Sonnet
        {generatedAt && <span className="ml-2 opacity-60">· Generated {generatedAt}</span>}
      </p>
    </div>
  )
}
