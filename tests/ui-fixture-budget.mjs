// scripts/run-tests.mjs bounds the serial suite and each test file, and
// tests/ui-races.test.mjs bounds the browser fixture inside it; all three
// read these deadlines so they cannot drift apart when the fixture grows.
//
// macOS CI ran all 162 steps in 299.1 seconds on main (run 43631042775).
// The Files steps of the PDF viewer, library and worker loads, the Files
// pane, hidden-file storage, quick open and the narrow toolbar add about 40
// seconds there (the OUT-18 reference run 41844391966 ran them in 167 steps
// in 296.7 seconds), for about 340 seconds for this fixture's 169 steps;
// Windows took 175 and 162 seconds for the reference's 167 (runs
// 41844391966, 41864786166). The 430-second interaction phase keeps about
// 90 seconds spare. The test adds 25 seconds for cleanup. The file also runs the
// harness unit tests and the injected-failure fixture first (17 seconds on
// macOS), so its runner gets 65 seconds beyond the fixture. A focused 1000px
// full-span wheel fixture gets a larger finite phase.
//
// The browser file runs last. Windows CI spent 1139, 1155 and 1287 seconds on
// the files before it (runs 43569468883, 43585106708, 43595811460) and 200
// and 217 seconds on it in the first two; the Files steps bring it to about
// 260. tests/preview-build.test.mjs, which builds the app and the fixture and
// runs the built fixture's one step, took 29 to 39 seconds on Windows (runs
// 41844391966, 41864786166); its owner tests start Vite and Chrome twice
// more and a stub, about 20 seconds more (6 locally). The suite gets the slowest
// serial files with it, rounded up to 1350 seconds, plus the browser file's
// whole deadline: 1870 seconds (1920 with the wheel phase), 16% over the
// slowest likely total of 1606. CI_JOB_SETUP_MS bounds the job's time outside the suite (setup, npm
// ci, build, site tests: 46 to 52 seconds on Windows in those runs), which
// must fit the job timeout in .github/workflows/ci.yml with the suite.
export const SERIAL_FILES_MS = 1_350_000;
export const CI_JOB_SETUP_MS = 120_000;
export function uiFixtureBudget(wheelCap = Number(process.env.OUTRIGHT_TEST_WHEEL_DELTA_CAP)) {
  const smallWheelCap = wheelCap > 0 && wheelCap <= 1000;
  const phaseMs = smallWheelCap ? 480_000 : 430_000;
  const fixtureMs = phaseMs + 25_000;
  const fileMs = fixtureMs + 65_000;
  return { smallWheelCap, phaseMs, fixtureMs, fileMs, suiteMs: SERIAL_FILES_MS + fileMs };
}
