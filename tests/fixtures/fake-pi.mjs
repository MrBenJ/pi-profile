import { writeFileSync } from "node:fs";

if (process.env.TEST_CAPTURE) {
  writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    profile: process.env.PI_PROFILE_NAME,
    root: process.env.PI_CODING_AGENT_DIR,
    sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
  }));
}
if (process.env.TEST_SELF_SIGNAL) {
  process.kill(process.pid, process.env.TEST_SELF_SIGNAL);
} else {
  process.exit(Number(process.env.TEST_EXIT_CODE || 0));
}
