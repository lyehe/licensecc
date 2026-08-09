import React, { FormEvent, useState } from "react";

import type { NavigationTarget } from "../../app/types";
import { api } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { shortHash } from "../../shared/format";
import { navigationForResult, searchPath, SearchResult } from "./workflow";

export function Search({ onNavigate }: { onNavigate: (target: NavigationTarget) => void }): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const { setMessage } = useOperatorControls();

  async function submitSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    const q = searchQuery.trim();
    if (q === "") {
      setSearchResults(null);
      return;
    }
    const response = await api<{ results: SearchResult[] }>(searchPath(q));
    if (response.ok && response.data) {
      setSearchResults(response.data.results);
    } else {
      setSearchResults([]);
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  function navigateToResult(result: SearchResult): void {
    onNavigate(navigationForResult(result));
    setSearchResults(null);
    setSearchQuery("");
  }

  return (
    <form className="globalSearch" onSubmit={(event) => void submitSearch(event)}>
      <input
        type="search"
        placeholder="Search customers, licenses, entitlements, orders"
        aria-label="Global search"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
      />
      <button type="submit">Search</button>
      {searchResults !== null && (
        <div className="searchResults" role="listbox" aria-label="Search results">
          <div className="searchResultsHead">
            <span className="muted">{searchResults.length} result{searchResults.length === 1 ? "" : "s"}</span>
            <button type="button" onClick={() => { setSearchResults(null); setSearchQuery(""); }}>Close</button>
          </div>
          {searchResults.length === 0 ? (
            <p className="muted searchEmpty">No matches.</p>
          ) : (
            (["customer", "license", "entitlement", "order"] as const)
              .filter((type) => searchResults.some((result) => result.type === type))
              .map((type) => (
                <div className="searchGroup" key={type}>
                  <h3>{type}s</h3>
                  {searchResults.filter((result) => result.type === type).map((result) => (
                    <button type="button" className="searchResult" role="option" key={`${result.type}:${result.id}`} onClick={() => navigateToResult(result)}>
                      <span className="searchResultLabel">{result.type === "entitlement" || result.type === "license" ? shortHash(result.label) : result.label}</span>
                      <span className="muted searchResultMeta">
                        {result.type === "customer" && (result.email ?? "")}
                        {result.type === "entitlement" && `${result.project ?? ""} / ${result.feature ?? ""}`}
                        {result.type === "license" && `${result.project ?? ""} · ${result.id}`}
                        {result.type === "order" && (result.project ?? "")}
                      </span>
                    </button>
                  ))}
                </div>
              ))
          )}
        </div>
      )}
    </form>
  );
}
