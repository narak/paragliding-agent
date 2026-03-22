import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold whitespace-nowrap transition-colors",
  {
    variants: {
      variant: {
        default:   "border-transparent bg-primary/10 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline:   "text-foreground",
        fly:       "border-fly/30 bg-fly/10 text-fly",
        marginal:  "border-marginal/30 bg-marginal/10 text-marginal",
        nofly:     "border-nofly/30 bg-nofly/10 text-nofly",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
