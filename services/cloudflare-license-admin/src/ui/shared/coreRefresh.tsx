import React, { ReactNode, createContext, useCallback, useContext, useRef } from "react";

import { EXACT_READ_PROOF, type ExactReadProof } from "./controls";

type CoreRefreshHandler = (strict?: boolean, isCurrent?: () => boolean) => Promise<ExactReadProof | null>;

interface CoreRefreshControls {
  refreshCore: (strict?: boolean, isCurrent?: () => boolean) => Promise<ExactReadProof | null>;
  registerCoreRefresh: (handler: CoreRefreshHandler) => () => void;
}

const CoreRefreshContext = createContext<CoreRefreshControls | null>(null);

// The pre-refactor console refreshed summary, entitlements, and events together after an
// entitlement-affecting write. This registry keeps that existing synchronization outside
// the application shell while each feature continues to own its endpoint state.
export function CoreRefreshProvider({ children }: { children: ReactNode }): React.ReactElement {
  const handlersRef = useRef(new Set<CoreRefreshHandler>());
  const registerCoreRefresh = useCallback((handler: CoreRefreshHandler): (() => void) => {
    handlersRef.current.add(handler);
    return () => handlersRef.current.delete(handler);
  }, []);
  const refreshCore = useCallback(async (strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> => {
    const results = await Promise.all([...handlersRef.current].map((handler) => handler(strict, isCurrent)));
    return results.length > 0 && results.every((result) => result === EXACT_READ_PROOF) ? EXACT_READ_PROOF : null;
  }, []);

  return <CoreRefreshContext.Provider value={{ refreshCore, registerCoreRefresh }}>{children}</CoreRefreshContext.Provider>;
}

export function useCoreRefresh(): CoreRefreshControls {
  const controls = useContext(CoreRefreshContext);
  if (controls === null) {
    throw new Error("core_refresh_provider_required");
  }
  return controls;
}
