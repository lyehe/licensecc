import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { LABELS, ProviderButtons, ProviderResult, useProviders } from "../auth/ProviderSignIn";
import { PasswordSettings } from "./PasswordSettings";
import { api } from "../../shared/api";
import { useSingleFlight } from "../../shared/useSingleFlight";

type Provider = keyof typeof LABELS;
type Identity = { provider: Provider; email: string };
const LAST_SIGN_IN_METHOD = "You can't disconnect your only sign-in method. Set up another way to sign in first.";

export function AccountFeature({ customerId }: {
  customerId: string | null;
}): React.ReactElement {
  const { providers, failed, retry } = useProviders();
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [identityError, setIdentityError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, runOnce } = useSingleFlight();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let cancelled = false;
    setIdentityError(false);
    void api<{ items: Identity[] }>("/portal/v1/auth/identities").then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) setIdentities(result.data.items);
      else setIdentityError(true);
    }).catch(() => { if (!cancelled) setIdentityError(true); });
    return () => { cancelled = true; };
  }, [attempt]);
  // Resolves true when the identity is still connected, so its row can take focus back.
  async function disconnect(provider: Provider): Promise<boolean> {
    let connected = true;
    await runOnce(async () => {
      const name = LABELS[provider];
      setNotice(null);
      try {
        const result = await api<{ provider: string }>("/portal/v1/auth/identities/unlink", { method: "POST", body: JSON.stringify({ provider }) });
        if (result.ok) {
          connected = false;
          setIdentities((items) => items && items.filter((item) => item.provider !== provider));
          setNotice(`${name} disconnected.`);
        } else {
          setNotice(result.code === "last_sign_in_method" ? LAST_SIGN_IN_METHOD : `Unable to disconnect ${name}. Please try again.`);
        }
      } catch {
        setNotice(`Unable to disconnect ${name}. Please try again.`);
      }
      // Whatever the outcome, re-read the list so it matches the server.
      setAttempt((value) => value + 1);
    });
    if (!connected) heading.current?.focus();
    return connected;
  }
  // The .accountNotice live region is mounted with the section, before any result, and only its text
  // changes, so a screen reader announces the result wherever focus goes next.
  return <div className="accountPage">
    <div className="pageHeading"><div><h1>Account</h1><p>Manage how you sign in.</p></div></div>
    <ProviderResult />
    {(notice !== null || failed || identityError || !providers || !identities || providers.google || providers.github || identities.length > 0) && <section className="tablePane full"><h2 ref={heading} tabIndex={-1}>Connected accounts</h2>
      <p role="status" className="accountNotice">{notice}</p>
      {(failed || identityError) ? <p>Unable to load sign-in methods. <button onClick={() => { retry(); setAttempt((value) => value + 1); }}>Retry</button></p> : !providers || !identities ? <p>Loading sign-in methods…</p> : <>
        {identities.map((identity) => <ConnectedIdentity key={identity.provider} identity={identity} busy={busy} onDisconnect={disconnect} />)}
        <ProviderButtons providers={providers} linked={identities.map((identity) => identity.provider)} link />

      </>}
    </section>}
    {providers?.password && <PasswordSettings />}
    <details className="referenceDetails"><summary>Account details</summary><p>Account ID</p><p className="identifier">{customerId ?? "Account details unavailable"}</p></details>
  </div>;
}

// One connected provider. Disconnect asks first, inline: the question takes focus so it is read out,
// and neither a double click nor a repeated Enter can confirm it. Cancel returns focus to Disconnect.
function ConnectedIdentity({ identity, busy, onDisconnect }: {
  identity: Identity;
  busy: boolean;
  onDisconnect(provider: Provider): Promise<boolean>;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const questionId = useId();
  const question = useRef<HTMLDivElement>(null);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const name = LABELS[identity.provider];
  useLayoutEffect(() => {
    if (confirming) question.current?.focus();
    else if (returnFocus.current) disconnectButton.current?.focus();
    returnFocus.current = false;
  }, [confirming]);
  function close(): void {
    returnFocus.current = true;
    setConfirming(false);
  }
  return <div className="connectedIdentity">
    <p>{name} · {identity.email}</p>
    {confirming ? <div ref={question} className="disconnectConfirm" role="group" aria-labelledby={questionId} tabIndex={-1}>
      <p id={questionId}>Disconnect {name}? You won't be able to sign in with {name} until you connect it again.</p>
      <div className="disconnectActions">
        <button type="button" className="primary" disabled={busy} onClick={() => void onDisconnect(identity.provider).then((connected) => { if (connected) close(); })}>{busy ? "Disconnecting…" : `Disconnect ${name}`}</button>
        <button type="button" disabled={busy} onClick={close}>Cancel</button>
      </div>
    </div> : <button ref={disconnectButton} type="button" aria-label={`Disconnect ${name}`} disabled={busy} onClick={() => setConfirming(true)}>Disconnect</button>}
  </div>;
}
