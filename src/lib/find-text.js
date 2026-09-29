import { UNICODE_CASEFOLD_17 } from "./unicode-casefold-17.js";

// Full, locale-independent Unicode 17 case folding is applied per code point.
// In particular, a character may expand (ß -> ss), so consumers must keep
// offsets in the folded string distinct from offsets in the source string.
export function foldFindText(value) {
  return String(value).replace(/[A-Z]|[^\x00-\x7f]/gu,
    (point) => UNICODE_CASEFOLD_17.get(point.codePointAt(0)) ?? point);
}
