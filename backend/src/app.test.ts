import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createApp } from "./app.js";
import { CompilerError, type CompilationResult } from "./compiler.js";
import type { InstalledLibrary, LibraryManager } from "./libraries.js";
import type { MonitorEvents, MonitorOpener } from "./monitor.js";
import type { BoardManager, PlatformSummary } from "./boards.js";

const successfulResult: CompilationResult = {
  logs: "Sketch compiled successfully.",
  artifact: {
    filename: "BitLabSketch.hex",
    contentType: "application/octet-stream",
    contentBase64: "AQID",
  },
};
const availablePorts = [{ address: "COM4", label: "Arduino Uno (COM4)" }];
// Boards installed by the Board Manager beyond the bundled boards.json list.
const installedBoards = [
  { name: "Arduino MKR1000", fqbn: "arduino:samd:mkr1000", platform: "arduino:samd", platformName: "Arduino SAMD Boards" },
];

function fakeBoardManager(overrides: Partial<BoardManager> = {}): BoardManager {
  const unexpected = async () => {
    throw new Error("unexpected board manager call");
  };
  return {
    listBoards: async () => installedBoards,
    hasBoard: async (fqbn) => installedBoards.some((board) => board.fqbn === fqbn),
    listInstalled: unexpected,
    search: unexpected,
    install: unexpected,
    uninstall: unexpected,
    listUrls: unexpected,
    addUrl: unexpected,
    removeUrl: unexpected,
    ...overrides,
  };
}

const app = createApp(
  async () => successfulResult,
  async () => availablePorts,
  async () => "avrdude done. Thank you.",
  {},
  undefined,
  undefined,
  fakeBoardManager(),
);
let baseUrl: string;
let server: ReturnType<typeof app.listen>;

before(async () => {
  server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

test("POST /compile returns the compiled binary and compiler logs", async () => {
  let compiledBoard = "";
  const boardApp = createApp(
    async (_code, board) => {
      compiledBoard = board;
      return successfulResult;
    },
    async () => availablePorts,
    async () => "avrdude done. Thank you.",
  );
  const boardServer = boardApp.listen(0);
  await once(boardServer, "listening");
  const address = boardServer.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "void setup() {}", board: "arduino:avr:mega" }),
    });

    assert.equal(response.status, 200);
    assert.equal(compiledBoard, "arduino:avr:mega");
    assert.deepEqual(await response.json(), {
      success: true,
      message: "Compilation succeeded.",
      logs: "Sketch compiled successfully.",
      artifact: {
        filename: "BitLabSketch.hex",
        contentType: "application/octet-stream",
        contentBase64: "AQID",
      },
    });
  } finally {
    boardServer.close();
  }
});

test("POST /compile returns compiler failures and logs", async () => {
  const failingApp = createApp(
    async () => {
      throw new CompilerError("Compilation failed.", 422, "error: expected ';'");
    },
    undefined,
    undefined,
  );
  const failingServer = failingApp.listen(0);
  await once(failingServer, "listening");
  const address = failingServer.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "void setup() {}", board: "arduino:avr:uno" }),
    });

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      success: false,
      message: "Compilation failed.",
      logs: "error: expected ';'",
    });
  } finally {
    failingServer.close();
  }
});

test("POST /compile rejects a missing or blank code field", async () => {
  const response = await fetch(`${baseUrl}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "  ", board: "arduino:avr:uno" }),
  });

  assert.equal(response.status, 400);
});

test("POST /compile rejects unsupported board FQBNs", async () => {
  const response = await fetch(`${baseUrl}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "void setup() {}", board: "attacker:core:target" }),
  });

  assert.equal(response.status, 400);
});

test("POST /upload accepts a board-matched ESP binary", async () => {
  let uploadedBoard = "";
  let uploadedSupportFiles: Record<string, Buffer> | undefined;
  const espApp = createApp(
    async () => successfulResult,
    async () => availablePorts,
    async (_port, board, _binary, _filename, supportFiles) => {
      uploadedBoard = board;
      uploadedSupportFiles = supportFiles;
      return "ESP upload complete.";
    },
  );
  const espServer = espApp.listen(0);
  await once(espServer, "listening");
  const address = espServer.address();
  assert.ok(address && typeof address !== "string");
  const espUpload = (supportFiles?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        port: "COM4",
        board: "esp32:esp32:esp32",
        filename: "BitLabSketch.bin",
        binary: Buffer.from([0x01, 0x02, 0x03]).toString("base64"),
        supportFiles,
      }),
    });

  try {
    const missing = await espUpload();
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).message, /bootloader and partition/);

    const response = await espUpload({
      bootloader: Buffer.from([0xe9]).toString("base64"),
      partitions: Buffer.from([0xaa, 0x50]).toString("base64"),
    });

    assert.equal(response.status, 200);
    assert.equal(uploadedBoard, "esp32:esp32:esp32");
    assert.deepEqual(uploadedSupportFiles?.bootloader, Buffer.from([0xe9]));
    assert.deepEqual(uploadedSupportFiles?.partitions, Buffer.from([0xaa, 0x50]));
  } finally {
    espServer.close();
  }
});

