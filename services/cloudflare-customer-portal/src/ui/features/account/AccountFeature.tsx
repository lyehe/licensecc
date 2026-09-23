import React, { useEffect, useState } from "react";
import { ProviderButtons, ProviderResult, useProviders } from "../auth/ProviderSignIn";
import { PasswordSettings } from "./PasswordSettings";
import { api } from "../../shared/api";

export function AccountFeature({ customerId }: {
  customerId: string | null;
}): React.ReactElement {
  const { providers, failed, retry } = useProviders();
  const [identities, setIdentities] = useState<Array<{ provider: string; email: string }> | null>(null);
  const [identityError, setIdentityError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setIdentityError(false);
    void api<{ items: Array<{ provider: string; email: string }> }>("/portal/v1/auth/identities").then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) setIdentities(result.data.items);
      else setIdentityError(true);
    }).catch(() => { if (!cancelled) setIdentityError(true); });
    return () => { cancelled = true; };
  }, [attempt]);
  return <div className="accountPage">
    <div className="pageHeading"><div><h1>Account</h1><p>Manage how you sign in.</p></div></div>
    <ProviderResult />
    {(failed || identityError || !providers || !identities || providers.google || providers.github || identities.length > 0) && <section className="tablePane full"><h2>Connected accounts</h2>
      {(failed || identityError) ? <p>Unable to load sign-in methods. <button onClick={() => { retry(); setAttempt((value) => value + 1); }}>Retry</button></p> : !providers || !identities ? <p>Loading sign-in methods…</p> : <>
        {identities.map((identity) => <p key={identity.provider}>{identity.provider === "google" ? "Google" : "GitHub"} · {identity.email}</p>)}
        <ProviderButtons providers={providers} linked={identities.map((identity) => identity.provider)} link />

      </>}
    </section>}
    {providers?.password && <PasswordSettings />}
    <details className="referenceDetails"><summary>Account details</summary><p>Account ID</p><p className="identifier">{customerId ?? "Account details unavailable"}</p></details>
  </div>;
}
