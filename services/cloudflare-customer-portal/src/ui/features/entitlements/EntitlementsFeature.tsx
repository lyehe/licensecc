import React from "react";

import {
  formatWindow,
  licenseDisplayStatus,
  licenseModeLabel,
  licenseStatusLead,
  NO_ENTITLEMENTS_EMPTY_COPY,
  shortHash,
  type LicenseDisplayStatus,
} from "../../portalWorkflow";
import { SupportContact } from "../../shared/SupportContact";
import { useLicenseClock } from "../../shared/useLicenseClock";
import type { EntitlementRow } from "../../types";

// Every date the lifecycle copy prints is a UTC YYYY-MM-DD (formatEpoch). Each one renders as a
// <time> that does not wrap: left alone, a narrow column breaks "2025-06-15" at a hyphen. The line
// stays one element, so the stacked phone layout keeps it beside its cell label.
const ISO_DATE = /(\d{4}-\d{2}-\d{2})/;

function DatedText({ text }: { text: string }): React.ReactElement {
  return <span>{text.split(ISO_DATE).map((part, index) => index % 2 === 1 ? <time key={index} dateTime={part} className="licenseDate">{part}</time> : part)}</span>;
}

// The next step after a status lead, where the customer has one. <SupportContact/> is a verb phrase,
// so each entry finishes the sentence around it.
const NEXT_STEP: Partial<Record<LicenseDisplayStatus, React.ReactNode>> = {
  expired: <><SupportContact /> to renew.</>,
  disabled: <><SupportContact />.</>,
  unknown: <><SupportContact />.</>,
};

// The next step that finishes a status lead, with its leading space, or nothing. Shared with the seat
// cards on Devices so the same license reads the same on both pages.
export function LicenseNextStep({ state }: { state: LicenseDisplayStatus }): React.ReactElement | null {
  const nextStep = NEXT_STEP[state];
  return nextStep === undefined ? null : <> {nextStep}</>;
}

// Only an active license offers something to do here. An inactive one (expired, suspended, revoked,
// not yet valid) offers no action: its status already says what happens next.
function LicenseAction({ state }: { state: LicenseDisplayStatus }): React.ReactElement | null {
  if (state !== "active") return null;
  return <span>Connect from your app</span>;
}

export function EntitlementsFeature({ entitlements }: { entitlements: EntitlementRow[] }): React.ReactElement {
  const now = useLicenseClock();
  return (
    <section className="tablePane full">
      <h2>License access</h2>
      <p>Status reflects license dates. Your app also checks device and trial access.</p>
      <table className="licenseTable">
        <thead><tr><th>Feature</th><th>Mode</th><th>Capacity</th><th>Status</th><th>Valid</th><th>Action</th></tr></thead>
        <tbody>
          {entitlements.map((item) => {
            const state = licenseDisplayStatus(item, now);
            return (
              <tr key={item.id}>
                <td data-label="Feature"><div>{item.feature}<details className="referenceDetails"><summary>License details</summary><code>{item.license_fingerprint || item.id}</code></details><span className="licenseReference">{shortHash(item.license_fingerprint || item.id)}</span></div></td>
                <td data-label="Mode"><DatedText text={licenseModeLabel(item, now)} /></td>
                <td data-label="Capacity">{item.max_active_devices} {item.max_active_devices === 1 ? "device" : "devices"}</td>
                <td data-label="Status"><span className="licenseStatus"><span className={`status ${state}`}><DatedText text={licenseStatusLead(item, now)} /></span><LicenseNextStep state={state} /></span></td>
                <td data-label="Valid"><DatedText text={formatWindow(item.valid_from, item.valid_until)} /></td>
                <td data-label="Action" className="licenseAction"><LicenseAction state={state} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {entitlements.length === 0 && <p className="muted">{NO_ENTITLEMENTS_EMPTY_COPY}</p>}
    </section>
  );
}