test("GET /ports lists the detected serial ports", async () => {
  const response = await fetch(`${baseUrl}/ports`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    ports: availablePorts,
  });
});

test("POST /upload flashes a valid HEX artifact to an available port", async () => {
  const response = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      port: "COM4",
      board: "arduino:avr:uno",
      filename: "BitLabSketch.hex",
      binary: Buffer.from(":00000001FF").toString("base64"),
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    message: "Upload succeeded.",
    logs: "avrdude done. Thank you.",
  });
});

test("POST /upload rejects ports not currently detected", async () => {
  let uploadCalled = false;
  const guardedApp = createApp(
    async () => successfulResult,
    async () => availablePorts,
    async () => {
      uploadCalled = true;
      return "";
    },
  );
  const guardedServer = guardedApp.listen(0);
  await once(guardedServer, "listening");
  const address = guardedServer.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        port: "COM99",
        board: "arduino:avr:uno",
        filename: "BitLabSketch.hex",
        binary: Buffer.from(":00000001FF").toString("base64"),
      }),
    });

    assert.equal(response.status, 409);
    assert.equal(uploadCalled, false);
  } finally {
    guardedServer.close();
  }
});

test("POST /upload rejects malformed Intel HEX artifacts", async () => {
  const response = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      port: "COM4",
      board: "arduino:avr:uno",
      filename: "BitLabSketch.hex",
      binary: Buffer.from(":00000001FE").toString("base64"),
    }),
  });

  assert.equal(response.status, 400);
});

test("API enforces HTTPS when enabled and emits HSTS for secure requests", async () => {
  const secureApp = createApp(
    async () => successfulResult,
    async () => availablePorts,
    undefined,
    { enforceHttps: true, trustProxy: true },
  );
  const secureServer = secureApp.listen(0);
  await once(secureServer, "listening");
  const address = secureServer.address();
  assert.ok(address && typeof address !== "string");
  const secureUrl = `http://127.0.0.1:${address.port}/ports`;

  try {
    const insecure = await fetch(secureUrl, {
      headers: { "X-Forwarded-Proto": "http" },
    });
    assert.equal(insecure.status, 426);

    const secure = await fetch(secureUrl, {
      headers: { "X-Forwarded-Proto": "https" },
    });
    assert.equal(secure.status, 200);
    assert.equal(
      secure.headers.get("strict-transport-security"),
      "max-age=31536000; includeSubDomains",
    );
  } finally {
    secureServer.close();
  }
});

test("compile and upload are rate limited per IP", async () => {
  const limitedApp = createApp(
    async () => successfulResult,
    async () => availablePorts,
    async () => "avrdude done. Thank you.",
    { rateLimit: { apiPerIp: 100, compilePerIp: 2, uploadPerIp: 1, libraryChangesPerIp: 10, windowMs: 60_000 } },
  );
  const limitedServer = limitedApp.listen(0);
  await once(limitedServer, "listening");
  const address = limitedServer.address();
  assert.ok(address && typeof address !== "string");
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const compileBody = { code: "void setup() {}", board: "arduino:avr:uno" };
  const uploadBody = {
    port: "COM4",
    board: "arduino:avr:uno",
    filename: "BitLabSketch.hex",
    binary: Buffer.from(":00000001FF").toString("base64"),
  };

  try {
    assert.equal((await post("/compile", compileBody)).status, 200);
    assert.equal((await post("/compile", compileBody)).status, 200);
    const limited = await post("/compile", compileBody);
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).message, /Too many compile requests/);

    assert.equal((await post("/upload", uploadBody)).status, 200);
    assert.equal((await post("/upload", uploadBody)).status, 429);
  } finally {
    limitedServer.close();
  }
});

