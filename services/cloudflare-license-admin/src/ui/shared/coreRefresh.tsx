import React, { ReactNode, createContext, useCallback, useContext, useRef } from "react";

type CoreRefreshHandler = () => Promise<void>;

interface CoreRefreshControls {
  refreshCore: () => Promise<void>;
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
  const refreshCore = useCallback(async (): Promise<void> => {
    await Promise.all([...handlersRef.current].map((handler) => handler()));
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
