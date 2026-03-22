export function todayMmdd(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

export function mmddToLabel(mmdd: string): string {
  const [mm, dd] = mmdd.split('-')
  const d = new Date(2000, parseInt(mm) - 1, parseInt(dd))
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
