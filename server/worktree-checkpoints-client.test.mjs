// The suite runner picks up every server/*.test.mjs; the checkpoint dialog's
// helper tests live under tests/, whose list in scripts/run-tests.mjs belongs
// to another OUT-2 slice, so they run from here.
import "../tests/worktree-checkpoints.test.mjs";
