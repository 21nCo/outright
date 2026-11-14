// scripts/run-tests.mjs bounds the serial suite and each test file, and
// tests/ui-races.test.mjs bounds the browser fixture inside it; all three
// read these deadlines so they cannot drift apart when the fixture grows.
//
// macOS CI ran 157 of the 162 steps in 274.9 seconds (run 43585106708); the
// five left repeat steps that took about 45 seconds with reduced motion.
// Ubuntu and Windows finished all 162 in 173.2 and 182.8 seconds. The 400-second interaction phase keeps
// about 80 seconds spare for those roughly 320 seconds. The test adds 25
// seconds for cleanup. The file also runs the harness unit tests and the
// injected-failure fixture first (17 seconds on macOS), so its runner gets 65
// seconds beyond the fixture. A focused 1000px full-span wheel fixture gets a
// larger finite phase.
//
// The browser file runs last. Windows CI spent 1139, 1155 and 1287 seconds on
// the files before it (runs 43569468883, 43585106708, 43595811460) and 200
// to 217 seconds on it, so the suite gets the slowest serial files plus the
// browser file's whole deadline: 1790 seconds, 15% over the slowest observed
// total of about 1520. CI_JOB_SETUP_MS is the job's time outside the suite
// (setup, npm ci, build, site tests: at most 70 seconds on Windows), which
// must fit the job timeout in .github/workflows/ci.yml with the suite.
export const SERIAL_FILES_MS = 1_300_000;
export const CI_JOB_SETUP_MS = 120_000;
export function uiFixtureBudget(wheelCap = Number(process.env.OUTRIGHT_TEST_WHEEL_DELTA_CAP)) {
  const smallWheelCap = wheelCap > 0 && wheelCap <= 1000;
  const phaseMs = smallWheelCap ? 450_000 : 400_000;
  const fixtureMs = phaseMs + 25_000;
  const fileMs = fixtureMs + 65_000;
  return { smallWheelCap, phaseMs, fixtureMs, fileMs, suiteMs: SERIAL_FILES_MS + fileMs };
}
