import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import bundledBoards from "../../boards.json";
import BoardManager from "./BoardManager";
import LibraryManager from "./LibraryManager";
import SerialMonitor from "./SerialMonitor";
import SerialPlotter from "./SerialPlotter";
import ThemePicker from "./ThemePicker";
import {
  BookIcon,
  ChartIcon,
  CheckIcon,
  ChipIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  MonitorIcon,
  PackageIcon,
  PlusIcon,
  PlugIcon,
  RefreshIcon,
  SaveIcon,
  TerminalIcon,
  TrashIcon,
  UploadIcon,
  UsbIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./icons";
import {
  applyTheme,
  defineMonacoThemes,
  loadThemeSettings,
  monacoThemeName,
  saveThemeSettings,
} from "./themes";
import { baudRates, useSerialMonitor } from "./useSerialMonitor";
import { useTaskProgress } from "./useTaskProgress";
import {
  emptySketch,
  pickSketchFile,
  saveSketchFile,
  sketchExtensions,
  supportsFilePickers,
} from "./sketchFile";
import { modelPath, useSketchTabs } from "./useSketchTabs";

const starterCode = `// Your Arduino sketch
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}
`;

type CompileResult = {
  success: boolean;
  message: string;
  logs?: string;
  artifact?: {
    filename: string;
    contentType: string;
    contentBase64: string;
    supportFiles?: Record<string, string>;
  };
};

type SerialPort = {
  address: string;
  label: string;
};

type ServiceResult = {
  success: boolean;
  message: string;
  logs?: string;
};

type WebUsbDevice = {
  vendorId: number;
  productId: number;
  productName?: string;
};

type UsbNavigator = Navigator & {
  usb?: {
    requestDevice(options: { filters: Array<{ vendorId: number }> }): Promise<WebUsbDevice>;
  };
};

type BottomTab = "console" | "monitor" | "plotter";

type Drawer = "libraries" | "boards";

type BoardOption = {
  name: string;
  fqbn: string;
  platformName?: string;
};

const selectedBoardKey = "bit-lab-board";
// Ctrl + mouse wheel: one zoom step per notch (trackpad pinches send smaller deltas).
const wheelZoomStep = 60;

const panelHeightKey = "bit-lab-panel-height";
const baudRateKey = "bit-lab-baud-rate";
const fontSizeKey = "bit-lab-font-size";
const defaultFontSize = 14;
const minFontSize = 10;
const maxFontSize = 32;
const minPanelHeight = 140;
const minEditorHeight = 160;

function readStoredNumber(key: string, fallback: number) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function storeNumber(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Only a convenience; ignore.
  }
}

function consoleLineClass(line: string) {
  if (/\berror\b|failed|not found/i.test(line)) {
    return "console-line console-line-error";
  }
  if (/\bwarning\b/i.test(line)) {
    return "console-line console-line-warning";
  }
  if (/succeeded|^Sketch uses|^Global variables|Thank you|Hash of data verified|Hard resetting/i.test(line)) {
    return "console-line console-line-success";
  }
  return "console-line";
}

