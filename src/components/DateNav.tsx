import { ChevronLeft, ChevronRight, Calendar } from "lucide-react"
import { Button } from "@/components/ui/button"
import { mmddToLabel } from "@/utils"

interface Props {
  availableDates: string[]
  currentIdx: number
  onNavigate: (idx: number) => void
  today: string
}

export default function DateNav({ availableDates, currentIdx, onNavigate, today }: Props) {
  const isToday = availableDates[currentIdx] === today

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon"
        title="Previous day"
        disabled={currentIdx <= 0}
        onClick={() => onNavigate(currentIdx - 1)}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <div className="relative flex items-center">
        <Calendar className="absolute left-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <select
          className="date-select pl-8"
          aria-label="Select date"
          value={availableDates[currentIdx] ?? ""}
          onChange={e => {
            const idx = availableDates.indexOf(e.target.value)
            if (idx !== -1) onNavigate(idx)
          }}
        >
          {[...availableDates].reverse().map(mmdd => (
            <option key={mmdd} value={mmdd}>
              {mmddToLabel(mmdd)}{mmdd === today ? " ★" : ""}
            </option>
          ))}
        </select>
      </div>

      <Button
        variant="outline"
        size="icon"
        title="Next day"
        disabled={currentIdx >= availableDates.length - 1}
        onClick={() => onNavigate(currentIdx + 1)}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>

      {isToday && (
        <span className="text-[10px] font-bold tracking-widest uppercase text-primary border border-primary/40 rounded-full px-2.5 py-0.5">
          Today
        </span>
      )}
    </div>
  )
}