test("API is rate limited per IP across all routes", async () => {
  const limitedApp = createApp(
    undefined,
    async () => availablePorts,
    undefined,
    { rateLimit: { apiPerIp: 2, compilePerIp: 10, uploadPerIp: 10, libraryChangesPerIp: 10, windowMs: 60_000 } },
  );
  const limitedServer = limitedApp.listen(0);
  await once(limitedServer, "listening");
  const address = limitedServer.address();
  assert.ok(address && typeof address !== "string");

  try {
    const url = `http://127.0.0.1:${address.port}/ports`;
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 429);
  } finally {
    limitedServer.close();
  }
});

async function withLibraryApp(
  overrides: Partial<LibraryManager>,
  run: (baseUrl: string) => Promise<void>,
) {
  const unexpected = async () => {
    throw new Error("unexpected library call");
  };
  const libraryApp = createApp(undefined, undefined, undefined, {}, {
    search: unexpected,
    listInstalled: unexpected,
    install: unexpected,
    uninstall: unexpected,
    installZip: unexpected,
    ...overrides,
  });
  const libraryServer = libraryApp.listen(0);
  await once(libraryServer, "listening");
  const address = libraryServer.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    libraryServer.close();
  }
}

const installedLibrary: InstalledLibrary = {
  name: "Adafruit Unified Sensor",
  version: "1.1.15",
  author: "Adafruit",
  sentence: "Required for all Adafruit Unified Sensor based libraries.",
  architectures: ["*"],
  includes: ["Adafruit_Sensor.h"],
};

test("GET /libraries lists installed libraries", async () => {
  await withLibraryApp({ listInstalled: async () => [installedLibrary] }, async (url) => {
    const response = await fetch(`${url}/libraries`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, libraries: [installedLibrary] });
  });
});

test("GET /libraries/search requires a search term", async () => {
  let searched = "";
  await withLibraryApp(
    {
      search: async (query) => {
        searched = query;
        return [];
      },
    },
    async (url) => {
      assert.equal((await fetch(`${url}/libraries/search?q=%20`)).status, 400);
      assert.equal((await fetch(`${url}/libraries/search?q=${"x".repeat(101)}`)).status, 400);

      const response = await fetch(`${url}/libraries/search?q=${encodeURIComponent(" dht sensor ")}`);
      assert.equal(response.status, 200);
      assert.equal(searched, "dht sensor");
    },
  );
});

test("POST /libraries/install validates the name and version", async () => {
  const installs: Array<[string, string | undefined]> = [];
  await withLibraryApp(
    {
      install: async (name, version) => {
        installs.push([name, version]);
        return "Installed";
      },
    },
    async (url) => {
      const install = (body: unknown) =>
        fetch(`${url}/libraries/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      assert.equal((await install({ name: "--git-url" })).status, 400);
      assert.equal((await install({ name: "Servo@1.0.0" })).status, 400);
      assert.equal((await install({ name: "Servo", version: "latest; rm" })).status, 400);

      const response = await install({ name: "DHT sensor library", version: "1.4.6" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).message, "Installed DHT sensor library 1.4.6.");
      assert.deepEqual(installs, [["DHT sensor library", "1.4.6"]]);
    },
  );
});

test("POST /libraries/uninstall reports CLI failures", async () => {
  await withLibraryApp(
    {
      uninstall: async (name) => {
        throw new CompilerError(`Could not remove ${name}.`, 422, "library not installed");
      },
    },
    async (url) => {
      const response = await fetch(`${url}/libraries/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Servo" }),
      });
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), {
        success: false,
        message: "Could not remove Servo.",
        logs: "library not installed",
      });
    },
  );
});

test("POST /libraries/zip accepts only ZIP archives", async () => {
  let received: Buffer | undefined;
  await withLibraryApp(
    {
      installZip: async (archive) => {
        received = archive;
        return "Library installed";
      },
    },
    async (url) => {
      const upload = (body: Uint8Array) =>
        fetch(`${url}/libraries/zip`, {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body,
        });

      assert.equal((await upload(Buffer.from("not a zip"))).status, 400);

      const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
      const response = await upload(zip);
      assert.equal(response.status, 200);
      assert.deepEqual(received, zip);

      const tooLarge = await upload(Buffer.alloc(20 * 1024 * 1024 + 1));
      assert.equal(tooLarge.status, 413);
      assert.match((await tooLarge.json()).message, /20 MB/);
    },
  );
});

