import React from "react";
import { exactExpiry, expiryDeadline, expiryDescription } from "./expiry";

export function EntitlementExpiry({ value, original, inherits, error, onChange }: {
  value: string; original?: number | null; inherits: boolean; error?: string; onChange(value: string): void;
}): React.ReactElement {
  const custom = value.startsWith("exact:");
  let preview = inherits ? "Blank: use policy expiry." : "Blank: No expiry.";
  try { const deadline = expiryDeadline(value, original); if (deadline !== null) preview = `Expiry: ${exactExpiry(deadline)} (UTC).`; } catch { /* Field validation explains an invalid draft. */ }
  return <div className="wide">
    {custom ? <><p>Custom expiry: {original === null || original === undefined ? "Unavailable" : exactExpiry(original)}. The exact deadline is kept until you change it.</p>
      <button type="button" name="valid_until" onClick={()=>onChange("")}>Change expiry</button></>
      : <label>Valid through<input aria-label="Valid through" name="valid_until" type="date" min="1970-01-01" max="9999-12-31" value={value} aria-invalid={!!error} aria-describedby="entitlement-date-rules entitlement-expiry-preview" onChange={event=>onChange(event.target.value)} /></label>}
    <p id="entitlement-expiry-preview" className="muted">{preview}</p>
    {error && <span id="entitlement-valid_until-error" role="alert">{error}</span>}
    {original !== undefined && <p className="muted">Stored expiry: {expiryDescription(original)}.</p>}
  </div>;
}
