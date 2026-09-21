export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function connectRuntime(onEvent, onStatus) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const eventKey = "outright.runtime-event-id";
  const instanceKey = "outright.runtime-instance-id";
  let socket;
  let stopped = false;
  let reconnectTimer;

  function connect() {
    onStatus?.("connecting");
    const after = Number(sessionStorage.getItem(eventKey)) || 0;
    const parameters = new URLSearchParams({ after: String(after) });
    const instanceId = sessionStorage.getItem(instanceKey);
    if (instanceId) parameters.set("instanceId", instanceId);
    socket = new WebSocket(`${protocol}//${window.location.host}/api/events?${parameters}`);
    socket.addEventListener("open", () => onStatus?.("connected"));
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (Number.isSafeInteger(message.eventId) && message.eventId >= 0) sessionStorage.setItem(eventKey, String(message.eventId));
        if (message.type === "runtime.connected" && message.payload?.runtimeInstanceId) sessionStorage.setItem(instanceKey, message.payload.runtimeInstanceId);
        onEvent(message);
      } catch { /* Ignore malformed runtime events. */ }
    });
    socket.addEventListener("close", () => {
      onStatus?.("disconnected");
      if (!stopped) reconnectTimer = window.setTimeout(connect, 1200);
    });
    socket.addEventListener("error", () => socket.close());
  }
  connect();

  return {
    send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); },
    close() { stopped = true; window.clearTimeout(reconnectTimer); socket?.close(); },
  };
}

export function query(path, parameters) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}
