import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { SendIcon, TrashIcon } from "./icons";
import type { SerialMonitorApi } from "./useSerialMonitor";

type Line = { time: number; text: string };

const maxLines = 2000;
const maxHistory = 50;
const lineEndings = [
  { label: "No line ending", value: "" },
  { label: "Newline", value: "\n" },
  { label: "Carriage return", value: "\r" },
  { label: "Both NL & CR", value: "\r\n" },
];

function formatTime(time: number) {
  const date = new Date(time);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

type SerialMonitorProps = {
  serial: SerialMonitorApi;
};

function SerialMonitor({ serial }: SerialMonitorProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [autoscroll, setAutoscroll] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [lineEnding, setLineEnding] = useState("\n");
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const output = useRef<HTMLPreElement>(null);
  // Incoming chunks are collected here and rendered at most once per frame.
  const buffer = useRef<Line[]>([]);
  const lastLineOpen = useRef(false);
  const frame = useRef(0);

  useEffect(() => {
    const unsubscribe = serial.subscribe((text) => {
      const now = Date.now();
      const parts = text.replace(/\r/g, "").split("\n");
      parts.forEach((part, index) => {
        const last = buffer.current[buffer.current.length - 1];
        if (index === 0 && lastLineOpen.current && last) {
          buffer.current[buffer.current.length - 1] = { ...last, text: last.text + part };
        } else if (index < parts.length - 1 || part) {
          buffer.current.push({ time: now, text: part });
        }
      });
      lastLineOpen.current = parts[parts.length - 1] !== "";
      if (buffer.current.length > maxLines) {
        buffer.current = buffer.current.slice(-maxLines);
      }
      if (!frame.current) {
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          setLines(buffer.current.slice());
        });
      }
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [serial.subscribe]);

  useLayoutEffect(() => {
    if (autoscroll && output.current) {
      output.current.scrollTop = output.current.scrollHeight;
    }
  }, [lines, autoscroll]);

  function clear() {
    buffer.current = [];
    lastLineOpen.current = false;
    setLines([]);
  }

  async function sendMessage() {
    if (!message && !lineEnding) {
      return;
    }
    if (await serial.send(message + lineEnding)) {
      if (message) {
        setHistory((entries) => [message, ...entries.filter((entry) => entry !== message)].slice(0, maxHistory));
      }
      setHistoryIndex(-1);
      setMessage("");
    }
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void sendMessage();
    } else if (event.key === "ArrowUp" && history.length > 0) {
      event.preventDefault();
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      setMessage(history[next]);
    } else if (event.key === "ArrowDown" && historyIndex >= 0) {
      event.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setMessage(next >= 0 ? history[next] : "");
    }
  }

  const connected = serial.status === "connected";

  return (
    <div className="serial-monitor">
      <div className="serial-toolbar">
        <label className="toggle">
          <input type="checkbox" checked={autoscroll} onChange={(event) => setAutoscroll(event.target.checked)} />
          <span>Autoscroll</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={timestamps} onChange={(event) => setTimestamps(event.target.checked)} />
          <span>Timestamps</span>
        </label>
        <span className="toolbar-spacer" />
        <span className="serial-count">{lines.length} lines</span>
        <button className="icon-button" type="button" onClick={clear} title="Clear output" aria-label="Clear output">
          <TrashIcon />
        </button>
      </div>

      <pre className="serial-output" ref={output} aria-live="off">
        {lines.length === 0 ? (
          <span className="serial-placeholder">
            {connected
              ? "Connected. Waiting for data from the board..."
              : "Select a serial port and click Connect to see what your board prints with Serial.print()."}
          </span>
        ) : (
          lines.map((line, index) => (
            <span className="serial-line" key={index}>
              {timestamps && <span className="serial-time">{formatTime(line.time)} → </span>}
              {line.text}
              {"\n"}
            </span>
          ))
        )}
      </pre>

      <div className="serial-input-row">
        <input
          className="serial-input"
          type="text"
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            setHistoryIndex(-1);
          }}
          onKeyDown={onInputKeyDown}
          placeholder={connected ? "Message to send (Enter to send, ↑ for history)" : "Connect to send messages"}
          disabled={!connected}
          maxLength={1000}
          aria-label="Message to send"
        />
        <select
          value={lineEnding}
          onChange={(event) => setLineEnding(event.target.value)}
          aria-label="Line ending"
          className="compact-select"
        >
          {lineEndings.map((option) => (
            <option key={option.label} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button className="button button-primary button-small" type="button" onClick={() => void sendMessage()} disabled={!connected}>
          <SendIcon />
          Send
        </button>
      </div>
    </div>
  );
}

export default SerialMonitor;
