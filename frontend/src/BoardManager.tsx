import { useCallback, useEffect, useRef, useState } from "react";

type Platform = {
  id: string;
  name: string;
  maintainer: string;
  website?: string;
  latestVersion: string;
  versions: string[];
  installedVersion?: string;
  boards: string[];
};

type ServiceResult = {
  success: boolean;
  message: string;
  logs?: string;
  platforms?: Platform[];
  urls?: string[];
};

type BoardManagerProps = {
  onOutput: (status: "working" | "success" | "failure", text: string) => void;
  // Called after a package is installed or removed so the board list can refresh.
  onChanged: () => void;
  onClose: () => void;
};

const boardPreviewCount = 4;

// Well-known third-party package indexes, offered as one-click suggestions.
const suggestedUrls = [
  {
    label: "Raspberry Pi Pico / RP2040 (Earle Philhower)",
    url: "https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json",
  },
  { label: "ESP32 (Espressif)", url: "https://espressif.github.io/arduino-esp32/package_esp32_index.json" },
  { label: "ESP8266 (Community)", url: "https://arduino.esp8266.com/stable/package_esp8266com_index.json" },
  { label: "STM32 (STMicroelectronics)", url: "https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json" },
  { label: "Adafruit boards", url: "https://adafruit.github.io/arduino-board-index/package_adafruit_index.json" },
  { label: "ATtiny (David A. Mellis)", url: "https://raw.githubusercontent.com/damellis/attiny/ide-1.6.x-boards-manager/package_damellis_attiny_index.json" },
];

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

