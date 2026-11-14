import type { ComponentProps } from "react";
import { cn } from "./cn.ts";
import { Spinner } from "./feedback.tsx";

const variants = {
  primary: "primary",
  secondary: "secondary",
  ghost: "ghost",
  danger: "danger",
} as const;

interface ButtonProps extends ComponentProps<"button"> {
  variant?: keyof typeof variants;
  /** Both sizes use the shared button dimensions. */
  size?: "sm" | "md";
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size: _size = "md",
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
      className={cn("btn", variants[variant], className)}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
