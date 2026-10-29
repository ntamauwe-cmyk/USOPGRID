import { useId } from "react";
import { cn } from "@/lib/utils";

// USOPGRID brand system — single source of truth for the identity.
//
// The mark is a routing fork on a grid: an origin node enters the hub and the
// route splits to two provider nodes (primary + failover). The faint 3×3
// lattice is the grid every payment connection runs on. Geometry is shared
// with public/logo.svg and public/favicon.svg — change them together.

export const USOPGRID_NAME = "USOPGRID";
export const USOPGRID_TAGLINE = "Powering Every Payment Connection.";
export const USOPGRID_DESCRIPTOR = "Enterprise Payment Infrastructure";
export const USOPGRID_COMPANY = "RAE Horizon Technologies Limited";

export const BRAND = {
  midnight: "#0B1240",
  ink: "#0E1430",
  paper: "#FFFFFF",
  mist: "#F2F4F9",
  signal: "#12C2B0",
  electric: "#2D5BFF",
} as const;

const GRID = [12, 24, 36].flatMap((y) => [12, 24, 36].map((x) => [x, y] as const));
const ROUTE = "M11 24 H24 V12 H37 M24 24 V36 H37";

export function UsopgridMark({
  className,
  tone = "tile",
  title = "USOPGRID",
}: {
  className?: string;
  /** tile: navy tile (default). onDark: no tile, for midnight surfaces. onLight: no tile, ink lattice for white surfaces. */
  tone?: "tile" | "onDark" | "onLight";
  title?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const g = `ug-${uid}`;
  const lattice = tone === "onLight" ? BRAND.ink : "#FFFFFF";
  const origin = tone === "onLight" ? BRAND.ink : "#FFFFFF";
  const hubCore = tone === "onLight" ? "#FFFFFF" : BRAND.midnight;
  return (
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label={title} className={cn("shrink-0", className)}>
      <defs>
        <linearGradient id={g} x1="11" y1="24" x2="37" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={BRAND.signal} />
          <stop offset="1" stopColor={BRAND.electric} />
        </linearGradient>
      </defs>
      {tone === "tile" && <rect width="48" height="48" rx="11" fill={BRAND.midnight} />}
      {GRID.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="1.7" fill={lattice} opacity={tone === "onLight" ? 0.18 : 0.28} />
      ))}
      <path d={ROUTE} stroke={`url(#${g})`} strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="24" r="3.2" fill={origin} />
      <circle cx="24" cy="24" r="4.6" fill={BRAND.signal} />
      <circle cx="24" cy="24" r="1.7" fill={hubCore} />
      <circle cx="37" cy="12" r="3.2" fill={BRAND.signal} />
      <circle cx="37" cy="36" r="3.2" fill={BRAND.electric} />
    </svg>
  );
}

/** Lockup: mark + wordmark. */
export function UsopgridLogo({
  className,
  markClassName,
  wordClassName,
  tone = "tile",
}: {
  className?: string;
  markClassName?: string;
  wordClassName?: string;
  tone?: "tile" | "onDark" | "onLight";
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <UsopgridMark tone={tone} className={cn("size-7", markClassName)} />
      <span className={cn("font-display text-[15px] font-bold tracking-[0.06em]", wordClassName)}>USOPGRID</span>
    </span>
  );
}
