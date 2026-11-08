import concurrent.futures
import fcntl
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

from gateway import FixedRuntime, Gateway, GatewayError, GatewayServer, MODEL, MODEL_DIGEST, PORTS, RUNTIME_VERSION, Registry, Store, canonical_hash

ORG = '00000000-0000-4000-8000-000000000001'
OTHER_ORG = '00000000-0000-4000-8000-000000000002'
TOKEN = 'test-token-' + 'x' * 48
SCHEMA = {'type': 'object', 'additionalProperties': False,
          'properties': {'ok': {'type': 'boolean'}}, 'required': ['ok']}
CHOICE_SCHEMA = {'$schema': 'https://json-schema.org/draft/2020-12/schema',
                 'type': 'object', 'additionalProperties': False,
                 'properties': {'planId': {'type': 'string', 'pattern': '^p(0|[1-9][0-9]*)$'},
                                'message': {'type': 'string', 'minLength': 1, 'maxLength': 100},
                                'uncertainty': {'type': 'string', 'maxLength': 160}},
                 'required': ['planId', 'message', 'uncertainty']}


def registry():
    return Registry({'version': 'bitovp-semantic-stages-v1', 'stages': {
        stage: {'promptVersion': 'local-story-v1', 'schemaHash': canonical_hash(SCHEMA),
                'schema': SCHEMA, 'maxOutputTokens': tokens}
        for stage, tokens in [('LOCAL_LEDGER_V1', 1024), ('LOCAL_BLUEPRINT_V1', 1536)]}})


def combined_registry_value(stages=None):
    if stages is None:
        stages = json.loads(json.dumps(registry().stages))
        for name, version in [('LOCAL_CAPTION_JA_V1', 'caption-ja-v1'), ('LOCAL_CAPTION_JA_V2', 'caption-ja-v2'),
                              ('LOCAL_FLOW_CONTEXT_V1', 'local-story-flow-context-v1'), ('LOCAL_FLOW_ROUTE_V1', 'local-story-flow-route-v1')]:
            stages[name] = {'promptVersion': version, 'schemaHash': canonical_hash(SCHEMA),
                            'schema': SCHEMA, 'maxOutputTokens': 1536}
    legacy = {name: value for name, value in stages.items() if not name.startswith('LOCAL_FLOW_')}
    flow = {name: value for name, value in stages.items() if name.startswith('LOCAL_FLOW_')}
    return {'version': 'bitovp-semantic-stages-combined-v1', 'stages': stages,
            'legacyRegistryHash': canonical_hash({'version': 'bitovp-semantic-stages-v1', 'stages': legacy}),
            'flowRegistryHash': canonical_hash({'version': 'local-story-flow-stages-v1', 'stages': flow})}


def planning_registry_value(stages=None):
    if stages is None:
        stages = {name: row for name, row in combined_registry_value()['stages'].items()
                  if not name.startswith('LOCAL_FLOW_')}
        stages['LOCAL_STORY_CHOICE_V1'] = {'promptVersion': 'local-story-choice-v1',
                                         'schemaHash': canonical_hash(CHOICE_SCHEMA),
                                         'schema': CHOICE_SCHEMA, 'maxOutputTokens': 512}
    legacy = {name: row for name, row in stages.items() if name in {
        'LOCAL_LEDGER_V1', 'LOCAL_BLUEPRINT_V1', 'LOCAL_CAPTION_JA_V1', 'LOCAL_CAPTION_JA_V2'}}
    choice = {name: row for name, row in stages.items() if name == 'LOCAL_STORY_CHOICE_V1'}
    return {'version': 'bitovp-semantic-stages-planning-v1', 'stages': stages,
            'legacyRegistryHash': canonical_hash({'version': 'bitovp-semantic-stages-v1', 'stages': legacy}),
            'choiceRegistryHash': canonical_hash({'version': 'local-story-choice-stages-v1', 'stages': choice})}


def request(**changes):
    return {'version': 'bitovp-semantic-job-v1', 'requestKey': str(uuid.uuid4()),
            'organizationId': ORG, 'profile': 'nvidia', 'stage': 'LOCAL_LEDGER_V1',
            'prompt': 'Input evidence only.', 'inputHash': 'a' * 64,
            'promptVersion': 'local-story-v1', 'schemaHash': canonical_hash(SCHEMA), **changes}


def choice_request(**changes):
    return request(**{'stage': 'LOCAL_STORY_CHOICE_V1', 'promptVersion': 'local-story-choice-v1',
                      'schemaHash': canonical_hash(CHOICE_SCHEMA), **changes})


class FakeRuntime:
    def __init__(self):
        self.preexisting = False
        self.invalid_identity = False
        self.calls = []
        self.started = threading.Event()
        self.releasing = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.block = False
        self.cleanup_error = False

    def identity(self, profile):
        self.calls.append(('identity', profile))
        if self.invalid_identity:
            raise GatewayError('NOT_CAPABLE')

    def loaded(self, profile):
        return [{'name': 'someone-elses-model'}] if self.preexisting else []

    def chat(self, profile, payload, control):
        self.calls.append(('chat', profile, payload))
        self.started.set()
        while self.block:
            control.check()
            time.sleep(.005)
        return {'message': {'content': '{"ok": true}', 'thinking': 'hidden reasoning'},
                'done_reason': 'stop', 'prompt_eval_count': 7, 'eval_count': 5,
                'load_duration': 2, 'prompt_eval_duration': 3, 'eval_duration': 4}

    def placement(self, profile):
        return [{'name': 'qwen3.8:27b-q8_0', 'size': 100, 'size_vram': 70, 'context_length': 8192}]

    def unload(self, profile):
        self.calls.append(('unload', profile))
        self.releasing.set()
        self.release.wait(2)
        if self.cleanup_error:
            raise GatewayError('CLEANUP_FAILED')


class PendingLoadRuntime(FixedRuntime):
    """A chat is accepted while /api/ps still hides its backend model load."""
    def __init__(self):
        super().__init__()
        self.calls = []
        self.started = threading.Event()
        self.unloading = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.models = []
        self.chat_error = None

    def request(self, profile, route, payload=None, control=None):
        self.calls.append((profile, route, payload))
        if route == '/api/version':
            return {'version': RUNTIME_VERSION}
        if route == '/api/tags':
            return {'models': [{'name': MODEL, 'digest': MODEL_DIGEST}]}
        if route == '/api/ps':
            return {'models': self.models if profile == 'nvidia' else []}
        if route == '/api/chat':
            self.started.set()
            if self.chat_error:
                raise GatewayError(self.chat_error)
            while True:
                control.check()
                time.sleep(.005)
        if route == '/api/generate':
            self.unloading.set()
            self.release.wait(2)
            return {'model': MODEL, 'done': True, 'done_reason': 'unload'}
        raise AssertionError('Unexpected fake API operation')


