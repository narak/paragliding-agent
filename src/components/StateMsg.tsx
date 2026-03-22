export default function StateMsg({ icon, message }: { icon: string; message: string }) {
  return (
    <div className="state-msg">
      <div className="icon">{icon}</div>
      <div>{message}</div>
    </div>
  )
}
