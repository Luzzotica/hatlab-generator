/**
 * Debug-mode NDJSON logging: Cursor ingest + dev-only `/api/debug-log` (writes workspace log file).
 */

const INGEST = "http://127.0.0.1:7308/ingest/f207d8e5-31a4-4fc3-90ad-c0892d7b6fa9";
const SESSION_ID = "9fab0c";

export function agentDebugLog(payload: {
  hypothesisId?: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
  runId?: string;
}): void {
  const body = JSON.stringify({
    sessionId: SESSION_ID,
    timestamp: Date.now(),
    runId: payload.runId ?? "debug",
    hypothesisId: payload.hypothesisId,
    location: payload.location,
    message: payload.message,
    data: payload.data,
  });

  if (typeof window !== "undefined") {
    console.info("[agentDebug]", payload.message, payload.data ?? {});
  }

  fetch(INGEST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": SESSION_ID,
    },
    body,
    keepalive: true,
  }).catch(() => {});

  if (typeof window !== "undefined") {
    fetch("/api/debug-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  }
}
