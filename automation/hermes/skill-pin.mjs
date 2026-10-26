export function selectPinnedSkill(ledgerSkill, worktreePin, coordinatorPin) {
  const matches = (pin) => pin && ledgerSkill?.identity === `${pin.workspaceSlug}/${pin.skillSlug}@${pin.semanticVersion}` && ledgerSkill?.digest === pin.digest;
  return [worktreePin, coordinatorPin].find(matches);
}
