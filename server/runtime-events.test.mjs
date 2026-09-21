import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeEventHub, validateSocketMessage } from "./runtime-events.mjs";

function client(bufferedAmount = 0) {
  return {
    readyState: 1,
    bufferedAmount,
    sent: [],
    closed: null,
    send(value) { this.sent.push(JSON.parse(value)); },
    close(code, reason) { this.closed = { code, reason }; this.readyState = 3; },
  };
}

test("replays bounded non-terminal events across reconnects", () => {
  const hub = createRuntimeEventHub({ now: () => "2026-01-01T00:00:00.000Z" });
  const first = client();
  hub.connect(first);
  const started = hub.publish({ type: "run.event", payload: { type: "run.started" } });
  hub.publish({ type: "terminal.output", payload: { data: "ephemeral" } });
  const completed = hub.publish({ type: "run.event", payload: { type: "run.completed" } });
  hub.disconnect(first);

  const resumed = client();
  hub.connect(resumed, { after: started.eventId });
  assert.deepEqual(resumed.sent.map((event) => event.eventId), [completed.eventId, completed.eventId]);
  assert.equal(resumed.sent[0].type, "run.event");
  assert.equal(resumed.sent.at(-1).payload.replay.missed, false);
  assert.equal(resumed.sent.some((event) => event.type === "terminal.output"), false);
});

test("reports a replay gap after bounded history is evicted", () => {
  const hub = createRuntimeEventHub({ maxEvents: 2 });
  for (let index = 0; index < 4; index += 1) hub.publish({ type: "projects.changed", payload: { index } });
  const resumed = client();
  hub.connect(resumed, { after: 1 });
  assert.equal(resumed.sent.length, 1);
  assert.equal(resumed.sent[0].type, "runtime.connected");
  assert.equal(resumed.sent[0].payload.replay.missed, true);
});

test("disconnects slow clients before adding more buffered data", () => {
  const hub = createRuntimeEventHub({ maxClientBufferBytes: 100 });
  const slow = client(90);
  hub.connect(slow);
  assert.deepEqual(slow.closed, { code: 1013, reason: "Runtime client is too slow" });
  assert.equal(hub.stats().clients, 0);
});

test("accepts only bounded terminal socket messages", () => {
  assert.deepEqual(validateSocketMessage({ type: "terminal.resize", terminalId: "one", cols: 100, rows: 30 }), { type: "terminal.resize", terminalId: "one", cols: 100, rows: 30 });
  assert.equal(validateSocketMessage({ type: "terminal.input", terminalId: "one", data: "x".repeat(70_000) }), null);
  assert.equal(validateSocketMessage({ type: "unknown" }), null);
});
