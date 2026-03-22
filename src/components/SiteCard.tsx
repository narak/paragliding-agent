import { SiteEntry } from '../types'

function verdictClass(verdict: string): string {
  return 'verdict-' + String(verdict ?? '').replace(/\s+/g, '-').toUpperCase()
}

export default function SiteCard({ site }: { site: SiteEntry }) {
  const v = site.verdict ?? ({} as SiteEntry['verdict'])
  const hasHazards = v.hazards && v.hazards.toLowerCase() !== 'none' && v.hazards.trim() !== ''

  return (
    <div className="site-card">
      <div className="site-header">
        <div>
          <div className="site-name">{site.name}</div>
          <div className="site-location">{site.locationDescriptor}</div>
        </div>
        <div className={`verdict-badge ${verdictClass(v.verdict)}`}>
          {v.emoji} {v.verdict}
        </div>
      </div>
      <div className="site-body">
        <div className="site-meta">
          <div><div className="meta-label">Best Window</div><div className="meta-value">{v.bestWindow}</div></div>
          <div><div className="meta-label">Skill Level</div><div className="meta-value">{v.skillLevel}</div></div>
          <div><div className="meta-label">Wind</div><div className="meta-value">{v.wind}</div></div>
          <div><div className="meta-label">Thermals</div><div className="meta-value">{v.thermals}</div></div>
        </div>
        {hasHazards && (
          <>
            <div className="section-label">Hazards</div>
            <div className="section-text hazard-text">{v.hazards}</div>
          </>
        )}
        <div className="section-label">Today's Setup</div>
        <div className="section-text">{site.todaySetup}</div>
        <details>
          <summary>Hour-by-hour &amp; site mechanics</summary>
          <div className="detail-body">
            {(site.hourlyWindows ?? []).map((w, i) => (
              <div key={i} className="hourly-window">
                <div className="hourly-label">{w.label}</div>
                <div className="hourly-text">{w.summary}</div>
              </div>
            ))}
            <div className="section-label" style={{ marginTop: '14px' }}>How It Works</div>
            <div className="section-text">{site.howItWorks}</div>
          </div>
        </details>
      </div>
    </div>
  )
}
