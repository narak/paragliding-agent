export default function StateMsg({ icon, message }: { icon: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-muted-foreground">
      <span className="text-4xl">{icon}</span>
      <span className="text-sm">{message}</span>
    </div>
  )
}
