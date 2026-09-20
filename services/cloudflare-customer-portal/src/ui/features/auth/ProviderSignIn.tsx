import React, { useEffect, useState } from "react";
import { api } from "../../shared/api";

type Providers = { google: boolean; github: boolean; email: boolean; password: boolean };
const LABELS = { google: "Google", github: "GitHub" };
export function useProviders(): { providers: Providers | null; failed: boolean; retry(): void } {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void api<Providers>("/portal/v1/auth/providers").then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) setProviders(result.data);
      else setFailed(true);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [attempt]);
  return { providers, failed, retry: () => setAttempt((value) => value + 1) };
}
export function ProviderButtons({ providers, linked = [], link = false }: { providers: Providers; linked?: string[]; link?: boolean }): React.ReactElement {
  return <div className="providerButtons">{(["google", "github"] as const).filter((provider) => providers[provider] && !linked.includes(provider)).map((provider) =>
      <form key={provider} method="post" action={`/portal/v1/auth/${provider}/start${link ? "?mode=link" : ""}`}>
        <button type="submit">{link ? "Connect" : "Continue with"} {LABELS[provider]}</button>
      </form>,
  )}</div>;
}

const ERRORS: Record<string, string> = {
  provider_unavailable: "This sign-in method is not available yet. Please try another method.",
  rate_limited: "Too many sign-in attempts. Please try again later.",
  sign_in_cancelled: "Sign-in was cancelled. You can try again.",
  account_link_required: "An account already uses this email. Sign in using its existing method, then connect this provider in Account. Contact your administrator if you cannot sign in.",
  link_failed: "Unable to connect this provider. Sign in again and retry from Account.",
  sign_in_failed: "Unable to complete sign-in. Please try again.",
};
export function ProviderResult(): React.ReactElement | null {
  const [result] = useState(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get("auth_error");
    const linked = url.searchParams.get("auth_result") === "linked";
    return error ? ERRORS[error] ?? ERRORS.sign_in_failed : linked ? "Sign-in provider connected." : null;
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("auth_error") && !url.searchParams.has("auth_result")) return;
    url.searchParams.delete("auth_error"); url.searchParams.delete("auth_result");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);
  return result ? <p role="status">{result}</p> : null;
}
