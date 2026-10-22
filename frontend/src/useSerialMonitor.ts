import { useCallback, useEffect, useRef, useState } from "react";

export const baudRates = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000,
  2000000,
];

export type SerialStatus = "disconnected" | "connecting" | "connected";

export type SerialConnection = { port: string; baudRate: number };

type MonitorEvent =
  | { type: "open"; port: string; baudRate: number }
  | { type: "data"; text: string }
  | { type: "error"; message: string }
  | { type: "closed" }
  | { type: "ping" };

type DataListener = (text: string) => void;

// One shared serial connection through the local Arduino CLI bridge. The monitor
// and plotter both subscribe to the same stream of incoming text.
export function useSerialMonitor() {
  const [status, setStatus] = useState<SerialStatus>("disconnected");
  const [connection, setConnection] = useState<SerialConnection>();
  const [error, setError] = useState("");
  const listeners = useRef(new Set<DataListener>());
  const controller = useRef<AbortController>(undefined);

  const subscribe = useCallback((listener: DataListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const disconnect = useCallback(() => {
    controller.current?.abort();
    controller.current = undefined;
    setStatus("disconnected");
  }, []);

  const connect = useCallback(async (port: string, baudRate: number) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setStatus("connecting");
    setConnection({ port, baudRate });
    setError("");

    const isCurrent = () => controller.current === current;
    try {
      const response = await fetch(
        `/monitor?port=${encodeURIComponent(port)}&baud=${baudRate}`,
        { signal: current.signal },
      );
      if (!response.ok || !response.body) {
        let message = `Could not open ${port} (HTTP ${response.status}).`;
        try {
          message = ((await response.json()) as { message?: string }).message ?? message;
        } catch {
          // Keep the generic message.
        }
        throw new Error(message);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) {
            continue;
          }
          const event = JSON.parse(line) as MonitorEvent;
          if (event.type === "open") {
            setStatus("connected");
          } else if (event.type === "data") {
            listeners.current.forEach((listener) => listener(event.text));
          } else if (event.type === "error") {
            setError(event.message);
          }
        }
      }
    } catch (caught) {
      if (isCurrent() && !(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught.message : "The serial monitor failed.");
      }
    } finally {
      if (isCurrent()) {
        controller.current = undefined;
        setStatus("disconnected");
      }
    }
  }, []);

  const send = useCallback(
    async (data: string) => {
      if (!connection || status !== "connected") {
        return false;
      }
      try {
        const response = await fetch("/monitor/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ port: connection.port, data }),
        });
        if (!response.ok) {
          const result = (await response.json()) as { message?: string };
          setError(result.message ?? "Could not send to the board.");
          return false;
        }
        return true;
      } catch {
        setError("Could not send to the board.");
        return false;
      }
    },
    [connection, status],
  );

  useEffect(() => () => controller.current?.abort(), []);

  return { status, connection, error, connect, disconnect, send, subscribe };
}

export type SerialMonitorApi = ReturnType<typeof useSerialMonitor>;
