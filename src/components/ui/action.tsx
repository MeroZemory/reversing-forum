import Link from "next/link";
import type { ComponentProps } from "react";

type ActionStyle = {
  variant?: "primary" | "secondary" | "quiet";
  size?: "default" | "compact";
  fullWidth?: boolean;
};

function actionClass({
  variant = "primary",
  size = "default",
  fullWidth = false,
  className,
}: ActionStyle & { className?: string }) {
  return [
    "button",
    variant !== "primary" && `button-${variant}`,
    size === "compact" && "button-small",
    fullWidth && "button-wide",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant,
  size,
  fullWidth,
  className,
  ...props
}: ComponentProps<"button"> & ActionStyle) {
  return (
    <button
      className={actionClass({ variant, size, fullWidth, className })}
      {...props}
    />
  );
}

export function ActionLink({
  variant,
  size,
  fullWidth,
  className,
  ...props
}: ComponentProps<typeof Link> & ActionStyle) {
  return (
    <Link
      className={actionClass({ variant, size, fullWidth, className })}
      {...props}
    />
  );
}
