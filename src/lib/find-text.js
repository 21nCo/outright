// Use the same locale-independent lowercase behavior at every Find boundary,
// then merge the two lowercase forms of Greek sigma. Unicode lowercasing
// chooses final sigma from word context, while a standalone query cannot.
export function foldFindText(value) {
  return value.toLowerCase().replace(/ς/g, "σ");
}