type FakeMonitor = {
  port: string;
  baudRate: number;
  events: MonitorEvents;
  written: string[];
  closed: boolean;
};

async function withMonitorApp(run: (baseUrl: string, monitors: FakeMonitor[]) => Promise<void>) {
  const monitors: FakeMonitor[] = [];
  const openMonitor: MonitorOpener = (port, baudRate, events) => {
    const monitor: FakeMonitor = { port, baudRate, events, written: [], closed: false };
    monitors.push(monitor);
    return {
      write: (data) => monitor.written.push(data),
      close: async () => {
        if (!monitor.closed) {
          monitor.closed = true;
          events.onClose();
        }
      },
    };
  };
  const monitorApp = createApp(
    async () => successfulResult,
    async () => availablePorts,
    async () => "avrdude done. Thank you.",
    {},
    undefined,
    openMonitor,
  );
  const monitorServer = monitorApp.listen(0);
  await once(monitorServer, "listening");
  const address = monitorServer.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, monitors);
  } finally {
    monitorServer.closeAllConnections();
    monitorServer.close();
  }
}

// Reads newline-delimited JSON events until `count` have arrived.
async function readEvents(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let buffer = "";
  while (events.length < count) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    events.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
  }
  return events;
}

test("GET /monitor validates the port and baud rate", async () => {
  await withMonitorApp(async (url, monitors) => {
    assert.equal((await fetch(`${url}/monitor?port=COM4&baud=1234`)).status, 400);
    assert.equal((await fetch(`${url}/monitor?baud=9600`)).status, 400);
    assert.equal((await fetch(`${url}/monitor?port=COM9&baud=9600`)).status, 409);
    assert.equal(monitors.length, 0);
  });
});

test("GET /monitor streams serial output and POST /monitor/send writes to the port", async () => {
  await withMonitorApp(async (url, monitors) => {
    const controller = new AbortController();
    const response = await fetch(`${url}/monitor?port=COM4&baud=115200`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();

    assert.deepEqual(await readEvents(reader, 1), [{ type: "open", port: "COM4", baudRate: 115200 }]);
    assert.equal(monitors[0].baudRate, 115200);

    monitors[0].events.onData("temp:21.5\n");
    assert.deepEqual(await readEvents(reader, 1), [{ type: "data", text: "temp:21.5\n" }]);

    const sent = await fetch(`${url}/monitor/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: "COM4", data: "on\n" }),
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(monitors[0].written, ["on\n"]);

    const unknownPort = await fetch(`${url}/monitor/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: "COM5", data: "on\n" }),
    });
    assert.equal(unknownPort.status, 409);

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(monitors[0].closed, true);
  });
});

test("POST /upload closes the serial monitor on that port first", async () => {
  await withMonitorApp(async (url, monitors) => {
    const response = await fetch(`${url}/monitor?port=COM4&baud=9600`);
    const reader = response.body!.getReader();
    await readEvents(reader, 1);

    const upload = await fetch(`${url}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        port: "COM4",
        board: "arduino:avr:uno",
        filename: "BitLabSketch.hex",
        binary: Buffer.from(":00000001FF").toString("base64"),
      }),
    });
    assert.equal(upload.status, 200);
    assert.equal(monitors[0].closed, true);
    assert.deepEqual(await readEvents(reader, 1), [{ type: "closed" }]);
  });
});

async function withBoardApp(
  overrides: Partial<BoardManager>,
  run: (baseUrl: string) => Promise<void>,
) {
  const boardApp = createApp(
    async () => successfulResult,
    async () => availablePorts,
    async () => "Upload complete.",
    {},
    undefined,
    undefined,
    fakeBoardManager(overrides),
  );
  const boardServer = boardApp.listen(0);
  await once(boardServer, "listening");
  const address = boardServer.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    boardServer.close();
  }
}

const samdPlatform: PlatformSummary = {
  id: "arduino:samd",
  name: "Arduino SAMD Boards",
  maintainer: "Arduino",
  latestVersion: "1.8.14",
  versions: ["1.8.14", "1.8.13"],
  boards: ["Arduino MKR1000"],
};

test("POST /compile accepts boards from installed board packages", async () => {
  await withBoardApp({}, async (url) => {
    const compile = (board: string) =>
      fetch(`${url}/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "void setup() {}", board }),
      });
    assert.equal((await compile("arduino:samd:mkr1000")).status, 200);
    assert.equal((await compile("arduino:samd:zero")).status, 400);
    assert.equal((await compile("--fqbn:x:y")).status, 400);
  });
});

