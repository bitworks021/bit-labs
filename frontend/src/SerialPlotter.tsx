import { useCallback, useEffect, useRef, useState } from "react";
import { PauseIcon, PlayIcon, TrashIcon } from "./icons";
import type { SerialMonitorApi } from "./useSerialMonitor";

type Sample = Record<string, number>;
type LegendEntry = { label: string; color: string; latest?: number };

const seriesColors = ["#f97316", "#3b82f6", "#22c55e", "#e11d48", "#a855f7", "#eab308", "#14b8a6", "#ec4899"];
const windowSizes = [100, 250, 500, 1000];
const maxSamples = 1000;

// Accepts the same formats as the Arduino IDE plotter:
// "12 34", "12,34", "temp:21.5 humidity:40" or "temp: 21.5, humidity: 40".
export function parsePlotLine(line: string): Array<[string, number]> {
  const fields = line.trim().replace(/:\s+/g, ":").split(/[\s,;]+/).filter(Boolean);
  const values: Array<[string, number]> = [];
  fields.forEach((field, index) => {
    const colon = field.lastIndexOf(":");
    const label = colon > 0 ? field.slice(0, colon) : `Value ${index + 1}`;
    const raw = colon >= 0 ? field.slice(colon + 1) : field;
    const value = raw === "" ? Number.NaN : Number(raw);
    if (Number.isFinite(value)) {
      values.push([label, value]);
    }
  });
  return values;
}

