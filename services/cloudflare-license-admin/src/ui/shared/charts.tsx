import React from "react";

export interface BarRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type EntitlementHealth = "healthy" | "expiring" | "expired" | "suspended";

export function scaleY(value: number, min: number, max: number, height: number, pad = 2): number {
  const usable = Math.max(0, height - pad * 2);
  if (max <= min) {
    return pad + usable / 2;
  }
  const t = (value - min) / (max - min);
  return pad + (1 - t) * usable;
}

export function pointXs(count: number, width: number): number[] {
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return [0];
  }
  const step = width / (count - 1);
  return Array.from({ length: count }, (_, index) => Math.round(index * step * 1000) / 1000);
}

export function linePath(values: ReadonlyArray<number>, width: number, height: number, pad = 2): string {
  if (values.length === 0) {
    return "";
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const xs = pointXs(values.length, width);
  if (values.length === 1) {
    const y = round(scaleY(values[0] ?? 0, min, max, height, pad));
    return `M 0 ${y} L ${round(width)} ${y}`;
  }
  return values
    .map((value, index) => `${index === 0 ? "M" : "L"} ${round(xs[index] ?? 0)} ${round(scaleY(value, min, max, height, pad))}`)
    .join(" ");
}

export function linePathScaled(
  values: ReadonlyArray<number>,
  scaleMin: number,
  scaleMax: number,
  width: number,
  height: number,
  pad = 2,
): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    const y = round(scaleY(values[0] ?? 0, scaleMin, scaleMax, height, pad));
    return `M 0 ${y} L ${round(width)} ${y}`;
  }
  const xs = pointXs(values.length, width);
  return values
    .map((value, index) => `${index === 0 ? "M" : "L"} ${round(xs[index] ?? 0)} ${round(scaleY(value, scaleMin, scaleMax, height, pad))}`)
    .join(" ");
}

export function areaPath(values: ReadonlyArray<number>, width: number, height: number, pad = 2): string {
  const line = linePath(values, width, height, pad);
  if (line === "") {
    return "";
  }
  const xs = pointXs(values.length, width);
  const lastX = values.length === 1 ? width : (xs[xs.length - 1] ?? 0);
  const firstX = values.length === 1 ? 0 : (xs[0] ?? 0);
  return `${line} L ${round(lastX)} ${round(height)} L ${round(firstX)} ${round(height)} Z`;
}

export function areaPathScaled(
  values: ReadonlyArray<number>,
  scaleMin: number,
  scaleMax: number,
  width: number,
  height: number,
  pad = 2,
): string {
  const line = linePathScaled(values, scaleMin, scaleMax, width, height, pad);
  if (line === "") {
    return "";
  }
  const xs = pointXs(values.length, width);
  const lastX = values.length === 1 ? width : (xs[xs.length - 1] ?? 0);
  const firstX = values.length === 1 ? 0 : (xs[0] ?? 0);
  return `${line} L ${round(lastX)} ${round(height)} L ${round(firstX)} ${round(height)} Z`;
}

export function barRects(values: ReadonlyArray<number>, width: number, height: number, gap = 0.2): BarRect[] {
  if (values.length === 0) {
    return [];
  }
  const max = Math.max(...values, 0);
  const slot = width / values.length;
  const clampedGap = Math.min(Math.max(gap, 0), 0.9);
  const barWidth = slot * (1 - clampedGap);
  const offset = (slot - barWidth) / 2;
  return values.map((value, index) => {
    const h = max <= 0 ? 0 : round((value / max) * height);
    return {
      x: round(index * slot + offset),
      y: round(height - h),
      w: round(barWidth),
      h,
    };
  });
}

export function isEmptySeries(values: ReadonlyArray<number>): boolean {
  return values.length === 0 || values.every((value) => value === 0);
}

export function entitlementHealth(
  status: string,
  validUntil: number | null | undefined,
  now: number,
  expiringWithinDays = 30,
): EntitlementHealth {
  if (status === "disabled" || status === "revoked") {
    return "suspended";
  }
  if (status !== "active") {
    return "healthy";
  }
  if (validUntil === null || validUntil === undefined) {
    return "healthy";
  }
  if (validUntil <= now) {
    return "expired";
  }
  if (validUntil <= now + expiringWithinDays * 86400) {
    return "expiring";
  }
  return "healthy";
}

const CHART_WIDTH = 600;
const CHART_HEIGHT = 120;
const CHART_PAD = 6;

export function HealthBadge({ status, validUntil, now }: { status: string; validUntil: number | null | undefined; now: number }): React.ReactElement {
  const health = entitlementHealth(status, validUntil, now);
  return <span className={`healthBadge health-${health}`}>{health}</span>;
}

export function LineAreaChart({ checkouts, denials, label }: { checkouts: number[]; denials: number[]; label: string }): React.ReactElement {
  if (isEmptySeries(checkouts) && isEmptySeries(denials)) {
    return <div className="chartEmpty muted">No usage activity in this window.</div>;
  }
  const combined = [...checkouts, ...denials];
  const scaleMin = Math.min(...combined);
  const scaleMax = Math.max(...combined);
  const area = areaPathScaled(checkouts, scaleMin, scaleMax, CHART_WIDTH, CHART_HEIGHT, CHART_PAD);
  const checkoutLine = linePathScaled(checkouts, scaleMin, scaleMax, CHART_WIDTH, CHART_HEIGHT, CHART_PAD);
  const denialLine = linePathScaled(denials, scaleMin, scaleMax, CHART_WIDTH, CHART_HEIGHT, CHART_PAD);
  return (
    <svg className="chart lineChart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {area !== "" && <path className="chartArea checkoutsArea" d={area} />}
      {checkoutLine !== "" && <path className="chartLine checkoutsLine" d={checkoutLine} fill="none" />}
      {denialLine !== "" && <path className="chartLine denialsLine" d={denialLine} fill="none" />}
    </svg>
  );
}

export function DenialRateChart({ rates, label }: { rates: number[]; label: string }): React.ReactElement {
  if (isEmptySeries(rates)) {
    return <div className="chartEmpty muted">No denials in this window.</div>;
  }
  const line = linePath(rates, CHART_WIDTH, CHART_HEIGHT, CHART_PAD);
  return (
    <svg className="chart lineChart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path className="chartLine denialRateLine" d={line} fill="none" />
    </svg>
  );
}

export function BarSparkChart({ values, label }: { values: number[]; label: string }): React.ReactElement {
  if (isEmptySeries(values)) {
    return <div className="chartEmpty muted">No fulfillment events in this window.</div>;
  }
  const rects = barRects(values, CHART_WIDTH, CHART_HEIGHT);
  return (
    <svg className="chart barChart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {rects.map((rect, index) => <rect key={index} className="chartBar" x={rect.x} y={rect.y} width={rect.w} height={rect.h} />)}
    </svg>
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
