import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

// Writes a command named `name` into `directory` that runs CommonJS `source`
// with this Node. Windows finds it as name.cmd through PATHEXT, as a shell
// does for a provider CLI's npm shim; POSIX runs a shell script.
export function writeNodeCommand(directory, name, source) {
  const script = path.join(directory, `${name}.cjs`);
  writeFileSync(script, source);
  if (process.platform === "win32") {
    const command = path.join(directory, `${name}.cmd`);
    writeFileSync(command, `@"${process.execPath}" "${script}" %*\r\n`);
    return command;
  }
  const command = path.join(directory, name);
  writeFileSync(command, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(command, 0o755);
  return command;
}