function BoardManager({ onOutput, onChanged, onClose }: BoardManagerProps) {
  const [tab, setTab] = useState<"browse" | "installed" | "urls">("browse");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Platform[]>();
  const [searching, setSearching] = useState(false);
  const [installed, setInstalled] = useState<Platform[]>([]);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState("");
  const [panelMessage, setPanelMessage] = useState("");
  const searchRequest = useRef(0);
  const [urls, setUrls] = useState<string[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState("");
  // Bumped after the URL list changes so Browse re-reads the package indexes.
  const [indexVersion, setIndexVersion] = useState(0);

  const refreshInstalled = useCallback(async () => {
    try {
      const result = await requestJson("/cores");
      setInstalled(result.platforms ?? []);
    } catch (error) {
      setPanelMessage(errorText(error, "Could not load installed board packages."));
    }
  }, []);

  const refreshUrls = useCallback(async () => {
    try {
      const result = await requestJson("/cores/urls");
      setUrls(result.urls ?? []);
    } catch (error) {
      setPanelMessage(errorText(error, "Could not load the board manager URLs."));
    }
  }, []);

  useEffect(() => {
    void refreshInstalled();
    void refreshUrls();
  }, [refreshInstalled, refreshUrls]);

  // An empty search lists every available package, like the Arduino IDE.
  useEffect(() => {
    const term = query.trim();
    const requestId = ++searchRequest.current;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setPanelMessage("");
      try {
        const result = await requestJson(`/cores/search?q=${encodeURIComponent(term)}`);
        if (requestId === searchRequest.current) {
          setResults(result.platforms ?? []);
        }
      } catch (error) {
        if (requestId === searchRequest.current) {
          setResults(undefined);
          setPanelMessage(errorText(error, "Board package search failed."));
        }
      } finally {
        if (requestId === searchRequest.current) {
          setSearching(false);
        }
      }
    }, term ? 400 : 0);
    return () => window.clearTimeout(timer);
  }, [query, indexVersion]);

  async function changePackage(id: string, action: () => Promise<ServiceResult>, working: string) {
    setBusyId(id);
    setPanelMessage("");
    onOutput("working", working);
    try {
      const result = await action();
      onOutput("success", `${result.message}\n\n${result.logs ?? ""}`);
      // Browse reads installed versions from this list too.
      await refreshInstalled();
      onChanged();
    } catch (error) {
      const text = errorText(error, "The board package change failed.");
      onOutput("failure", text);
      setPanelMessage(text.split("\n")[0]);
    } finally {
      setBusyId("");
    }
  }

  function install(id: string, version?: string) {
    void changePackage(
      id,
      () =>
        requestJson("/cores/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, version }),
        }),
      `Installing ${id}${version ? ` ${version}` : ""}. Board packages include compilers and tools, so this can take several minutes...`,
    );
  }

  function uninstall(id: string) {
    if (!window.confirm(`Remove ${id}? Boards from this package will no longer be available.`)) {
      return;
    }
    void changePackage(
      id,
      () =>
        requestJson("/cores/uninstall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        }),
      `Removing ${id}...`,
    );
  }

  async function changeUrl(url: string, path: string, working: string) {
    setUrlBusy(url);
    setPanelMessage("");
    onOutput("working", working);
    try {
      const result = await requestJson(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      onOutput("success", `${result.message}\n\n${result.logs ?? ""}`);
      await refreshUrls();
      setIndexVersion((version) => version + 1);
      return true;
    } catch (error) {
      const text = errorText(error, "The board manager URL change failed.");
      onOutput("failure", text);
      setPanelMessage(text.split("\n")[0]);
      return false;
    } finally {
      setUrlBusy("");
    }
  }

  async function addUrl(url: string) {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    if (await changeUrl(trimmed, "/cores/urls", `Adding ${trimmed} and downloading its board index...`)) {
      setNewUrl("");
    }
  }

  function removeUrl(url: string) {
    if (window.confirm(`Remove this board manager URL?\n\n${url}\n\nInstalled boards from it stay installed.`)) {
      void changeUrl(url, "/cores/urls/remove", `Removing ${url}...`);
    }
  }

  const installedById = new Map(installed.map((platform) => [platform.id, platform]));
  const isBusy = busyId !== "";

  function header(platform: Platform) {
    return (
      <div className="library-header">
        <span className="library-name">
          {platform.website ? (
            <a href={platform.website} target="_blank" rel="noreferrer">
              {platform.name}
            </a>
          ) : (
            platform.name
          )}
        </span>
        <span className="library-author">
          {platform.id}
          {platform.maintainer && ` · by ${platform.maintainer}`}
        </span>
      </div>
    );
  }

  function boardList(platform: Platform) {
    if (platform.boards.length === 0) {
      return null;
    }
    const shown = platform.boards.slice(0, boardPreviewCount).join(", ");
    const more = platform.boards.length - boardPreviewCount;
    return (
      <p className="library-sentence" title={platform.boards.join("\n")}>
        Boards: {shown}
        {more > 0 && ` and ${more} more`}
      </p>
    );
  }

  return (
    <aside className="library-panel" aria-label="Board Manager">
      <div className="panel-heading">
        <span>BOARD MANAGER</span>
        <button className="library-close" type="button" onClick={onClose} aria-label="Close Board Manager">
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
          <button
            type="button"
            role="tab"
            aria-selected={tab === "urls"}
            className={tab === "urls" ? "library-tab active" : "library-tab"}
            onClick={() => setTab("urls")}
          >
            Board URLs ({urls.length})
          </button>
        </div>
      </div>

      {tab === "browse" && (
        <input
          className="library-search"
          type="search"
          placeholder="Search board packages, e.g. SAMD, ESP32, RP2040"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search board packages"
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
            {searching && results === undefined && <p className="library-empty">Loading board packages...</p>}
            {!searching && results?.length === 0 && (
              <p className="library-empty">No board packages match "{query.trim()}".</p>
            )}
            {results?.map((platform) => {
              const current = installedById.get(platform.id);
              const version = selectedVersions[platform.id] ?? platform.latestVersion;
              const working = busyId === platform.id;
              return (
                <article className="library-card" key={platform.id}>
                  {header(platform)}
                  {boardList(platform)}
                  <div className="library-meta">
                    {current?.installedVersion && (
                      <span className="library-badge">Installed {current.installedVersion}</span>
                    )}
                    <span>Latest {platform.latestVersion}</span>
                  </div>
                  <div className="library-actions">
                    <select
                      value={version}
                      onChange={(event) =>
                        setSelectedVersions((versions) => ({ ...versions, [platform.id]: event.target.value }))
                      }
                      aria-label={`${platform.name} version`}
                      disabled={isBusy}
                    >
                      {platform.versions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button button-primary library-button"
                      type="button"
                      disabled={isBusy || current?.installedVersion === version}
                      onClick={() => install(platform.id, version)}
                    >
                      {working
                        ? "Working..."
                        : !current?.installedVersion
                          ? "Install"
                          : current.installedVersion === version
                            ? "Installed"
                            : "Switch"}
                    </button>
                    {current?.installedVersion && (
                      <button
                        className="button button-secondary library-button"
                        type="button"
                        disabled={isBusy}
                        onClick={() => uninstall(platform.id)}
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

        {tab === "urls" && (
          <>
            <p className="library-empty">
              Board makers publish a package index link (a <code>package_..._index.json</code> URL). Add it here,
              then find and install the boards in Browse.
            </p>
            <form
              className="url-form"
              onSubmit={(event) => {
                event.preventDefault();
                void addUrl(newUrl);
              }}
            >
              <input
                className="library-search url-input"
                type="url"
                placeholder="https://.../package_..._index.json"
                value={newUrl}
                onChange={(event) => setNewUrl(event.target.value)}
                aria-label="Board manager URL"
                disabled={urlBusy !== ""}
                required
              />
              <button className="button button-primary library-button" type="submit" disabled={urlBusy !== "" || !newUrl.trim()}>
                {urlBusy && urlBusy === newUrl.trim() ? "Adding..." : "Add"}
              </button>
            </form>

            {urls.length === 0 && <p className="library-empty">No additional URLs yet.</p>}
            {urls.map((url) => (
              <article className="library-card url-card" key={url}>
                <span className="url-text" title={url}>
                  {url}
                </span>
                <button
                  className="button button-secondary library-button"
                  type="button"
                  disabled={urlBusy !== ""}
                  onClick={() => removeUrl(url)}
                >
                  {urlBusy === url ? "Working..." : "Remove"}
                </button>
              </article>
            ))}

            {suggestedUrls.some((suggestion) => !urls.includes(suggestion.url)) && (
              <>
                <p className="url-heading">Popular board URLs</p>
                {suggestedUrls
                  .filter((suggestion) => !urls.includes(suggestion.url))
                  .map((suggestion) => (
                    <article className="library-card url-card" key={suggestion.url}>
                      <span className="url-suggestion">
                        <span className="library-name">{suggestion.label}</span>
                        <span className="url-text" title={suggestion.url}>
                          {suggestion.url}
                        </span>
                      </span>
                      <button
                        className="button button-secondary library-button"
                        type="button"
                        disabled={urlBusy !== ""}
                        onClick={() => void addUrl(suggestion.url)}
                      >
                        {urlBusy === suggestion.url ? "Adding..." : "Add"}
                      </button>
                    </article>
                  ))}
              </>
            )}
          </>
        )}

        {tab === "installed" && (
          <>
            {installed.length === 0 && (
              <p className="library-empty">No board packages installed yet. Find one in Browse.</p>
            )}
            {installed.map((platform) => {
              const update =
                platform.installedVersion && platform.latestVersion !== platform.installedVersion
                  ? platform.latestVersion
                  : undefined;
              return (
                <article className="library-card" key={platform.id}>
                  {header(platform)}
                  {boardList(platform)}
                  <div className="library-meta">
                    <span className="library-badge">Version {platform.installedVersion}</span>
                    {update && <span className="library-update">Update available: {update}</span>}
                  </div>
                  <div className="library-actions">
                    {update && (
                      <button
                        className="button button-primary library-button"
                        type="button"
                        disabled={isBusy}
                        onClick={() => install(platform.id, update)}
                      >
                        {busyId === platform.id ? "Working..." : "Update"}
                      </button>
                    )}
                    <button
                      className="button button-secondary library-button"
                      type="button"
                      disabled={isBusy}
                      onClick={() => uninstall(platform.id)}
                    >
                      {busyId === platform.id && !update ? "Working..." : "Remove"}
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

export default BoardManager;
