// Keep the same length-changing lowercase behavior at every Find boundary,
// then merge the two lowercase forms of Greek sigma. Unicode lowercasing
// chooses final sigma from word context, while a standalone query cannot.
export function foldFindText(value) {
  return value.toLocaleLowerCase().replace(/ς/g, "σ");
}