function niceStep(range: number) {
  const rough = range / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  return (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude;
}

function formatValue(value: number) {
  if (Math.abs(value) >= 10_000 || (Math.abs(value) < 0.01 && value !== 0)) {
    return value.toExponential(1);
  }
  return Number(value.toFixed(2)).toString();
}

type SerialPlotterProps = {
  serial: SerialMonitorApi;
};

function SerialPlotter({ serial }: SerialPlotterProps) {
  const [paused, setPaused] = useState(false);
  const [windowSize, setWindowSize] = useState(250);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [legend, setLegend] = useState<LegendEntry[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const samples = useRef<Sample[]>([]);
  const totalSamples = useRef(0);
  const colors = useRef(new Map<string, string>());
  const partialLine = useRef("");
  const frame = useRef(0);
  const settings = useRef({ paused, windowSize, hidden });
  settings.current = { paused, windowSize, hidden };

  const draw = useCallback(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || element.clientWidth === 0) {
      return;
    }

    const ratio = window.devicePixelRatio || 1;
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const gridColor = styles.getPropertyValue("--border").trim();
    const labelColor = styles.getPropertyValue("--text-subtle").trim();
    context.font = "11px ui-monospace, Consolas, monospace";

    const { windowSize: size, hidden: hiddenSeries } = settings.current;
    const visible = samples.current.slice(-size);
    const labels = [...colors.current.keys()].filter((label) => !hiddenSeries.has(label));

    let min = Infinity;
    let max = -Infinity;
    for (const sample of visible) {
      for (const label of labels) {
        const value = sample[label];
        if (value !== undefined) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }

    const left = 56;
    const right = 14;
    const top = 12;
    const bottom = 24;
    const plotWidth = Math.max(1, width - left - right);
    const plotHeight = Math.max(1, height - top - bottom);

    if (!Number.isFinite(min)) {
      context.fillStyle = labelColor;
      context.textAlign = "center";
      context.fillText("Waiting for numbers... print values like  Serial.println(sensorValue);", width / 2, height / 2);
      return;
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const padding = (max - min) * 0.08;
    min -= padding;
    max += padding;

    const y = (value: number) => top + plotHeight - ((value - min) / (max - min)) * plotHeight;
    const x = (index: number) => left + (index / Math.max(1, size - 1)) * plotWidth;

    // Horizontal grid lines with value labels.
    const step = niceStep(max - min);
    context.strokeStyle = gridColor;
    context.lineWidth = 1;
    context.fillStyle = labelColor;
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
      const lineY = Math.round(y(value)) + 0.5;
      context.beginPath();
      context.moveTo(left, lineY);
      context.lineTo(width - right, lineY);
      context.stroke();
      context.fillText(formatValue(value), left - 8, lineY);
    }

    // Sample numbers along the bottom.
    const firstSample = totalSamples.current - visible.length;
    context.textAlign = "center";
    context.textBaseline = "top";
    for (let tick = 0; tick <= 4; tick += 1) {
      const index = Math.round((tick / 4) * (size - 1));
      context.fillText(String(firstSample + index), x(index), top + plotHeight + 7);
    }

    context.lineWidth = 1.75;
    context.lineJoin = "round";
    for (const label of labels) {
      context.strokeStyle = colors.current.get(label) ?? seriesColors[0];
      context.beginPath();
      let drawing = false;
      visible.forEach((sample, index) => {
        const value = sample[label];
        if (value === undefined) {
          drawing = false;
          return;
        }
        if (drawing) {
          context.lineTo(x(index), y(value));
        } else {
          context.moveTo(x(index), y(value));
          drawing = true;
        }
      });
      context.stroke();
    }
  }, []);

  const scheduleDraw = useCallback(() => {
    if (frame.current) {
      return;
    }
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (settings.current.paused) {
        return;
      }
      draw();
      const latest = samples.current[samples.current.length - 1] ?? {};
      setLegend(
        [...colors.current].map(([label, color]) => ({ label, color, latest: latest[label] })),
      );
    });
  }, [draw]);

  useEffect(() => {
    const unsubscribe = serial.subscribe((text) => {
      const lines = (partialLine.current + text).split("\n");
      partialLine.current = lines.pop() ?? "";
      let added = false;
      for (const line of lines) {
        const values = parsePlotLine(line);
        if (values.length === 0) {
          continue;
        }
        const sample: Sample = {};
        for (const [label, value] of values) {
          if (!colors.current.has(label)) {
            colors.current.set(label, seriesColors[colors.current.size % seriesColors.length]);
          }
          sample[label] = value;
        }
        samples.current.push(sample);
        totalSamples.current += 1;
        added = true;
      }
      if (samples.current.length > maxSamples) {
        samples.current = samples.current.slice(-maxSamples);
      }
      if (added) {
        scheduleDraw();
      }
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [serial.subscribe, scheduleDraw]);

  // Redraw on resize (including when the tab becomes visible) and when settings change.
  useEffect(() => {
    const element = canvas.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => draw());
    observer.observe(element);
    return () => observer.disconnect();
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw, windowSize, hidden, paused]);

  function clear() {
    samples.current = [];
    totalSamples.current = 0;
    colors.current.clear();
    partialLine.current = "";
    setHidden(new Set());
    setLegend([]);
    draw();
  }

  function toggleSeries(label: string) {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }

  return (
    <div className="serial-plotter">
      <div className="serial-toolbar">
        <div className="plot-legend">
          {legend.length === 0 && <span className="serial-count">No series yet</span>}
          {legend.map((entry) => (
            <button
              key={entry.label}
              type="button"
              className={hidden.has(entry.label) ? "legend-item muted" : "legend-item"}
              onClick={() => toggleSeries(entry.label)}
              aria-pressed={!hidden.has(entry.label)}
              title={hidden.has(entry.label) ? "Show series" : "Hide series"}
            >
              <span className="legend-swatch" style={{ background: entry.color }} />
              {entry.label}
              {entry.latest !== undefined && <span className="legend-value">{formatValue(entry.latest)}</span>}
            </button>
          ))}
        </div>
        <span className="toolbar-spacer" />
        <select
          className="compact-select"
          value={windowSize}
          onChange={(event) => setWindowSize(Number(event.target.value))}
          aria-label="Points shown"
        >
          {windowSizes.map((size) => (
            <option key={size} value={size}>
              {size} points
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          type="button"
          onClick={() => setPaused((value) => !value)}
          title={paused ? "Resume" : "Pause"}
          aria-label={paused ? "Resume plot" : "Pause plot"}
          aria-pressed={paused}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <button className="icon-button" type="button" onClick={clear} title="Clear plot" aria-label="Clear plot">
          <TrashIcon />
        </button>
      </div>
      <div className="plot-area">
        <canvas ref={canvas} className="plot-canvas" role="img" aria-label="Serial plotter chart" />
        {paused && <span className="plot-paused">Paused</span>}
      </div>
    </div>
  );
}

export default SerialPlotter;
