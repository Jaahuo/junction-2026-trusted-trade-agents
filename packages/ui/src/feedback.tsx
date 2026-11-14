import type { ReactNode } from "react";
import { cn } from "./cn.ts";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent",
        className,
      )}
    />
  );
}

const alertTones = {
  info: "border-primary/30 bg-[var(--color-bg-brand-subtle)] text-foreground",
  success: "border-success/40 bg-[var(--color-bg-success)] text-foreground",
  warning: "border-warning/50 bg-[var(--color-bg-warning)] text-foreground",
  danger: "border-danger/40 bg-[var(--color-bg-danger)] text-danger",
} as const;

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: keyof typeof alertTones;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div role="alert" className={cn("rounded-md border px-4 py-3 text-sm", alertTones[tone])}>
      {title === undefined ? null : <p className="mb-1 font-semibold">{title}</p>}
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 border border-dashed border-border px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {description === undefined ? null : <p className="text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}
