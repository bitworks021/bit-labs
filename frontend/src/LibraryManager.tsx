import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";

type LibrarySummary = {
  name: string;
  author: string;
  sentence: string;
  website?: string;
  category?: string;
  architectures: string[];
  includes: string[];
  latestVersion: string;
  versions: string[];
};

type InstalledLibrary = {
  name: string;
  version: string;
  author: string;
  sentence: string;
  website?: string;
  architectures: string[];
  includes: string[];
  latestVersion?: string;
};

type ServiceResult = {
  success: boolean;
  message: string;
  logs?: string;
  libraries?: unknown;
};

type LibraryManagerProps = {
  onOutput: (status: "working" | "success" | "failure", text: string) => void;
  onInclude: (headers: string[]) => void;
  onClose: () => void;
};

const maxZipBytes = 20 * 1024 * 1024;

async function requestJson(input: string, init?: RequestInit): Promise<ServiceResult> {
  const response = await fetch(input, init);
  let result: ServiceResult;
  try {
    result = (await response.json()) as ServiceResult;
  } catch {
    throw new Error(`The server returned an unexpected response (HTTP ${response.status}).`);
  }
  if (!response.ok || !result.success) {
    throw Object.assign(new Error(result.message ?? `Request failed (HTTP ${response.status}).`), {
      logs: result.logs ?? "",
    });
  }
  return result;
}

function errorText(error: unknown, fallback: string) {
  if (error instanceof Error) {
    const logs = (error as Error & { logs?: string }).logs;
    return logs ? `${error.message}\n\n${logs}` : error.message;
  }
  return fallback;
}

function authorName(author: string) {
  // Index authors look like "Name <email>"; show only the name.
  return author.replace(/\s*<[^>]*>/g, "").trim();
}

