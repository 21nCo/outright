const OPEN = 1;

export function createRuntimeEventHub(options = {}) {
  const maxEvents = positiveInteger(options.maxEvents, 1_000);
  const maxReplayBytes = positiveInteger(options.maxReplayBytes, 2 * 1024 * 1024);
  const maxClientBufferBytes = positiveInteger(options.maxClientBufferBytes, 1024 * 1024);
  const now = options.now ?? (() => new Date().toISOString());
  const clients = new Set();
  const replay = [];
  let replayBytes = 0;
  let replayFloor = 0;
  let lastEventId = 0;

  function publish(event) {
    const record = { ...event, eventId: ++lastEventId, emittedAt: now() };
    const encoded = JSON.stringify(record);
    if (event.type !== "terminal.output") retain(record, encoded);
    for (const client of clients) send(client, encoded);
    return record;
  }

  function connect(client, { after = 0, payload = {} } = {}) {
    const requestedAfter = eventCursor(after);
    const missed = requestedAfter > lastEventId || (requestedAfter > 0 && requestedAfter < replayFloor);
    let healthy = true;
    if (requestedAfter > 0 && !missed) {
      for (const entry of replay) {
        if (entry.record.eventId > requestedAfter && !send(client, entry.encoded)) { healthy = false; break; }
      }
    }
    if (healthy) {
      const connected = JSON.stringify({
        type: "runtime.connected",
        eventId: lastEventId,
        payload: {
          ...payload,
          replay: {
            requestedAfter,
            oldestAvailable: replay[0]?.record.eventId ?? lastEventId,
            latest: lastEventId,
            missed,
          },
        },
        emittedAt: now(),
      });
      healthy = send(client, connected);
    }
    if (healthy) clients.add(client);
    return { missed, latest: lastEventId };
  }

  function disconnect(client) { clients.delete(client); }
  function shutdown() { for (const client of clients) client.close(); clients.clear(); }

  function retain(record, encoded) {
    const bytes = Buffer.byteLength(encoded);
    if (bytes > maxReplayBytes) {
      replayFloor = Math.max(replayFloor, record.eventId);
      return;
    }
    replay.push({ record, encoded, bytes });
    replayBytes += bytes;
    while (replay.length > maxEvents || replayBytes > maxReplayBytes) {
      const removed = replay.shift();
      replayBytes -= removed.bytes;
      replayFloor = Math.max(replayFloor, removed.record.eventId);
    }
  }

  function send(client, encoded) {
    if (client.readyState !== OPEN) { clients.delete(client); return false; }
    if ((client.bufferedAmount ?? 0) + Buffer.byteLength(encoded) > maxClientBufferBytes) {
      clients.delete(client);
      client.close(1013, "Runtime client is too slow");
      return false;
    }
    try { client.send(encoded); return true; }
    catch { clients.delete(client); client.close(); return false; }
  }

  return {
    publish,
    connect,
    disconnect,
    shutdown,
    stats: () => ({ clients: clients.size, replayEvents: replay.length, replayBytes, replayFloor, lastEventId }),
  };
}

export function validateSocketMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.type === "terminal.input") {
    if (typeof message.terminalId !== "string" || message.terminalId.length > 100 || typeof message.data !== "string" || Buffer.byteLength(message.data) > 64 * 1024) return null;
    return { type: message.type, terminalId: message.terminalId, data: message.data };
  }
  if (message.type === "terminal.resize") {
    if (typeof message.terminalId !== "string" || message.terminalId.length > 100 || !Number.isFinite(message.cols) || !Number.isFinite(message.rows)) return null;
    return { type: message.type, terminalId: message.terminalId, cols: message.cols, rows: message.rows };
  }
  return null;
}

function eventCursor(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
