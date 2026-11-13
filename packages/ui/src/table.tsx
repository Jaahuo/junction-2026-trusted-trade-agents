import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table {...props} className={cn("w-full border-collapse text-left text-sm", className)} />
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      {...props}
      className={cn("border-b border-border px-4 py-2.5 font-medium text-muted", className)}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      {...props}
      className={cn("border-b border-border px-4 py-2.5 last:border-b-0", className)}
    />
  );
}
