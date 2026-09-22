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
import { localMessage, resultMessage } from "../../shared/api";
import { useLicenseClock } from "../../shared/useLicenseClock";
import type { EntitlementRow, StatusMessage } from "../../types";

interface DownloadOptions {
  runOnce(work: () => Promise<void>): Promise<void>;
  setMessage: React.Dispatch<React.SetStateAction<StatusMessage | null>>;
}

export interface LicenseDownloads {
  deviceKeys: Record<string, string>;
  setDeviceKey(entitlementId: string, value: string): void;
  download(item: EntitlementRow): Promise<void>;
  clear(): void;
}

export function useLicenseDownloads({ runOnce, setMessage }: DownloadOptions): LicenseDownloads {
  const [deviceKeys, setDeviceKeys] = useState<Record<string, string>>({});

  function setDeviceKey(entitlementId: string, value: string): void {
    setDeviceKeys((current) => ({ ...current, [entitlementId]: value }));
  }

  async function download(item: EntitlementRow): Promise<void> {
    if (!canDownloadLicense(item) || licenseDisplayStatus(item, Math.floor(Date.now() / 1000)) !== "enabled") {
      setMessage(localMessage("license_unavailable", false));
      return;
    }
    await runOnce(async () => {
      const deviceKeyId = (deviceKeys[item.id] ?? "").trim();
      if (deviceKeyId === "") {
        setMessage(localMessage("device_key_required", false));
        return;
      }
      const response = await fetch(downloadPath(), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entitlement_id: item.id, device_key_id: deviceKeyId }),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || contentType.includes("application/json")) {
        try {
          const result = (await response.json()) as ApiEnvelope<unknown>;
          setMessage(resultMessage(result));
        } catch {
          setMessage(localMessage(`download_failed_${response.status}`, false));
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
      setMessage(localMessage("download_started", true));
    });
  }

  const clear = useCallback((): void => setDeviceKeys({}), []);

  return { deviceKeys, setDeviceKey, download, clear };
}

export function LicenseDownloadAction({item,downloads,busy}:{item:EntitlementRow;downloads:LicenseDownloads;busy:boolean}):React.ReactElement {
  const now=useLicenseClock();
  return <details className="licenseDownload"><summary>Activate and download</summary>
    <p>{ACTIVATION_DOWNLOAD_DISCLOSURE}</p>
    <label>Device key<input aria-label={`Device key for ${item.project} ${item.feature}`} placeholder="Device key ID" value={downloads.deviceKeys[item.id]??""} onChange={event=>downloads.setDeviceKey(item.id,event.target.value)} /></label>
    <p>{DEVICE_KEY_HELP_COPY}</p>
    <button disabled={busy || licenseDisplayStatus(item,now)!=="enabled" || (downloads.deviceKeys[item.id]??"").trim()===""} onClick={()=>void downloads.download(item)}>{ACTIVATION_DOWNLOAD_ACTION_LABEL}</button>
  </details>;
}