function LibraryManager({ onOutput, onInclude, onClose }: LibraryManagerProps) {
  const [tab, setTab] = useState<"browse" | "installed">("browse");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LibrarySummary[]>();
  const [searching, setSearching] = useState(false);
  const [installed, setInstalled] = useState<InstalledLibrary[]>([]);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [busyName, setBusyName] = useState("");
  const [panelMessage, setPanelMessage] = useState("");
  const searchRequest = useRef(0);
  const zipInput = useRef<HTMLInputElement>(null);

  const refreshInstalled = useCallback(async () => {
    try {
      const result = await requestJson("/libraries");
      setInstalled((result.libraries as InstalledLibrary[]) ?? []);
    } catch (error) {
      setPanelMessage(errorText(error, "Could not load installed libraries."));
    }
  }, []);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  const runSearch = useCallback(async (term: string) => {
    const requestId = ++searchRequest.current;
    setSearching(true);
    setPanelMessage("");
    try {
      const result = await requestJson(`/libraries/search?q=${encodeURIComponent(term)}`);
      if (requestId === searchRequest.current) {
        setResults((result.libraries as LibrarySummary[]) ?? []);
      }
    } catch (error) {
      if (requestId === searchRequest.current) {
        setResults(undefined);
        setPanelMessage(errorText(error, "Library search failed."));
      }
    } finally {
      if (requestId === searchRequest.current) {
        setSearching(false);
      }
    }
  }, []);

  // Search as the user types, once they pause.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      searchRequest.current += 1;
      setResults(undefined);
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(() => void runSearch(term), 450);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  async function changeLibrary(name: string, action: () => Promise<ServiceResult>, working: string) {
    setBusyName(name);
    setPanelMessage("");
    onOutput("working", working);
    try {
      const result = await action();
      onOutput("success", `${result.message}\n\n${result.logs ?? ""}`);
      await refreshInstalled();
    } catch (error) {
      const text = errorText(error, "The library change failed.");
      onOutput("failure", text);
      setPanelMessage(text.split("\n")[0]);
    } finally {
      setBusyName("");
    }
  }

  function install(name: string, version?: string) {
    void changeLibrary(
      name,
      () =>
        requestJson("/libraries/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, version }),
        }),
      `Installing ${name}${version ? ` ${version}` : ""} and its dependencies...`,
    );
  }

  function uninstall(name: string) {
    void changeLibrary(
      name,
      () =>
        requestJson("/libraries/uninstall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        }),
      `Removing ${name}...`,
    );
  }

  function installZip(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!file.name.toLowerCase().endsWith(".zip") || file.size > maxZipBytes) {
      setPanelMessage("Choose a .zip library of up to 20 MB.");
      return;
    }
    void changeLibrary(
      file.name,
      () =>
        requestJson("/libraries/zip", {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: file,
        }),
      `Installing ${file.name}...`,
    );
  }

  const installedByName = new Map(installed.map((library) => [library.name, library]));
  const isBusy = busyName !== "";

  function includeButton(includes: string[]) {
    if (includes.length === 0) {
      return null;
    }
    return (
      <button
        className="button button-secondary library-button"
        type="button"
        onClick={() => onInclude(includes)}
        title={includes.map((header) => `#include <${header}>`).join("\n")}
      >
        Include
      </button>
    );
  }

  function libraryHeader(name: string, author: string, website?: string) {
    return (
      <div className="library-header">
        <span className="library-name">
          {website ? (
            <a href={website} target="_blank" rel="noreferrer">
              {name}
            </a>
          ) : (
            name
          )}
        </span>
        {author && <span className="library-author">by {authorName(author)}</span>}
      </div>
    );
  }

  return (
    <aside className="library-panel" aria-label="Library Manager">
      <div className="panel-heading">
        <span>LIBRARY MANAGER</span>
        <button className="library-close" type="button" onClick={onClose} aria-label="Close Library Manager">
          ×
        </button>
      </div>

      <div className="library-toolbar">
        <div className="library-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "browse"}
            className={tab === "browse" ? "library-tab active" : "library-tab"}
            onClick={() => setTab("browse")}
          >
            Browse
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "installed"}
            className={tab === "installed" ? "library-tab active" : "library-tab"}
            onClick={() => setTab("installed")}
          >
            Installed ({installed.length})
          </button>
        </div>
        <button
          className="button button-secondary library-button"
          type="button"
          onClick={() => zipInput.current?.click()}
          disabled={isBusy}
        >
          Add .ZIP
        </button>
        <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={installZip} />
      </div>

      {tab === "browse" && (
        <input
          className="library-search"
          type="search"
          placeholder="Search libraries, e.g. DHT, Servo, NeoPixel"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search libraries"
          autoFocus
        />
      )}

      {panelMessage && (
        <p className="library-message" role="alert">
          {panelMessage}
        </p>
      )}

      <div className="library-list">
        {tab === "browse" && (
          <>
            {searching && <p className="library-empty">Searching...</p>}
            {!searching && results === undefined && (
              <p className="library-empty">Type at least two characters to search the Arduino library index.</p>
            )}
            {!searching && results?.length === 0 && <p className="library-empty">No libraries match "{query.trim()}".</p>}
            {!searching &&
              results?.map((library) => {
                const current = installedByName.get(library.name);
                const version = selectedVersions[library.name] ?? library.latestVersion;
                const working = busyName === library.name;
                return (
                  <article className="library-card" key={library.name}>
                    {libraryHeader(library.name, library.author, library.website)}
                    {library.sentence && <p className="library-sentence">{library.sentence}</p>}
                    <div className="library-meta">
                      {current && <span className="library-badge">Installed {current.version}</span>}
                      {library.category && <span>{library.category}</span>}
                    </div>
                    <div className="library-actions">
                      {current && includeButton(current.includes)}
                      <select
                        value={version}
                        onChange={(event) =>
                          setSelectedVersions((versions) => ({ ...versions, [library.name]: event.target.value }))
                        }
                        aria-label={`${library.name} version`}
                        disabled={isBusy}
                      >
                        {library.versions.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                      <button
                        className="button button-primary library-button"
                        type="button"
                        disabled={isBusy || current?.version === version}
                        onClick={() => install(library.name, version)}
                      >
                        {working ? "Working..." : !current ? "Install" : current.version === version ? "Installed" : "Switch"}
                      </button>
                      {current && (
                        <button
                          className="button button-secondary library-button"
                          type="button"
                          disabled={isBusy}
                          onClick={() => uninstall(library.name)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
          </>
        )}

        {tab === "installed" && (
          <>
            {installed.length === 0 && (
              <p className="library-empty">No libraries installed yet. Search in Browse or add a .ZIP library.</p>
            )}
            {installed.map((library) => {
              const update =
                library.latestVersion && library.latestVersion !== library.version ? library.latestVersion : undefined;
              return (
                <article className="library-card" key={library.name}>
                  {libraryHeader(library.name, library.author, library.website)}
                  {library.sentence && <p className="library-sentence">{library.sentence}</p>}
                  <div className="library-meta">
                    <span className="library-badge">Version {library.version}</span>
                    {update && <span className="library-update">Update available: {update}</span>}
                  </div>
                  <div className="library-actions">
                    {includeButton(library.includes)}
                    {update && (
                      <button
                        className="button button-primary library-button"
                        type="button"
                        disabled={isBusy}
                        onClick={() => install(library.name, update)}
                      >
                        {busyName === library.name ? "Working..." : "Update"}
                      </button>
                    )}
                    <button
                      className="button button-secondary library-button"
                      type="button"
                      disabled={isBusy}
                      onClick={() => uninstall(library.name)}
                    >
                      {busyName === library.name && !update ? "Working..." : "Remove"}
                    </button>
                  </div>
                </article>
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}

export default LibraryManager;
