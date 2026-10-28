// scripts/run-tests.mjs bounds each test file and tests/ui-races.test.mjs
// bounds the browser fixture inside it; both read these deadlines so they
// cannot drift apart when the fixture grows.
//
// macOS CI (Chrome 156) ran 151 of the 156 steps in 205.6 seconds, with
// frame-bound steps about 2.4 times slower than on Windows and Ubuntu, which
// finished all 156 in 134.5 and 127.5 seconds. Its last five steps take about
// 27 seconds more, so the 280-second interaction phase keeps about 45 seconds
// spare there. The test adds 25 seconds for cleanup. The file also runs the
// harness unit tests and the injected-failure fixture first (17 seconds on
// macOS), so its runner gets 65 seconds beyond the fixture. A focused 1000px
// full-span wheel fixture gets a larger finite phase.
export function uiFixtureBudget(wheelCap = Number(process.env.OUTRIGHT_TEST_WHEEL_DELTA_CAP)) {
  const smallWheelCap = wheelCap > 0 && wheelCap <= 1000;
  const phaseMs = smallWheelCap ? 330_000 : 280_000;
  const fixtureMs = phaseMs + 25_000;
  return { smallWheelCap, phaseMs, fixtureMs, fileMs: fixtureMs + 65_000 };
}
