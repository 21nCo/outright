// Output a detached broker keeps for its next reattach: at most limitBytes of
// UTF-8 at all times, newest last. Output is stored in chunks of at most
// CHUNK_CHARS characters, each with its byte length; whole chunks are dropped
// while the rest still fills the limit, then the oldest is cut to the limit on
// a character boundary, so a surrogate pair is never split.
export const DETACHED_OUTPUT_BYTES = 1024 * 1024;
const CHUNK_CHARS = 16 * 1024;

const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;

// The UTF-8 bytes in characters [start, end) of text, counting a lone
// surrogate as the three-byte replacement character it encodes to.
function utf8Bytes(text, start = 0, end = text.length) {
  let bytes = 0;
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHigh(code) && index + 1 < end && isLow(text.charCodeAt(index + 1))) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}

export function createDetachedOutput(limitBytes = DETACHED_OUTPUT_BYTES) {
  let chunks = [];
  let sizes = [];
  let bytes = 0;
  let dropped = 0;
  const count = (value) => Math.min(Number.MAX_SAFE_INTEGER, dropped + value);
  const append = (data, start, end) => {
    const last = chunks.length - 1;
    const piece = data.slice(start, end);
    let size = utf8Bytes(data, start, end);
    if (last >= 0 && chunks[last].length < CHUNK_CHARS) {
      // A pair split across two pushes is four bytes once joined, not six.
      if (isHigh(chunks[last].charCodeAt(chunks[last].length - 1)) && isLow(data.charCodeAt(start))) size -= 2;
      chunks[last] += piece;
      sizes[last] += size;
    } else {
      chunks.push(piece);
      sizes.push(size);
    }
    bytes += size;
  };
  const trim = () => {
    while (chunks.length > 1 && bytes - sizes[0] >= limitBytes) {
      dropped = count(chunks.shift().length);
      bytes -= sizes.shift();
    }
    if (bytes <= limitBytes) return;
    const oldest = chunks[0];
    let index = 0;
    let removed = 0;
    while (index < oldest.length && removed < bytes - limitBytes) {
      const pair = isHigh(oldest.charCodeAt(index)) && index + 1 < oldest.length && isLow(oldest.charCodeAt(index + 1));
      removed += utf8Bytes(oldest, index, index + (pair ? 2 : 1));
      index += pair ? 2 : 1;
    }
    dropped = count(index);
    bytes -= removed;
    if (index === oldest.length) {
      chunks.shift();
      sizes.shift();
    } else {
      chunks[0] = oldest.slice(index);
      sizes[0] -= removed;
    }
  };
  return {
    push(data) {
      if (!data) return;
      let start = 0;
      while (start < data.length) {
        const last = chunks.length - 1;
        const room = last >= 0 && chunks[last].length < CHUNK_CHARS ? CHUNK_CHARS - chunks[last].length : CHUNK_CHARS;
        let end = Math.min(data.length, start + room);
        // Keep a surrogate pair in one chunk; a full chunk may take its low half.
        if (end < data.length && isHigh(data.charCodeAt(end - 1)) && isLow(data.charCodeAt(end))) end += 1;
        if (start === 0 && last >= 0 && chunks[last].length >= CHUNK_CHARS
          && isHigh(chunks[last].charCodeAt(chunks[last].length - 1)) && isLow(data.charCodeAt(0))) {
          chunks[last] += data[0];
          sizes[last] += 1;
          bytes += 1;
          start = 1;
          continue;
        }
        append(data, start, end);
        start = end;
      }
      trim();
    },
    // Characters lost before the ring saw them, such as shed peer output.
    drop(characters) { dropped = count(characters); },
    // UTF-8 bytes currently held, never more than limitBytes.
    retainedBytes() { return bytes; },
    // The kept output, preceded by a notice when older output was dropped.
    take() {
      const output = chunks.join("");
      const notice = dropped ? `\u001b[0m[Outright: ${dropped} earlier terminal output characters were dropped while detached]\r\n` : "";
      chunks = [];
      sizes = [];
      bytes = 0;
      dropped = 0;
      return notice + output;
    },
  };
}
