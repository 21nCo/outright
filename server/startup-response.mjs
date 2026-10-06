// Vite and the standalone host must expose the same recovery contract so the
// client can distinguish bounded maintenance retries from terminal failure.
export function writeStartupUnavailable(response, startupError) {
  const transient = !startupError;
  response.writeHead(transient ? 503 : 500, {
    "content-type": "application/json",
    ...(transient ? { "retry-after": "1" } : {}),
  });
  response.end(JSON.stringify({
    error: transient ? "Runtime recovery is in progress" : "Runtime recovery failed; database requires inspection",
    code: transient ? "ARCHIVE_MAINTENANCE_TRANSIENT" : "ARCHIVE_MAINTENANCE_FAILED",
  }));
}
