// Output a detached broker keeps for its next reattach: at most limitBytes of
// UTF-8, newest last. Whole chunks are dropped while the rest still fills the
// limit; the oldest kept chunk is cut to the exact limit only when taken.
export const DETACHED_OUTPUT_BYTES = 1024 * 1024;
const CHUNK_CHARS = 16 * 1024;

export function createDetachedOutput(limitBytes = DETACHED_OUTPUT_BYTES) {
  let chunks = [];
  let bytes = 0;
  let dropped = 0;
  const count = (value) => Math.min(Number.MAX_SAFE_INTEGER, dropped + value);
  return {
    push(data) {
      if (!data) return;
      const last = chunks.length - 1;
      if (last >= 0 && chunks[last].length < CHUNK_CHARS) chunks[last] += data;
      else chunks.push(data);
      bytes += Buffer.byteLength(data);
      while (chunks.length > 1 && bytes - Buffer.byteLength(chunks[0]) >= limitBytes) {
        const oldest = chunks.shift();
        bytes -= Buffer.byteLength(oldest);
        dropped = count(oldest.length);
      }
    },
    // Characters lost before the ring saw them, such as shed peer output.
    drop(characters) { dropped = count(characters); },
    // The kept output, preceded by a notice when older output was dropped.
    take() {
      let output = chunks.join("");
      const excess = bytes - limitBytes;
      if (excess > 0) {
        const tail = Buffer.from(output).subarray(excess);
        let start = 0;
        while (start < tail.length && (tail[start] & 0xc0) === 0x80) start += 1;
        const kept = tail.subarray(start).toString("utf8");
        dropped = count(output.length - kept.length);
        output = kept;
      }
      const notice = dropped ? `\u001b[0m[Outright: ${dropped} earlier terminal output characters were dropped while detached]\r\n` : "";
      chunks = [];
      bytes = 0;
      dropped = 0;
      return notice + output;
    },
  };
}
