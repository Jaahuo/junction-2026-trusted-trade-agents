import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

const control =
  "w-full rounded-md border border-[var(--color-border-strong)] bg-surface px-3 text-foreground placeholder:text-muted " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={cn(control, "h-10", className)} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={cn(control, "min-h-24 py-2", className)} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select {...props} className={cn(control, "h-10", className)} />;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {error === undefined ? null : <span className="text-danger">{error}</span>}
      {hint === undefined || error !== undefined ? null : (
        <span className="text-muted">{hint}</span>
      )}
    </label>
  );
}
