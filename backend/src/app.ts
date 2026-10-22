import express, { type Request, type Response } from "express";
import helmet from "helmet";
import {
  artifactExtensions,
  compileSketch,
  CompilerError,
  listSerialPorts,
  esp32SupportFiles,
  type CompileArtifact,
  type CompilationResult,
  type Esp32SupportFile,
  type SerialPort,
  isSupportedBoard,
  requiresSupportFiles,
  uploadBinary,
} from "./compiler.js";
import {
  arduinoLibraryManager,
  isValidLibraryName,
  isValidLibraryVersion,
  type LibraryManager,
} from "./libraries.js";
import {
  arduinoBoardManager,
  isValidFqbn,
  isValidIndexUrl,
  isValidPlatformId,
  isValidPlatformVersion,
  type BoardManager,
} from "./boards.js";
import {
  isSupportedBaudRate,
  openArduinoMonitor,
  type MonitorOpener,
  type MonitorSession,
} from "./monitor.js";
import { createRateLimiters, rateLimitConfigFromEnv, type RateLimitConfig } from "./rateLimit.js";

type CompileResponse = {
  success: boolean;
  message: string;
  logs: string;
  artifact?: CompileArtifact;
};

type Compiler = (code: string, board: string) => Promise<CompilationResult>;

type UploadResult = {
  success: boolean;
  message: string;
  logs: string;
};

type PortLister = () => Promise<SerialPort[]>;
type Uploader = (
  port: string,
  board: string,
  binary: Buffer,
  filename: string,
  supportFiles?: Record<Esp32SupportFile, Buffer>,
) => Promise<string>;
type PortsResponse = {
  success: boolean;
  ports?: SerialPort[];
  message?: string;
  logs?: string;
};

const maxLibraryZipBytes = 20 * 1024 * 1024;
const maxMonitorSendLength = 1_024;
const monitorHeartbeatMs = 15_000;

type ServiceResponse = {
  success: boolean;
  message: string;
  logs: string;
};

function sendServiceError(response: Response, error: unknown, action: string) {
  if (error instanceof CompilerError) {
    response.status(error.statusCode).json({
      success: false,
      message: error.message,
      logs: error.logs,
    });
    return;
  }
  console.error(`Unexpected error while ${action}:`, error);
  response.status(500).json({
    success: false,
    message: `An unexpected error occurred while ${action}.`,
    logs: "",
  });
}

export type AppSecurityOptions = {
  enforceHttps?: boolean;
  trustProxy?: boolean;
  rateLimit?: RateLimitConfig;
};

function decodeIntelHex(contentBase64: string): Buffer | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
    return undefined;
  }

  const hex = Buffer.from(contentBase64, "base64");
  const lines = hex.toString("ascii").trim().split(/\r?\n/);
  let hasEofRecord = false;

  for (const line of lines) {
    if (!/^:[0-9A-Fa-f]+$/.test(line) || line.length < 11) {
      return undefined;
    }
    const byteCount = Number.parseInt(line.slice(1, 3), 16);
    if (line.length !== 11 + byteCount * 2) {
      return undefined;
    }
    const record = Buffer.from(line.slice(1), "hex");
    if (record.reduce((sum, byte) => sum + byte, 0) % 256 !== 0) {
      return undefined;
    }
    if (line.slice(7, 9).toUpperCase() === "01" && byteCount === 0) {
      hasEofRecord = true;
    }
  }

  return hasEofRecord ? hex : undefined;
}

function decodeArtifact(
  contentBase64: string,
  filename: string,
  board: string,
): Buffer | undefined {
  if (
    !/^[A-Za-z0-9_-]{1,32}\.(?:hex|bin)$/.test(filename) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      contentBase64,
    )
  ) {
    return undefined;
  }

  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (!(artifactExtensions(board) as string[]).includes(extension)) {
    return undefined;
  }

  const binary = Buffer.from(contentBase64, "base64");
  if (binary.length === 0 || binary.length > 500_000) {
    return undefined;
  }

  if (extension === "hex" && !decodeIntelHex(contentBase64)) {
    return undefined;
  }
  return binary;
}

