// Outright-managed Anthropic Messages API runner. It streams the provider's
// native server-sent events to stdout as JSON lines. Any failure is written as
// a native-shaped `error` line followed by a nonzero exit. The API key is read
// from OUTRIGHT_ANTHROPIC_API_KEY only, is never echoed and is sent only to
// the configured endpoint: redirects are refused rather than followed.
import { pathToFileURL } from "node:url";

const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
// A fixed output cap; a response that reaches it fails its run (see the adapter).
export const MAX_OUTPUT_TOKENS = 8192;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const ENDPOINT_REQUIREMENT = "OUTRIGHT_ANTHROPIC_BASE_URL must be an https URL or a loopback http address, without a user name or password";

// The manager may stop reading; wait for it instead of buffering the whole
// stream in this process.
function write(record) {
  if (process.stdout.write(`${JSON.stringify(record)}\n`)) return undefined;
  return new Promise((resolve) => {
    const done = () => { process.stdout.off("drain", done); process.stdout.off("close", done); process.stdout.off("error", done); resolve(); };
    process.stdout.on("drain", done);
    process.stdout.once("close", done);
    process.stdout.once("error", done);
  });
}

async function fail(type, message, code = 1) {
  await write({ type: "error", error: { type, message } });
  process.exitCode = code;
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator !== 2 || argv[0] !== "--model" || !argv[1] || argv.length !== 4 || !argv[3]) return null;
  return { model: argv[1], prompt: argv[3] };
}

// Shared with the adapter's detect(), so an unusable endpoint is reported
// before a run is queued rather than when the runner starts.
export function anthropicEndpoint(environment) {
  let base;
  try { base = new URL(environment.OUTRIGHT_ANTHROPIC_BASE_URL || "https://api.anthropic.com"); }
  catch { return null; }
  // The key must never cross a network in plaintext.
  if (base.protocol !== "https:" && !(base.protocol === "http:" && LOCAL_HOSTS.has(base.hostname))) return null;
  // fetch refuses URL credentials only after the run is queued, and its
  // error would carry them into the run's diagnostics.
  if (base.username || base.password) return null;
  // Relative to the base path, as the Anthropic SDKs resolve it, so a
  // gateway mounted at https://host/anthropic receives /anthropic/v1/messages.
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL("v1/messages", base);
}

function networkCode(error) {
  const code = error?.cause?.code ?? error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "network error";
}

async function discard(body) {
  try { await body?.cancel(); } catch { /* Already closed. */ }
}

async function readBounded(body, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of body ?? []) {
    chunks.push(chunk);
    bytes += chunk.length;
    if (bytes >= limit) break;
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

export async function run(argv = process.argv.slice(2), environment = process.env) {
  const request = parseArguments(argv);
  if (!request) return fail("invalid_request_error", "Usage: anthropic-api-runner --model <model> -- <prompt>", 2);
  const apiKey = environment.OUTRIGHT_ANTHROPIC_API_KEY;
  if (!apiKey) return fail("authentication_error", "OUTRIGHT_ANTHROPIC_API_KEY is not set", 2);
  const url = anthropicEndpoint(environment);
  if (!url) return fail("invalid_request_error", ENDPOINT_REQUIREMENT, 2);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      // A followed redirect would resend the key to a hop that was never
      // validated, possibly over plaintext or to another origin.
      redirect: "manual",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: request.model, max_tokens: MAX_OUTPUT_TOKENS, stream: true, messages: [{ role: "user", content: request.prompt }] }),
    });
  } catch (error) {
    // Only an error code: fetch messages can quote the endpoint URL.
    return fail("network_error", `Anthropic API request failed: ${networkCode(error)}`);
  }
  if (response.status >= 300 && response.status < 400) {
    await discard(response.body);
    return fail("api_error", `Anthropic API redirected the request (HTTP ${response.status}); Outright does not forward credentials across redirects`);
  }
  if (!response.ok) {
    const text = await readBounded(response.body, MAX_ERROR_BYTES).catch(() => "");
    let message = `Anthropic API returned HTTP ${response.status}`;
    let type = "api_error";
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error?.message === "string") message = parsed.error.message;
      if (typeof parsed?.error?.type === "string") type = parsed.error.type;
    } catch { /* Keep the status summary. */ }
    return fail(type, message);
  }
  const decoder = new TextDecoder();
  let buffered = "";
  let data = [];
  // Bytes of the event being assembled: completed data lines plus the
  // partial line still buffered.
  let dataBytes = 0;
  let stopped = false;
  let errored = false;
  // Returns false when the stream can no longer be trusted. Text already
  // written stays in the transcript; the run still fails.
  const dispatch = async () => {
    if (!data.length) return true;
    const payload = data.join("\n");
    data = [];
    dataBytes = 0;
    let event;
    try { event = JSON.parse(payload); }
    catch { return false; }
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    if (event.type === "message_stop") stopped = true;
    if (event.type === "error") errored = true;
    await write(event);
    return true;
  };
  const malformedEvent = () => fail("api_error", "Anthropic API sent a malformed stream event");
  // Returning from the read loop cancels the response body.
  const overflow = () => fail("api_error", "Anthropic API stream event exceeded 1 MiB");
  try {
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (!line) { if (!(await dispatch())) return malformedEvent(); }
        else if (line.startsWith("data:")) {
          const value = line.slice(5).trimStart();
          data.push(value);
          dataBytes += Buffer.byteLength(value) + 1;
          if (dataBytes > MAX_EVENT_BYTES) return overflow();
        }
      }
      if (dataBytes + Buffer.byteLength(buffered) > MAX_EVENT_BYTES) return overflow();
    }
    if (!(await dispatch())) return malformedEvent();
  } catch (error) { return fail("network_error", `Anthropic API stream failed: ${networkCode(error)}`); }
  if (errored) process.exitCode = 1;
  else if (!stopped) await fail("api_error", "Anthropic API stream ended before message_stop");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
