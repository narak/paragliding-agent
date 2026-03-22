import { useState, useEffect } from 'react'
import { BriefJson } from './types'
import { todayMmdd, mmddToLabel } from './utils'
import DateNav from './components/DateNav'
import StateMsg from './components/StateMsg'
import SiteCard from './components/SiteCard'
import OutlookMatrix from './components/OutlookMatrix'

export default function App() {
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [currentIdx, setCurrentIdx] = useState(-1)
  const [brief, setBrief] = useState<BriefJson | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load manifest on mount
  useEffect(() => {
    async function init() {
      try {
        const res = await fetch('./briefs/manifest.json?t=' + Date.now())
        if (!res.ok) throw new Error('manifest not found — has the agent run yet?')
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

  // Load brief when date changes
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
  const currentMmdd = availableDates[currentIdx] ?? ''

  const generatedAt = brief?.generatedAt
    ? 'Generated ' + new Date(brief.generatedAt).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      }) + ' PT'
    : ''

  return (
    <div className="container">
      <div className="header">
        <h1>🪂 Paragliding Brief</h1>
        <div className="header-right">
          <DateNav
            availableDates={availableDates}
            currentIdx={currentIdx}
            onNavigate={setCurrentIdx}
            today={today}
          />
          {generatedAt && <div className="generated-at">{generatedAt}</div>}
        </div>
      </div>

      {loading && (
        <StateMsg icon="⏳" message={currentMmdd ? `Loading ${mmddToLabel(currentMmdd)}...` : 'Loading...'} />
      )}
      {!loading && error && <StateMsg icon="⚠️" message={error} />}
      {!loading && brief && (
        <BriefView brief={brief} isToday={currentMmdd === today} mmdd={currentMmdd} />
      )}
    </div>
  )
}

function BriefView({ brief, isToday, mmdd }: { brief: BriefJson; isToday: boolean; mmdd: string }) {
  const flagsClear = (brief.aviationFlags ?? '').toLowerCase().trim() === 'clear'
  const watchClear = (brief.watchlist ?? '').toLowerCase().includes('nothing')

  return (
    <>
      {!isToday && (
        <div className="history-banner">
          📅 Viewing historical brief for {brief.date ?? mmddToLabel(mmdd)} — compare with actual conditions to calibrate accuracy
        </div>
      )}

      <div className="tldr">
        <div className="tldr-label">TL;DR</div>
        <p>{brief.tldr}</p>
      </div>

      <div className="two-col">
        <div className="card no-margin">
          <div className="card-title">Upper Air &amp; Sounding (OAK)</div>
          <p>{brief.upperAir}</p>
        </div>
        <div className="card no-margin">
          <div className="card-title">Aviation Flags</div>
          <p style={{ color: flagsClear ? 'var(--muted)' : 'var(--marginal)' }}>{brief.aviationFlags}</p>
        </div>
      </div>

      <div className="sites-grid">
        {(brief.sites ?? []).map(site => (
          <SiteCard key={site.name} site={site} />
        ))}
      </div>

      <div className="card">
        <div className="card-title">3-Day Outlook</div>
        <OutlookMatrix outlook={brief.outlook} />
      </div>

      <div className="card">
        <div className="card-title">Watchlist</div>
        <p className={watchClear ? 'watchlist-clear' : 'watchlist-text'}>{brief.watchlist}</p>
      </div>

      <div className="footer">Open-Meteo · IEM Sounding · aviationweather.gov · Analysis by Claude Sonnet</div>
    </>
  )
}
