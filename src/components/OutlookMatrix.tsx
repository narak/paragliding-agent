import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Outlook } from "@/types"

const DAYS: { key: keyof Outlook; label: string }[] = [
  { key: "tomorrow", label: "Tomorrow" },
  { key: "day2",     label: "Day 2" },
  { key: "day3",     label: "Day 3" },
]

function outlookEmoji(text: string): string {
  const t = (text ?? "").toLowerCase()
  if (/\bno.fly\b|not flyable|unflyable|avoid|too strong|dangerous/.test(t)) return "❌"
  if (/\bmarginal\b|caution|watch|deteriorat|gusty|uncertain|tricky|limited/.test(t)) return "⚠️"
  if (/\bgood\b|great|excellent|solid|ideal|flyable|clean|prime|strong thermal/.test(t)) return "✅"
  return "🔵"
}

export default function OutlookMatrix({ outlook }: { outlook: Outlook }) {
  const initialOpen = Object.fromEntries(DAYS.map(d => [d.key, true])) as Record<string, boolean>
  const [openDays, setOpenDays] = useState<Record<string, boolean>>(initialOpen)

  if (!outlook) return <p className="text-sm text-muted-foreground">No outlook data.</p>

  const siteNames: string[] = []
  for (const { key } of DAYS) {
    for (const entry of (outlook[key] ?? [])) {
      if (entry.name && !siteNames.includes(entry.name)) siteNames.push(entry.name)
    }
  }
  if (siteNames.length === 0) return <p className="text-sm text-muted-foreground">No outlook data.</p>

  const lookup: Record<string, Record<string, string>> = {}
  for (const { key } of DAYS) {
    lookup[key] = {}
    for (const entry of (outlook[key] ?? [])) {
      lookup[key][entry.name] = entry.analysis ?? ""
    }
  }

  const toggle = (key: string) => setOpenDays(prev => ({ ...prev, [key]: !prev[key] }))

  return (
    <>
      {/* Mobile: one card per day */}
      <div className="md:hidden space-y-2">
        {DAYS.map(({ key, label }) => (
          <div key={key} className="border border-border rounded-md overflow-hidden">
            <button
              onClick={() => toggle(key)}
              className="w-full flex items-center justify-between px-3 py-2 bg-secondary/40 hover:bg-secondary/60 transition-colors"
            >
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h4>
              {openDays[key]
                ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            </button>
            {openDays[key] && (
              <div className="space-y-2 px-3 py-3">
                {siteNames.map(site => {
                  const analysis = lookup[key][site] ?? "—"
                  const emoji = analysis === "—" ? "" : outlookEmoji(analysis)
                  return (
                    <div key={site} className="flex items-start gap-6">
                      <span className="text-xs font-bold text-foreground whitespace-nowrap w-24 shrink-0 pt-0.5">{site}</span>
                      {analysis === "—" ? (
                        <span className="text-border text-sm">—</span>
                      ) : (
                        <span className="flex items-start gap-1.5 text-sm text-muted-foreground leading-relaxed">
                          <span className="text-base shrink-0 leading-snug">{emoji}</span>
                          <span>{analysis}</span>
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Desktop: table with collapsible columns */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-32">Site</TableHead>
              {DAYS.map(d => (
                <TableHead key={d.key} className="p-0">
                  <button
                    onClick={() => toggle(d.key)}
                    className="flex items-center gap-1 w-full px-4 py-3 hover:text-foreground transition-colors"
                  >
                    {openDays[d.key]
                      ? <ChevronDown className="h-3 w-3 shrink-0" />
                      : <ChevronRight className="h-3 w-3 shrink-0" />}
                    {d.label}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {siteNames.map(site => (
              <TableRow key={site}>
                <TableCell className="font-bold text-foreground text-xs whitespace-nowrap">{site}</TableCell>
                {DAYS.map(({ key }) => {
                  const analysis = lookup[key][site] ?? "—"
                  const emoji = analysis === "—" ? "" : outlookEmoji(analysis)
                  return (
                    <TableCell key={key} className="text-muted-foreground leading-relaxed">
                      {!openDays[key] ? null : analysis === "—" ? (
                        <span className="text-border">—</span>
                      ) : (
                        <span className="flex items-start gap-1.5">
                          <span className="text-base shrink-0 leading-snug">{emoji}</span>
                          <span>{analysis}</span>
                        </span>
                      )}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  )
}
