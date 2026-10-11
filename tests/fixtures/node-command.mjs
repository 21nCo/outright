import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

// Writes a command named `name` into `directory` that runs CommonJS `source`
// with this Node. Windows finds it as name.cmd through PATHEXT, as a shell
// does for a provider CLI's npm shim; POSIX runs a shell script. Paths are
// quoted so neither shell expands anything in them.
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
// Batch files expand %NAME% even inside quotes; Windows paths cannot hold ".
const batchQuote = (value) => `"${value.replaceAll("%", "%%")}"`;

export function writeNodeCommand(directory, name, source) {
  const script = path.join(directory, `${name}.cjs`);
  writeFileSync(script, source);
  if (process.platform === "win32") {
    const command = path.join(directory, `${name}.cmd`);
    writeFileSync(command, `@${batchQuote(process.execPath)} ${batchQuote(script)} %*\r\n`);
    return command;
  }
  const command = path.join(directory, name);
  writeFileSync(command, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
  chmodSync(command, 0o755);
  return command;
}
