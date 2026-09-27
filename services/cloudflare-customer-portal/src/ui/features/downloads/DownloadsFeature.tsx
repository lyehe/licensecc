import React, { useCallback, useState } from "react";

import type { ApiEnvelope } from "../../../shared/api";
import {
  ACTIVATION_DOWNLOAD_ACTION_LABEL,
  ACTIVATION_DOWNLOAD_DISCLOSURE,
  DEVICE_KEY_HELP_COPY,
  downloadPath,
  canDownloadLicense,
  licenseDisplayStatus,
} from "../../portalWorkflow";
import { ActionResult } from "../../shared/ActionResult";
import { currentSessionEpoch, localMessage, reportUnauthorized, resultMessage } from "../../shared/api";
import type { EntitlementRow, StatusMessage } from "../../types";

interface DownloadOptions {
  runOnce(work: () => Promise<void>): Promise<void>;
}

export interface LicenseDownloads {
  deviceKeys: Record<string, string>;
  // D2: this download's own result (keyed by entitlement id), shown next to its own control instead
  // of the page-level line.
  messages: Record<string, StatusMessage | null>;
  setDeviceKey(entitlementId: string, value: string): void;
  download(item: EntitlementRow): Promise<void>;
  clear(): void;
  // Fix round 1 (Important): messages lives here, one level above the Apps page's own components, so
  // it otherwise outlives a visit to Apps -- a stale "Download started." would reappear on a later
  // visit. App.tsx calls this when the Apps page is left. Deliberately narrower than clear(): typed
  // device keys are untouched.
  clearMessages(): void;
}

export function useLicenseDownloads({ runOnce }: DownloadOptions): LicenseDownloads {
  const [deviceKeys, setDeviceKeys] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, StatusMessage | null>>({});

  function setDeviceKey(entitlementId: string, value: string): void {
    setDeviceKeys((current) => ({ ...current, [entitlementId]: value }));
  }

  function setMessage(entitlementId: string, message: StatusMessage | null): void {
    setMessages((current) => ({ ...current, [entitlementId]: message }));
  }

  async function download(item: EntitlementRow): Promise<void> {
    // Checked again at click time: the license (or its trial) may have ended since the row rendered.
    if (!canDownloadLicense(item) || licenseDisplayStatus(item, Math.floor(Date.now() / 1000)) !== "active") {
      setMessage(item.id, localMessage("license_unavailable", false));
      return;
    }
    await runOnce(async () => {
      const deviceKeyId = (deviceKeys[item.id] ?? "").trim();
      if (deviceKeyId === "") {
        setMessage(item.id, localMessage("device_key_required", false));
        return;
      }
      // Captured before the raw fetch goes out, same as api() does internally, so a straggler response
      // from a request sent under an OLDER session can't bounce a customer who already signed in again
      // (fix round 1).
      const requestEpoch = currentSessionEpoch();
      let response: Response;
      try {
        response = await fetch(downloadPath(), {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entitlement_id: item.id, device_key_id: deviceKeyId }),
        });
      } catch {
        // This download bypasses api() (it needs the raw Response to read a blob), so a dropped
        // connection needs the same guard here -- same code and copy as api()'s own fetch rejection
        // (task C2), so the customer sees an identical message either way.
        setMessage(item.id, localMessage("network_unavailable", false));
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || contentType.includes("application/json")) {
        try {
          const result = (await response.json()) as ApiEnvelope<unknown>;
          // This download bypasses api() (see the fetch above), so a mid-session 401 needs its own
          // route to the same global onUnauthorized hook every other api() path already gets -- "every
          // api() path" (task C3) has to include the download too.
          reportUnauthorized(response.status, result.code, requestEpoch);
          setMessage(item.id, resultMessage(result));
        } catch {
          setMessage(item.id, localMessage(`download_failed_${response.status}`, false));
        }
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${item.project}-${item.feature}.lic`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setMessage(item.id, localMessage("download_started", true));
    });
  }

  const clear = useCallback((): void => {
    setDeviceKeys({});
    setMessages({});
  }, []);

  // Fix round 1 (Important): called from App.tsx when the Apps page is left, so a stale local result
  // never reappears on a later visit. Typed device keys survive navigation; only shown results do not.
  const clearMessages = useCallback((): void => setMessages({}), []);

  return { deviceKeys, messages, setDeviceKey, download, clear, clearMessages };
}

// Rendered only for a license that is active now (EntitlementsFeature): an inactive license offers no
// download at all, and download() re-checks the license when it is clicked.
export function LicenseDownloadAction({item,downloads,busy}:{item:EntitlementRow;downloads:LicenseDownloads;busy:boolean}):React.ReactElement {
  return <details className="licenseDownload"><summary>Activate and download</summary>
    <p>{ACTIVATION_DOWNLOAD_DISCLOSURE}</p>
    <label>Device key<input aria-label={`Device key for ${item.project} ${item.feature}`} placeholder="Device key ID" value={downloads.deviceKeys[item.id]??""} onChange={event=>downloads.setDeviceKey(item.id,event.target.value)} /></label>
    <p>{DEVICE_KEY_HELP_COPY}</p>
    <button disabled={busy || (downloads.deviceKeys[item.id]??"").trim()===""} onClick={()=>void downloads.download(item)}>{ACTIVATION_DOWNLOAD_ACTION_LABEL}</button>
    <ActionResult message={downloads.messages[item.id] ?? null} />
  </details>;
}
