#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Linux real-process tests; no GPU, database or network is used."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest


def process_identity(pid):
    try:
        value = Path(f"/proc/{pid}/stat").read_text()
        fields = value[value.rfind(")") + 2:].split()
        return {"pid": pid, "start": fields[19], "state": fields[0]}
    except (FileNotFoundError, ProcessLookupError):
        return None


def alive(identity):
    current = process_identity(identity["pid"]) if identity else None
    return current is not None and current["start"] == identity["start"] and current["state"] != "Z"


def wait_for(predicate, seconds=3):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(.01)
    raise AssertionError("Timed out waiting for owned process state")


if len(sys.argv) > 1 and sys.argv[1] == "--owner":
    # The test, not this owner, retains the heartbeat writer. Killing the owner
    # therefore isolates PDEATHSIG from both EOF and deadline expiry.
    base, fd, timeout, info, child = json.loads(sys.argv[2]), int(sys.argv[3]), sys.argv[4], Path(sys.argv[5]), sys.argv[6]
    command = [*base, "--parent-pid", str(os.getpid()), "--heartbeat-fd", str(fd),
               "--heartbeat-timeout-ms", timeout, "--", sys.executable, "-c",
               "import os,time,pathlib,json; p=pathlib.Path(" + repr(child) + "); q=p.with_suffix('.tmp'); q.write_text(json.dumps({'pid':os.getpid()})); q.replace(p); time.sleep(60)"]
    proc = subprocess.Popen(command, pass_fds=(fd,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.close(fd)
    temporary = info.with_suffix(".tmp")
    temporary.write_text(json.dumps({"owner": process_identity(os.getpid()), "helper": process_identity(proc.pid)}))
    temporary.replace(info)
    time.sleep(60)
    sys.exit(0)

parser = argparse.ArgumentParser()
parser.add_argument("--guardian", type=Path, required=True)
parser.add_argument("--native", type=Path)
args, remaining = parser.parse_known_args()
if not sys.platform.startswith("linux"):
    raise SystemExit("Linux supervisor lifecycle tests require Linux")
identity = subprocess.check_output([str(args.guardian), "--identity"], text=True).strip()
match = re.fullmatch(r"bitovp-vmaf-supervisor-v1-clock=boottime-source=([0-9a-f]{64})", identity)
if not match:
    raise SystemExit("Supervisor identity is not a recorded build")
base = [str(args.native), "--supervise"] if args.native else [str(args.guardian), "--expected-source", match[1], "--expected-protocol", "1", "--expected-clock", "boottime"]


def boottime_ns():
    # Match the Node owner: /proc/uptime includes suspend and is rounded down.
    token = Path("/proc/uptime").read_text().split()[0]
    if not re.fullmatch(r"[0-9]+\.[0-9]{1,9}", token):
        raise ValueError("The Linux boot-time clock is unavailable")
    seconds, fraction = token.split(".")
    return int(seconds) * 1000000000 + int(fraction.ljust(9, "0"))


class Heartbeat:
    def __init__(self, fd, timeout_ms, interval=.05):
        self.fd, self.timeout, self.interval = fd, timeout_ms, interval
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def run(self):
        while not self.stop.is_set():
            try:
                os.write(self.fd, f"{boottime_ns() + self.timeout * 1000000}\n".encode())
            except OSError:
                break
            self.stop.wait(self.interval)

    def close(self):
        self.stop.set()
        self.thread.join(timeout=2)
        os.close(self.fd)


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bitovp-supervisor-")
        self.root = Path(self.temp.name)
        self.processes = []
        self.heartbeats = []
        self.readers = []
        self.handles = {}

    def tearDown(self):
        for heartbeat in self.heartbeats:
            heartbeat.close()
        for fd in self.readers:
            try:
                os.close(fd)
            except OSError:
                pass
        for handle in self.handles.values():
            try:
                signal.pidfd_send_signal(handle, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for proc in self.processes:
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        for handle in self.handles.values():
            os.close(handle)
        self.temp.cleanup()

    def track(self, identity):
        if not identity:
            return
        key = (identity["pid"], identity["start"])
        if key not in self.handles:
            try:
                self.handles[key] = os.pidfd_open(identity["pid"])
            except ProcessLookupError:
                return
        self.assertEqual(process_identity(identity["pid"])["start"], identity["start"])

    def owned_signal(self, identity, value):
        signal.pidfd_send_signal(self.handles[(identity["pid"], identity["start"])], value)

    def launch(self, command, *, timeout=1000, heartbeat=True, env=None):
        read, write = os.pipe()
        full = [*base, "--parent-pid", str(os.getpid()), "--heartbeat-fd", str(read),
                "--heartbeat-timeout-ms", str(timeout), "--", *command]
        environment = dict(os.environ if env is None else env, BITOVP_TEST_HEARTBEAT_FD=str(read))
        proc = subprocess.Popen(full, pass_fds=(read,), start_new_session=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
        self.processes.append(proc)
        self.track(process_identity(proc.pid))
        os.close(read)
        if heartbeat:
            self.heartbeats.append(Heartbeat(write, timeout))
        else:
            self.readers.append(write)
        return proc, write

    def owner(self, *, timeout=2000):
        read, write = os.pipe()
        info, child = self.root / "owner.json", self.root / "child.json"
        proc = subprocess.Popen([sys.executable, __file__, "--owner", json.dumps(base), str(read), str(timeout), str(info), str(child)],
                                pass_fds=(read,), start_new_session=True)
        self.processes.append(proc)
        self.track(process_identity(proc.pid))
        os.close(read)
        heartbeat = Heartbeat(write, timeout)
        self.heartbeats.append(heartbeat)
        wait_for(lambda: info.exists() and child.exists())
        state = json.loads(info.read_text())
        state["child"] = process_identity(json.loads(child.read_text())["pid"])
        self.assertIsNotNone(state["child"])
        self.track(state["helper"]); self.track(state["child"])
        return proc, state, heartbeat

    def test_status_output_arguments_environment_and_closed_control_fd(self):
        code = """import os,sys,json
try:
 os.fstat(int(os.environ['BITOVP_TEST_HEARTBEAT_FD'])); control_open=True
except OSError:
 control_open=False
print(json.dumps({'args':sys.argv[1:],'mps':os.getenv('CUDA_MPS_PIPE_DIRECTORY'),'sentinel':os.getenv('BITOVP_TEST_SENTINEL'),'controlOpen':control_open}))
print('stderr marker',file=sys.stderr)
sys.exit(7)
"""
        environment = dict(os.environ, CUDA_MPS_PIPE_DIRECTORY="/a/private/original-pipe", BITOVP_TEST_SENTINEL="value with spaces")
        proc, _ = self.launch([sys.executable, "-c", code, "argument with spaces", "$(literal)", "--option"], env=environment)
        stdout, stderr = proc.communicate(timeout=4)
        self.assertEqual(proc.returncode, 7, stderr)
        result = json.loads(stdout)
        self.assertEqual(result["args"], ["argument with spaces", "$(literal)", "--option"])
        self.assertEqual(result["mps"], "")
        self.assertFalse(result["controlOpen"])
        self.assertEqual(result["sentinel"], "value with spaces")
        self.assertEqual(environment["CUDA_MPS_PIPE_DIRECTORY"], "/a/private/original-pipe")
        self.assertEqual(stderr, "stderr marker\n")

    def test_fresh_heartbeats_extend_past_initial_deadline(self):
        proc, _ = self.launch([sys.executable, "-c", "import time; time.sleep(1.3); print('complete')"], timeout=400)
        stdout, stderr = proc.communicate(timeout=4)
        self.assertEqual(proc.returncode, 0, stderr)
        self.assertEqual(stdout, "complete\n")

    def test_no_heartbeat_starts_no_command_and_kernel_deadline_fires(self):
        marker = self.root / "should-not-exist"
        proc, _ = self.launch([sys.executable, "-c", "from pathlib import Path; Path(" + repr(str(marker)) + ").touch()"], timeout=250, heartbeat=False)
        proc.communicate(timeout=3)
        self.assertEqual(proc.returncode, -signal.SIGKILL)
        self.assertFalse(marker.exists())

    def test_eof_terminates_running_command(self):
        proc, state, heartbeat = self.owner()
        heartbeat.close(); self.heartbeats.remove(heartbeat)
        wait_for(lambda: not alive(state["helper"]) and not alive(state["child"]))
        self.assertIsNone(proc.poll())

    def test_parent_sigkill_with_heartbeat_writer_kept_alive(self):
        foreign = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(60)"], start_new_session=True)
        self.processes.append(foreign)
        self.track(process_identity(foreign.pid))
        owner, state, _ = self.owner()
        self.owned_signal(state["owner"], signal.SIGKILL)
        owner.wait(timeout=2)
        wait_for(lambda: not alive(state["helper"]) and not alive(state["child"]), 1.5)
        self.assertIsNone(foreign.poll())

    def test_helper_sigkill_terminates_child_without_guessing_pids(self):
        _, state, _ = self.owner()
        self.owned_signal(state["helper"], signal.SIGKILL)
        wait_for(lambda: not alive(state["child"]), 1.5)

    def test_owner_sigstop_does_not_keep_old_heartbeats_alive(self):
        # Here the owner is deliberately kept alive but stopped. Stop the test's
        # writer as a frozen Node event loop would, keeping the FD itself open.
        owner, state, heartbeat = self.owner(timeout=450)
        heartbeat.stop.set(); heartbeat.thread.join(timeout=2)
        self.owned_signal(state["owner"], signal.SIGSTOP)
        wait_for(lambda: not alive(state["helper"]) and not alive(state["child"]), 2)
        self.owned_signal(state["owner"], signal.SIGCONT)

    def test_stopped_helper_is_killed_by_the_kernel_timer(self):
        _, state, _ = self.owner(timeout=450)
        self.owned_signal(state["helper"], signal.SIGSTOP)
        wait_for(lambda: not alive(state["helper"]) and not alive(state["child"]), 2)

    def test_kernel_timer_uses_suspend_aware_clock(self):
        _, state, _ = self.owner()
        timers = Path(f"/proc/{state['helper']['pid']}/timers").read_text()
        clocks = re.findall(r"^ClockID:\s+(\d+)$", timers, re.MULTILINE)
        self.assertEqual(clocks, [str(time.CLOCK_BOOTTIME)])

    def test_malformed_stale_and_excessive_heartbeats_fail_closed(self):
        for payload in (b"x\n", b"1\n", b"9" * 21 + b"\n", str(boottime_ns() + 60000000000).encode() + b"\n"):
            proc, write = self.launch([sys.executable, "-c", "import time; time.sleep(60)"], timeout=400, heartbeat=False)
            os.write(write, payload)
            proc.communicate(timeout=2)
            self.assertNotEqual(proc.returncode, 0)

    def test_wrong_parent_fd_timeout_source_and_protocol_never_start_work(self):
        marker = self.root / "never-started"
        command = [sys.executable, "-c", "from pathlib import Path;Path(" + repr(str(marker)) + ").touch()"]
        read, write = os.pipe()
        try:
            valid = ["--parent-pid", str(os.getpid()), "--heartbeat-fd", str(read), "--heartbeat-timeout-ms", "1000", "--", *command]
            for index, replacement in ((1, str(os.getpid() + 100000)), (3, "2"), (5, "15001"), (5, "0")):
                changed = valid.copy(); changed[index] = replacement
                run = subprocess.run([*base, *changed], pass_fds=(read,), capture_output=True, text=True, timeout=2)
                self.assertNotEqual(run.returncode, 0)
            for expected_source, protocol, clock in (("0" * 64, "1", "boottime"), (match[1], "2", "boottime"), (match[1], "1", "monotonic")):
                run = subprocess.run([str(args.guardian), "--expected-source", expected_source, "--expected-protocol", protocol, "--expected-clock", clock, *valid],
                                     pass_fds=(read,), capture_output=True, text=True, timeout=2)
                self.assertNotEqual(run.returncode, 0)
        finally:
            os.close(read); os.close(write)
        self.assertFalse(marker.exists())


unittest.main(argv=[__file__, *remaining])
