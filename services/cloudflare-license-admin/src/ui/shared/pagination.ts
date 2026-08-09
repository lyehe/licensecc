import type { Dispatch, SetStateAction } from "react";

import { api } from "./api";
import { csvExportPath, withCursor } from "./urls";

export { csvExportPath, withCursor } from "./urls";

export async function loadMore<T>(
  url: string,
  cursor: string | null,
  setItems: Dispatch<SetStateAction<T[]>>,
  setCursor: Dispatch<SetStateAction<string | null>>,
  setMessage: Dispatch<SetStateAction<string>>,
): Promise<void> {
  if (cursor === null) {
    return;
  }
  const response = await api<{ items: T[]; next_cursor: string | null }>(withCursor(url, cursor));
  const data = response.data;
  if (response.ok && data) {
    setItems((previous) => [...previous, ...data.items]);
    setCursor(data.next_cursor ?? null);
  } else {
    setMessage(`${response.code} (${response.request_id})`);
  }
}

export async function downloadCsv(
  listUrl: string,
  filename: string,
  runMutation: (work: () => Promise<void>) => Promise<void>,
  setMessage: Dispatch<SetStateAction<string>>,
): Promise<void> {
  await runMutation(async () => {
    try {
      const response = await fetch(csvExportPath(listUrl));
      if (!response.ok) {
        setMessage(`csv_export_failed (${response.status})`);
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setMessage(`exported ${filename}`);
    } catch {
      setMessage("csv_export_failed");
    }
  });
}
