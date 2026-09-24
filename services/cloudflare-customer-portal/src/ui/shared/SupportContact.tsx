import React, { createContext, useContext } from "react";

// The operator's support contact: the `support` field of GET /portal/v1/auth/providers, provided
// once for the whole portal by ProvidersScope. null means none is configured (or not loaded yet).
export const SupportContactContext = createContext<string | null>(null);

// The Worker only publishes https: or mailto: contacts. Checking the scheme again here means no
// other value can reach the href, whatever a response carried.
const LINKABLE = /^(?:https|mailto):/i;

// A verb phrase with no trailing punctuation; callers finish the sentence:
//   <>This account is suspended. <SupportContact />.</>
//   <><SupportContact /> if you can't sign in.</>
// It links the configured contact and otherwise reads "Contact your administrator". `support`
// overrides the app-wide contact; leave it out to use the one the portal was configured with.
export function SupportContact({ support }: { support?: string | null }): React.ReactElement {
  const appWide = useContext(SupportContactContext);
  const contact = support === undefined ? appWide : support;
  return contact && LINKABLE.test(contact) ? <a href={contact}>Contact support</a> : <>Contact your administrator</>;
}