function decodeSupportFiles(value: unknown): Record<Esp32SupportFile, Buffer> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const decoded: Partial<Record<Esp32SupportFile, Buffer>> = {};
  for (const name of esp32SupportFiles) {
    const encoded = (value as Record<string, unknown>)[name];
    if (
      typeof encoded !== "string" ||
      encoded.length > 100_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      return undefined;
    }
    const file = Buffer.from(encoded, "base64");
    if (file.length === 0) {
      return undefined;
    }
    decoded[name] = file;
  }
  return decoded as Record<Esp32SupportFile, Buffer>;
}

export function createApp(
  compiler: Compiler = compileSketch,
  portLister: PortLister = listSerialPorts,
  uploader: Uploader = uploadBinary,
  security: AppSecurityOptions = {},
  libraries: LibraryManager = arduinoLibraryManager,
  openMonitor: MonitorOpener = openArduinoMonitor,
  boardManager: BoardManager = arduinoBoardManager,
) {
  const app = express();
  // One serial monitor per port; a port can't be shared, so uploads close it first.
  const monitors = new Map<string, MonitorSession>();

  async function releaseMonitor(port: string) {
    await monitors.get(port)?.close();
  }

  // The bundled board list is always allowed; anything else must come from an installed core.
  async function isKnownBoard(fqbn: string) {
    return isValidFqbn(fqbn) && (isSupportedBoard(fqbn) || (await boardManager.hasBoard(fqbn)));
  }
  const limiters = createRateLimiters(security.rateLimit ?? rateLimitConfigFromEnv());
  const enforceHttps =
    security.enforceHttps ??
    (process.env.NODE_ENV === "production" || process.env.REQUIRE_HTTPS === "true");

  // Trust exactly one reverse-proxy hop; trusting all hops lets clients spoof their IP
  // and bypass the per-IP rate limit.
  const trustProxy = security.trustProxy ?? process.env.TRUST_PROXY === "true";
  app.set("trust proxy", trustProxy ? 1 : false);
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use((request, response, next) => {
    if (enforceHttps && !request.secure) {
      response.status(426).json({
        success: false,
        message: "HTTPS is required for this API.",
      });
      return;
    }
    if (request.secure) {
      response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });
  app.use(limiters.api);
  app.use(express.json({ limit: "1mb" }));

  app.get("/ports", async (_request, response: Response<PortsResponse>) => {
    try {
      response.json({ success: true, ports: await portLister() });
    } catch (error) {
      if (error instanceof CompilerError) {
        response.status(error.statusCode).json({
          success: false,
          message: error.message,
          logs: error.logs,
        });
        return;
      }
      console.error("Unexpected board detection error:", error);
      response.status(500).json({
        success: false,
        message: "An unexpected board detection error occurred.",
        logs: "",
      });
    }
  });

  app.post("/compile", limiters.compile, async (request: Request, response: Response<CompileResponse>) => {
    const { code, board } = request.body as { code?: unknown; board?: unknown };

    if (typeof code !== "string" || code.trim().length === 0) {
      response.status(400).json({
        success: false,
        message: "A non-empty code string is required.",
        logs: "",
      });
      return;
    }

    if (typeof board !== "string" || !(await isKnownBoard(board))) {
      response.status(400).json({
        success: false,
        message: "A supported board FQBN is required.",
        logs: "",
      });
      return;
    }

    try {
      const result = await compiler(code, board);
      response.json({
        success: true,
        message: "Compilation succeeded.",
        logs: result.logs,
        artifact: result.artifact,
      });
    } catch (error) {
      if (error instanceof CompilerError) {
        response.status(error.statusCode).json({
          success: false,
          message: error.message,
          logs: error.logs,
        });
        return;
      }

      console.error("Unexpected compilation service error:", error);
      response.status(500).json({
        success: false,
        message: "An unexpected compilation service error occurred.",
        logs: "",
      });
    }
  });

  app.post("/upload", limiters.upload, async (request: Request, response: Response<UploadResult>) => {
    const { port, board, binary, filename, contentBase64, supportFiles } = request.body as {
      port?: unknown;
      board?: unknown;
      binary?: unknown;
      filename?: unknown;
      contentBase64?: unknown;
      supportFiles?: unknown;
    };

    if (typeof port !== "string" || port.trim().length === 0) {
      response.status(400).json({
        success: false,
        message: "A serial port is required.",
        logs: "",
      });
      return;
    }

    if (typeof board !== "string" || !(await isKnownBoard(board))) {
      response.status(400).json({
        success: false,
        message: "A supported board FQBN is required.",
        logs: "",
      });
      return;
    }

    const encodedBinary = binary ?? contentBase64;
    if (
      typeof encodedBinary !== "string" ||
      encodedBinary.length > 700_000 ||
      typeof filename !== "string"
    ) {
      response.status(400).json({
        success: false,
        message: "A valid compiled binary and filename are required.",
        logs: "",
      });
      return;
    }

    const decodedBinary = decodeArtifact(encodedBinary, filename, board);
    if (!decodedBinary) {
      response.status(400).json({
        success: false,
        message: "The binary does not match the selected board or is invalid.",
        logs: "",
      });
      return;
    }

    const decodedSupportFiles = requiresSupportFiles(board)
      ? decodeSupportFiles(supportFiles)
      : undefined;
    if (requiresSupportFiles(board) && !decodedSupportFiles) {
      response.status(400).json({
        success: false,
        message: "ESP32 uploads need the bootloader and partition files. Compile the sketch again.",
        logs: "",
      });
      return;
    }

    try {
      const ports = await portLister();
      if (!ports.some((candidate) => candidate.address === port)) {
        response.status(409).json({
          success: false,
          message: "The selected port is not currently available. Refresh the board list.",
          logs: "",
        });
        return;
      }

      await releaseMonitor(port);
      const logs = await uploader(port, board, decodedBinary, filename, decodedSupportFiles);
      response.json({ success: true, message: "Upload succeeded.", logs });
    } catch (error) {
      if (error instanceof CompilerError) {
        response.status(error.statusCode).json({
          success: false,
          message: error.message,
          logs: error.logs,
        });
        return;
      }
      console.error("Unexpected upload service error:", error);
      response.status(500).json({
        success: false,
        message: "An unexpected upload service error occurred.",
        logs: "",
      });
    }
  });

  // Streams serial output as newline-delimited JSON until the client disconnects.
  app.get("/monitor", async (request, response) => {
    const port = typeof request.query.port === "string" ? request.query.port.trim() : "";
    const baudRate = Number(request.query.baud);
    if (port.length === 0 || port.length > 100 || !isSupportedBaudRate(baudRate)) {
      response.status(400).json({
        success: false,
        message: "A serial port and a supported baud rate are required.",
        logs: "",
      });
      return;
    }

    try {
      const ports = await portLister();
      if (!ports.some((candidate) => candidate.address === port)) {
        response.status(409).json({
          success: false,
          message: "The selected port is not currently available. Refresh the board list.",
          logs: "",
        });
        return;
      }
      await releaseMonitor(port);
    } catch (error) {
      sendServiceError(response, error, "opening the serial monitor");
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    const send = (event: Record<string, unknown>) => {
      if (!response.writableEnded) {
        response.write(`${JSON.stringify(event)}
`);
      }
    };
    const heartbeat = setInterval(() => send({ type: "ping" }), monitorHeartbeatMs);

    const session: MonitorSession = openMonitor(port, baudRate, {
      onData: (text) => send({ type: "data", text }),
      onClose: (error) => {
        clearInterval(heartbeat);
        if (monitors.get(port) === session) {
          monitors.delete(port);
        }
        send(error ? { type: "error", message: error } : { type: "closed" });
        response.end();
      },
    });
    monitors.set(port, session);
    send({ type: "open", port, baudRate });

    response.on("close", () => {
      clearInterval(heartbeat);
      void session.close();
    });
  });

  app.post("/monitor/send", async (request: Request, response: Response<ServiceResponse>) => {
    const { port, data } = request.body as { port?: unknown; data?: unknown };
    if (
      typeof port !== "string" ||
      typeof data !== "string" ||
      data.length === 0 ||
      data.length > maxMonitorSendLength
    ) {
      response.status(400).json({
        success: false,
        message: `A port and up to ${maxMonitorSendLength} characters of data are required.`,
        logs: "",
      });
      return;
    }

    const session = monitors.get(port);
    if (!session) {
      response.status(409).json({
        success: false,
        message: "The serial monitor is not connected to that port.",
        logs: "",
      });
      return;
    }
    session.write(data);
    response.json({ success: true, message: "Sent.", logs: "" });
  });

  app.get("/libraries", async (_request, response) => {
    try {
      response.json({ success: true, libraries: await libraries.listInstalled() });
    } catch (error) {
      sendServiceError(response, error, "listing libraries");
    }
  });

  app.get("/libraries/search", async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
    if (query.length === 0 || query.length > 100) {
      response.status(400).json({
        success: false,
        message: "Enter a search term of up to 100 characters.",
        logs: "",
      });
      return;
    }

    try {
      response.json({ success: true, libraries: await libraries.search(query) });
    } catch (error) {
      sendServiceError(response, error, "searching libraries");
    }
  });

  app.post(
    "/libraries/install",
    limiters.libraryChanges,
    async (request: Request, response: Response<ServiceResponse>) => {
      const { name, version } = request.body as { name?: unknown; version?: unknown };
      if (
        typeof name !== "string" ||
        !isValidLibraryName(name) ||
        (version !== undefined && (typeof version !== "string" || !isValidLibraryVersion(version)))
      ) {
        response.status(400).json({
          success: false,
          message: "A valid library name and optional version are required.",
          logs: "",
        });
        return;
      }

      try {
        const logs = await libraries.install(name, version);
        response.json({
          success: true,
          message: `Installed ${name}${version ? ` ${version}` : ""}.`,
          logs,
        });
      } catch (error) {
        sendServiceError(response, error, "installing the library");
      }
    },
  );

  app.post(
    "/libraries/uninstall",
    limiters.libraryChanges,
    async (request: Request, response: Response<ServiceResponse>) => {
      const { name } = request.body as { name?: unknown };
      if (typeof name !== "string" || !isValidLibraryName(name)) {
        response.status(400).json({
          success: false,
          message: "A valid library name is required.",
          logs: "",
        });
        return;
      }

      try {
        const logs = await libraries.uninstall(name);
        response.json({ success: true, message: `Removed ${name}.`, logs });
      } catch (error) {
        sendServiceError(response, error, "removing the library");
      }
    },
  );

  app.post(
    "/libraries/zip",
    limiters.libraryChanges,
    express.raw({ type: "application/zip", limit: maxLibraryZipBytes }),
    async (request: Request, response: Response<ServiceResponse>) => {
      const archive = request.body;
      // Every ZIP archive starts with a local file header ("PK").
      if (
        !Buffer.isBuffer(archive) ||
        archive.length < 4 ||
        archive.readUInt32LE(0) !== 0x04034b50
      ) {
        response.status(400).json({
          success: false,
          message: "Upload a .zip file containing an Arduino library.",
          logs: "",
        });
        return;
      }

      try {
        const logs = await libraries.installZip(archive);
        response.json({ success: true, message: "Installed the ZIP library.", logs });
      } catch (error) {
        sendServiceError(response, error, "installing the ZIP library");
      }
    },
  );

  app.get("/boards", async (_request, response) => {
    try {
      response.json({ success: true, boards: await boardManager.listBoards() });
    } catch (error) {
      sendServiceError(response, error, "listing boards");
    }
  });

  app.get("/cores", async (_request, response) => {
    try {
      response.json({ success: true, platforms: await boardManager.listInstalled() });
    } catch (error) {
      sendServiceError(response, error, "listing board packages");
    }
  });

  app.get("/cores/search", async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
    if (query.length > 100) {
      response.status(400).json({
        success: false,
        message: "Enter a search term of up to 100 characters.",
        logs: "",
      });
      return;
    }

    try {
      response.json({ success: true, platforms: await boardManager.search(query) });
    } catch (error) {
      sendServiceError(response, error, "searching board packages");
    }
  });

  app.post(
    "/cores/install",
    limiters.libraryChanges,
    async (request: Request, response: Response<ServiceResponse>) => {
      const { id, version } = request.body as { id?: unknown; version?: unknown };
      if (
        typeof id !== "string" ||
        !isValidPlatformId(id) ||
        (version !== undefined && (typeof version !== "string" || !isValidPlatformVersion(version)))
      ) {
        response.status(400).json({
          success: false,
          message: "A valid board package id (like arduino:avr) and optional version are required.",
          logs: "",
        });
        return;
      }

      try {
        const logs = await boardManager.install(id, version);
        response.json({ success: true, message: `Installed ${id}${version ? ` ${version}` : ""}.`, logs });
      } catch (error) {
        sendServiceError(response, error, "installing the board package");
      }
    },
  );

  app.post(
    "/cores/uninstall",
    limiters.libraryChanges,
    async (request: Request, response: Response<ServiceResponse>) => {
      const { id } = request.body as { id?: unknown };
      if (typeof id !== "string" || !isValidPlatformId(id)) {
        response.status(400).json({
          success: false,
          message: "A valid board package id is required.",
          logs: "",
        });
        return;
      }

      try {
        const logs = await boardManager.uninstall(id);
        response.json({ success: true, message: `Removed ${id}.`, logs });
      } catch (error) {
        sendServiceError(response, error, "removing the board package");
      }
    },
  );

  app.get("/cores/urls", async (_request, response) => {
    try {
      response.json({ success: true, urls: await boardManager.listUrls() });
    } catch (error) {
      sendServiceError(response, error, "reading the board manager URLs");
    }
  });

  app.post("/cores/urls", limiters.libraryChanges, async (request: Request, response: Response<ServiceResponse>) => {
    const { url } = request.body as { url?: unknown };
    if (typeof url !== "string" || !isValidIndexUrl(url.trim())) {
      response.status(400).json({
        success: false,
        message: "Enter an http(s) link to a board package index (.json), up to 500 characters.",
        logs: "",
      });
      return;
    }

    try {
      const logs = await boardManager.addUrl(url.trim());
      response.json({ success: true, message: "Added the board manager URL and downloaded its index.", logs });
    } catch (error) {
      sendServiceError(response, error, "adding the board manager URL");
    }
  });

  app.post(
    "/cores/urls/remove",
    limiters.libraryChanges,
    async (request: Request, response: Response<ServiceResponse>) => {
      const { url } = request.body as { url?: unknown };
      if (typeof url !== "string" || url.length === 0 || url.length > 500) {
        response.status(400).json({ success: false, message: "A board manager URL is required.", logs: "" });
        return;
      }

      try {
        const logs = await boardManager.removeUrl(url);
        response.json({ success: true, message: "Removed the board manager URL.", logs });
      } catch (error) {
        sendServiceError(response, error, "removing the board manager URL");
      }
    },
  );

  // Body-parser failures (oversized or malformed bodies) would otherwise produce an HTML page.
  app.use((error: unknown, _request: Request, response: Response, next: express.NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const status =
      typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500;
    response.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message:
        status === 413
          ? "The request is too large. Library ZIP files may be up to 20 MB."
          : status === 400
            ? "The request body is malformed."
            : "An unexpected server error occurred.",
      logs: "",
    });
  });

  return app;
}

export const app = createApp();
