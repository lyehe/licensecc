export function dateInputToEpoch(value: string, label: string): number | null {
  if (value === "") {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label}_must_be_a_valid_date`);
  }
  const epochMs = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(epochMs) || epochMs < 0) {
    throw new Error(`${label}_must_be_a_valid_date`);
  }
  return Math.floor(epochMs / 1000);
}

export function epochToDateInput(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return new Date(value * 1000).toISOString().slice(0, 10);
}
