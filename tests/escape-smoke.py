#!/usr/bin/env python3
"""Authenticated POSIX PTY smoke against the locally pinned Pi: python3 tests/escape-smoke.py"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

harness = Path(__file__).resolve().parent.parent
cli = harness / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
temp = Path(tempfile.mkdtemp(prefix="pi-escape-smoke-"))
root = temp / "project"
(root / "scripts").mkdir(parents=True)
subprocess.run(["git", "init", "-q", str(root)], check=True)
(root / "source.txt").write_text("original\n")
verify = root / "scripts/verify"
verify.write_text('#!/usr/bin/env bash\necho started > "$SMOKE_DIR/started"\nsleep 2\necho alive > "$SMOKE_DIR/heartbeat"\nsleep 28\necho finished > "$SMOKE_DIR/finished"\nexit 1\n')
verify.chmod(0o755)
(temp / "config.json").write_text(json.dumps({"automaticOnSettle": True, "evidenceDir": str(temp / "evidence")}))
observer = temp / "observer.mjs"
observer.write_text('''import { appendFileSync, writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.onTerminalInput((data) => { if (data === "\\x1b") writeFileSync(process.env.SMOKE_DIR + "/escape", "received"); });
    writeFileSync(process.env.SMOKE_DIR + "/ready", "ready");
  });
  pi.on("agent_before_settle", (_event, ctx) => {
    writeFileSync(process.env.SMOKE_DIR + "/signal", String(!!ctx.signal));
    appendFileSync("source.txt", "changed\\n");
  });
  pi.on("agent_settled", (event, ctx) => {
    writeFileSync(process.env.SMOKE_DIR + "/settled", JSON.stringify({ aborted: event.aborted, feedback: ctx.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === "pi-engineering-harness-feedback").length }));
  });
}
''')
env = {**os.environ, "PI_HARNESS_CONFIG": str(temp / "config.json"), "SMOKE_DIR": str(temp), "PI_OFFLINE": "1", "TERM": "xterm-256color"}
env.pop("PI_PACKAGE_DIR", None)
assert subprocess.check_output(["node", str(cli), "--version"], env=env, text=True).strip() == "1.4.0"
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
process = subprocess.Popen(["node", str(cli), "--approve", "--no-tools", "--no-extensions", "--no-session", "-e", str(observer), "-e", str(harness)], cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = bytearray()

def wait_for(predicate, description, timeout=50):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        if process.poll() is not None:
            break
        if select.select([master], [], [], 0.1)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break
    raise AssertionError(f"{description}; Pi exit={process.poll()}; output tail={output[-4000:].decode(errors='replace')}")

try:
    wait_for(lambda: (temp / "ready").exists(), "Pi did not start")
    time.sleep(1)
    os.write(master, b"Reply done without using tools.\r")
    wait_for(lambda: (temp / "started").exists(), "Pi did not reach verification")
    assert (temp / "signal").read_text() == "false", "settlement unexpectedly supplied an abort signal"
    assert not (temp / "heartbeat").exists(), "verifier heartbeat preceded Escape"
    os.write(master, b"\x1b")
    wait_for(lambda: (temp / "escape").exists(), "Pi did not receive Escape")
    wait_for(lambda: (temp / "heartbeat").exists(), "Verification did not continue after Escape")
    assert not (temp / "finished").exists() and not (temp / "evidence").exists(), "Escape unexpectedly stopped verification"
    os.write(master, b"/verify-cancel\r")
    wait_for(lambda: (temp / "settled").exists(), "Pi did not settle after /verify-cancel")
    records = [json.loads(path.read_text()) for path in (temp / "evidence").glob("*.json")]
    assert any(r.get("kind") == "attempt" and r.get("status") == "cancelled" for r in records), records
    assert any(r.get("kind") == "summary" and r.get("finalOutcome") == "cancelled" and r.get("repairContinuations") == 0 for r in records), records
    settled = json.loads((temp / "settled").read_text())
    assert settled["aborted"] and settled["feedback"] == 0, settled
    print(f"Real Pi 1.4.0 PTY: Escape received but did not stop settlement verification; /verify-cancel cancelled with no repair. Artifacts: {temp}")
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    os.close(master)
