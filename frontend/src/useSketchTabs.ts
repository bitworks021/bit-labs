import { useCallback, useEffect, useRef, useState } from "react";
import { emptySketch, type SketchFileHandle } from "./sketchFile";

export type SketchTab = {
  id: string;
  name: string;
  code: string;
  // Contents as last saved/opened, to tell whether the tab has unsaved changes.
  savedCode: string;
};

type TabState = { tabs: SketchTab[]; activeId: string };

const storageKey = "bit-lab-sketches";

function newId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isTab(value: unknown): value is SketchTab {
  const tab = value as SketchTab;
  return (
    typeof tab === "object" &&
    tab !== null &&
    typeof tab.id === "string" &&
    typeof tab.name === "string" &&
    typeof tab.code === "string" &&
    typeof tab.savedCode === "string"
  );
}

// Open tabs survive a reload. File handles can't be stored, so a restored tab
// asks where to save the next time it is saved.
function loadState(initialCode: string): TabState {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<TabState> | null;
    const tabs = Array.isArray(saved?.tabs) ? saved.tabs.filter(isTab) : [];
    if (tabs.length > 0) {
      const activeId = tabs.some((tab) => tab.id === saved?.activeId) ? saved!.activeId! : tabs[0].id;
      return { tabs, activeId };
    }
  } catch {
    // Fall back to a fresh sketch.
  }
  const id = newId();
  return { tabs: [{ id, name: "sketch.ino", code: initialCode, savedCode: initialCode }], activeId: id };
}

export function modelPath(id: string) {
  return `file:///${id}.ino`;
}

export function useSketchTabs(initialCode: string) {
  const [state, setState] = useState(() => loadState(initialCode));
  const handles = useRef(new Map<string, SketchFileHandle>());
  const active = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        // Storage full or unavailable: tabs just won't be restored.
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [state]);

  const select = useCallback((id: string) => {
    setState((current) => ({ ...current, activeId: id }));
  }, []);

  const setActiveCode = useCallback((update: string | ((code: string) => string)) => {
    setState((current) => ({
      ...current,
      tabs: current.tabs.map((tab) =>
        tab.id === current.activeId
          ? { ...tab, code: typeof update === "function" ? update(tab.code) : update }
          : tab,
      ),
    }));
  }, []);

  const nextName = useCallback(() => {
    const names = new Set(state.tabs.map((tab) => tab.name));
    let index = 2;
    while (names.has(`sketch_${index}.ino`)) {
      index += 1;
    }
    return names.has("sketch.ino") ? `sketch_${index}.ino` : "sketch.ino";
  }, [state.tabs]);

  // Opens text in a new tab, or switches to it if the same file is already open.
  const open = useCallback((text: string, name: string, handle?: SketchFileHandle) => {
    setState((current) => {
      const existing = current.tabs.find((tab) => tab.name === name && tab.savedCode === text);
      if (existing && handle) {
        handles.current.set(existing.id, handle);
        return { ...current, activeId: existing.id };
      }
      const id = newId();
      if (handle) {
        handles.current.set(id, handle);
      }
      const tab = { id, name, code: text, savedCode: text };
      // Opening a file replaces an untouched blank sketch instead of leaving it behind.
      const blank = text !== emptySketch && current.tabs.find(
        (candidate) =>
          candidate.id === current.activeId &&
          candidate.code === emptySketch &&
          candidate.savedCode === emptySketch &&
          !handles.current.has(candidate.id),
      );
      const tabs = blank
        ? current.tabs.map((candidate) => (candidate.id === blank.id ? tab : candidate))
        : [...current.tabs, tab];
      return { tabs, activeId: id };
    });
  }, []);

  const close = useCallback((id: string) => {
    handles.current.delete(id);
    setState((current) => {
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) {
        return current;
      }
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      if (tabs.length === 0) {
        const fresh = { id: newId(), name: "sketch.ino", code: emptySketch, savedCode: emptySketch };
        return { tabs: [fresh], activeId: fresh.id };
      }
      const activeId =
        current.activeId === id ? tabs[Math.min(index, tabs.length - 1)].id : current.activeId;
      return { tabs, activeId };
    });
  }, []);

  const markSaved = useCallback((id: string, code: string, name?: string, handle?: SketchFileHandle) => {
    if (handle) {
      handles.current.set(id, handle);
    }
    setState((current) => ({
      ...current,
      tabs: current.tabs.map((tab) =>
        tab.id === id ? { ...tab, savedCode: code, name: name ?? tab.name } : tab,
      ),
    }));
  }, []);

  const handleFor = useCallback((id: string) => handles.current.get(id), []);

  return {
    tabs: state.tabs,
    active,
    select,
    setActiveCode,
    nextName,
    open,
    close,
    markSaved,
    handleFor,
  };
}
