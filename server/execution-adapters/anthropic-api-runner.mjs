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

// A provider or gateway can reflect the key in any field it controls, either
// verbatim or inside JSON-encoded text it nests in a message. These are the
// key and each further JSON string escape of it.
function secretForms(secret) {
  const forms = [];
  for (let form = secret; form && !forms.includes(form) && forms.length < 4; form = JSON.stringify(form).slice(1, -1)) forms.unshift(form);
  return forms;
}

function redactText(text, forms) {
  return forms.reduce((result, form) => result.replaceAll(form, "[redacted]"), text);
}

// Provider values are redacted before serialization, so no decoding of a
// written record can recover the key.
function redact(value, forms) {
  if (typeof value === "string") return redactText(value, forms);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, forms));
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [redactText(name, forms), redact(item, forms)]));
}

// The manager concatenates every text delta of a run into one answer, so
// text is redacted as a single stream. A suffix that could begin the key is
// held until the next delta shows otherwise, and is released when the
// stream ends.
function textRedactor(forms) {
  let held = "";
  const longest = Math.max(...forms.map((form) => form.length));
  return {
    push(text) {
      const combined = redactText(held + text, forms);
      let keep = Math.min(longest - 1, combined.length);
      while (keep > 0 && !forms.some((form) => form.startsWith(combined.slice(combined.length - keep)))) keep -= 1;
      held = combined.slice(combined.length - keep);
      return combined.slice(0, combined.length - keep);
    },
    flush() { const text = held; held = ""; return text; },
  };
}

// The only way a record leaves the runner. protect() binds the key's forms
// as soon as the key is read; from then on every record, synthetic ones
// included, is redacted here before serialization and no call site can omit
// it. The manager may stop reading; wait for it instead of buffering the
// whole stream in this process.
function createOutput() {
  let forms = [];
  const write = (record) => {
    if (process.stdout.write(`${JSON.stringify(redact(record, forms))}\n`)) return undefined;
    return new Promise((resolve) => {
      const done = () => { process.stdout.off("drain", done); process.stdout.off("close", done); process.stdout.off("error", done); resolve(); };
      process.stdout.on("drain", done);
      process.stdout.once("close", done);
      process.stdout.once("error", done);
    });
  };
  return {
    protect(secret) { forms = secretForms(secret); return forms; },
    write,
    async fail(type, message, code = 1) {
      await write({ type: "error", error: { type, message } });
      process.exitCode = code;
    },
  };
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
  const output = createOutput();
  // An unexpected error's text, which Node would print to stderr, may quote
  // the key; only a fixed message leaves through the redacting writer.
  try { await execute(argv, environment, output); }
  catch { await output.fail("api_error", "Anthropic API runner failed unexpectedly"); }
}

async function execute(argv, environment, { protect, write, fail }) {
  const request = parseArguments(argv);
  if (!request) return fail("invalid_request_error", "Usage: anthropic-api-runner --model <model> -- <prompt>", 2);
  const apiKey = environment.OUTRIGHT_ANTHROPIC_API_KEY;
  if (!apiKey) return fail("authentication_error", "OUTRIGHT_ANTHROPIC_API_KEY is not set", 2);
  const forms = protect(apiKey);
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
  const text = textRedactor(forms);
  let textIndex = 0;
  const decoder = new TextDecoder();
  let buffered = "";
  // The event's data lines joined by LF, held as bytes so the 1 MiB bound is
  // the memory the event retains, however many lines it arrives in.
  let data = Buffer.alloc(4096);
  let dataBytes = 0;
  let hasData = false;
  const append = (value) => {
    const size = Buffer.byteLength(value) + (hasData ? 1 : 0);
    if (dataBytes + size > MAX_EVENT_BYTES) return false;
    if (dataBytes + size > data.length) {
      const grown = Buffer.alloc(Math.min(MAX_EVENT_BYTES, Math.max(data.length * 2, dataBytes + size)));
      data.copy(grown, 0, 0, dataBytes);
      data = grown;
    }
    if (hasData) data[dataBytes++] = 0x0a;
    dataBytes += data.write(value, dataBytes);
    hasData = true;
    return true;
  };
  let stopped = false;
  let errored = false;
  // The adapter fails a message_delta without a valid stop reason; a stream
  // with none at all must not complete either.
  let delta = false;
  // Returns false when the stream can no longer be trusted. Text already
  // written stays in the transcript; the run still fails.
  const dispatch = async () => {
    if (!hasData) return true;
    const payload = data.toString("utf8", 0, dataBytes);
    dataBytes = 0;
    hasData = false;
    let event;
    try { event = JSON.parse(payload); }
    catch { return false; }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string" || !event.type) return false;
    if (event.type === "message_stop") stopped = true;
    if (event.type === "message_delta") delta = true;
    if (event.type === "error") errored = true;
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
      // A native block index is a non-negative integer; the held text is
      // later released under the last valid one.
      if (!Number.isSafeInteger(event.index) || event.index < 0) return false;
      textIndex = event.index;
      event = { ...event, delta: { ...event.delta, text: text.push(event.delta.text) } };
    }
    await write(event);
    return true;
  };
  // Every exit releases the held text before its final record, so the
  // answer keeps everything that was not the key.
  const release = async () => {
    const rest = text.flush();
    if (rest) await write({ type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: rest } });
  };
  const malformedEvent = () => fail("api_error", "Anthropic API sent a malformed stream event");
  // Leaving the read loop cancels the response body.
  const overflow = () => fail("api_error", "Anthropic API stream event exceeded 1 MiB");
  // SSE lines end in CRLF, LF or CR. A CR that ends a chunk may be the first
  // half of a CRLF, so it waits for the next chunk unless the stream ended.
  // Returns the failure to report, if any.
  const readLines = async (ended) => {
    for (let end; (end = /\r\n|\r|\n/.exec(buffered));) {
      if (!ended && end[0] === "\r" && end.index === buffered.length - 1) break;
      const line = buffered.slice(0, end.index);
      buffered = buffered.slice(end.index + end[0].length);
      if (!line) { if (!(await dispatch())) return malformedEvent; }
      else if (line.startsWith("data:") && !append(line.slice(5).trimStart())) return overflow;
    }
    return null;
  };
  let failure;
  try {
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      failure = await readLines(false);
      if (failure) break;
      if (dataBytes + Buffer.byteLength(buffered) > MAX_EVENT_BYTES) { failure = overflow; break; }
    }
    failure ??= await readLines(true);
    if (!failure && !(await dispatch())) failure = malformedEvent;
  } catch (error) { failure = () => fail("network_error", `Anthropic API stream failed: ${networkCode(error)}`); }
  await release();
  if (failure) return failure();
  if (errored) process.exitCode = 1;
  else if (!stopped) await fail("api_error", "Anthropic API stream ended before message_stop");
  else if (!delta) await fail("api_error", "Anthropic API stream ended without a stop reason; the answer may be incomplete");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
