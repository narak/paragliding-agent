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

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-32">Site</TableHead>
          {DAYS.map(d => <TableHead key={d.key}>{d.label}</TableHead>)}
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
                  {analysis === "—" ? (
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
  )
}
