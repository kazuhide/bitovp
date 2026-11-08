#!/usr/bin/env python3
"""Offline operator release attestation. It never rewrites the failed job."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import time
import uuid

from gateway import GatewayError, PORTS, Store, UNCONFIRMED_ERRORS, canonical_hash, inference_lease, runtime_release_bindings


def pid_start_ticks(pid):
    try:
        text = Path(f'/proc/{pid}/stat').read_text()
        return int(text[text.rindex(')') + 2:].split()[19])
    except FileNotFoundError:
        return None


def cgroup_pids(group):
    root = Path('/sys/fs/cgroup') / group.lstrip('/')
    found = set()
    if root.exists():
        for path in root.rglob('cgroup.procs'):
            found.update(int(p) for p in path.read_text().split())
    return sorted(found)


def effective_unit_configuration(lab, directory, unit_path, unit_text, state):
    if (state.get('LoadState') != 'loaded' or state.get('Type') != 'simple' or state.get('KillMode') != 'control-group'
            or state.get('NeedDaemonReload') != 'no' or state.get('DropInPaths') != ''
            or Path(state.get('FragmentPath', '')).resolve() != unit_path.resolve()):
        raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
    lines = [line.split('=', 1)[1] for line in unit_text.splitlines() if line.startswith('ExecStart=')]
    if len(lines) != 1:
        raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
    argv = shlex.split(lines[0])
    effective = state.get('ExecStart', '')
    match = re.match(r'^\{ path=([^;]+) ; argv\[\]=([^;]+) ;', effective)
    if (not argv or not Path(argv[0]).is_absolute() or match is None or effective.count('{') != 1
            or shlex.split(match[2]) != argv or Path(match[1].strip()).resolve() != Path(argv[0]).resolve()):
        raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
    executable = Path(argv[0]).resolve()
    if unit_path.name == 'bitovp-semantic-gateway.service':
        if argv[1:] != [str(directory / 'gateway.py'), '--directory', str(directory)] or executable != Path('/usr/bin/python3').resolve():
            raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
    elif not executable.is_relative_to((lab / 'runtime').resolve()) or executable.name != 'ollama' or argv[1:] != ['serve']:
        raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
    return {'executable': str(executable), 'argv': argv, 'fragmentPath': str(unit_path.resolve()),
            'dropInPaths': [], 'needDaemonReload': False, 'killMode': 'control-group', 'type': 'simple'}


def main_process_identity(pid, configuration, proc_root=Path('/proc')):
    try:
        executable = proc_root / str(pid) / 'exe'
        raw = (proc_root / str(pid) / 'cmdline').read_bytes()
        argv = raw.rstrip(b'\0').decode('utf-8').split('\0')
        expected = configuration['argv']
        if (str(executable.resolve(strict=True)) != configuration['executable'] or len(argv) != len(expected)
                or Path(argv[0]).resolve() != Path(expected[0]).resolve() or argv[1:] != expected[1:]):
            raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
        digest = hashlib.sha256()
        with executable.open('rb') as handle:
            while chunk := handle.read(1024 * 1024): digest.update(chunk)
        return {'mainProcessExeHash': digest.hexdigest(), 'mainProcessArgvHash': hashlib.sha256(raw).hexdigest()}
    except (OSError, ValueError, IndexError):
        raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)


def validate_stopped_units(capture, read_unit, read_group, read_pid, unit_hash):
    """The flags are derived from fresh OS reads, never accepted from a proof-file caller."""
    result = []
    for before in capture['units']:
        state = read_unit(before['unitName'])
        if (state.get('ActiveState') != 'inactive' or state.get('MainPID') != '0'
                or state.get('effectiveConfigHash') != before['effectiveConfigHash']
                or read_group(before['cgroup']) or unit_hash(before['unitName']) != before['unitFileHash']
                or any(read_pid(p['pid']) == p['startTicks'] for p in before['oldProcesses'])):
            raise GatewayError('OPERATOR_STOP_UNCONFIRMED', 422)
        result.append({**before, 'observedStoppedAt': time.time(), 'activeState': 'inactive',
                       'mainPid': 0, 'cgroupEmpty': True, 'oldPidsGone': True})
    return result


class OfflineOperator:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.lab = Path.home() / '.local/share/bitovp-llm-lab'
        if (self.directory != self.lab / 'gateway'
                or json.loads((self.lab / 'lab-identity.json').read_text()).get('owner') != 'bitovp-dual-gpu-llm-20261104'
                or json.loads((self.directory / 'owner.json').read_text()).get('owner') != 'bitovp-local-story-integration-20261104'):
            raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)

    def row_and_quarantine(self, job):
        uri = (self.directory / 'state/jobs.sqlite3').as_uri() + '?mode=ro'
        with sqlite3.connect(uri, uri=True) as db:
            db.row_factory = sqlite3.Row
            found = db.execute('SELECT * FROM jobs WHERE id=?', (job,)).fetchone()
            if found is None:
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            row = dict(found)
            bindings = runtime_release_bindings(row)
            quarantine = db.execute('SELECT * FROM runtime_quarantines WHERE profile=?', (bindings['profile'],)).fetchone()
            if (row['state'] != 'FAILED' or row['cleanup_confirmed'] != 0 or row['error_code'] not in UNCONFIRMED_ERRORS
                    or quarantine is None or db.execute("SELECT 1 FROM jobs WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELLED') LIMIT 1").fetchone()):
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            return row, dict(quarantine)

    def unit_hash(self, unit):
        path = Path.home() / '.config/systemd/user' / unit
        if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid():
            raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
        text = path.read_text()
        if str(self.lab) not in text:
            raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
        return hashlib.sha256(path.read_bytes()).hexdigest()

    @staticmethod
    def unit_state(unit):
        if unit not in ('bitovp-semantic-gateway.service', 'bitovp-llm-amd.service', 'bitovp-llm-nvidia.service'):
            raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
        response = subprocess.run(['systemctl', '--user', 'show', unit, '-p', 'MainPID', '-p', 'ActiveState',
                                   '-p', 'ControlGroup', '-p', 'KillMode', '-p', 'ExecStart', '-p', 'FragmentPath',
                                   '-p', 'DropInPaths', '-p', 'NeedDaemonReload', '-p', 'LoadState', '-p', 'Type'], capture_output=True, text=True, timeout=10, check=True)
        return dict(line.split('=', 1) for line in response.stdout.splitlines() if '=' in line)

    def checked_unit_state(self, unit):
        state = self.unit_state(unit)
        path = Path.home() / '.config/systemd/user' / unit
        self.unit_hash(unit)
        configuration = effective_unit_configuration(self.lab, self.directory, path, path.read_text(), state)
        return {**state, 'effectiveConfigHash': canonical_hash(configuration)}, configuration

    def capture_unit(self, unit):
        state, configuration = self.checked_unit_state(unit)
        group = f'/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/app.slice/{unit}'
        if (state.get('ActiveState') != 'active' or state.get('ControlGroup') != group
                or not state.get('MainPID', '').isdigit() or int(state['MainPID']) <= 0):
            raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
        processes = [{'pid': pid, 'startTicks': pid_start_ticks(pid)} for pid in cgroup_pids(group)]
        if int(state['MainPID']) not in {p['pid'] for p in processes} or any(p['startTicks'] is None for p in processes):
            raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
        identity = main_process_identity(int(state['MainPID']), configuration)
        return {'unitName': unit, 'cgroup': group, 'unitFileHash': self.unit_hash(unit),
                'effectiveConfigHash': state['effectiveConfigHash'], **identity,
                'beforeMainPid': int(state['MainPID']), 'oldProcesses': processes}

    def backup(self):
        backup_directory = self.directory / 'state/release-backups'
        backup_directory.mkdir(mode=0o700, exist_ok=True)
        if backup_directory.is_symlink(): raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
        backup = backup_directory / (str(uuid.uuid4()) + '.sqlite3')
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.close(fd)
        with sqlite3.connect((self.directory / 'state/jobs.sqlite3').as_uri() + '?mode=ro', uri=True) as source, sqlite3.connect(backup) as destination:
            source.backup(destination)
        return str(backup)

    def capture(self, job):
        row, quarantine = self.row_and_quarantine(job)
        bindings = runtime_release_bindings(row)
        units = [self.capture_unit(unit) for unit in ('bitovp-semantic-gateway.service', 'bitovp-llm-' + bindings['profile'] + '.service')]
        capture = {'version': 'bitovp-runtime-release-capture-v1', 'capturedAt': time.time(),
                'operatorUid': os.getuid(), 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                'bindings': bindings, 'quarantineHash': canonical_hash(quarantine), 'units': units}
        self.last_capture_backup = self.backup()
        Store(self.directory / 'state/jobs.sqlite3').retain_runtime_capture(capture)
        return capture

    def stop_owned_units(self, supplied):
        capture = Store(self.directory / 'state/jobs.sqlite3').load_runtime_capture(supplied)
        _, quarantine = self.row_and_quarantine(capture['bindings']['jobId'])
        if canonical_hash(quarantine) != capture['quarantineHash']: raise GatewayError('INVALID_RELEASE_PROOF', 422)
        for before in capture['units']:
            if self.capture_unit(before['unitName']) != before: raise GatewayError('OPERATOR_OWNER_MISMATCH', 422)
            subprocess.run(['systemctl', '--user', 'stop', before['unitName']], capture_output=True, timeout=100, check=True)

    def confirm(self, capture):
        capture = Store(self.directory / 'state/jobs.sqlite3').load_runtime_capture(capture)
        if (not isinstance(capture, dict) or set(capture) != {'version', 'capturedAt', 'operatorUid', 'bootId', 'bindings', 'quarantineHash', 'units'}
                or capture['version'] != 'bitovp-runtime-release-capture-v1' or capture['operatorUid'] != os.getuid()
                or capture['bootId'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip()
                or not isinstance(capture['capturedAt'], (int, float)) or not 0 <= time.time() - capture['capturedAt'] <= 3600):
            raise GatewayError('INVALID_RELEASE_PROOF', 422)
        if not isinstance(capture['bindings'], dict) or not isinstance(capture['bindings'].get('jobId'), str) or not isinstance(capture['units'], list):
            raise GatewayError('INVALID_RELEASE_PROOF', 422)
        row, quarantine = self.row_and_quarantine(capture['bindings']['jobId'])
        if runtime_release_bindings(row) != capture['bindings'] or canonical_hash(quarantine) != capture['quarantineHash']:
            raise GatewayError('INVALID_RELEASE_PROOF', 422)
        # Validate the whole receipt shape before using any caller-provided unit/group/PID.
        tentative = {'version': 'bitovp-runtime-release-v1', 'releaseId': str(uuid.uuid4()), **capture['bindings'],
                     'quarantineHash': capture['quarantineHash'], 'captureHash': canonical_hash(capture), 'confirmedAt': time.time(),
                     'operatorUid': capture['operatorUid'], 'bootId': capture['bootId'],
                     'units': [{**before, 'observedStoppedAt': time.time(), 'activeState': 'inactive', 'mainPid': 0,
                                'cgroupEmpty': True, 'oldPidsGone': True} for before in capture['units']]}
        tentative['confirmedAt'] = time.time()
        from gateway import validate_runtime_release
        validate_runtime_release(tentative, row)
        tentative['units'] = validate_stopped_units(capture, lambda unit: self.checked_unit_state(unit)[0], cgroup_pids, pid_start_ticks, self.unit_hash)
        tentative['confirmedAt'] = time.time()
        backup = self.backup()
        store = Store(self.directory / 'state/jobs.sqlite3')
        result = store.confirm_runtime_release(tentative)
        return {'version': 'bitovp-operator-release-receipt-v1', 'proof': tentative, 'result': result,
                'failedJobUnchanged': store.details(row['id']) == row, 'backupFile': str(backup)}


def private_write(path, value):
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['capture', 'confirm'])
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--job-id')
    parser.add_argument('--capture-file', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.output.is_symlink():
        raise GatewayError('INVALID_RELEASE_PROOF', 422)
    operator = OfflineOperator(args.directory)
    with inference_lease(operator.lab / 'locks/inference.lock'):
        if args.action == 'capture' and args.job_id and args.capture_file is None:
            value = operator.capture(args.job_id)
        elif args.action == 'confirm' and args.capture_file is not None and args.job_id is None:
            path = args.capture_file
            if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077 or path.stat().st_size > 65536:
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            value = operator.confirm(json.loads(path.read_text()))
        else:
            raise GatewayError('INVALID_RELEASE_PROOF', 422)
        private_write(args.output, value)
    print(json.dumps({'version': value['version'], 'output': str(args.output), 'operation': args.action}))


if __name__ == '__main__':
    main()
