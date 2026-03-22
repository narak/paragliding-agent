import { mmddToLabel } from '../utils'

interface Props {
  availableDates: string[]
  currentIdx: number
  onNavigate: (idx: number) => void
  today: string
}

export default function DateNav({ availableDates, currentIdx, onNavigate, today }: Props) {
  const isToday = availableDates[currentIdx] === today

  return (
    <div className="date-nav">
      <button
        title="Previous day"
        disabled={currentIdx <= 0}
        onClick={() => onNavigate(currentIdx - 1)}
      >‹</button>
      <select
        aria-label="Select date"
        value={availableDates[currentIdx] ?? ''}
        onChange={e => {
          const idx = availableDates.indexOf(e.target.value)
          if (idx !== -1) onNavigate(idx)
        }}
      >
        {[...availableDates].reverse().map(mmdd => (
          <option key={mmdd} value={mmdd}>
            {mmddToLabel(mmdd)}{mmdd === today ? ' ★' : ''}
          </option>
        ))}
      </select>
      <button
        title="Next day"
        disabled={currentIdx >= availableDates.length - 1}
        onClick={() => onNavigate(currentIdx + 1)}
      >›</button>
      {isToday && <span className="today-badge">TODAY</span>}
    </div>
  )
}
