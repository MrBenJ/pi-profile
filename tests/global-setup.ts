import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export default async function globalSetup(): Promise<void> {
  const repository = resolve(import.meta.dirname, "..");
  await exec(process.execPath, [resolve(repository, "node_modules/typescript/bin/tsc")], { cwd: repository });
}
