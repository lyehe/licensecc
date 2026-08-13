import React, { useCallback, useState } from "react";

import type { ApiEnvelope } from "../../../shared/api";
import {
  ACTIVATION_DOWNLOAD_ACTION_LABEL,
  ACTIVATION_DOWNLOAD_DISCLOSURE,
  DEVICE_KEY_HELP_COPY,
  downloadPath,
  formatWindow,
  NO_DOWNLOADS_EMPTY_COPY,
} from "../../portalWorkflow";
import { localMessage, resultMessage } from "../../shared/api";
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

export function DownloadsFeature({ busy, downloads, entitlements }: {
  busy: boolean;
  downloads: LicenseDownloads;
  entitlements: EntitlementRow[];
}): React.ReactElement {
  const downloadable = entitlements.filter((item) => item.license_mode !== "floating");
  return (
    <section className="tablePane full">
      <h2>Download licenses</h2>
      <p className="muted">{ACTIVATION_DOWNLOAD_DISCLOSURE}</p>
      <p className="muted">{DEVICE_KEY_HELP_COPY}</p>
      <table>
        <thead><tr><th>Project</th><th>Feature</th><th>Status</th><th>Valid</th><th>License</th></tr></thead>
        <tbody>
          {downloadable.map((item, index) => (
            <tr key={`dl/${item.id}/${index}`}>
              <td>{item.project}</td>
              <td>{item.feature}</td>
              <td><span className={`status ${item.status}`}>{item.status}</span></td>
              <td>{formatWindow(item.valid_from, item.valid_until)}</td>
              <td className="actions">
                <input
                  aria-label={`Device key for ${item.project} ${item.feature}`}
                  placeholder="device key id"
                  value={downloads.deviceKeys[item.id] ?? ""}
                  onChange={(event) => downloads.setDeviceKey(item.id, event.target.value)}
                />
                <button disabled={busy || item.status !== "active" || (downloads.deviceKeys[item.id] ?? "").trim() === ""} onClick={() => void downloads.download(item)}>{ACTIVATION_DOWNLOAD_ACTION_LABEL}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {downloadable.length === 0 && <p className="muted">{NO_DOWNLOADS_EMPTY_COPY}</p>}
    </section>
  );
}
