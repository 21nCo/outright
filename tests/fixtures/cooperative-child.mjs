// A child that announces readiness, then exits normally after the old watchdog.
process.stdout.write("ready\n");
setTimeout(() => process.exit(0), 150);
