import type { ComponentProps } from "react";
import { cn } from "./cn.ts";
import { Spinner } from "./feedback.tsx";

const variants = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
  secondary: "border border-border bg-surface text-foreground hover:bg-background",
  ghost: "text-foreground hover:bg-border/50",
  danger: "bg-danger text-primary-foreground hover:opacity-90",
} as const;

const sizes = { sm: "h-8 px-3 text-sm", md: "h-10 px-4" } as const;

interface ButtonProps extends ComponentProps<"button"> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  type = "button",
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled === true || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
