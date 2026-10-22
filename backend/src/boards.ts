import { stat } from "node:fs/promises";
import path from "node:path";
import { CompilerError, projectRoot, runArduinoCli } from "./compiler.js";

export type InstalledBoard = {
  name: string;
  fqbn: string;
  platform: string;
  platformName: string;
};

export type PlatformSummary = {
  id: string;
  name: string;
  maintainer: string;
  website?: string;
  latestVersion: string;
  // Newest first.
  versions: string[];
  installedVersion?: string;
  boards: string[];
};

export type BoardManager = {
  listBoards(): Promise<InstalledBoard[]>;
  hasBoard(fqbn: string): Promise<boolean>;
  listInstalled(): Promise<PlatformSummary[]>;
  search(query: string): Promise<PlatformSummary[]>;
  install(id: string, version?: string): Promise<string>;
  uninstall(id: string): Promise<string>;
  // "Additional Boards Manager URLs": package index files from third-party board makers.
  listUrls(): Promise<string[]>;
  addUrl(url: string): Promise<string>;
  removeUrl(url: string): Promise<string>;
};

export function isValidIndexUrl(value: string): boolean {
  if (value.length > 500 || !/^https?:\/\/[^\s"'<>`]+$/i.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const indexMaxAgeMs = 24 * 60 * 60_000;
const packageIndexPath = path.join(projectRoot, ".arduino15", "package_index.json");
// Cores such as ESP32 download several hundred MB of toolchains.
const installTimeout = {
  timeoutMs: 20 * 60_000,
  timeoutMessage: "Board package installation timed out after 20 minutes.",
};

export function isValidPlatformId(id: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,64}$/.test(id) && !id.startsWith("-");
}

export function isValidPlatformVersion(version: string): boolean {
  return /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(version);
}

export function isValidFqbn(fqbn: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,64}$/.test(fqbn) && !fqbn.startsWith("-");
}

type Release = {
  name?: string;
  version?: string;
  boards?: Array<{ name?: string }>;
};

type PlatformEntry = {
  id?: string;
  maintainer?: string;
  website?: string;
  releases?: Record<string, Release>;
  installed_version?: string;
  latest_version?: string;
};

function compareVersions(left: string, right: string): number {
  const a = left.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function httpUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https?:\/\//i.test(value) ? value : undefined;
}

function parsePlatforms(stdout: string, logs: string): PlatformSummary[] {
  let output: { platforms?: PlatformEntry[] };
  try {
    output = JSON.parse(stdout) as { platforms?: PlatformEntry[] };
  } catch {
    throw new CompilerError("Arduino CLI returned an invalid board package list.", 500, logs);
  }

  return (output.platforms ?? [])
    .flatMap((platform) => {
      const latestVersion = platform.latest_version;
      if (!platform.id || !latestVersion) {
        return [];
      }
      const shown = platform.releases?.[platform.installed_version ?? latestVersion] ?? platform.releases?.[latestVersion];
      return [
        {
          id: platform.id,
          name: shown?.name ?? platform.id,
          maintainer: platform.maintainer ?? "",
          website: httpUrl(platform.website),
          latestVersion,
          versions: Object.keys(platform.releases ?? { [latestVersion]: {} }).sort(compareVersions).reverse(),
          installedVersion: platform.installed_version || undefined,
          boards: (shown?.boards ?? []).flatMap((board) => (board.name ? [board.name] : [])),
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

// Installs and removals all write to the same packages folder, so run them one at a time.
let mutationQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.catch(() => undefined);
  return run;
}

let indexRefresh: Promise<void> | undefined;
function ensureFreshIndex(): Promise<void> {
  indexRefresh ??= (async () => {
    try {
      const { mtimeMs } = await stat(packageIndexPath);
      if (Date.now() - mtimeMs < indexMaxAgeMs) {
        return;
      }
    } catch {
      // Missing index: download it below.
    }
    // A failed refresh (e.g. offline) still lets searches use the existing index.
    await runArduinoCli(["--no-color", "core", "update-index"], projectRoot, {
      timeoutMs: 120_000,
      timeoutMessage: "Updating the board package index timed out.",
    }).catch(() => undefined);
  })().finally(() => {
    setTimeout(() => (indexRefresh = undefined), indexMaxAgeMs).unref();
  });
  return indexRefresh;
}

// `board listall` takes a moment, so keep its result until a package changes.
let boardCache: Promise<InstalledBoard[]> | undefined;

// `board listall --format json` repeats every platform's full board list for each
// board (over 20 MB with ESP32 installed), so read the compact text table instead
// and take platform names from `core list`.
async function loadBoards(): Promise<InstalledBoard[]> {
  const [result, platforms] = await Promise.all([
    runArduinoCli(["--no-color", "board", "listall"], projectRoot, { maxStdoutLength: 2_000_000 }),
    listInstalled(),
  ]);
  if (result.exitCode !== 0) {
    throw new CompilerError("Could not list installed boards.", 503, result.logs);
  }
  const platformNames = new Map(platforms.map((platform) => [platform.id, platform.name]));

  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      // Board names may contain spaces; the FQBN is always the last column.
      const match = /^(.+?)\s+(\S+)\s*$/.exec(line);
      if (!match || !isValidFqbn(match[2])) {
        return [];
      }
      const [, name, fqbn] = match;
      const platform = fqbn.split(":").slice(0, 2).join(":");
      return [{ name: name.trim(), fqbn, platform, platformName: platformNames.get(platform) ?? platform }];
    })
    .sort((left, right) => left.platformName.localeCompare(right.platformName) || left.name.localeCompare(right.name));
}

function listBoards(): Promise<InstalledBoard[]> {
  boardCache ??= loadBoards().catch((error: unknown) => {
    boardCache = undefined;
    throw error;
  });
  return boardCache;
}

async function hasBoard(fqbn: string): Promise<boolean> {
  try {
    return (await listBoards()).some((board) => board.fqbn === fqbn);
  } catch {
    return false;
  }
}

async function listInstalled(): Promise<PlatformSummary[]> {
  const result = await runArduinoCli(["core", "list", "--format", "json"], projectRoot, {
    maxStdoutLength: 20_000_000,
  });
  if (result.exitCode !== 0) {
    throw new CompilerError("Could not list installed board packages.", 503, result.logs);
  }
  return parsePlatforms(result.stdout, result.logs);
}

async function search(query: string): Promise<PlatformSummary[]> {
  await ensureFreshIndex();
  const result = await runArduinoCli(
    ["core", "search", "--format", "json", ...(query ? ["--", query] : [])],
    projectRoot,
    { timeoutMs: 60_000, timeoutMessage: "Board package search timed out.", maxStdoutLength: 20_000_000 },
  );
  if (result.exitCode !== 0) {
    throw new CompilerError("Board package search failed.", 503, result.logs);
  }
  return parsePlatforms(result.stdout, result.logs);
}

function install(id: string, version?: string): Promise<string> {
  return serialize(async () => {
    const target = version ? `${id}@${version}` : id;
    try {
      const result = await runArduinoCli(["--no-color", "core", "install", "--", target], projectRoot, installTimeout);
      if (result.exitCode !== 0) {
        throw new CompilerError(`Could not install ${target}.`, 422, result.logs);
      }
      return result.logs;
    } finally {
      boardCache = undefined;
    }
  });
}

function uninstall(id: string): Promise<string> {
  return serialize(async () => {
    try {
      const result = await runArduinoCli(["--no-color", "core", "uninstall", "--", id]);
      if (result.exitCode !== 0) {
        throw new CompilerError(`Could not remove ${id}.`, 422, result.logs);
      }
      return result.logs;
    } finally {
      boardCache = undefined;
    }
  });
}

const urlsSetting = "board_manager.additional_urls";

async function listUrls(): Promise<string[]> {
  const result = await runArduinoCli(["config", "get", urlsSetting, "--format", "json"]);
  if (result.exitCode !== 0) {
    throw new CompilerError("Could not read the board manager URLs.", 503, result.logs);
  }
  try {
    const urls = JSON.parse(result.stdout) as unknown;
    return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
  } catch {
    // An empty setting prints nothing.
    return [];
  }
}

function updateIndex() {
  return runArduinoCli(["--no-color", "core", "update-index"], projectRoot, {
    timeoutMs: 180_000,
    timeoutMessage: "Downloading the board package indexes timed out.",
  });
}

function addUrl(url: string): Promise<string> {
  return serialize(async () => {
    if (!(await listUrls()).includes(url)) {
      const added = await runArduinoCli(["config", "add", urlsSetting, url]);
      if (added.exitCode !== 0) {
        throw new CompilerError("Could not save the board manager URL.", 500, added.logs);
      }
    }

    const result = await updateIndex();
    // A link that can't be downloaded makes every later CLI command print errors,
    // so only keep it if its index arrived.
    const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const failed = result.logs
      .split(/\r?\n/)
      .some(
        (line) =>
          (line.includes(url) || (fileName !== "" && line.includes(fileName))) &&
          /fail|error|invalid|cannot|not found/i.test(line),
      );
    if (failed) {
      await runArduinoCli(["config", "remove", urlsSetting, url]);
      throw new CompilerError(
        "Could not download a board package index from that link. Check that it is a package_..._index.json URL.",
        422,
        result.logs,
      );
    }
    indexRefresh = undefined;
    return result.logs;
  });
}

function removeUrl(url: string): Promise<string> {
  return serialize(async () => {
    const result = await runArduinoCli(["config", "remove", urlsSetting, url]);
    if (result.exitCode !== 0) {
      throw new CompilerError("Could not remove the board manager URL.", 500, result.logs);
    }
    return result.logs;
  });
}

export const arduinoBoardManager: BoardManager = {
  listUrls,
  addUrl,
  removeUrl,
  listBoards,
  hasBoard,
  listInstalled,
  search,
  install,
  uninstall,
};
