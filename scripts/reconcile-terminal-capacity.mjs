// Offline, one-target operator recovery for a terminal whose OS owner cannot
// be proved empty automatically. The runtime lease prevents a live server
// from creating another terminal while this decision is recorded.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutrightDatabase } from "../server/database.mjs";
import { cleanupTerminalSocket } from "../server/managed-terminal.mjs";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
const filename = path.resolve(value("--database") ?? path.join(os.homedir(), ".outright", "outright.db"));
const target = value("--target");
const evidence = value("--evidence");
if (!existsSync(filename)) throw new Error(`Outright database does not exist: ${filename}`);
if (target && (args.includes("--list") || !args.includes("--verified-empty") || !evidence)) {
  throw new Error("Resolving one terminal requires --target ID --verified-empty --evidence 'how the native process tree was verified empty'");
}
if (!target && !args.includes("--list")) throw new Error("Use --list or --target ID --verified-empty --evidence TEXT");
const database = createOutrightDatabase({ filename, runtimeLease: true });
try {
  database.reconcileTerminalAudit();
  if (target) {
    if (!database.terminalUnknownReservations().some((entry) => entry.target === target)) {
      throw new Error("The terminal has no unresolved capacity reservation");
    }
    cleanupTerminalSocket(target);
    database.resolveTerminalUnknown(target, `Operator verified native owner empty: ${evidence}`);
    process.stdout.write(`Resolved one terminal reservation: ${target}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(database.terminalUnknownReservations(), null, 2)}\n`);
  }
} finally { await database.close(); }
