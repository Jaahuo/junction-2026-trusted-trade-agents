import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description === undefined ? null : <p className="mt-1 text-muted">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section {...props} className={cn("border border-border bg-surface p-5", className)} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 {...props} className={cn("mb-3 text-lg font-semibold", className)} />;
}

const badgeTones = {
  neutral: "neutral",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
} as const;

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof badgeTones;
  children: ReactNode;
}) {
  return <span className={cn("pill", badgeTones[tone])}>{children}</span>;
}
