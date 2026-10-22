import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import boards from "../../boards.json" with { type: "json" };

const sketchName = "BitLabSketch";
const maxLogLength = 200_000;
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const configPath = path.join(projectRoot, "arduino-cli.yaml");

export type CompileArtifact = {
  filename: string;
  contentType: string;
  contentBase64: string;
  // ESP32 uploads also flash the bootloader and partition table from the build.
  supportFiles?: Record<Esp32SupportFile, string>;
};

export type Esp32SupportFile = "bootloader" | "partitions";
export const esp32SupportFiles: Esp32SupportFile[] = ["bootloader", "partitions"];

export function requiresSupportFiles(fqbn: string): boolean {
  return fqbn.startsWith("esp32:");
}

export type CompilationResult = {
  artifact: CompileArtifact;
  logs: string;
};

export type SerialPort = {
  address: string;
  label: string;
};

export type SupportedBoard = {
  name: string;
  fqbn: string;
};

export const supportedBoards = boards as SupportedBoard[];

export function isSupportedBoard(fqbn: string): boolean {
  return supportedBoards.some((board) => board.fqbn === fqbn);
}

export type ArtifactExtension = "hex" | "bin";

// The file the board's upload tool expects: AVR boards flash Intel HEX, most other
// cores (ESP, SAMD, Renesas, mbed...) flash a raw .bin.
export function artifactExtensions(fqbn: string): ArtifactExtension[] {
  const architecture = fqbn.split(":")[1] ?? "";
  return architecture === "avr" || architecture === "megaavr" ? ["hex"] : ["bin", "hex"];
}

export class CompilerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly logs = "",
  ) {
    super(message);
    this.name = "CompilerError";
  }
}

export function getCliPath() {
  if (process.env.ARDUINO_CLI_PATH) {
    return process.env.ARDUINO_CLI_PATH;
  }

  const localCli = path.join(
    projectRoot,
    ".tools",
    process.platform === "win32" ? "arduino-cli.exe" : "arduino-cli",
  );
  return localCli;
}

export type CliOptions = {
  timeoutMs?: number;
  timeoutMessage?: string;
  env?: NodeJS.ProcessEnv;
  // Upper bound for the separately captured stdout, used for --format json output.
  maxStdoutLength?: number;
};

export function runArduinoCli(
  args: string[],
  cwd: string = projectRoot,
  options: CliOptions = {},
): Promise<{ logs: string; stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const cliPath = getCliPath();
    const child = spawn(cliPath, ["--config-file", configPath, ...args], {
      cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    let stdout = "";
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxStdoutLength = options.maxStdoutLength ?? maxLogLength;

    const appendLogs = (chunk: Buffer) => {
      if (logs.length < maxLogLength) {
        logs += chunk.toString("utf8").slice(0, maxLogLength - logs.length);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      appendLogs(chunk);
      if (stdout.length < maxStdoutLength) {
        stdout += chunk.toString("utf8").slice(0, maxStdoutLength - stdout.length);
      }
    });
    child.stderr.on("data", appendLogs);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT") {
        reject(
          new CompilerError(
            "Arduino CLI was not found. Run 'npm run arduino:setup' or set ARDUINO_CLI_PATH.",
            503,
            logs,
          ),
        );
        return;
      }
      reject(new CompilerError(`Could not start Arduino CLI: ${error.message}`, 500, logs));
    });

    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new CompilerError(
            options.timeoutMessage ?? `Compilation timed out after ${timeoutMs / 1000} seconds.`,
            504,
            logs,
          ),
        );
        return;
      }
      resolve({ logs, stdout, exitCode: code ?? 1 });
    });
  });
}

