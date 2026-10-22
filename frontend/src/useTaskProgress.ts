import { useCallback, useEffect, useRef, useState } from "react";

export type TaskKind = "compile" | "upload";

export type TaskProgress = {
  kind: TaskKind;
  percent: number;
  state: "running" | "success" | "failure";
  elapsedMs: number;
};

// Arduino CLI doesn't report build progress, so progress is estimated from how long
// the same task took last time on the same board (with sensible first-run defaults).
function defaultDuration(kind: TaskKind, board: string) {
  const isEsp = board.startsWith("esp");
  if (kind === "compile") {
    return isEsp ? 45_000 : 10_000;
  }
  return isEsp ? 25_000 : 8_000;
}

function storageKey(kind: TaskKind, board: string) {
  return `bit-lab-duration:${kind}:${board}`;
}

function loadDuration(kind: TaskKind, board: string) {
  try {
    const saved = Number(localStorage.getItem(storageKey(kind, board)));
    if (Number.isFinite(saved) && saved > 500) {
      return saved;
    }
  } catch {
    // Fall back to the default estimate.
  }
  return defaultDuration(kind, board);
}

function saveDuration(kind: TaskKind, board: string, previous: number, actual: number) {
  try {
    localStorage.setItem(storageKey(kind, board), String(Math.round(previous * 0.4 + actual * 0.6)));
  } catch {
    // Estimates just won't improve.
  }
}

// Eases toward 95% so a slow run never looks finished before it is.
function estimate(elapsedMs: number, expectedMs: number) {
  return 95 * (1 - Math.exp((-2.3 * elapsedMs) / expectedMs));
}

export function useTaskProgress() {
  const [progress, setProgress] = useState<TaskProgress>();
  const run = useRef<{ kind: TaskKind; board: string; expected: number; startedAt: number }>(undefined);
  const ticker = useRef(0);
  const hideTimer = useRef(0);

  const stopTimers = () => {
    window.clearInterval(ticker.current);
    window.clearTimeout(hideTimer.current);
  };

  const start = useCallback((kind: TaskKind, board: string) => {
    stopTimers();
    const current = { kind, board, expected: loadDuration(kind, board), startedAt: performance.now() };
    run.current = current;
    setProgress({ kind, percent: 0, state: "running", elapsedMs: 0 });
    ticker.current = window.setInterval(() => {
      const elapsedMs = performance.now() - current.startedAt;
      setProgress({ kind, percent: estimate(elapsedMs, current.expected), state: "running", elapsedMs });
    }, 120);
  }, []);

  const finish = useCallback((success: boolean) => {
    const current = run.current;
    if (!current) {
      return;
    }
    stopTimers();
    run.current = undefined;
    const elapsedMs = performance.now() - current.startedAt;
    if (success) {
      saveDuration(current.kind, current.board, current.expected, elapsedMs);
    }
    setProgress((previous) => ({
      kind: current.kind,
      percent: success ? 100 : (previous?.percent ?? 0),
      state: success ? "success" : "failure",
      elapsedMs,
    }));
    hideTimer.current = window.setTimeout(() => setProgress(undefined), success ? 1_800 : 4_000);
  }, []);

  useEffect(() => stopTimers, []);

  return { progress, start, finish };
}
