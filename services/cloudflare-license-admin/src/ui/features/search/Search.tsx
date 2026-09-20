import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { NavigationTarget } from "../../app/types";
import { hashForTarget } from "../../app/navigationState";
import { api, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { hasSearchData } from "../../shared/mutationGuards";
import { useRequestFence } from "../../shared/requestFence";
import { focusWorkspaceTarget } from "../../shared/workspaceFocus";
import { navigationForResult, searchPath, type SearchResult } from "./workflow";

type SearchState = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };

export function Search({ onNavigate, onOpen, closeSignal, hiddenByMenu }: {
  onNavigate: (target: NavigationTarget) => boolean;
  onOpen: () => void;
  closeSignal: number;
  hiddenByMenu: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResultsSnapshot, setSearchResults] = useState<SearchResult[]>([]);
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const { modalActive } = useOperatorControls();
  const searchFence = useRequestFence(`${open ? "open" : "closed"}\u0000${searchQuery}`);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const surfaceId = useId();
  const inputId = useId();
  useEffect(() => { setOpen(false); setState({ kind: "idle" }); }, [closeSignal]);
  useEffect(() => {
    if (hiddenByMenu || modalActive) { setOpen(false); setState({ kind: "idle" }); }
  }, [hiddenByMenu, modalActive]);
  useLayoutEffect(() => { if (open) input.current?.focus(); }, [open]);

  function closeSearch(): void {
    setOpen(false);
    setState({ kind: "idle" });
    focusWorkspaceTarget(trigger.current);
  }

  async function submitSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    const q = searchQuery.trim();
    if (q === "") {
      setState({ kind: "idle" });
      input.current?.focus();
      return;
    }
    const ticket = searchFence.begin();
    setState({ kind: "loading" });
    const response = await api<{ results: SearchResult[] }>(searchPath(q));
    if (!searchFence.isCurrent(ticket)) return;
    const parsed = parseExactApiSuccess<{ results: SearchResult[] }>(response, "search_results", hasSearchData);
    if (parsed !== null && searchFence.settle(ticket)) {
      setSearchResults(parsed.data.results);
      setState({ kind: "ready" });
    } else setState({ kind: "error", message: apiFailureMessage(response) });
  }

  const searchResults = searchFence.isSettled() ? searchResultsSnapshot : [];
  return (
    <div className={`globalSearch${open ? " isOpen" : ""}`} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
      }
    }}>
      <button ref={trigger} className="searchTrigger" type="button" aria-expanded={open} aria-controls={surfaceId} onClick={() => {
        if (open) closeSearch();
        else { onOpen(); setOpen(true); }
      }}>Search</button>
      {open && <section id={surfaceId} className="searchSurface" aria-label="Search workspace">
        <div className="searchResultsHead"><h2>Search workspace</h2><button type="button" onClick={closeSearch}>Close search</button></div>
        <form onSubmit={(event) => void submitSearch(event)}>
          <label htmlFor={inputId}>Global search</label>
          <div className="searchInputRow"><input ref={input} id={inputId} type="search" placeholder="Customer, license, entitlement, or order" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setState({ kind: "idle" }); }} /><button type="submit" disabled={state.kind === "loading"}>Search records</button></div>
          <p className="muted">Search text stays in this session and is not included in workspace links.</p>
        </form>
        {state.kind === "loading" && <p role="status">Searching records…</p>}
        {state.kind === "error" && <div className="searchError" role="alert"><p>Search could not be completed. Try searching again.</p><details><summary>Technical details</summary><p>{state.message}</p></details></div>}
        {state.kind === "ready" && <section className="searchResults" aria-label="Search results">
          <h3 role="status">{searchResults.length} result{searchResults.length === 1 ? "" : "s"}</h3>
          {searchResults.length === 0 ? <p className="muted searchEmpty">No matches. Try another name or identifier.</p> : (["customer", "license", "entitlement", "order"] as const)
            .filter((type) => searchResults.some((result) => result.type === type))
            .map((type) => <div className="searchGroup" key={type}>
              <h4>{type === "customer" ? "Customers" : type === "license" ? "Licenses" : type === "entitlement" ? "Entitlements" : "Orders"}</h4>
              <ul>{searchResults.filter((result) => result.type === type).map((result) => <li key={`${result.type}:${result.id}`}>
                <a className="searchResult" href={hashForTarget(navigationForResult(result))} onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  if (onNavigate(navigationForResult(result))) { setOpen(false); setState({ kind: "idle" }); }
                }}>
                  <span className="searchResultLabel">{result.type === "entitlement" ? `${result.project ?? "Entitlement"} / ${result.feature ?? "Access"}` : result.label || result.id}</span>
                  <span className="muted searchResultMeta">{result.type} · {result.id}{result.type === "customer" && result.email ? ` · ${result.email}` : ""}{result.type !== "customer" && result.project ? ` · ${result.project}` : ""}</span>
                </a>
              </li>)}</ul>
            </div>)}
        </section>}
      </section>}
    </div>
  );
}
