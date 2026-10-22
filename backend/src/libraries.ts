import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CompilerError, projectRoot, runArduinoCli } from "./compiler.js";

export type LibrarySummary = {
  name: string;
  author: string;
  sentence: string;
  website?: string;
  category?: string;
  architectures: string[];
  includes: string[];
  latestVersion: string;
  // Newest first.
  versions: string[];
  installedVersion?: string;
};

export type InstalledLibrary = {
  name: string;
  version: string;
  author: string;
  sentence: string;
  website?: string;
  architectures: string[];
  includes: string[];
  latestVersion?: string;
};

export type LibraryManager = {
  search(query: string): Promise<LibrarySummary[]>;
  listInstalled(): Promise<InstalledLibrary[]>;
  install(name: string, version?: string): Promise<string>;
  uninstall(name: string): Promise<string>;
  installZip(archive: Buffer): Promise<string>;
};

const maxSearchResults = 50;
const indexMaxAgeMs = 24 * 60 * 60_000;
const libraryIndexPath = path.join(projectRoot, ".arduino15", "library_index.json");
const installTimeout = {
  timeoutMs: 300_000,
  timeoutMessage: "Library installation timed out after 5 minutes.",
};

// Library names may contain spaces and punctuation, but never "@" (the version
// separator), control characters, or a leading "-" that could read as a CLI flag.
export function isValidLibraryName(name: string): boolean {
  return /^[^\s@\-\x00-\x1f\x7f][^@\x00-\x1f\x7f]{0,119}$/.test(name) && name.trim() === name;
}

export function isValidLibraryVersion(version: string): boolean {
  return /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(version);
}

type IndexRelease = {
  author?: string;
  version?: string;
  sentence?: string;
  website?: string;
  category?: string;
  architectures?: string[];
  provides_includes?: string[];
};

type InstalledEntry = {
  library?: IndexRelease & { name?: string; location?: string };
  release?: IndexRelease;
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

function parseJson<T>(stdout: string, logs: string, what: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new CompilerError(`Arduino CLI returned an invalid ${what}.`, 500, logs);
  }
}

// Library installs and removals all write to the same libraries folder, so run them one at a time.
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
      const { mtimeMs } = await stat(libraryIndexPath);
      if (Date.now() - mtimeMs < indexMaxAgeMs) {
        return;
      }
    } catch {
      // Missing index: download it below.
    }
    // A failed refresh (e.g. offline) still lets searches use the existing index.
    await runArduinoCli(["--no-color", "lib", "update-index"], projectRoot, {
      timeoutMs: 120_000,
      timeoutMessage: "Updating the library index timed out.",
    }).catch(() => undefined);
  })().finally(() => {
    // Re-check on a later search once this refresh settles.
    setTimeout(() => (indexRefresh = undefined), indexMaxAgeMs).unref();
  });
  return indexRefresh;
}

async function listInstalled(): Promise<InstalledLibrary[]> {
  const result = await runArduinoCli(["lib", "list", "--format", "json"]);
  if (result.exitCode !== 0) {
    throw new CompilerError("Could not list installed libraries.", 503, result.logs);
  }
  const output = parseJson<{ installed_libraries?: InstalledEntry[] }>(
    result.stdout,
    result.logs,
    "installed library list",
  );

  return (output.installed_libraries ?? [])
    .flatMap(({ library, release }) => {
      if (!library?.name || !library.version) {
        return [];
      }
      return [
        {
          name: library.name,
          version: library.version,
          author: library.author ?? "",
          sentence: library.sentence ?? "",
          website: httpUrl(library.website),
          architectures: library.architectures ?? [],
          includes: library.provides_includes ?? [],
          latestVersion: release?.version,
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function search(query: string): Promise<LibrarySummary[]> {
  await ensureFreshIndex();
  const [result, installed] = await Promise.all([
    runArduinoCli(
      ["lib", "search", "--format", "json", "--omit-releases-details", "--", query],
      projectRoot,
      { timeoutMs: 60_000, timeoutMessage: "Library search timed out.", maxStdoutLength: 20_000_000 },
    ),
    listInstalled(),
  ]);
  if (result.exitCode !== 0) {
    throw new CompilerError("Library search failed.", 503, result.logs);
  }
  const output = parseJson<{
    libraries?: Array<{ name?: string; latest?: IndexRelease; available_versions?: string[] }>;
  }>(result.stdout, result.logs, "library search result");
  const installedVersions = new Map(installed.map((library) => [library.name, library.version]));

  return (output.libraries ?? [])
    .flatMap(({ name, latest, available_versions }) => {
      if (!name || !latest?.version) {
        return [];
      }
      return [
        {
          name,
          author: latest.author ?? "",
          sentence: latest.sentence ?? "",
          website: httpUrl(latest.website),
          category: latest.category,
          architectures: latest.architectures ?? [],
          includes: latest.provides_includes ?? [],
          latestVersion: latest.version,
          versions: [...(available_versions ?? [latest.version])].sort(compareVersions).reverse(),
          installedVersion: installedVersions.get(name),
        },
      ];
    })
    .slice(0, maxSearchResults);
}

function install(name: string, version?: string): Promise<string> {
  return serialize(async () => {
    const target = version ? `${name}@${version}` : name;
    const result = await runArduinoCli(
      ["--no-color", "lib", "install", "--", target],
      projectRoot,
      installTimeout,
    );
    if (result.exitCode !== 0) {
      throw new CompilerError(`Could not install ${target}.`, 422, result.logs);
    }
    return result.logs;
  });
}

function uninstall(name: string): Promise<string> {
  return serialize(async () => {
    const result = await runArduinoCli(["--no-color", "lib", "uninstall", "--", name]);
    if (result.exitCode !== 0) {
      throw new CompilerError(`Could not remove ${name}.`, 422, result.logs);
    }
    return result.logs;
  });
}

function installZip(archive: Buffer): Promise<string> {
  return serialize(async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "bit-lab-library-"));
    const archivePath = path.join(temporaryDirectory, "library.zip");
    try {
      await writeFile(archivePath, archive);
      // ZIP installs are disabled in arduino-cli.yaml; allow them only for this command.
      const result = await runArduinoCli(
        ["--no-color", "lib", "install", "--zip-path", archivePath],
        projectRoot,
        { ...installTimeout, env: { ARDUINO_LIBRARY_ENABLE_UNSAFE_INSTALL: "true" } },
      );
      if (result.exitCode !== 0) {
        throw new CompilerError(
          "Could not install the ZIP library. It must contain one Arduino library folder.",
          422,
          result.logs,
        );
      }
      return result.logs;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
}

export const arduinoLibraryManager: LibraryManager = {
  search,
  listInstalled,
  install,
  uninstall,
  installZip,
};
