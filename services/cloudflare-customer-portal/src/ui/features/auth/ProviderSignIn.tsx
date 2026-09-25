import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { rateLimitMessage } from "../../portalWorkflow";
import { api } from "../../shared/api";
import { SupportContact, SupportContactContext } from "../../shared/SupportContact";

type Providers = { google: boolean; github: boolean; email: boolean; password: boolean; support?: string | null };
type ProvidersState = { providers: Providers | null; failed: boolean; retry(): void };
const ProvidersContext = createContext<ProvidersState | null>(null);
// Display names for the sign-in providers, shared with Account's connected-account rows.
export const LABELS = { google: "Google", github: "GitHub" };

// App mounts this once, so every screen (sign-in, Account, and the signed-in Connect flow) reads one
// GET /portal/v1/auth/providers response: the sign-in options and the support contact.
export function ProvidersScope({ children }: { children: React.ReactNode }): React.ReactElement {
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
  const state = useMemo(() => ({ providers, failed, retry: () => setAttempt((value) => value + 1) }), [providers, failed]);
  // A response without `support` (an older Worker) means no contact is configured.
  const support = typeof providers?.support === "string" ? providers.support : null;
  return <ProvidersContext.Provider value={state}>
    <SupportContactContext.Provider value={support}>{children}</SupportContactContext.Provider>
  </ProvidersContext.Provider>;
}
export function useProviders(): ProvidersState {
  const state = useContext(ProvidersContext);
  if (state === null) throw new Error("useProviders() requires an enclosing <ProvidersScope>");
  return state;
}
export function ProviderButtons({ providers, linked = [], link = false }: { providers: Providers; linked?: string[]; link?: boolean }): React.ReactElement {
  return <div className="providerButtons">{(["google", "github"] as const).filter((provider) => providers[provider] && !linked.includes(provider)).map((provider) =>
      <form key={provider} method="post" action={`/portal/v1/auth/${provider}/start${link ? "?mode=link" : ""}`}>
        <button type="submit">{link ? "Connect" : "Continue with"} {LABELS[provider]}</button>
      </form>,
  )}</div>;
}

const ERRORS: Record<string, React.ReactNode> = {
  provider_unavailable: "This sign-in method is not available yet. Please try another method.",
  // A redirect carries no retry-after header a top-level navigation could read, so this always uses
  // the shared sentence's "later" fallback -- the same one every other headerless 429 falls back to.
  rate_limited: rateLimitMessage(),
  link_expired: "This sign-in link has expired or was already used. Request a new code.",
  sign_in_cancelled: "Sign-in was cancelled. You can try again.",
  account_suspended: <>This account is suspended. <SupportContact />.</>,
  account_link_required: <>An account already uses this email. Sign in with the method you already use for it, then connect Google or GitHub under Account. <SupportContact /> if you can't sign in.</>,
  link_failed: "Unable to connect this provider. Sign in again and retry from Account.",
  sign_in_failed: "Unable to complete sign-in. Please try again.",
};
export function ProviderResult(): React.ReactElement | null {
  const [result] = useState<React.ReactNode>(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get("auth_error");
    const linked = url.searchParams.get("auth_result") === "linked";
    return error ? (Object.hasOwn(ERRORS, error) ? ERRORS[error] : ERRORS.sign_in_failed) : linked ? "Sign-in provider connected." : null;
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("auth_error") && !url.searchParams.has("auth_result")) return;
    url.searchParams.delete("auth_error"); url.searchParams.delete("auth_result");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);
  return result ? <p role="status">{result}</p> : null;
}
