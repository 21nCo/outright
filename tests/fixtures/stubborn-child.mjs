process.on("SIGTERM", () => {});
process.stdout.write("ready\n");
// A killed test runner cannot clean up an orphaned detached fixture.
setTimeout(() => process.exit(0), 45_000);
