import React, { useEffect, useRef, useState } from "react";
import { api, parseExactApiSuccess } from "../../shared/api";
import { EXACT_READ_PROOF, useOperatorControls } from "../../shared/controls";
import { hasCustomerDetailData, parseMutationResponse, type MutationFailurePolicy } from "../../shared/mutationGuards";
import { useNavigationGuard } from "../../app/navigation";

type CreatedUser = { id: string; name: string; login_email: string; status: "active" };
const failures: MutationFailurePolicy = { initial: [
  { status: 400, codes: ["invalid_request", "invalid_json", "invalid_idempotency_key"] },
  { status: 401, codes: ["missing_access_jwt", "admin_auth_not_configured"] },
  { status: 403, codes: ["invalid_access_jwt", "admin_role_denied", "admin_role_required"] },
  { status: 409, codes: ["email_in_use"] }, { status: 413, codes: ["body_too_large"] },
], replay: [] };

export function AddUser({ onCancel, onOpen }: { onCancel(): void; onOpen(id: string): void }): React.ReactElement {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [created, setCreated] = useState<CreatedUser | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(true); const saved = useRef<CreatedUser | null>(null);
  const { busy, operationLocked, runKeyedMutation } = useOperatorControls();
  const locked = busy || operationLocked;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { requestLeave } = useNavigationGuard({ when: !saved.current && !!(name || email || password), message: "Discard this unsaved user?", onDiscard: () => setPassword("") });
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setError("");
    if ([...password].length < 15 || [...password].length > 128 || new TextEncoder().encode(password).length > 512) { setError("Use a password between 15 and 128 characters."); return; }
    const input = { name: name.trim(), email: email.trim().toLowerCase(), password };
    await runKeyedMutation<CreatedUser>({
      request: { method: "POST", path: "/api/admin/customers", body: JSON.stringify(input) },
      send: attempt => api(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (value, phase) => parseMutationResponse(value, "customer_created", (data): data is CreatedUser => {
        if (!data || typeof data !== "object") return false;
        const row = data as CreatedUser;
        return typeof row.id === "string" && row.id.startsWith("cust_") && row.name === input.name && row.login_email === input.email && row.status === "active";
      }, failures, phase),
      onApplied: result => { saved.current = result.data; setPassword(""); },
      onUnapplied: result => { setPassword(""); setError(result.code === "email_in_use" ? "This email already belongs to an account. No user was added." : `Could not add user: ${result.code}`); },
      refresh: async () => {
        const user = saved.current; if (!user || !mounted.current) return null;
        const response = await api(`/api/admin/customers/${encodeURIComponent(user.id)}`);
        if (!mounted.current || !parseExactApiSuccess(response, "customer", data => hasCustomerDetailData(data, user.id))) return null;
        setCreated(user); return EXACT_READ_PROOF;
      },
      isCurrent: () => mounted.current,
    });
  }
  if (created) return <section className="editorLayout"><h3>User added</h3><p>{created.name} · {created.login_email}</p><p>Share the initial password securely. The user can change it in their portal account. No licenses have been assigned.</p><button disabled={locked} onClick={() => onOpen(created.id)}>Open user</button></section>;
  return <section className="editorLayout"><h3>Add user</h3><p>Create a customer portal account. No email is sent.</p>
    <form aria-label="Add portal user" onSubmit={event => void submit(event)}>
      <fieldset disabled={locked || saved.current !== null}>
        <label>Name<input autoFocus required maxLength={128} autoComplete="off" value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Login email<input type="email" required maxLength={254} autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Initial password<input type="password" required autoComplete="new-password" aria-describedby="new-user-password-hint" value={password} onChange={event => setPassword(event.target.value)} /></label>
        <p id="new-user-password-hint">15–128 characters. The login email remains unverified.</p>
        {error && <p role="alert">{error}</p>}
        <div className="actions"><button className="primary" type="submit">Add user</button><button type="button" onClick={() => requestLeave(onCancel)}>Cancel</button></div>
      </fieldset>
    </form>
  </section>;
}
