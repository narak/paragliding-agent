import { Wind, Clock, User, Flame, AlertTriangle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { SiteEntry } from "@/types"

type VerdictVariant = "fly" | "marginal" | "nofly"

function verdictVariant(v: string): VerdictVariant {
  const upper = (v ?? "").toUpperCase()
  if (upper === "FLY") return "fly"
  if (upper === "MARGINAL") return "marginal"
  return "nofly"
}

export default function SiteCard({ site }: { site: SiteEntry }) {
  const v = site.verdict ?? ({} as SiteEntry["verdict"])
  const hasHazards = v.hazards && v.hazards.toLowerCase() !== "none" && v.hazards.trim() !== ""

  return (
    <Card className="overflow-hidden">
      {/* Site header */}
      <div className="flex items-start justify-between gap-3 px-5 py-4 bg-secondary/40 border-b border-border">
        <div>
          <div className="font-bold text-base text-foreground">{site.name}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{site.locationDescriptor}</div>
        </div>
        <Badge variant={verdictVariant(v.verdict)}>
          {v.emoji} {v.verdict}
        </Badge>
      </div>

      <CardContent className="pt-4 space-y-4">
        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 pb-4 border-b border-border">
          <MetaItem icon={<Clock className="h-3 w-3" />} label="Best Window" value={v.bestWindow} />
          <MetaItem icon={<User className="h-3 w-3" />} label="Skill Level" value={v.skillLevel} />
          <MetaItem icon={<Wind className="h-3 w-3" />} label="Wind" value={v.wind} />
          <MetaItem icon={<Flame className="h-3 w-3" />} label="Thermals" value={v.thermals} />
        </div>

        {/* Hazards */}
        {hasHazards && (
          <div className="flex gap-2 p-3 rounded-md bg-marginal/5 border border-marginal/20">
            <AlertTriangle className="h-4 w-4 text-marginal shrink-0 mt-0.5" />
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-marginal mb-1">Hazards</div>
              <p className="text-sm text-marginal/90">{v.hazards}</p>
            </div>
          </div>
        )}

        {/* Today's setup */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Today's Setup</div>
          <p className="text-sm leading-relaxed">{site.todaySetup}</p>
        </div>

        {/* Hourly windows (collapsible) */}
        <details>
          <summary>Hour-by-hour &amp; site mechanics</summary>
          <div className="mt-3 space-y-0 divide-y divide-border">
            {(site.hourlyWindows ?? []).map((w, i) => (
              <div key={i} className="py-2.5">
                <div className="text-xs font-bold text-muted-foreground mb-1">{w.label}</div>
                <div className="text-sm">{w.summary}</div>
              </div>
            ))}
            <div className="pt-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">How It Works</div>
              <p className="text-sm leading-relaxed">{site.howItWorks}</p>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

function MetaItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  )
}
