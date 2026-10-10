// Outright-managed Anthropic Messages API runner. It streams the provider's
// native server-sent events to stdout as JSON lines. Any failure is written as
// a native-shaped `error` line followed by a nonzero exit. The API key is read
// from OUTRIGHT_ANTHROPIC_API_KEY only, is never echoed and is sent only to
// the configured endpoint: redirects are refused rather than followed.
import { pathToFileURL } from "node:url";

const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function fail(type, message, code = 1) {
  process.stdout.write(`${JSON.stringify({ type: "error", error: { type, message } })}\n`);
  process.exitCode = code;
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator !== 2 || argv[0] !== "--model" || !argv[1] || argv.length !== 4 || !argv[3]) return null;
  return { model: argv[1], prompt: argv[3] };
}

function endpoint(environment) {
  let base;
  try { base = new URL(environment.OUTRIGHT_ANTHROPIC_BASE_URL || "https://api.anthropic.com"); }
  catch { return null; }
  // The key must never cross a network in plaintext.
  if (base.protocol !== "https:" && !(base.protocol === "http:" && LOCAL_HOSTS.has(base.hostname))) return null;
  return new URL("/v1/messages", base);
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
  const url = endpoint(environment);
  if (!url) return fail("invalid_request_error", "OUTRIGHT_ANTHROPIC_BASE_URL must be an https URL", 2);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      // A followed redirect would resend the key to a hop that was never
      // validated, possibly over plaintext or to another origin.
      redirect: "manual",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: request.model, max_tokens: 8192, stream: true, messages: [{ role: "user", content: request.prompt }] }),
    });
  } catch (error) { return fail("network_error", `Anthropic API request failed: ${error?.cause?.code ?? error?.message ?? "network error"}`); }
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
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join("\n");
    data = [];
    dataBytes = 0;
    let event;
    try { event = JSON.parse(payload); }
    catch { return; }
    if (event?.type === "message_stop") stopped = true;
    if (event?.type === "error") errored = true;
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  // Returning from the read loop cancels the response body.
  const overflow = () => fail("api_error", "Anthropic API stream event exceeded 1 MiB");
  try {
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (!line) dispatch();
        else if (line.startsWith("data:")) {
          const value = line.slice(5).trimStart();
          data.push(value);
          dataBytes += Buffer.byteLength(value) + 1;
          if (dataBytes > MAX_EVENT_BYTES) return overflow();
        }
      }
      if (dataBytes + Buffer.byteLength(buffered) > MAX_EVENT_BYTES) return overflow();
    }
    dispatch();
  } catch (error) { return fail("network_error", `Anthropic API stream failed: ${error?.message ?? "stream error"}`); }
  if (errored) process.exitCode = 1;
  else if (!stopped) fail("api_error", "Anthropic API stream ended before message_stop");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
