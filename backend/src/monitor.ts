import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { configPath, getCliPath, projectRoot } from "./compiler.js";

export const supportedBaudRates = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000,
  2000000,
];

export function isSupportedBaudRate(value: number): boolean {
  return supportedBaudRates.includes(value);
}

export type MonitorEvents = {
  onData(text: string): void;
  // `error` is set only when the monitor stopped without being asked to.
  onClose(error?: string): void;
};

export type MonitorSession = {
  write(data: string): void;
  // Resolves once the serial port has been released. Safe to call more than once.
  close(): Promise<void>;
};

export type MonitorOpener = (port: string, baudRate: number, events: MonitorEvents) => MonitorSession;

const closeTimeoutMs = 3_000;

function killTree(child: ChildProcess) {
  // arduino-cli runs the serial-monitor plugin as its own child, which would keep
  // the COM port open if only the parent were killed.
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGKILL");
}

export const openArduinoMonitor: MonitorOpener = (port, baudRate, events) => {
  const child = spawn(
    getCliPath(),
    [
      "--config-file",
      configPath,
      "--no-color",
      "monitor",
      "--port",
      port,
      "--protocol",
      "serial",
      "--config",
      `baudrate=${baudRate}`,
      "--quiet",
    ],
    { cwd: projectRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const decoder = new StringDecoder("utf8");
  let errors = "";
  let closing = false;
  let finished = false;

  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });

  const finish = (error?: string) => {
    if (finished) {
      return;
    }
    finished = true;
    const rest = decoder.end();
    if (rest) {
      events.onData(rest);
    }
    events.onClose(error);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (text) {
      events.onData(text);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (errors.length < 2_000) {
      errors += chunk.toString("utf8");
    }
  });
  // Writes racing the process exit would otherwise crash the server with EPIPE.
  child.stdin.on("error", () => {});

  child.once("error", (error: NodeJS.ErrnoException) => {
    finish(
      error.code === "ENOENT"
        ? "Arduino CLI was not found. Run 'npm run arduino:setup' or set ARDUINO_CLI_PATH."
        : `Could not start the serial monitor: ${error.message}`,
    );
  });
  child.once("close", (code) => {
    finish(
      closing || code === 0
        ? undefined
        : errors.trim() || `The serial monitor stopped unexpectedly (exit code ${code}).`,
    );
  });

  return {
    write(data) {
      if (!finished) {
        child.stdin.write(data);
      }
    },
    async close() {
      if (!finished && !closing) {
        closing = true;
        // End of input makes arduino-cli close the port and exit on its own.
        child.stdin.end();
        const timer = setTimeout(() => killTree(child), closeTimeoutMs);
        void exited.then(() => clearTimeout(timer));
      }
      await exited;
    },
  };
};
