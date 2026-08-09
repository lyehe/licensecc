export type TimeseriesRange = 7 | 30 | 90;

export const TIMESERIES_RANGE_DAYS: ReadonlyArray<TimeseriesRange> = [7, 30, 90];

export function timeseriesPath(rangeDays: TimeseriesRange, buckets?: number, now: number = Math.floor(Date.now() / 1000)): string {
  const from = now - rangeDays * 86400;
  const params = new URLSearchParams();
  params.set("from", String(from));
  params.set("to", String(now));
  if (buckets !== undefined) params.set("buckets", String(buckets));
  return `/api/admin/report/timeseries?${params.toString()}`;
}