class GatewayTests(unittest.TestCase):
    def release_fixture(self):
        job = self.submit(request(profile='amd'))
        owner = str(uuid.uuid4())
        self.assertTrue(self.gateway.store.claim(job, owner))
        self.gateway.store.finish(job, owner, 'FAILED', error_code='RUNTIME_STOP_UNCONFIRMED', cleanup_confirmed=False)
        self.gateway.store.quarantine('amd', 'RUNTIME_STOP_UNCONFIRMED')
        row = self.gateway.store.details(job)
        with self.gateway.store.connection() as db:
            quarantine = dict(db.execute('SELECT * FROM runtime_quarantines WHERE profile=?', ('amd',)).fetchone())
        now = time.time()
        units = []
        for index, unit in enumerate(('bitovp-semantic-gateway.service', 'bitovp-llm-amd.service')):
            units.append({'unitName': unit, 'cgroup': f'/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/app.slice/{unit}',
                          'unitFileHash': 'f' * 64, 'effectiveConfigHash': 'e' * 64,
                          'mainProcessExeHash': 'a' * 64, 'mainProcessArgvHash': 'b' * 64, 'beforeMainPid': 10000 + index,
                          'oldProcesses': [{'pid': 10000 + index, 'startTicks': 12345 + index}],
                          'observedStoppedAt': now, 'activeState': 'inactive', 'mainPid': 0,
                          'cgroupEmpty': True, 'oldPidsGone': True})
        proof = {'version': 'bitovp-runtime-release-v1', 'releaseId': str(uuid.uuid4()), 'jobId': job,
                 'organizationId': ORG, 'profile': 'amd', 'requestHash': row['request_hash'],
                 'payloadHash': hashlib.sha256(row['payload'].encode()).hexdigest(), 'terminalRowHash': canonical_hash(row),
                 'errorCode': row['error_code'], 'quarantineHash': canonical_hash(quarantine),
                 'confirmedAt': now, 'operatorUid': os.getuid(), 'bootId': str(uuid.uuid4()), 'units': units}
        stop_keys = {'observedStoppedAt', 'activeState', 'mainPid', 'cgroupEmpty', 'oldPidsGone'}
        capture = {'version': 'bitovp-runtime-release-capture-v1', 'capturedAt': now, 'operatorUid': os.getuid(),
                   'bootId': proof['bootId'], 'bindings': {key: proof[key] for key in ('jobId', 'organizationId', 'profile', 'requestHash', 'payloadHash', 'terminalRowHash', 'errorCode')},
                   'quarantineHash': proof['quarantineHash'], 'units': [{key: value for key, value in unit.items() if key not in stop_keys} for unit in units]}
        self.gateway.store.retain_runtime_capture(capture)
        proof['captureHash'] = canonical_hash(capture)
        return job, row, proof

    def test_operator_release_persists_across_recovery_without_rewriting_failed_history(self):
        job, original, proof = self.release_fixture()
        result = self.gateway.store.confirm_runtime_release(proof)
        self.assertTrue(result['quarantineCleared'])
        self.assertEqual(self.gateway.store.details(job), original)
        for _ in range(2):
            recovered = Store(self.gateway.store.path)
            recovered.recover()
            self.assertEqual(recovered.quarantined_profiles(), [])
            self.assertEqual(recovered.details(job), original)
        self.assertEqual(self.gateway.store.get(job, ORG)['cleanupConfirmed'], False)
        self.assertEqual(self.call('POST', '/v1/runtime-releases', proof)[0], 404)

    def test_operator_release_rejects_foreign_or_incomplete_stop_proofs(self):
        job, original, proof = self.release_fixture()
        for changes in [{'profile': 'nvidia'}, {'organizationId': OTHER_ORG}, {'jobId': str(uuid.uuid4())},
                        {'payloadHash': 'b' * 64}, {'terminalRowHash': 'b' * 64}, {'quarantineHash': 'b' * 64},
                        {'captureHash': 'b' * 64},
                        {'errorCode': 'CLEANUP_FAILED'}, {'units': []}]:
            with self.subTest(changes=changes), self.assertRaises(GatewayError):
                self.gateway.store.confirm_runtime_release({**proof, **changes})
        bad = json.loads(json.dumps(proof))
        bad['units'][1]['oldPidsGone'] = False
        with self.assertRaises(GatewayError): self.gateway.store.confirm_runtime_release(bad)
        self.assertEqual(self.gateway.store.details(job), original)
        self.assertEqual(self.gateway.store.quarantined_profiles(), ['amd'])

    def test_release_rows_are_append_only_and_tampered_failure_is_requarantined(self):
        import sqlite3
        job, original, proof = self.release_fixture()
        self.gateway.store.confirm_runtime_release(proof)
        with self.gateway.store.connection() as db:
            for sql in ['UPDATE runtime_release_confirmations SET proof_json=proof_json', 'DELETE FROM runtime_release_confirmations',
                        'UPDATE runtime_release_captures SET capture_json=capture_json', 'DELETE FROM runtime_release_captures']:
                with self.assertRaises(sqlite3.IntegrityError): db.execute(sql)
            db.execute('UPDATE jobs SET payload=payload || ? WHERE id=?', (' ', job))
        self.gateway.store.recover()
        self.assertEqual(self.gateway.store.quarantined_profiles(), ['amd'])
        self.assertNotEqual(self.gateway.store.details(job)['payload'], original['payload'])

    def test_recovery_does_not_accept_malformed_inserted_proof_or_clear_other_reason(self):
        job, original, proof = self.release_fixture()
        self.gateway.store.confirm_runtime_release(proof)
        self.gateway.store.quarantine('nvidia', 'CLEANUP_FAILED')
        self.gateway.store.quarantine('amd', 'DIFFERENT_FENCE')
        self.gateway.store.recover()
        self.assertEqual(self.gateway.store.quarantined_profiles(), ['amd', 'nvidia'])
        self.assertEqual(self.gateway.store.details(job), original)
        isolated = Store(self.root / 'malformed.sqlite3')
        with self.gateway.store.connection() as db:
            saved = dict(db.execute('SELECT * FROM runtime_release_confirmations').fetchone())
            saved_capture = dict(db.execute('SELECT * FROM runtime_release_captures').fetchone())
        malformed = json.loads(saved['proof_json']); malformed['units'][0]['cgroupEmpty'] = False
        saved['proof_json'] = json.dumps(malformed); saved['proof_hash'] = canonical_hash(malformed)
        with isolated.connection() as db:
            db.execute('INSERT INTO jobs('+','.join(original)+') VALUES('+','.join('?' for _ in original)+')', tuple(original.values()))
            db.execute('INSERT INTO runtime_release_captures('+','.join(saved_capture)+') VALUES('+','.join('?' for _ in saved_capture)+')', tuple(saved_capture.values()))
            db.execute('INSERT INTO runtime_release_confirmations('+','.join(saved)+') VALUES('+','.join('?' for _ in saved)+')', tuple(saved.values()))
        isolated.recover()
        self.assertEqual(isolated.quarantined_profiles(), ['amd'])
        self.assertEqual(self.gateway.store.get(job, ORG)['cleanupConfirmed'], False)

    def test_release_does_not_clear_an_unproven_failure_or_other_profile(self):
        job, original, proof = self.release_fixture()
        body = request(profile='amd')
        other = {**original, 'id': str(uuid.uuid4()), 'request_key': body['requestKey'],
                 'request_hash': canonical_hash(body), 'payload': json.dumps(body, sort_keys=True, separators=(',', ':')),
                 'error_code': 'CLEANUP_FAILED'}
        with self.gateway.store.connection() as db:
            db.execute('INSERT INTO jobs('+','.join(other)+') VALUES('+','.join('?' for _ in other)+')', tuple(other.values()))
        self.gateway.store.quarantine('nvidia', 'CLEANUP_FAILED')
        self.assertFalse(self.gateway.store.confirm_runtime_release(proof)['quarantineCleared'])
        self.assertEqual(self.gateway.store.quarantined_profiles(), ['amd', 'nvidia'])
        self.assertEqual(self.gateway.store.details(job), original)

    def test_offline_stop_verifier_reads_os_state_and_rejects_surviving_pid_or_cgroup(self):
        from record_runtime_release import validate_stopped_units
        _, original, proof = self.release_fixture()
        stop_keys = {'observedStoppedAt', 'activeState', 'mainPid', 'cgroupEmpty', 'oldPidsGone'}
        capture = {'units': [{k: v for k, v in unit.items() if k not in stop_keys} for unit in proof['units']]}
        inactive = lambda _: {'ActiveState': 'inactive', 'MainPID': '0', 'effectiveConfigHash': 'e' * 64}
        results = validate_stopped_units(capture, inactive, lambda _: [], lambda _: None, lambda _: 'f' * 64)
        self.assertTrue(all(row['cgroupEmpty'] and row['oldPidsGone'] for row in results))
        for group, pid, state in [(lambda _: [999], lambda _: None, inactive),
                                  (lambda _: [], lambda _: 12345, inactive),
                                  (lambda _: [], lambda _: None, lambda _: {'ActiveState': 'active', 'MainPID': '999'})]:
            with self.assertRaises(GatewayError):
                validate_stopped_units(capture, state, group, pid, lambda _: 'f' * 64)

    def test_imported_capture_cannot_change_retained_survivor_start_identity(self):
        import sqlite3
        from record_runtime_release import OfflineOperator
        _, original, proof = self.release_fixture()
        stop_keys = {'observedStoppedAt', 'activeState', 'mainPid', 'cgroupEmpty', 'oldPidsGone'}
        capture = {'version': 'bitovp-runtime-release-capture-v1', 'capturedAt': time.time(), 'operatorUid': os.getuid(),
                   'bootId': proof['bootId'], 'bindings': {k: proof[k] for k in ('jobId', 'organizationId', 'profile', 'requestHash', 'payloadHash', 'terminalRowHash', 'errorCode')},
                   'quarantineHash': proof['quarantineHash'], 'units': [{k: v for k, v in unit.items() if k not in stop_keys} for unit in proof['units']]}
        capture['units'][1]['oldProcesses'].append({'pid': 20000, 'startTicks': 55555})
        directory = self.root / 'operator'; (directory / 'state').mkdir(parents=True)
        database = directory / 'state/jobs.sqlite3'
        with sqlite3.connect(self.gateway.store.path) as source, sqlite3.connect(database) as destination:
            source.backup(destination)
        # A retained OS capture is trusted independently of the imported JSON file.
        with sqlite3.connect(database) as db:
            db.execute('CREATE TABLE IF NOT EXISTS runtime_release_captures (capture_hash TEXT PRIMARY KEY,capture_nonce TEXT UNIQUE NOT NULL,job_id TEXT NOT NULL,profile TEXT NOT NULL,request_hash TEXT NOT NULL,payload_hash TEXT NOT NULL,terminal_row_hash TEXT NOT NULL,captured_at REAL NOT NULL,capture_json TEXT NOT NULL)')
            db.execute('INSERT INTO runtime_release_captures VALUES(?,?,?,?,?,?,?,?,?)',
                       (canonical_hash(capture), str(uuid.uuid4()), original['id'], 'amd', original['request_hash'], capture['bindings']['payloadHash'], capture['bindings']['terminalRowHash'], capture['capturedAt'], json.dumps(capture)))
        tampered = json.loads(json.dumps(capture)); tampered['units'][1]['oldProcesses'][-1]['startTicks'] += 1
        operator = OfflineOperator.__new__(OfflineOperator); operator.directory = directory
        operator.unit_state = lambda _: {'ActiveState': 'inactive', 'MainPID': '0'}
        operator.unit_hash = lambda _: 'f' * 64
        original_read = Path.read_text
        def read(path, *args, **kwargs):
            return capture['bootId'] if str(path) == '/proc/sys/kernel/random/boot_id' else original_read(path, *args, **kwargs)
        with patch('record_runtime_release.Path.read_text', read), patch('record_runtime_release.cgroup_pids', return_value=[]), patch('record_runtime_release.pid_start_ticks', side_effect=lambda pid: 55555 if pid == 20000 else None):
            with self.assertRaises(GatewayError): operator.confirm(tampered)

    def test_capture_rejects_effective_drop_in_before_authorizing_any_stop(self):
        import sqlite3
        from record_runtime_release import OfflineOperator
        _, original, proof = self.release_fixture()
        home = (self.root / 'fake-home').resolve(); lab = home / '.local/share/bitovp-llm-lab'; directory = lab / 'gateway'
        (directory / 'state').mkdir(parents=True); (home / '.config/systemd/user').mkdir(parents=True)
        (lab / 'lab-identity.json').write_text(json.dumps({'owner': 'bitovp-dual-gpu-llm-20261104'}))
        (directory / 'owner.json').write_text(json.dumps({'owner': 'bitovp-local-story-integration-20261104'}))
        for unit in ('bitovp-semantic-gateway.service', 'bitovp-llm-amd.service'):
            argv = '/usr/bin/python3 '+str(directory/'gateway.py')+' --directory '+str(directory) if unit == 'bitovp-semantic-gateway.service' else str(lab/'runtime/0.40.14/bin/ollama')+' serve'
            (home / '.config/systemd/user' / unit).write_text('ExecStart='+argv+'\n')
        with sqlite3.connect(self.gateway.store.path) as source, sqlite3.connect(directory/'state/jobs.sqlite3') as destination: source.backup(destination)
        original_read = Path.read_text
        def read(path, *args, **kwargs):
            return proof['bootId'] if str(path) == '/proc/sys/kernel/random/boot_id' else original_read(path, *args, **kwargs)
        with patch('record_runtime_release.Path.home', return_value=home), patch('record_runtime_release.Path.read_text', read):
            operator = OfflineOperator(directory)
            with self.gateway.store.connection() as db:
                quarantine = dict(db.execute('SELECT * FROM runtime_quarantines WHERE profile=?', ('amd',)).fetchone())
            operator.row_and_quarantine = lambda _: (original, quarantine)
            operator.unit_state = lambda unit: {'ActiveState': 'active', 'MainPID': '10000', 'ControlGroup': f'/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/app.slice/{unit}',
                'KillMode': 'control-group', 'LoadState': 'loaded', 'Type': 'simple', 'NeedDaemonReload': 'no',
                'FragmentPath': str(home/'.config/systemd/user'/unit), 'DropInPaths': '/run/user/override.conf',
                'ExecStart': '{ path=/bin/sleep ; argv[]=/bin/sleep 1000 ; ignore_errors=no ; }'}
            with patch('record_runtime_release.cgroup_pids', return_value=[10000]), patch('record_runtime_release.pid_start_ticks', return_value=12345):
                with self.assertRaises(GatewayError): operator.capture(proof['jobId'])

    def test_changed_effective_identity_after_capture_cannot_stop_a_unit(self):
        import sqlite3
        from record_runtime_release import OfflineOperator
        _, original, _ = self.release_fixture()
        with self.gateway.store.connection() as db:
            capture = json.loads(db.execute('SELECT capture_json FROM runtime_release_captures').fetchone()[0])
            quarantine = dict(db.execute('SELECT * FROM runtime_quarantines WHERE profile=?', ('amd',)).fetchone())
        directory = self.root / 'stop-operator'; (directory / 'state').mkdir(parents=True)
        with sqlite3.connect(self.gateway.store.path) as source, sqlite3.connect(directory/'state/jobs.sqlite3') as destination: source.backup(destination)
        operator = OfflineOperator.__new__(OfflineOperator); operator.directory = directory
        operator.row_and_quarantine = lambda _: (original, quarantine)
        operator.capture_unit = lambda _: {**capture['units'][0], 'effectiveConfigHash': 'c' * 64}
        with patch('record_runtime_release.subprocess.run') as stop:
            with self.assertRaises(GatewayError): operator.stop_owned_units(capture)
            stop.assert_not_called()

    def test_effective_configuration_and_main_process_must_match_owned_command(self):
        from record_runtime_release import effective_unit_configuration, main_process_identity
        lab = (self.root / 'lab').resolve(); directory = lab/'gateway'; unit_path = self.root/'bitovp-llm-amd.service'
        binary = lab/'runtime/0.40.14/bin/ollama'; binary.parent.mkdir(parents=True); binary.write_bytes(b'synthetic executable')
        text = 'ExecStart='+str(binary)+' serve\n'
        state = {'LoadState':'loaded','Type':'simple','KillMode':'control-group','NeedDaemonReload':'no','DropInPaths':'',
                 'FragmentPath':str(unit_path.resolve()),'ExecStart':'{ path='+str(binary)+' ; argv[]='+str(binary)+' serve ; ignore_errors=no ; }'}
        configuration = effective_unit_configuration(lab,directory,unit_path,text,state)
        for change in [{'NeedDaemonReload':'yes'}, {'DropInPaths':'/override'}, {'FragmentPath':'/unrelated.service'},
                       {'ExecStart':'{ path=/bin/sleep ; argv[]=/bin/sleep 1000 ; ignore_errors=no ; }'}]:
            with self.assertRaises(GatewayError): effective_unit_configuration(lab,directory,unit_path,text,{**state,**change})
        process = self.root/'proc/999'; process.mkdir(parents=True); (process/'exe').symlink_to(binary)
        raw = (str(binary)+'\0serve\0').encode(); (process/'cmdline').write_bytes(raw)
        identity = main_process_identity(999,configuration,self.root/'proc')
        self.assertEqual(identity['mainProcessArgvHash'],hashlib.sha256(raw).hexdigest())
        (process/'cmdline').write_bytes(b'/bin/sleep\x001000\x00')
        with self.assertRaises(GatewayError): main_process_identity(999,configuration,self.root/'proc')
    def test_initial_provisioning_accepts_v2_registry_but_keeps_both_story_schemas_required(self):
        from provision_gateway import validate_initial_registry
        value = {'version': 'bitovp-semantic-stages-v1', 'stages': dict(registry().stages)}
        validate_initial_registry(value)
        for stage, version in [('LOCAL_CAPTION_JA_V1', 'caption-ja-v1'), ('LOCAL_CAPTION_JA_V2', 'caption-ja-v2')]:
            value['stages'][stage] = {'promptVersion': version, 'schemaHash': canonical_hash(SCHEMA), 'schema': SCHEMA, 'maxOutputTokens': 1536}
        validate_initial_registry(value)
        del value['stages']['LOCAL_LEDGER_V1']
        with self.assertRaises(ValueError):
            validate_initial_registry(value)

    def test_japanese_stage_is_optional_and_has_an_independent_prompt_identity(self):
        legacy = registry()
        self.assertEqual(set(legacy.stages), {'LOCAL_LEDGER_V1', 'LOCAL_BLUEPRINT_V1'})
        stages = dict(legacy.stages)
        stages['LOCAL_CAPTION_JA_V1'] = {'promptVersion': 'caption-ja-v1', 'schemaHash': canonical_hash(SCHEMA),
                                         'schema': SCHEMA, 'maxOutputTokens': 1536}
        expanded = Registry({'version': 'bitovp-semantic-stages-v1', 'stages': stages})
        body = request(stage='LOCAL_CAPTION_JA_V1', promptVersion='caption-ja-v1')
        self.assertEqual(expanded.validate(body, ORG)['maxOutputTokens'], 1536)
        with self.assertRaises(GatewayError):
            legacy.validate(body, ORG)
        with self.assertRaises(GatewayError):
            expanded.validate({**body, 'promptVersion': 'local-story-v1'}, ORG)
        stages['LOCAL_CAPTION_JA_V2'] = {**stages['LOCAL_CAPTION_JA_V1'], 'promptVersion': 'caption-ja-v2'}
        contextual = Registry({'version': 'bitovp-semantic-stages-v1', 'stages': stages})
        body_v2 = request(stage='LOCAL_CAPTION_JA_V2', promptVersion='caption-ja-v2', prompt='x' * 5632)
        self.assertEqual(contextual.validate(body_v2, ORG)['maxOutputTokens'], 1536)
        with self.assertRaises(GatewayError):
            contextual.validate({**body_v2, 'promptVersion': 'caption-ja-v1'}, ORG)
        with self.assertRaises(GatewayError):
            contextual.validate({**body_v2, 'prompt': 'x' * 5633}, ORG)

    def test_combined_flow_registry_requires_exact_six_and_both_component_hashes(self):
        from provision_gateway import validate_initial_registry
        value = combined_registry_value()
        accepted = Registry(value)
        self.assertEqual(len(accepted.stages), 6)
        validate_initial_registry(value)
        legacy = {'version': 'bitovp-semantic-stages-v1', 'stages': dict(accepted.stages)}
        with self.assertRaises(ValueError): Registry(legacy)
        for name in ['LOCAL_LEDGER_V1', 'LOCAL_BLUEPRINT_V1', 'LOCAL_CAPTION_JA_V2', 'LOCAL_FLOW_ROUTE_V1']:
            stages = dict(value['stages']); del stages[name]
            with self.subTest(missing=name), self.assertRaises(ValueError): Registry(combined_registry_value(stages))
        stages = {**value['stages'], 'LOCAL_FLOW_UNKNOWN_V1': value['stages']['LOCAL_FLOW_ROUTE_V1']}
        with self.assertRaises(ValueError): Registry(combined_registry_value(stages))
        for field in ['legacyRegistryHash', 'flowRegistryHash']:
            with self.subTest(field=field), self.assertRaises(ValueError): Registry({**value, field: 'f' * 64})
        with self.assertRaises(ValueError): Registry({**value, 'extra': True})

    def test_combined_flow_entries_keep_prompt_token_schema_and_external_ref_guards(self):
        for stage, version in [('LOCAL_FLOW_CONTEXT_V1', 'local-story-flow-context-v1'), ('LOCAL_FLOW_ROUTE_V1', 'local-story-flow-route-v1')]:
            mutations = [
                {'promptVersion': 'local-story-v1'}, {'promptVersion': 'caption-ja-v2'},
                {'maxOutputTokens': True}, {'maxOutputTokens': 1537},
                {'schemaHash': 'f' * 64}, {'extra': True},
                {'schema': {'$ref': 'https://fixture.invalid/schema'}, 'schemaHash': canonical_hash({'$ref': 'https://fixture.invalid/schema'})},
                {'schema': {'$dynamicRef': 'file:///not-read'}, 'schemaHash': canonical_hash({'$dynamicRef': 'file:///not-read'})},
            ]
            for change in mutations:
                value = combined_registry_value()
                value['stages'][stage] = {**value['stages'][stage], **change}
                # Re-seal component hashes so the entry-specific guard must reject it.
                with self.subTest(stage=stage, fields=list(change)), self.assertRaises(ValueError):
                    Registry(combined_registry_value(value['stages']))
            valid = Registry(combined_registry_value())
            body = request(stage=stage, promptVersion=version, prompt='あ' * 1877 + 'x')
            self.assertEqual(len(body['prompt'].encode()), 5632)
            self.assertEqual(valid.validate(body, ORG)['maxOutputTokens'], 1536)
            for change in [{'prompt': body['prompt'] + 'x'}, {'promptVersion': 'local-story-v1'}, {'extra': True}]:
                with self.subTest(stage=stage, fields=list(change)), self.assertRaises(GatewayError):
                    valid.validate({**body, **change}, ORG)

    def test_flow_stages_share_the_owned_runtime_receipt_and_cleanup_on_both_profiles(self):
        self.gateway.registry = Registry(combined_registry_value())
        for stage, version in [('LOCAL_FLOW_CONTEXT_V1', 'local-story-flow-context-v1'), ('LOCAL_FLOW_ROUTE_V1', 'local-story-flow-route-v1')]:
            for profile in ['amd', 'nvidia']:
                with self.subTest(stage=stage, profile=profile):
                    body = request(stage=stage, promptVersion=version, profile=profile)
                    job = self.submit(body)
                    self.assertTrue(self.gateway.run_one())
                    value = self.call('GET', '/v1/semantic-jobs/' + job)[1]
                    self.assertEqual((value['stage'], value['state'], value['cleanupConfirmed']), (stage, 'SUCCEEDED', True))
                    proof = value['result']['receipt']
                    self.assertEqual((proof['profile'], proof['promptVersion'], proof['maxOutputTokens']), (profile, version, 1536))
                    self.assertEqual((proof['context'], proof['thinking'], proof['schemaVerified']), (8192, False, False))
                    self.assertEqual(proof['requestHash'], canonical_hash(body))
                    self.assertEqual(proof['promptHash'], hashlib.sha256(body['prompt'].encode()).hexdigest())
                    self.assertEqual(self.runtime.calls[-1], ('unload', profile))
                    chats = [c for c in self.runtime.calls if c[0] == 'chat']
                    self.assertEqual(chats[-1][2]['options']['num_predict'], 1536)
                    self.assertEqual(chats[-1][2]['format'], SCHEMA)

    def test_planning_choice_registry_adds_five_without_changing_legacy_or_flow(self):
        from provision_gateway import validate_initial_registry
        value = planning_registry_value()
        expanded = Registry(value)
        self.assertEqual(len(expanded.stages), 5)
        validate_initial_registry(value)
        legacy = {name: row for name, row in combined_registry_value()['stages'].items()
                  if not name.startswith('LOCAL_FLOW_')}
        self.assertEqual({name: row for name, row in expanded.stages.items()
                          if name != 'LOCAL_STORY_CHOICE_V1'}, legacy)
        self.assertEqual(Registry({'version': 'bitovp-semantic-stages-v1', 'stages': legacy}).stages, legacy)
        self.assertEqual(len(Registry(combined_registry_value()).stages), 6)
        self.assertEqual(canonical_hash(CHOICE_SCHEMA),
                         '99cb2b5b802ea39d898b2a601f511c521f2c0c0e2ca07e8e94cf4c356d0bf7f6')
        self.gateway.registry = expanded
        health = self.call('GET', '/health')[1]
        self.assertEqual({row['stage'] for row in health['stages']}, set(expanded.stages))
        choice = next(row for row in health['stages'] if row['stage'] == 'LOCAL_STORY_CHOICE_V1')
        self.assertEqual((choice['promptVersion'], choice['schemaHash'], choice['maxOutputTokens']),
                         ('local-story-choice-v1', canonical_hash(CHOICE_SCHEMA), 512))
        self.assertEqual((health['model'], health['modelDigest'], health['runtimeVersion']),
                         (MODEL, MODEL_DIGEST, RUNTIME_VERSION))
        self.assertEqual(self.runtime.calls, [])

    def test_planning_choice_registry_rejects_unknown_members_versions_and_hashes(self):
        value = planning_registry_value()
        for version in ['bitovp-semantic-stages-v1', 'bitovp-semantic-stages-combined-v1',
                        'local-story-choice-stages-v1', 'bitovp-semantic-stages-planning-v2']:
            with self.subTest(version=version), self.assertRaises(ValueError):
                Registry({**value, 'version': version})
        for name in value['stages']:
            stages = dict(value['stages']); del stages[name]
            with self.subTest(missing=name), self.assertRaises(ValueError):
                Registry(planning_registry_value(stages))
        for stage in ['LOCAL_STORY_CHOICE_V2', 'LOCAL_FLOW_CONTEXT_V1']:
            with self.subTest(extra=stage), self.assertRaises(ValueError):
                Registry(planning_registry_value({**value['stages'], stage: value['stages']['LOCAL_STORY_CHOICE_V1']}))
        for field in ['legacyRegistryHash', 'choiceRegistryHash']:
            with self.subTest(field=field), self.assertRaises(ValueError):
                Registry({**value, field: 'f' * 64})
        with self.assertRaises(ValueError): Registry({**value, 'extra': True})

    def test_choice_entry_keeps_prompt_schema_ref_and_exact_output_guards(self):
        mutations = [{'promptVersion': 'local-story-v1'}, {'promptVersion': 'local-story-flow-route-v1'},
                     {'maxOutputTokens': True}, {'maxOutputTokens': 0},
                     {'maxOutputTokens': 511}, {'maxOutputTokens': 513},
                     {'schemaHash': 'f' * 64}, {'extra': True},
                     {'schema': {'$ref': 'https://fixture.invalid/schema'},
                      'schemaHash': canonical_hash({'$ref': 'https://fixture.invalid/schema'})},
                     {'schema': {'$dynamicRef': 'file:///not-read'},
                      'schemaHash': canonical_hash({'$dynamicRef': 'file:///not-read'})}]
        for change in mutations:
            stages = planning_registry_value()['stages']
            stages['LOCAL_STORY_CHOICE_V1'] = {**stages['LOCAL_STORY_CHOICE_V1'], **change}
            with self.subTest(fields=list(change)), self.assertRaises(ValueError):
                Registry(planning_registry_value(stages))

    def test_choice_request_reserves_6656_utf8_bytes_without_changing_other_caps(self):
        accepted = Registry(planning_registry_value())
        body = choice_request(prompt='あ' * 2218 + 'xx')
        self.assertEqual(len(body['prompt'].encode()), 6656)
        self.assertEqual(accepted.validate(body, ORG)['maxOutputTokens'], 512)
        for changes in [{'prompt': body['prompt'] + 'x'}, {'promptVersion': 'local-story-v1'},
                        {'schemaHash': 'f' * 64}, {'stage': 'LOCAL_STORY_CHOICE_V2'},
                        {'profile': 'cpu'}, {'maxOutputTokens': 512}]:
            with self.subTest(fields=list(changes)), self.assertRaises(GatewayError):
                accepted.validate({**body, **changes}, ORG)
        for stage, cap in [('LOCAL_LEDGER_V1', 6144), ('LOCAL_BLUEPRINT_V1', 5632)]:
            self.assertGreater(accepted.validate(request(stage=stage, prompt='x' * cap), ORG)['maxOutputTokens'], 0)
            with self.assertRaises(GatewayError):
                accepted.validate(request(stage=stage, prompt='x' * (cap + 1)), ORG)

    def test_choice_receipt_and_owned_cleanup_on_both_profiles(self):
        self.gateway.registry = Registry(planning_registry_value())
        sample = {'planId': 'p0', 'message': 'Select this prepared plan.', 'uncertainty': ''}
        original_chat = self.runtime.chat
        def chat(profile, payload, control):
            value = original_chat(profile, payload, control)
            value['message']['content'] = json.dumps(sample)
            return value
        with patch.object(self.runtime, 'chat', side_effect=chat):
            for profile in ['amd', 'nvidia']:
                with self.subTest(profile=profile):
                    body = choice_request(profile=profile)
                    job = self.submit(body)
                    self.assertTrue(self.gateway.run_one())
                    value = self.call('GET', '/v1/semantic-jobs/' + job)[1]
                    self.assertEqual((value['stage'], value['state'], value['cleanupConfirmed']),
                                     ('LOCAL_STORY_CHOICE_V1', 'SUCCEEDED', True))
                    self.assertEqual(json.loads(value['result']['content']), sample)
                    proof = value['result']['receipt']
                    self.assertEqual((proof['profile'], proof['promptVersion'], proof['maxOutputTokens']),
                                     (profile, 'local-story-choice-v1', 512))
                    self.assertEqual((proof['model'], proof['modelDigest'], proof['runtimeVersion']),
                                     (MODEL, MODEL_DIGEST, RUNTIME_VERSION))
                    self.assertEqual((proof['context'], proof['thinking'], proof['schemaVerified']), (8192, False, False))
                    self.assertEqual(proof['requestHash'], canonical_hash(body))
                    self.assertEqual(proof['schemaHash'], canonical_hash(CHOICE_SCHEMA))
                    self.assertEqual(self.runtime.calls[-1], ('unload', profile))
                    payload = [c[2] for c in self.runtime.calls if c[0] == 'chat'][-1]
                    self.assertEqual((payload['options']['num_ctx'], payload['options']['num_predict']), (8192, 512))
                    self.assertEqual(payload['format'], CHOICE_SCHEMA)

    def test_choice_auth_tenant_and_idempotency_use_existing_boundaries(self):
        self.gateway.registry = Registry(planning_registry_value())
        body = choice_request()
        self.assertEqual(self.call('POST', '/v1/semantic-jobs', body, {})[0], 401)
        self.assertEqual(self.call('POST', '/v1/semantic-jobs', choice_request(organizationId=OTHER_ORG))[0], 403)
        self.assertIsNone(self.gateway.store.next_queued())
        first, row = self.call('POST', '/v1/semantic-jobs', body)
        again, duplicate = self.call('POST', '/v1/semantic-jobs', body)
        self.assertEqual((first, again, row['id']), (202, 200, duplicate['id']))
        self.assertEqual(self.call('POST', '/v1/semantic-jobs', {**body, 'prompt': 'changed'})[0], 409)
        foreign, _ = self.gateway.store.submit(choice_request(organizationId=OTHER_ORG))
        self.assertEqual(self.call('GET', '/v1/semantic-jobs/' + foreign['id'])[0], 404)
        self.assertEqual(self.call('POST', '/v1/semantic-jobs/' + foreign['id'] + '/cancel', {})[0], 404)
        self.assertEqual(self.gateway.store.get(foreign['id'], OTHER_ORG)['state'], 'QUEUED')

    def test_choice_cleanup_failure_preserves_failure_and_quarantine(self):
        self.gateway.registry = Registry(planning_registry_value())
        self.runtime.cleanup_error = True
        job = self.submit(choice_request())
        self.assertTrue(self.gateway.run_one())
        value = self.call('GET', '/v1/semantic-jobs/' + job)[1]
        self.assertEqual((value['state'], value['errorCode'], value['cleanupConfirmed']), ('FAILED', 'CLEANUP_FAILED', False))
        self.assertEqual(self.gateway.store.quarantined_profiles(), ['nvidia'])

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.runtime = FakeRuntime()
        self.gateway = Gateway(self.root, ORG, hashlib.sha256(TOKEN.encode()).hexdigest(),
                               registry(), self.runtime)
        self.headers = {'Authorization': 'Bearer ' + TOKEN}

    def tearDown(self):
        self.directory.cleanup()

    def call(self, method, path, body=None, headers=None):
        return self.gateway.route(method, path, self.headers if headers is None else headers, body)

    def submit(self, body=None):
        status, value = self.call('POST', '/v1/semantic-jobs', body or request())
        self.assertEqual(status, 202)
        return value['id']

    def test_authentication_and_tenant_bind_before_any_job_creation(self):
        self.assertEqual(self.call('POST', '/v1/semantic-jobs', request(), {})[0], 401)
        self.assertEqual(self.call('POST', '/v1/semantic-jobs', request(), {'Authorization': 'Bearer ' + 'wrong' * 12})[0], 401)
        status, body = self.call('POST', '/v1/semantic-jobs', request(organizationId=OTHER_ORG))
        self.assertEqual((status, body['error']['code']), (403, 'TENANT_FORBIDDEN'))
        self.assertIsNone(self.gateway.store.next_queued())
        self.assertEqual(self.runtime.calls, [])

    def test_readiness_requires_auth_and_only_fixed_profiles_without_queries(self):
        self.gateway.runtime = FixedRuntime()
        with patch.object(self.gateway.runtime, 'request') as runtime_request:
            self.assertEqual(self.call('GET', '/readiness/nvidia', headers={})[0], 401)
            for path in ['/readiness/cpu', '/readiness/11434', '/readiness/nvidia?host=other', '/readiness']:
                self.assertEqual(self.call('GET', path)[0], 404)
            self.assertEqual(self.call('POST', '/readiness/nvidia', {})[0], 404)
            runtime_request.assert_not_called()

    def test_readiness_gets_metadata_only_and_preserves_static_health(self):
        self.gateway.runtime = FixedRuntime()
        before_health = self.call('GET', '/health')
        for profile in PORTS:
            with patch.object(self.gateway.runtime, 'request', side_effect=[
                    {'version': RUNTIME_VERSION}, {'models': [{'name': MODEL, 'digest': MODEL_DIGEST}]}]) as runtime_request:
                self.assertEqual(self.call('GET', '/readiness/' + profile), (200, {
                    'version': 'bitovp-semantic-readiness-v1', 'profile': profile,
                    'scope': 'METADATA_ONLY', 'ready': True, 'code': 'READY'}))
                self.assertEqual(runtime_request.call_args_list, [
                    unittest.mock.call(profile, '/api/version'), unittest.mock.call(profile, '/api/tags')])
        self.assertEqual(self.call('GET', '/health'), before_health)
        self.assertIsNone(self.gateway.store.next_queued())

    def test_readiness_reports_mismatch_and_transport_failures_without_raw_details(self):
        self.gateway.runtime = FixedRuntime()
        cases = [
            ([{'version': 'future'}], 'RUNTIME_VERSION_MISMATCH'),
            ([{'version': RUNTIME_VERSION}, {'models': []}], 'MODEL_MISMATCH'),
            ([{'version': RUNTIME_VERSION}, {'models': [{'name': MODEL, 'digest': 'b' * 64}]}], 'MODEL_MISMATCH'),
            ([{'version': RUNTIME_VERSION}, {'models': [{'name': 'other', 'digest': MODEL_DIGEST}]}], 'MODEL_MISMATCH'),
            ([{'version': None}], 'RUNTIME_UNAVAILABLE'),
            ([{'version': RUNTIME_VERSION}, {'models': 'private malformed body'}], 'RUNTIME_UNAVAILABLE'),
            ([{'version': RUNTIME_VERSION}, {'models': [None]}], 'RUNTIME_UNAVAILABLE'),
            ([OSError('SYNTHETIC_PRIVATE_HOST_AND_BODY')], 'RUNTIME_UNAVAILABLE'),
        ]
        for responses, code in cases:
            with self.subTest(code=code), patch.object(self.gateway.runtime, 'request', side_effect=responses):
                self.assertEqual(self.call('GET', '/readiness/nvidia'), (200, {
                    'version': 'bitovp-semantic-readiness-v1', 'profile': 'nvidia',
                    'scope': 'METADATA_ONLY', 'ready': False, 'code': code}))

    def test_readiness_stopping_or_any_quarantine_skips_all_runtime_requests(self):
        self.gateway.runtime = FixedRuntime()
        with patch.object(self.gateway.runtime, 'request') as runtime_request:
            self.gateway.stopping.set()
            self.assertEqual(self.call('GET', '/readiness/amd')[1]['code'], 'GATEWAY_STOPPING')
            self.gateway.stopping.clear()
            self.gateway.store.quarantine('nvidia', 'CLEANUP_FAILED')
            for profile in PORTS:
                value = self.call('GET', '/readiness/' + profile)[1]
                self.assertEqual((value['ready'], value['code']), (False, 'RUNTIME_QUARANTINED'))
            runtime_request.assert_not_called()

    def test_readiness_rechecks_an_admission_fence_changed_during_metadata_reads(self):
        self.gateway.runtime = FixedRuntime()
        def metadata(profile, route):
            if route == '/api/version':
                return {'version': RUNTIME_VERSION}
            self.gateway.store.quarantine('amd', 'CLEANUP_FAILED')
            return {'models': [{'name': MODEL, 'digest': MODEL_DIGEST}]}
        with patch.object(self.gateway.runtime, 'request', side_effect=metadata):
            self.assertEqual(self.call('GET', '/readiness/nvidia')[1]['code'], 'RUNTIME_QUARANTINED')

    def test_fixed_stage_schema_and_runtime_options_cannot_be_overridden(self):
        for changes in [{'model': 'cloud-model'}, {'baseURL': 'https://example.com'},
                        {'stage': 'OTHER'}, {'schemaHash': 'f' * 64}, {'profile': 'cpu'},
                        {'promptVersion': 'future'}, {'prompt': 'x' * 65537}]:
            with self.subTest(changes=list(changes)):
                self.assertEqual(self.call('POST', '/v1/semantic-jobs', request(**changes))[0], 422)
        self.assertIsNone(self.gateway.store.next_queued())

    def test_each_stage_reserves_output_and_template_budget_before_acceptance(self):
        for stage, maximum in [('LOCAL_LEDGER_V1', 6144), ('LOCAL_BLUEPRINT_V1', 5632)]:
            self.assertEqual(self.call('POST', '/v1/semantic-jobs', request(stage=stage, prompt='x' * maximum))[0], 202)
            self.assertEqual(self.call('POST', '/v1/semantic-jobs', request(stage=stage, prompt='x' * (maximum + 1)))[0], 422)
        self.assertEqual(self.call('POST', '/v1/semantic-jobs', request(prompt='一' * 2049))[0], 422)

    def test_other_tenant_job_cannot_be_read_or_cancelled(self):
        row, _ = self.gateway.store.submit(request(organizationId=OTHER_ORG))
        self.assertEqual(self.call('GET', '/v1/semantic-jobs/' + row['id'])[0], 404)
        self.assertEqual(self.call('POST', '/v1/semantic-jobs/' + row['id'] + '/cancel', {})[0], 404)
        self.assertEqual(self.gateway.store.get(row['id'], OTHER_ORG)['state'], 'QUEUED')

    def test_atomic_idempotency_returns_one_job_and_rejects_changed_payload(self):
        body = request()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(lambda _: self.call('POST', '/v1/semantic-jobs', body), range(8)))
        self.assertEqual(sum(status == 202 for status, _ in responses), 1)
        self.assertEqual(len({row['id'] for _, row in responses}), 1)
        self.assertEqual({row['requestHash'] for _, row in responses}, {canonical_hash(body)})
        status, value = self.call('POST', '/v1/semantic-jobs', {**body, 'prompt': 'different'})
        self.assertEqual((status, value['error']['code']), (409, 'IDEMPOTENCY_CONFLICT'))

    def test_success_receipt_omits_reasoning_and_is_published_after_release(self):
        job = self.submit()
        self.assertTrue(self.gateway.run_one())
        status, value = self.call('GET', '/v1/semantic-jobs/' + job)
        self.assertEqual((status, value['state']), (200, 'SUCCEEDED'))
        receipt = value['result']['receipt']
        self.assertTrue(receipt['cleanupConfirmed'])
        self.assertFalse(receipt['schemaVerified'])
        self.assertEqual(receipt['context'], 8192)
        self.assertEqual(receipt['profile'], 'nvidia')
        self.assertEqual(receipt['apiStats']['promptEvalCount'], 7)
        self.assertFalse(receipt['thinking'])
        self.assertNotIn('hidden reasoning', json.dumps(value))
        self.assertEqual(self.runtime.calls[-1], ('unload', 'nvidia'))

    def test_unavailable_runtime_and_preexisting_model_are_not_unloaded(self):
        for field, code in [('invalid_identity', 'NOT_CAPABLE'), ('preexisting', 'RESOURCE_BUSY')]:
            setattr(self.runtime, field, True)
            job = self.submit()
            self.gateway.run_one()
            value = self.call('GET', '/v1/semantic-jobs/' + job)[1]
            self.assertEqual((value['state'], value['errorCode']), ('FAILED', code))
            self.assertFalse(any(c[0] in ('chat', 'unload') for c in self.runtime.calls))
            setattr(self.runtime, field, False)

    def test_queued_cancel_is_immediate_and_never_calls_runtime(self):
        job = self.submit()
        status, value = self.call('POST', '/v1/semantic-jobs/' + job + '/cancel', {})
        self.assertEqual((status, value['state']), (200, 'CANCELLED'))
        self.assertFalse(self.gateway.run_one())
        self.assertEqual(self.runtime.calls, [])

    def test_late_submit_cannot_start_after_cancel_of_deterministic_id(self):
        body = request()
        job = str(uuid.uuid5(uuid.NAMESPACE_URL, 'bitovp-semantic:' + ORG + ':' + body['requestKey']))
        self.assertEqual(self.call('POST', '/v1/semantic-jobs/' + job + '/cancel', {})[0], 404)
        status, value = self.call('POST', '/v1/semantic-jobs', body)
        self.assertEqual((status, value['id'], value['state']), (202, job, 'CANCELLED'))
        self.assertFalse(self.gateway.run_one())
        self.assertEqual(self.runtime.calls, [])

    def test_running_cancel_stays_cancelling_until_owned_release_finishes(self):
        self.runtime.block = True
        self.runtime.release.clear()
        job = self.submit()
        thread = threading.Thread(target=self.gateway.run_one)
        thread.start()
        self.assertTrue(self.runtime.started.wait(2))
        self.call('POST', '/v1/semantic-jobs/' + job + '/cancel', {})
        self.assertTrue(self.runtime.releasing.wait(2))
        value = self.call('GET', '/v1/semantic-jobs/' + job)[1]
        self.assertEqual(value['state'], 'CANCELLING')
        self.assertNotIn('result', value)
        with (self.root / 'inference.lock').open('a') as handle:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.runtime.release.set()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        value = self.call('GET', '/v1/semantic-jobs/' + job)[1]
        self.assertEqual(value['state'], 'CANCELLED')
        self.assertNotIn('result', value)

    def test_cleanup_failure_cannot_be_reported_as_success_or_cancelled(self):
        self.runtime.cleanup_error = True
        job = self.submit()
        self.gateway.run_one()
        value = self.call('GET', '/v1/semantic-jobs/' + job)[1]
        self.assertEqual((value['state'], value['errorCode']), ('FAILED', 'CLEANUP_FAILED'))
        self.assertNotIn('result', value)

    def test_invalid_or_nonfinite_json_is_failed_after_owned_cleanup(self):
        response = FakeRuntime().chat('nvidia', {}, None)
        for content in ['plain text', '{"value":NaN}', '{"broken":']:
            job = self.submit()
            value = {**response, 'message': {'content': content}}
            with patch.object(self.runtime, 'chat', return_value=value):
                self.gateway.run_one()
            result = self.call('GET', '/v1/semantic-jobs/' + job)[1]
            self.assertEqual((result['state'], result['errorCode']), ('FAILED', 'OUTPUT_INVALID'))
            self.assertEqual(self.runtime.calls[-1], ('unload', 'nvidia'))

    def test_deadline_is_a_failed_job_after_cleanup(self):
        self.runtime.block = True
        self.gateway.timeout_seconds = .02
        job = self.submit()
        self.gateway.run_one()
        value = self.call('GET', '/v1/semantic-jobs/' + job)[1]
        self.assertEqual((value['state'], value['errorCode']), ('FAILED', 'DEADLINE'))
        self.assertEqual(self.runtime.calls[-1], ('unload', 'nvidia'))

    def test_terminal_state_exposes_owned_cleanup_confirmation(self):
        queued = self.submit()
        self.assertFalse(self.call('GET', '/v1/semantic-jobs/' + queued)[1]['cleanupConfirmed'])
        self.assertTrue(self.call('POST', '/v1/semantic-jobs/' + queued + '/cancel', {})[1]['cleanupConfirmed'])
        self.runtime.cleanup_error = True
        failed = self.submit()
        self.gateway.run_one()
        result = self.call('GET', '/v1/semantic-jobs/' + failed)[1]
        self.assertEqual(result['errorCode'], 'CLEANUP_FAILED')
        self.assertFalse(result['cleanupConfirmed'])

    def test_cancel_during_invisible_backend_load_requires_ack_and_persistent_quarantine(self):
        runtime = PendingLoadRuntime()
        runtime.release.clear()
        self.gateway.runtime = runtime
        body = request()
        first, queued = self.submit(body), self.submit()
        quarantine = self.gateway.store.quarantine
        fenced = []
        def quarantine_while_locked(profile, code):
            with (self.root / 'inference.lock').open('a') as handle:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            quarantine(profile, code)
            fenced.append(profile)
        self.gateway.store.quarantine = quarantine_while_locked
        worker = threading.Thread(target=self.gateway.run_one)
        worker.start()
        try:
            self.assertTrue(runtime.started.wait(2))
            self.call('POST', '/v1/semantic-jobs/' + first + '/cancel', {})
            self.assertTrue(runtime.unloading.wait(1), 'An empty /api/ps must not skip the owned unload request')
            interim = self.call('GET', '/v1/semantic-jobs/' + first)[1]
            self.assertEqual(interim['state'], 'CANCELLING')
            self.assertFalse(interim['cleanupConfirmed'])
            with (self.root / 'inference.lock').open('a') as handle:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            runtime.release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        result = self.call('GET', '/v1/semantic-jobs/' + first)[1]
        self.assertEqual((result['state'], result['errorCode']), ('FAILED', 'RUNTIME_STOP_UNCONFIRMED'))
        self.assertFalse(result['cleanupConfirmed'])
        self.assertNotIn('result', result)
        self.assertEqual(fenced, ['nvidia'])
        # Even a successful unload ACK cannot exclude this accepted load appearing later.
        runtime.models = [{'name': MODEL, 'digest': MODEL_DIGEST}]
        self.assertTrue(self.gateway.run_one())
        blocked = self.call('GET', '/v1/semantic-jobs/' + queued)[1]
        self.assertEqual((blocked['state'], blocked['errorCode']), ('FAILED', 'RUNTIME_QUARANTINED'))
        self.assertEqual(sum(route == '/api/chat' for _, route, _ in runtime.calls), 1)
        status, rejected = self.call('POST', '/v1/semantic-jobs', request(profile='amd'))
        self.assertEqual((status, rejected['error']['code']), (503, 'RUNTIME_QUARANTINED'))
        self.assertEqual(self.call('POST', '/v1/semantic-jobs', body), (200, result))
        health = self.call('GET', '/health')[1]
        self.assertEqual((health['status'], health['quarantinedProfiles']), ('degraded', ['nvidia']))
        restarted = Gateway(self.root, ORG, hashlib.sha256(TOKEN.encode()).hexdigest(), registry(), runtime)
        status, rejected = restarted.route('POST', '/v1/semantic-jobs', self.headers, request())
        self.assertEqual((status, rejected['error']['code']), (503, 'RUNTIME_QUARANTINED'))

    def test_transport_loss_cannot_confirm_cleanup_from_an_unload_ack_and_empty_ps(self):
        runtime = PendingLoadRuntime()
        runtime.chat_error = 'RUNTIME_FAILED'
        self.gateway.runtime = runtime
        job = self.submit()
        self.gateway.run_one()
        result = self.call('GET', '/v1/semantic-jobs/' + job)[1]
        self.assertEqual((result['state'], result['errorCode']), ('FAILED', 'RUNTIME_STOP_UNCONFIRMED'))
        self.assertFalse(result['cleanupConfirmed'])
        self.assertEqual(self.gateway.store.quarantined_profiles(), ['nvidia'])

    def test_failed_quarantine_persistence_stops_admission_but_keeps_status_and_cancel(self):
        runtime = PendingLoadRuntime()
        runtime.chat_error = 'RUNTIME_FAILED'
        self.gateway.runtime = runtime
        first, queued = self.submit(), self.submit(request(profile='amd'))
        with patch.object(self.gateway.store, 'quarantine', side_effect=OSError('Authored persistence failure')):
            self.gateway.run_one()
        self.assertTrue(self.gateway.stopping.is_set())
        self.assertFalse(self.gateway.run_one())
        self.assertEqual(self.gateway.store.get(queued, ORG)['state'], 'QUEUED')
        for profile in ('amd', 'nvidia'):
            status, rejected = self.call('POST', '/v1/semantic-jobs', request(profile=profile))
            self.assertEqual(status, 503, 'A stopping worker must not admit new jobs')
            self.assertEqual((status, rejected['error']['code']), (503, 'GATEWAY_STOPPING'))
        health = self.call('GET', '/health')[1]
        self.assertEqual((health['status'], health['acceptingJobs']), ('degraded', False))
        status, result = self.call('GET', '/v1/semantic-jobs/' + first)
        self.assertEqual(status, 200)
        self.assertFalse(result['cleanupConfirmed'])
        self.assertEqual(self.call('POST', '/v1/semantic-jobs/' + queued + '/cancel', {})[1]['state'], 'CANCELLED')

    def test_final_backend_done_ack_and_owned_unload_can_complete_normally(self):
        runtime = FixedRuntime()
        model = {'name': MODEL, 'digest': MODEL_DIGEST, 'size': 100, 'size_vram': 70, 'context_length': 8192}
        models, calls = [], []
        def backend(profile, route, payload=None, control=None):
            calls.append((profile, route, payload))
            if route == '/api/version':
                return {'version': RUNTIME_VERSION}
            if route == '/api/tags':
                return {'models': [{'name': MODEL, 'digest': MODEL_DIGEST}]}
            if route == '/api/ps':
                return {'models': models.copy() if profile == 'nvidia' else []}
            if route == '/api/chat':
                models.append(model)
                return {**FakeRuntime().chat(profile, payload, control), 'model': MODEL, 'done': True}
            if route == '/api/generate':
                models.clear()
                return {'model': MODEL, 'done': True, 'done_reason': 'unload'}
            raise AssertionError('Unexpected fake API operation')
        self.gateway.runtime = runtime
        job = self.submit()
        with patch.object(runtime, 'request', side_effect=backend):
            self.gateway.run_one()
        result = self.call('GET', '/v1/semantic-jobs/' + job)[1]
        self.assertEqual(result['state'], 'SUCCEEDED')
        self.assertTrue(result['cleanupConfirmed'])
        self.assertEqual(self.gateway.store.quarantined_profiles(), [])
        self.assertEqual(sum(route == '/api/generate' for _, route, _ in calls), 1)

    def test_empty_model_list_is_not_cleanup_without_valid_unload_ack(self):
        for reply in [{}, {'model': MODEL, 'done': False, 'done_reason': 'unload'},
                      {'model': MODEL, 'done': True, 'done_reason': 'load'},
                      {'model': 'another-model', 'done': True, 'done_reason': 'unload'}]:
            with self.subTest(reply=reply):
                runtime = FixedRuntime()
                with patch.object(runtime, 'loaded', return_value=[]), patch.object(runtime, 'request', return_value=reply):
                    with self.assertRaises(GatewayError) as caught:
                        runtime.unload('nvidia')
                    self.assertEqual(caught.exception.code, 'CLEANUP_FAILED')

    def test_recovery_fences_abandoned_owner_and_preserves_queued_work(self):
        queued = self.submit()
        abandoned = self.submit()
        self.gateway.store.claim(abandoned, 'old-owner')
        self.gateway.store.recover()
        self.assertEqual(self.gateway.store.get(abandoned, ORG)['errorCode'], 'RESTARTED')
        self.assertEqual(self.gateway.store.get(queued, ORG)['state'], 'QUEUED')
        self.assertEqual(self.gateway.store.quarantined_profiles(), ['nvidia'])
        self.assertFalse(self.gateway.store.finish(abandoned, 'old-owner', 'SUCCEEDED', {'late': True}, None))

    def test_registry_hash_is_checked_and_external_schema_references_are_rejected(self):
        bad = {'version': 'bitovp-semantic-stages-v1', 'stages': {'LOCAL_LEDGER_V1': {
            'promptVersion': 'local-story-v1', 'schemaHash': 'f' * 64, 'schema': SCHEMA,
            'maxOutputTokens': 1024}}}
        with self.assertRaises(ValueError):
            Registry(bad)
        schema = {'$ref': 'https://example.com/schema'}
        bad['stages']['LOCAL_LEDGER_V1'].update(schema=schema, schemaHash=canonical_hash(schema))
        with self.assertRaises(ValueError):
            Registry(bad)

    def test_cancel_shutdown_reaches_only_the_owned_runtime_connection(self):
        started, disconnected, cancel = threading.Event(), threading.Event(), threading.Event()
        class RuntimeHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                started.set()
                self.connection.settimeout(2)
                if self.connection.recv(1) == b'':
                    disconnected.set()
            def log_message(self, *_):
                pass
        class CancelControl:
            def check(self):
                if cancel.is_set():
                    raise GatewayError('CANCELED')
        server = ThreadingHTTPServer(('127.0.0.1', 0), RuntimeHandler)
        serving = threading.Thread(target=server.serve_forever)
        serving.start()
        errors = []
        def call():
            try:
                FixedRuntime.request('nvidia', '/api/chat', {'prompt': 'fixture'}, CancelControl())
            except GatewayError as error:
                errors.append(error.code)
        try:
            with patch.dict(PORTS, {'nvidia': server.server_port}):
                caller = threading.Thread(target=call)
                caller.start()
                self.assertTrue(started.wait(2))
                cancel.set()
                caller.join(2)
                self.assertFalse(caller.is_alive())
                self.assertTrue(disconnected.wait(2))
                self.assertEqual(errors, ['CANCELED'])
        finally:
            server.shutdown()
            server.server_close()
            serving.join(2)

    def test_runtime_placement_rejects_cpu_only_or_changed_identity(self):
        runtime = FixedRuntime()
        good = {'name': 'qwen3.8:27b-q8_0', 'digest': '8f5fb6b71ea00052cbe8545738c55ce61112c4e571cb60ca4dad00b131766039',
                'context_length': 8192, 'size_vram': 100, 'size': 200}
        for changes in [{'size_vram': 0}, {'digest': 'wrong'}, {'context_length': 16384}]:
            with patch.object(runtime, 'loaded', return_value=[{**good, **changes}]):
                with self.assertRaises(GatewayError):
                    runtime.placement('amd')
        with patch.object(runtime, 'loaded', return_value=[good]):
            self.assertEqual(runtime.placement('amd'), [good])

    def test_https_auth_and_body_boundaries_use_the_real_http_handler(self):
        certificate, key = self.root / 'certificate.pem', self.root / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(key), '-out', str(certificate), '-days', '1', '-subj', '/CN=localhost',
                        '-addext', 'subjectAltName=IP:127.0.0.1'], check=True, capture_output=True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, key)
        server = GatewayServer(('127.0.0.1', 0), self.gateway, context)
        serving = threading.Thread(target=server.serve_forever)
        serving.start()
        client_context = ssl.create_default_context(cafile=str(certificate))
        def send_http(method, body=None, headers=None):
            connection = http.client.HTTPSConnection('127.0.0.1', server.server_port,
                                                     timeout=2, context=client_context)
            try:
                connection.request(method, '/health' if method == 'GET' else '/v1/semantic-jobs',
                                   body=body, headers=headers or {})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        try:
            self.assertEqual(send_http('GET')[0], 401)
            status, health = send_http('GET', headers=self.headers)
            self.assertEqual(status, 200)
            self.assertEqual(health['model'], 'qwen3.8:27b-q8_0')
            headers = {**self.headers, 'Content-Type': 'application/json', 'Content-Length': str(128 * 1024 + 1)}
            self.assertEqual(send_http('POST', headers=headers)[0], 413)
            headers = {**self.headers, 'Content-Type': 'application/json'}
            self.assertEqual(send_http('POST', 'NaN', headers)[0], 400)
            status, value = send_http('POST', json.dumps(request()), headers)
            self.assertEqual((status, value['state']), (202, 'QUEUED'))
            self.assertNotIn('prompt', value)
            self.assertEqual(self.runtime.calls, [])
        finally:
            server.shutdown()
            server.server_close()
            serving.join(2)

    def test_cancel_during_connect_cannot_send_a_late_runtime_request(self):
        connecting, release, cancel, observed = (threading.Event() for _ in range(4))
        sent, errors = [], []
        class DelayedConnection:
            def __init__(self, *_args, **_kwargs):
                self.sock = None
            def connect(self):
                connecting.set()
                release.wait(2)
                self.sock = object()
            def request(self, *_args, **_kwargs):
                sent.append(True)
            def close(self):
                pass
        class CancelControl:
            def check(self):
                if cancel.is_set():
                    observed.set()
                    raise GatewayError('CANCELED')
        def call():
            try:
                FixedRuntime.request('amd', '/api/chat', {}, CancelControl())
            except GatewayError as error:
                errors.append(error.code)
        with patch('gateway.http.client.HTTPConnection', DelayedConnection):
            thread = threading.Thread(target=call)
            thread.start()
            self.assertTrue(connecting.wait(2))
            cancel.set()
            self.assertTrue(observed.wait(2))
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(sent, [])
        self.assertEqual(errors, ['CANCELED'])


if __name__ == '__main__':
    unittest.main()