test("POST /upload expects .hex for AVR and .bin for other cores", async () => {
  await withBoardApp({}, async (url) => {
    const upload = (board: string, filename: string, binary: string) =>
      fetch(`${url}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: "COM4", board, filename, binary }),
      });
    const bin = Buffer.from([0x01, 0x02]).toString("base64");
    assert.equal((await upload("arduino:samd:mkr1000", "BitLabSketch.bin", bin)).status, 200);
    assert.equal((await upload("arduino:avr:uno", "BitLabSketch.bin", bin)).status, 400);
  });
});

test("GET /boards lists installed boards", async () => {
  await withBoardApp({}, async (url) => {
    const response = await fetch(`${url}/boards`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, boards: installedBoards });
  });
});

test("GET /cores/search passes the query through", async () => {
  let searched: string | undefined;
  await withBoardApp(
    {
      search: async (query) => {
        searched = query;
        return [samdPlatform];
      },
    },
    async (url) => {
      assert.equal((await fetch(`${url}/cores/search?q=${"x".repeat(101)}`)).status, 400);
      const response = await fetch(`${url}/cores/search?q=%20samd%20`);
      assert.equal(response.status, 200);
      assert.equal(searched, "samd");
      assert.deepEqual((await response.json()).platforms, [samdPlatform]);
    },
  );
});

test("POST /cores/install validates the package id and version", async () => {
  const installs: Array<[string, string | undefined]> = [];
  await withBoardApp(
    {
      install: async (id, version) => {
        installs.push([id, version]);
        return "Platform installed";
      },
    },
    async (url) => {
      const install = (body: unknown) =>
        fetch(`${url}/cores/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      assert.equal((await install({ id: "--help" })).status, 400);
      assert.equal((await install({ id: "arduino" })).status, 400);
      assert.equal((await install({ id: "arduino:samd", version: "latest; rm" })).status, 400);

      const response = await install({ id: "arduino:samd", version: "1.8.14" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).message, "Installed arduino:samd 1.8.14.");
      assert.deepEqual(installs, [["arduino:samd", "1.8.14"]]);
    },
  );
});

test("POST /cores/uninstall reports CLI failures", async () => {
  await withBoardApp(
    {
      uninstall: async (id) => {
        throw new CompilerError(`Could not remove ${id}.`, 422, "platform not installed");
      },
    },
    async (url) => {
      const response = await fetch(`${url}/cores/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "arduino:samd" }),
      });
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), {
        success: false,
        message: "Could not remove arduino:samd.",
        logs: "platform not installed",
      });
    },
  );
});

test("board manager URLs can be listed, added and removed", async () => {
  const urls = ["https://espressif.github.io/arduino-esp32/package_esp32_index.json"];
  const rp2040 = "https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json";
  await withBoardApp(
    {
      listUrls: async () => urls,
      addUrl: async (url) => {
        urls.push(url);
        return "Downloading index: package_rp2040_index.json downloaded";
      },
      removeUrl: async (url) => {
        urls.splice(urls.indexOf(url), 1);
        return "";
      },
    },
    async (url) => {
      const post = (path: string, body: unknown) =>
        fetch(`${url}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      assert.equal((await post("/cores/urls", { url: "file:///C:/index.json" })).status, 400);
      assert.equal((await post("/cores/urls", { url: "--additional-urls" })).status, 400);
      assert.equal((await post("/cores/urls", { url: "https://x.y/a b.json" })).status, 400);

      assert.equal((await post("/cores/urls", { url: ` ${rp2040} ` })).status, 200);
      assert.deepEqual((await (await fetch(`${url}/cores/urls`)).json()).urls.at(-1), rp2040);

      assert.equal((await post("/cores/urls/remove", { url: rp2040 })).status, 200);
      assert.equal(urls.includes(rp2040), false);
    },
  );
});

test("POST /cores/urls reports links whose index can't be downloaded", async () => {
  await withBoardApp(
    {
      addUrl: async () => {
        throw new CompilerError("Could not download a board package index from that link.", 422, "Download failed");
      },
    },
    async (url) => {
      const response = await fetch(`${url}/cores/urls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.invalid/package_test_index.json" }),
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).logs, "Download failed");
    },
  );
});