function App() {
  const [selectedBoard, setSelectedBoard] = useState(() => {
    try {
      return localStorage.getItem(selectedBoardKey) || bundledBoards[0].fqbn;
    } catch {
      return bundledBoards[0].fqbn;
    }
  });
  const [installedBoards, setInstalledBoards] = useState<BoardOption[]>();
  const sketches = useSketchTabs(starterCode);
  const code = sketches.active.code;
  const [consoleOutput, setConsoleOutput] = useState(
    "Ready. Compile your sketch for Arduino Uno to see compiler output here.",
  );
  const [operationStatus, setOperationStatus] = useState<
    "ready" | "compiling" | "uploading" | "installing" | "success" | "failure"
  >("ready");
  const [drawer, setDrawer] = useState<Drawer>();
  const [artifact, setArtifact] = useState<CompileResult["artifact"]>();
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [usbDeviceName, setUsbDeviceName] = useState("");
  const [themeSettings, setThemeSettings] = useState(loadThemeSettings);
  const [bottomTab, setBottomTab] = useState<BottomTab>("console");
  const [panelHeight, setPanelHeight] = useState(() => readStoredNumber(panelHeightKey, 240));
  const [baudRate, setBaudRate] = useState(() => readStoredNumber(baudRateKey, 9600));
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [fontSize, setFontSize] = useState(() => readStoredNumber(fontSizeKey, defaultFontSize));
  const fileInput = useRef<HTMLInputElement>(null);
  const editorPanel = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<Monaco>(undefined);
  const serial = useSerialMonitor();
  const task = useTaskProgress();
  const workspace = useRef<HTMLElement>(null);

  // Apply before paint so the page never flashes the wrong colors.
  useLayoutEffect(() => {
    applyTheme(themeSettings);
    saveThemeSettings(themeSettings);
  }, [themeSettings]);

  useEffect(() => {
    if (!drawer) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDrawer(undefined);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawer]);

  useEffect(() => {
    void refreshPorts({ quiet: true });
    void refreshBoards();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(selectedBoardKey, selectedBoard);
    } catch {
      // Only a convenience.
    }
  }, [selectedBoard]);

  // A compiled binary belongs to the tab it was built from.
  useEffect(() => {
    setArtifact(undefined);
  }, [sketches.active.id]);

  // Free the editor model of a closed tab.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) {
      return;
    }
    const open = new Set(sketches.tabs.map((tab) => modelPath(tab.id)));
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme === "file" && !open.has(model.uri.toString())) {
        model.dispose();
      }
    }
  }, [sketches.tabs]);

  // Ctrl + mouse wheel over the sketch zooms the code instead of the page.
  useEffect(() => {
    const element = editorPanel.current;
    if (!element) {
      return;
    }
    let accumulated = 0;
    function onWheel(event: WheelEvent) {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      accumulated += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 20 : event.deltaY;
      while (Math.abs(accumulated) >= wheelZoomStep) {
        zoom(accumulated < 0 ? 1 : -1);
        accumulated -= Math.sign(accumulated) * wheelZoomStep;
      }
    }
    element.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => element.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  async function refreshBoards() {
    try {
      const response = await fetch("/boards");
      const result = (await response.json()) as { success: boolean; boards?: BoardOption[] };
      if (response.ok && result.success) {
        setInstalledBoards(result.boards ?? []);
      }
    } catch {
      // Keep showing the bundled boards.
    }
  }

  async function compileCode() {
    if (isBusy) {
      return;
    }
    setOperationStatus("compiling");
    setArtifact(undefined);
    setBottomTab("console");
    setConsoleOutput("Compiling sketch...");
    task.start("compile", selectedBoard);

    try {
      const response = await fetch("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, board: selectedBoard }),
      });
      const result = (await response.json()) as CompileResult;

      if (!response.ok) {
        task.finish(false);
        setOperationStatus("failure");
        setConsoleOutput(`${result.message}\n\n${result.logs ?? ""}`);
        return;
      }

      task.finish(true);
      setOperationStatus("success");
      setArtifact(result.artifact);
      setConsoleOutput(`${result.message}\n\n${result.logs ?? ""}`);
    } catch (error) {
      task.finish(false);
      setOperationStatus("failure");
      setConsoleOutput(
        error instanceof Error ? `Error: ${error.message}` : "Error: Compilation failed.",
      );
    }
  }

  async function refreshPorts({ quiet = false } = {}) {
    try {
      const response = await fetch("/ports");
      const result = (await response.json()) as {
        success: boolean;
        ports?: SerialPort[];
        message?: string;
        logs?: string;
      };

      if (!response.ok || !result.success) {
        if (!quiet) {
          setOperationStatus("failure");
          setConsoleOutput(`${result.message ?? "Could not detect board ports."}\n\n${result.logs ?? ""}`);
        }
        return;
      }

      const availablePorts = result.ports ?? [];
      setPorts(availablePorts);
      setSelectedPort((current) =>
        availablePorts.some((port) => port.address === current)
          ? current
          : (availablePorts[0]?.address ?? ""),
      );
      if (!quiet) {
        setOperationStatus("ready");
        setConsoleOutput(
          availablePorts.length > 0
            ? `Found ${availablePorts.length} serial port${availablePorts.length === 1 ? "" : "s"}.`
            : "No serial boards found. Connect a board and refresh the port list.",
        );
      }
    } catch (error) {
      if (!quiet) {
        setOperationStatus("failure");
        setConsoleOutput(
          error instanceof Error ? `Board detection failed: ${error.message}` : "Board detection failed.",
        );
      }
    }
  }

  async function detectBoard() {
    const usb = (navigator as UsbNavigator).usb;
    if (!usb) {
      setUsbDeviceName("");
      await refreshPorts();
      setConsoleOutput(
        "WebUSB is unavailable in this browser. Use the local Arduino CLI bridge and select a serial port.",
      );
      return;
    }

    try {
      const device = await usb.requestDevice({
        filters: [
          { vendorId: 0x2341 },
          { vendorId: 0x2a03 },
          { vendorId: 0x1a86 },
          { vendorId: 0x10c4 },
          { vendorId: 0x0403 },
        ],
      });
      setUsbDeviceName(
        device.productName ?? `USB device ${device.vendorId.toString(16)}:${device.productId.toString(16)}`,
      );
      await refreshPorts();
      setConsoleOutput(
        `Detected ${device.productName ?? "a USB device"}. Select its serial port to upload with the local Arduino CLI bridge.`,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return;
      }
      setOperationStatus("failure");
      setConsoleOutput(
        error instanceof Error ? `USB detection failed: ${error.message}` : "USB detection failed.",
      );
    }
  }

  async function uploadCode() {
    if (!artifact || !selectedPort || isBusy) {
      return;
    }

    // The port can't be shared: pause the serial monitor and reconnect after uploading.
    const resume =
      serial.status !== "disconnected" && serial.connection?.port === selectedPort
        ? serial.connection
        : undefined;
    if (resume) {
      serial.disconnect();
    }

    setOperationStatus("uploading");
    setBottomTab("console");
    setConsoleOutput(`Uploading ${artifact.filename} to ${selectedPort}...`);
    task.start("upload", selectedBoard);

    try {
      const response = await fetch("/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          port: selectedPort,
          board: selectedBoard,
          filename: artifact.filename,
          binary: artifact.contentBase64,
          supportFiles: artifact.supportFiles,
        }),
      });
      const result = (await response.json()) as ServiceResult;

      if (!response.ok) {
        task.finish(false);
        setOperationStatus("failure");
        setConsoleOutput(`${result.message}\n\n${result.logs ?? ""}`);
        return;
      }

      task.finish(true);
      setOperationStatus("success");
      setConsoleOutput(`${result.message}\n\n${result.logs ?? ""}`);
    } catch (error) {
      task.finish(false);
      setOperationStatus("failure");
      setConsoleOutput(
        error instanceof Error ? `Upload failed: ${error.message}` : "Upload failed.",
      );
    } finally {
      if (resume) {
        void serial.connect(resume.port, resume.baudRate);
      }
    }
  }

  function downloadArtifact() {
    if (!artifact) {
      return;
    }

    const bytes = Uint8Array.from(atob(artifact.contentBase64), (character) =>
      character.charCodeAt(0),
    );
    const url = URL.createObjectURL(new Blob([bytes], { type: artifact.contentType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function showLibraryOutput(status: "working" | "success" | "failure", text: string) {
    setOperationStatus(status === "working" ? "installing" : status);
    setBottomTab("console");
    setConsoleOutput(text);
  }

  // Like the Arduino IDE's "Include Library": add any missing #include lines at the top.
  function includeLibrary(headers: string[]) {
    sketches.setActiveCode((current) => {
      const included = new Set(
        [...current.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)].map((match) => match[1]),
      );
      const missing = headers.filter((header) => !included.has(header));
      if (missing.length === 0) {
        return current;
      }
      return `${missing.map((header) => `#include <${header}>`).join("\n")}\n${current}`;
    });
    setConsoleOutput(`Added ${headers.map((header) => `<${header}>`).join(", ")} to the sketch.`);
  }

  function connectSerial() {
    if (selectedPort) {
      void serial.connect(selectedPort, baudRate);
    }
  }

  function changeBaudRate(value: number) {
    setBaudRate(value);
    storeNumber(baudRateKey, value);
    if (serial.status !== "disconnected" && serial.connection) {
      void serial.connect(serial.connection.port, value);
    }
  }

  // Opening the monitor or plotter connects automatically, like the Arduino IDE.
  function openTab(tab: BottomTab) {
    setBottomTab(tab);
    if (tab !== "console" && serial.status === "disconnected" && selectedPort && !isBusy) {
      connectSerial();
    }
  }

  function clampPanelHeight(height: number) {
    const available = workspace.current?.clientHeight ?? 600;
    return Math.round(Math.min(Math.max(height, minPanelHeight), Math.max(minPanelHeight, available - minEditorHeight)));
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    const handle = event.currentTarget;
    const bottom = workspace.current?.getBoundingClientRect().bottom ?? window.innerHeight;
    handle.setPointerCapture(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => setPanelHeight(clampPanelHeight(bottom - moveEvent.clientY - 3));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setPanelHeight((height) => {
        storeNumber(panelHeightKey, height);
        return height;
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0;
    if (delta) {
      event.preventDefault();
      const height = clampPanelHeight(panelHeight + delta);
      setPanelHeight(height);
      storeNumber(panelHeightKey, height);
    }
  }

  function newFile() {
    sketches.open(emptySketch, sketches.nextName());
    setConsoleOutput("New sketch created in a new tab.");
  }

  async function openFile() {
    if (!supportsFilePickers()) {
      fileInput.current?.click();
      return;
    }
    try {
      const picked = await pickSketchFile();
      if (picked) {
        sketches.open(picked.text, picked.handle.name, picked.handle);
        setConsoleOutput(`Opened ${picked.handle.name}.`);
      }
    } catch (error) {
      setConsoleOutput(error instanceof Error ? `Could not open the file: ${error.message}` : "Could not open the file.");
    }
  }

  async function openFromInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (file.size > 1_000_000) {
      setConsoleOutput("That file is too large to be a sketch (limit 1 MB).");
      return;
    }
    sketches.open(await file.text(), file.name);
    setConsoleOutput(`Opened ${file.name}.`);
  }

  async function saveFile() {
    const tab = sketches.active;
    try {
      const saved = await saveSketchFile(tab.code, tab.name, sketches.handleFor(tab.id));
      if (saved === undefined) {
        return;
      }
      sketches.markSaved(tab.id, tab.code, saved?.name, saved ?? undefined);
      setConsoleOutput(saved ? `Saved ${saved.name}.` : `Downloaded ${tab.name}.`);
    } catch (error) {
      setConsoleOutput(error instanceof Error ? `Could not save the file: ${error.message}` : "Could not save the file.");
    }
  }

  function closeTab(id: string) {
    const tab = sketches.tabs.find((candidate) => candidate.id === id);
    if (tab && tab.code !== tab.savedCode && !window.confirm(`Close ${tab.name} without saving your changes?`)) {
      return;
    }
    sketches.close(id);
  }

  function zoom(change: number | "reset") {
    setFontSize((size) => {
      const next =
        change === "reset" ? defaultFontSize : Math.min(maxFontSize, Math.max(minFontSize, size + change));
      storeNumber(fontSizeKey, next);
      return next;
    });
  }

  // Keyboard shortcuts from the Arduino IDE: Ctrl+R compiles, Ctrl+U uploads,
  // Ctrl+S saves, Ctrl+O opens, Ctrl+= / Ctrl+- / Ctrl+0 zoom the editor.
  const shortcuts = useRef({ compile: compileCode, upload: uploadCode, save: saveFile, open: openFile });
  shortcuts.current = { compile: compileCode, upload: uploadCode, save: saveFile, open: openFile };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
        return;
      }
      const actions: Record<string, () => void> = {
        r: () => void shortcuts.current.compile(),
        u: () => void shortcuts.current.upload(),
        s: () => void shortcuts.current.save(),
        o: () => void shortcuts.current.open(),
        "=": () => zoom(1),
        "+": () => zoom(1),
        "-": () => zoom(-1),
        "0": () => zoom("reset"),
      };
      const action = actions[event.key.toLowerCase()];
      if (action) {
        // Capture phase + stopPropagation keeps the browser and Monaco from handling it too.
        event.preventDefault();
        event.stopPropagation();
        action();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const onEditorMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco;
    editor.onDidChangeCursorPosition((event) =>
      setCursor({ line: event.position.lineNumber, column: event.position.column }),
    );
  };

  const isBusy = operationStatus === "compiling" || operationStatus === "uploading";
  const bundledFqbns = new Set(bundledBoards.map((board) => board.fqbn));
  const boardGroups = new Map<string, BoardOption[]>();
  for (const board of installedBoards ?? []) {
    if (!bundledFqbns.has(board.fqbn)) {
      const group = board.platformName ?? "Other boards";
      boardGroups.set(group, [...(boardGroups.get(group) ?? []), board]);
    }
  }
  const boardName = [...bundledBoards, ...(installedBoards ?? [])].find(
    (board) => board.fqbn === selectedBoard,
  )?.name;
  const progress = task.progress;
  const progressLabel = progress
    ? progress.state === "running"
      ? `${progress.kind === "compile" ? "Compiling" : "Uploading"} ${Math.round(progress.percent)}%`
      : progress.state === "success"
        ? progress.kind === "compile"
          ? "Compiled"
          : "Uploaded"
        : progress.kind === "compile"
          ? "Compile failed"
          : "Upload failed"
    : "";
  const serialLabel =
    serial.status === "connected"
      ? `Connected · ${serial.connection?.port} @ ${serial.connection?.baudRate}`
      : serial.status === "connecting"
        ? `Connecting to ${serial.connection?.port}...`
        : "Not connected";

  function runButtonStyle(kind: "compile" | "upload") {
    return progress?.kind === kind
      ? ({ "--progress": `${progress.percent}%` } as CSSProperties)
      : undefined;
  }

  function runButtonClass(kind: "compile" | "upload") {
    const base = kind === "compile" ? "run-button run-button-primary" : "run-button";
    return progress?.kind === kind ? `${base} has-progress progress-${progress.state}` : base;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <a className="brand" href="/" aria-label="Bit Lab home">
            <span className="brand-mark">B</span>
            <span className="brand-name">Bit Lab</span>
          </a>
          <div className="run-actions">
            <button
              className={runButtonClass("compile")}
              style={runButtonStyle("compile")}
              type="button"
              onClick={compileCode}
              disabled={isBusy}
              title="Compile (Ctrl+R)"
            >
              <span className="run-button-fill" aria-hidden="true" />
              <CheckIcon />
              <span>{progress?.kind === "compile" ? progressLabel : "Compile"}</span>
            </button>
            <button
              className={runButtonClass("upload")}
              style={runButtonStyle("upload")}
              type="button"
              onClick={uploadCode}
              disabled={!artifact || !selectedPort || isBusy}
              title={!artifact ? "Compile first, then upload" : !selectedPort ? "Select a serial port first" : "Upload (Ctrl+U)"}
            >
              <span className="run-button-fill" aria-hidden="true" />
              <UploadIcon />
              <span>{progress?.kind === "upload" ? progressLabel : "Upload"}</span>
            </button>
          </div>
          <div className="board-controls" aria-label="Board connection">
            <label className="field" title="Board">
              <ChipIcon />
              <select
                value={selectedBoard}
                onChange={(event) => {
                  setSelectedBoard(event.target.value);
                  setArtifact(undefined);
                  setOperationStatus("ready");
                  setConsoleOutput("Board changed. Compile the sketch for the selected board.");
                }}
                aria-label="Select Board"
              >
                {!boardName && <option value={selectedBoard}>{selectedBoard} (not installed)</option>}
                <optgroup label="Common boards">
                  {bundledBoards.map((board) => (
                    <option key={board.fqbn} value={board.fqbn}>
                      {board.name}
                    </option>
                  ))}
                </optgroup>
                {[...boardGroups].map(([group, groupBoards]) => (
                  <optgroup key={group} label={group}>
                    {groupBoards.map((board) => (
                      <option key={board.fqbn} value={board.fqbn}>
                        {board.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="field" title="Serial port">
              <PlugIcon />
              <select
                value={selectedPort}
                onChange={(event) => setSelectedPort(event.target.value)}
                aria-label="Serial port"
              >
                <option value="">{ports.length === 0 ? "No ports found" : "Select a port"}</option>
                {ports.map((port) => (
                  <option key={port.address} value={port.address}>
                    {port.label}
                  </option>
                ))}
              </select>
              <button
                className="field-button"
                type="button"
                onClick={() => void refreshPorts()}
                title="Refresh ports"
                aria-label="Refresh ports"
              >
                <RefreshIcon />
              </button>
            </div>
          </div>
        </div>
        <div className="actions">
          <button className="button button-ghost" type="button" onClick={detectBoard} title={usbDeviceName ? `USB detected: ${usbDeviceName}` : "Detect a USB board"}>
            <UsbIcon />
            <span className="button-label">Detect board</span>
          </button>
          <button
            className="button button-ghost"
            type="button"
            onClick={downloadArtifact}
            disabled={!artifact}
            title="Download the compiled binary"
          >
            <DownloadIcon />
            <span className="button-label">{artifact?.filename.split(".").pop()?.toUpperCase() ?? "Binary"}</span>
          </button>
          <button
            className={drawer === "boards" ? "button button-ghost button-active" : "button button-ghost"}
            type="button"
            onClick={() => setDrawer((current) => (current === "boards" ? undefined : "boards"))}
            aria-pressed={drawer === "boards"}
            title="Board Manager"
          >
            <PackageIcon />
            <span className="button-label">Boards</span>
          </button>
          <button
            className={drawer === "libraries" ? "button button-ghost button-active" : "button button-ghost"}
            type="button"
            onClick={() => setDrawer((current) => (current === "libraries" ? undefined : "libraries"))}
            aria-pressed={drawer === "libraries"}
            title="Library Manager"
          >
            <BookIcon />
            <span className="button-label">Libraries</span>
          </button>
          <ThemePicker settings={themeSettings} onChange={setThemeSettings} />
        </div>
        {progress && (
          <div
            className={`task-progress task-progress-${progress.state}`}
            role="progressbar"
            aria-label={progressLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress.percent)}
          >
            <span style={{ width: `${progress.percent}%` }} />
          </div>
        )}
      </header>

      <div className="workbench">
        <section
          className="workspace"
          aria-label="Code workspace"
          ref={workspace}
          style={{ gridTemplateRows: `minmax(${minEditorHeight}px, 1fr) 6px ${panelHeight}px` }}
        >
          <div className="editor-panel" ref={editorPanel}>
            <div className="panel-heading">
              <div className="file-tabs" role="tablist" aria-label="Open sketches">
                {sketches.tabs.map((tab) => {
                  const dirty = tab.code !== tab.savedCode;
                  const isActive = tab.id === sketches.active.id;
                  return (
                    <div
                      key={tab.id}
                      className={isActive ? "file-tab active" : "file-tab"}
                      role="tab"
                      aria-selected={isActive}
                      tabIndex={isActive ? 0 : -1}
                      title={`${tab.name}${dirty ? " (unsaved changes)" : ""}`}
                      onClick={() => sketches.select(tab.id)}
                      onAuxClick={(event) => {
                        if (event.button === 1) {
                          closeTab(tab.id);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          sketches.select(tab.id);
                        }
                      }}
                    >
                      <span className={dirty ? "file-dot dirty" : "file-dot"} aria-hidden="true" />
                      <span className="file-tab-name">{tab.name}</span>
                      <button
                        className="file-tab-close"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeTab(tab.id);
                        }}
                        aria-label={`Close ${tab.name}`}
                        title="Close"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                <button className="icon-button file-tab-add" type="button" onClick={newFile} title="New tab" aria-label="New tab">
                  <PlusIcon />
                </button>
              </div>
              <div className="editor-toolbar">
                <button className="icon-button" type="button" onClick={newFile} title="New sketch" aria-label="New sketch">
                  <FileIcon />
                </button>
                <button className="icon-button" type="button" onClick={() => void openFile()} title="Open (Ctrl+O)" aria-label="Open file">
                  <FolderIcon />
                </button>
                <button className="icon-button" type="button" onClick={() => void saveFile()} title="Save (Ctrl+S)" aria-label="Save file">
                  <SaveIcon />
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept={sketchExtensions.join(",")}
                  hidden
                  onChange={(event) => void openFromInput(event)}
                />
                <span className="toolbar-divider" aria-hidden="true" />
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => zoom(-1)}
                  disabled={fontSize <= minFontSize}
                  title="Zoom out (Ctrl+-)"
                  aria-label="Zoom out"
                >
                  <ZoomOutIcon />
                </button>
                <button
                  className="zoom-level"
                  type="button"
                  onClick={() => zoom("reset")}
                  title="Reset zoom (Ctrl+0)"
                  aria-label={`Zoom ${Math.round((fontSize / defaultFontSize) * 100)}%, reset`}
                >
                  {Math.round((fontSize / defaultFontSize) * 100)}%
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => zoom(1)}
                  disabled={fontSize >= maxFontSize}
                  title="Zoom in (Ctrl+=)"
                  aria-label="Zoom in"
                >
                  <ZoomInIcon />
                </button>
              </div>
            </div>
            <Editor
              height="100%"
              language="cpp"
              theme={monacoThemeName(themeSettings.themeId)}
              beforeMount={defineMonacoThemes}
              onMount={onEditorMount}
              path={modelPath(sketches.active.id)}
              value={code}
              onChange={(value) => sketches.setActiveCode(value ?? "")}
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize,
                fontLigatures: true,
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                cursorBlinking: "smooth",
                renderLineHighlight: "all",
                tabSize: 2,
                padding: { top: 16 },
              }}
            />
          </div>

          <div
            className="splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize bottom panel"
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={resizeWithKeyboard}
          />

          <section className="bottom-panel" aria-label="Output">
            <div className="panel-tabs">
              <div className="tab-list" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={bottomTab === "console"}
                  className={bottomTab === "console" ? "panel-tab active" : "panel-tab"}
                  onClick={() => openTab("console")}
                >
                  <TerminalIcon />
                  Console
                  <span className={`status-dot status-dot-${operationStatus}`} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bottomTab === "monitor"}
                  className={bottomTab === "monitor" ? "panel-tab active" : "panel-tab"}
                  onClick={() => openTab("monitor")}
                >
                  <MonitorIcon />
                  Serial Monitor
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bottomTab === "plotter"}
                  className={bottomTab === "plotter" ? "panel-tab active" : "panel-tab"}
                  onClick={() => openTab("plotter")}
                >
                  <ChartIcon />
                  Serial Plotter
                </button>
              </div>

              <div className="panel-tools">
                {bottomTab === "console" ? (
                  <>
                    <span className={`console-status console-status-${operationStatus}`}>{operationStatus}</span>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => setConsoleOutput("")}
                      title="Clear console"
                      aria-label="Clear console"
                    >
                      <TrashIcon />
                    </button>
                  </>
                ) : (
                  <>
                    <span className={`serial-status serial-status-${serial.status}`}>
                      <span className="status-dot" aria-hidden="true" />
                      {serialLabel}
                    </span>
                    <select
                      className="compact-select"
                      value={baudRate}
                      onChange={(event) => changeBaudRate(Number(event.target.value))}
                      aria-label="Baud rate"
                    >
                      {baudRates.map((rate) => (
                        <option key={rate} value={rate}>
                          {rate} baud
                        </option>
                      ))}
                    </select>
                    {serial.status === "disconnected" ? (
                      <button
                        className="button button-primary button-small"
                        type="button"
                        onClick={connectSerial}
                        disabled={!selectedPort || isBusy}
                        title={selectedPort ? `Connect to ${selectedPort}` : "Select a serial port first"}
                      >
                        <PlugIcon />
                        Connect
                      </button>
                    ) : (
                      <button className="button button-secondary button-small" type="button" onClick={serial.disconnect}>
                        Disconnect
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {serial.error && bottomTab !== "console" && (
              <p className="serial-error" role="alert">
                {serial.error}
              </p>
            )}

            <div className="panel-body" hidden={bottomTab !== "console"}>
              <pre className="console-output" role="status" aria-live="polite">
                {consoleOutput.split("\n").map((line, index) => (
                  <span className={consoleLineClass(line)} key={index}>
                    {line}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </div>
            <div className="panel-body" hidden={bottomTab !== "monitor"}>
              <SerialMonitor serial={serial} />
            </div>
            <div className="panel-body" hidden={bottomTab !== "plotter"}>
              <SerialPlotter serial={serial} />
            </div>
          </section>
        </section>
        {drawer === "libraries" && (
          <LibraryManager
            onOutput={showLibraryOutput}
            onInclude={includeLibrary}
            onClose={() => setDrawer(undefined)}
          />
        )}
        {drawer === "boards" && (
          <BoardManager
            onOutput={showLibraryOutput}
            onChanged={() => void refreshBoards()}
            onClose={() => setDrawer(undefined)}
          />
        )}
      </div>

      <footer className="statusbar">
        <div className="statusbar-group">
          <span>{boardName}</span>
          <span className="statusbar-muted">{selectedBoard}</span>
          <span className="statusbar-divider" />
          <span>{selectedPort || "No port"}</span>
          <span className="statusbar-divider" />
          <span className={`statusbar-serial statusbar-serial-${serial.status}`}>
            <span className="status-dot" aria-hidden="true" />
            Serial {serial.status}
          </span>
        </div>
        <div className="statusbar-group">
          {progressLabel && <span>{progressLabel}</span>}
          <span>
            Ln {cursor.line}, Col {cursor.column}
          </span>
        </div>
      </footer>
    </main>
  );
}

export default App;