export async function compileSketch(code: string, fqbn: string): Promise<CompilationResult> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "bit-lab-compile-"));
  const sketchDirectory = path.join(temporaryDirectory, sketchName);
  const outputDirectory = path.join(temporaryDirectory, "build");
  const sketchPath = path.join(sketchDirectory, `${sketchName}.ino`);

  try {
    await Promise.all([mkdir(sketchDirectory), mkdir(outputDirectory)]);
    await writeFile(sketchPath, code, "utf8");

    const result = await runArduinoCli(
      [
        "--no-color",
        "compile",
        "--fqbn",
        fqbn,
        "--output-dir",
        outputDirectory,
        sketchDirectory,
      ],
      projectRoot,
    );

    if (result.exitCode !== 0) {
      throw new CompilerError("Compilation failed.", 422, result.logs);
    }

    let extension: ArtifactExtension | undefined;
    let binary: Buffer | undefined;
    for (const candidate of artifactExtensions(fqbn)) {
      try {
        binary = await readFile(path.join(outputDirectory, `${sketchName}.ino.${candidate}`));
        extension = candidate;
        break;
      } catch {
        // Try the next format this board can use.
      }
    }
    if (!binary || !extension) {
      throw new CompilerError(
        `Arduino CLI completed without producing a .${artifactExtensions(fqbn).join(" or .")} binary.`,
        500,
        result.logs,
      );
    }

    let supportFiles: CompileArtifact["supportFiles"];
    if (requiresSupportFiles(fqbn)) {
      try {
        const [bootloader, partitions] = await Promise.all(
          esp32SupportFiles.map((name) =>
            readFile(path.join(outputDirectory, `${sketchName}.ino.${name}.bin`)),
          ),
        );
        supportFiles = {
          bootloader: bootloader.toString("base64"),
          partitions: partitions.toString("base64"),
        };
      } catch {
        throw new CompilerError(
          "Arduino CLI completed without producing the ESP32 bootloader and partition files.",
          500,
          result.logs,
        );
      }
    }

    return {
      artifact: {
        filename: `${sketchName}.${extension}`,
        contentType: "application/octet-stream",
        contentBase64: binary.toString("base64"),
        ...(supportFiles && { supportFiles }),
      },
      logs: result.logs,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function listSerialPorts(): Promise<SerialPort[]> {
  const result = await runArduinoCli(["--no-color", "board", "list", "--format", "json"], projectRoot);
  if (result.exitCode !== 0) {
    throw new CompilerError("Could not detect connected Arduino boards.", 503, result.logs);
  }

  try {
    const output = JSON.parse(result.stdout) as {
      detected_ports?: Array<{
        port?: { address?: unknown; label?: unknown; protocol?: unknown };
      }>;
    };
    return (output.detected_ports ?? [])
      .map(({ port }) => {
        if (
          !port ||
          port.protocol !== "serial" ||
          typeof port.address !== "string"
        ) {
          return undefined;
        }
        return {
          address: port.address,
          label: typeof port.label === "string" ? port.label : port.address,
        };
      })
      .filter((port): port is SerialPort => port !== undefined);
  } catch {
    throw new CompilerError("Arduino CLI returned an invalid board list.", 500, result.logs);
  }
}

export async function uploadBinary(
  port: string,
  fqbn: string,
  binary: Buffer,
  filename: string,
  supportFiles?: Record<Esp32SupportFile, Buffer>,
): Promise<string> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "bit-lab-upload-"));
  const sketchDirectory = path.join(temporaryDirectory, sketchName);
  const binaryPath = path.join(temporaryDirectory, `${sketchName}${path.extname(filename)}`);

  try {
    await mkdir(sketchDirectory);
    await writeFile(path.join(sketchDirectory, `${sketchName}.ino`), "", "utf8");
    await writeFile(binaryPath, binary);
    // The ESP32 upload recipe reads {project_name}.bootloader.bin and .partitions.bin
    // from the same directory as the --input-file binary.
    if (supportFiles) {
      await Promise.all(
        esp32SupportFiles.map((name) =>
          writeFile(path.join(temporaryDirectory, `${sketchName}.${name}.bin`), supportFiles[name]),
        ),
      );
    }

    const result = await runArduinoCli(
      [
        "--no-color",
        "upload",
        "--fqbn",
        fqbn,
        "--port",
        port,
        "--input-file",
        binaryPath,
        sketchDirectory,
      ],
      projectRoot,
    );

    if (result.exitCode !== 0) {
      throw new CompilerError("Upload failed. Check the board connection and port.", 422, result.logs);
    }

    return result.logs;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
