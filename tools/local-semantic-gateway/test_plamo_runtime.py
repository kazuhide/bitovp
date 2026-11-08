"""Synthetic files, HTTP and cgroups only. These tests never start model services."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid
from gateway import Gateway, GatewayError, Registry, canonical_hash, inference_lease
from plamo_runtime import InstalledPlamoRuntime, PlamoError, digest, render_unit, runtime_argv, installation_recipe_hash, unit_name, PINS
from generate_plamo_units import generate

ORG = '00000000-0000-4000-8000-000000000001'
TOKEN = 'synthetic-not-a-secret'

def fixture_identity(manifest, profile='nvidia'):
    runtime = manifest['runtimes'][profile]
    return {'version': 'local-caption-model-v3', 'provider': 'LOCAL_LLAMA_CPP', 'profile': profile,
            'modelId': manifest['modelId'], 'sourceRevision': manifest['sourceRevision'],
            **{k: manifest[k] for k in ('configId', 'weightSha256', 'weightBytes', 'quantization', 'promptTemplateHash', 'contextPolicyFingerprint')},
            'runtimeSourceRevision': runtime['sourceRevision'], 'runtimeBinarySha256': runtime['binarySha256'],
            **({'runtimeBackend': runtime['backend']} if 'backend' in runtime else {}),
            'context': 8192, 'maxOutputTokens': 1536, 'temperature': 0, 'seed': 41, 'thinking': False,
            'promptVersion': 'plamo-pfml3-caption-v1', 'validationPolicyFingerprint': PINS['validationPolicyFingerprint'],
            'schemaHash': PINS['schemaHash'], 'manifestHash': digest(manifest)}

class SyntheticRuntime:
    def __init__(self):
        self.calls = []
    def loaded(self, profile):
        self.calls.append(profile)
        return []

class PlamoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.directory = self.root / 'gateway'
        self.directory.mkdir(mode=0o700)
        self.lab = self.root / 'plamo'
        self.lab.mkdir(mode=0o700)
        files = []
        for directory, name in [('bin', 'llama-server'), ('weights', 'model.gguf'), ('lib', 'backend.so')]:
            parent = self.lab / directory
            parent.mkdir(mode=0o700)
            path = parent / name
            path.write_bytes(('SYNTHETIC-' + name).encode())
            path.chmod(0o600)
            files.append(path)
        binary, weights, library = files
        binary.chmod(0o700)
        self.manifest = {'version': 'bitovp-plamo-installed-manifest-v1', 'configId': str(uuid.uuid4()),
            'modelId': 'pfnet/plamo-3-translate-31b', 'sourceRevision': '01eac57bf80ef8114decd998f8f3a803ba795557',
            'weightSha256': hashlib.sha256(weights.read_bytes()).hexdigest(), 'weightBytes': weights.stat().st_size,
            'quantization': 'Q8_0', 'promptTemplateHash': PINS['templateHash'], 'contextPolicyFingerprint': PINS['contextPolicyFingerprint'],
            'runtimes': {'nvidia': {'sourceRevision': 'a' * 40, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest()}}}
        self.identity = fixture_identity(self.manifest)
        self.item = {'identity': self.identity, 'binaryPath': str(binary), 'weightsPath': str(weights),
            'libraries': [{'path': str(library), 'sha256': hashlib.sha256(library.read_bytes()).hexdigest()}],
            'libraryDirectories': [str(library.parent)], 'gpuLayers': 10, 'gpuDevice': 'CUDA0', 'memoryMaxBytes': 4 * 1024**3}
        recipe = installation_recipe_hash('nvidia', self.item)
        self.manifest['runtimes']['nvidia']['buildRecipeHash'] = recipe
        self.identity['runtimeBuildRecipeHash'] = recipe
        self.identity['manifestHash'] = digest(self.manifest)
        self.config = self.directory / 'plamo-private.json'
        self.config.write_text(json.dumps({'version': 'bitovp-plamo-private-v1', 'manifest': self.manifest, 'profiles': {'nvidia': self.item}}))
        self.config.chmod(0o600)
        self.runtime = InstalledPlamoRuntime(self.directory)
        self.headers = {'Authorization': 'Bearer ' + TOKEN}
        self.gateway = Gateway(self.root / 'state', ORG, hashlib.sha256(TOKEN.encode()).hexdigest(), Registry({'version': 'bitovp-semantic-stages-v1', 'stages': {}}), SyntheticRuntime(), self.root / 'inference.lock', self.runtime)

    def tearDown(self):
        self.temp.cleanup()

    def body(self):
        return {'version': 'bitovp-plamo-caption-job-v1', 'requestKey': str(uuid.uuid4()), 'organizationId': ORG,
                'profile': 'nvidia', 'stage': 'LOCAL_PLAMO_CAPTION_JA_V1', 'prompt': 'synthetic PFML3',
                'inputHash': 'a' * 64, 'promptVersion': 'plamo-pfml3-caption-v1', 'schemaHash': self.identity['schemaHash'],
                'manifestHash': self.identity['manifestHash']}

    def unit(self, active='inactive'):
        return {'ActiveState': active, 'MainPID': '99' if active == 'active' else '0',
                'InvocationID': '1' * 32 if active == 'active' else ''}

    def test_metadata_is_auth_bound_no_start_and_fails_closed_on_missing_or_changed_files(self):
        path = '/readiness/plamo/nvidia/' + self.identity['manifestHash']
        with patch.object(self.runtime, 'unit', return_value=self.unit()), patch.object(self.runtime, 'systemctl') as start:
            self.assertEqual(self.gateway.route('GET', path, {})[0], 401)
            status, result = self.gateway.route('GET', path, self.headers)
            self.assertEqual((status, result['code'], result['identity']), (200, 'READY', self.identity))
            start.assert_not_called()
            Path(self.item['weightsPath']).write_bytes(b'CHANGED')
            result = self.gateway.route('GET', path, self.headers)[1]
            self.assertEqual((result['code'], result['identity'], result['manifestHash']), ('MODEL_MISMATCH', None, None))
        self.gateway.plamo_runtime = None
        self.assertEqual(self.gateway.route('GET', path, self.headers)[1]['code'], 'MODEL_NOT_INSTALLED')

    def test_dedicated_unit_has_own_budget_no_autostart_and_no_gateway_child_model(self):
        unit = render_unit('nvidia', self.item)
        self.assertIn('MemoryMax=4294967296', unit)
        self.assertIn('BindsTo=bitovp-semantic-gateway.service', unit)
        self.assertIn('KillMode=control-group', unit)
        self.assertIn('ExecStart=/usr/bin/env -i ', unit)
        self.assertNotIn('[Install]', unit)
        self.assertNotIn('256M', unit)
        argv = runtime_argv('nvidia', self.item)
        self.assertIn('11438', argv)
        for denied in ('--model-url', '--hf-repo', '--agent', '--connect', '--jinja'):
            self.assertNotIn(denied, argv)

    def test_global_quarantine_and_stopping_override_installed_metadata(self):
        path = '/readiness/plamo/nvidia/' + self.identity['manifestHash']
        with patch.object(self.runtime, 'metadata') as read:
            self.gateway.store.quarantine('amd', 'CLEANUP_FAILED')
            result = self.gateway.route('GET', path, self.headers)[1]
            self.assertEqual((result['ready'], result['code'], result['identity']), (False, 'RUNTIME_QUARANTINED', None))
            self.gateway.stopping.set()
            self.assertEqual(self.gateway.route('GET', path, self.headers)[1]['code'], 'GATEWAY_STOPPING')
            read.assert_not_called()

    def test_request_tenant_budget_and_arbitrary_options_denied_before_submit(self):
        for changes, status in [({'organizationId': str(uuid.uuid4())}, 403), ({'prompt': 'a' * 5633}, 422), ({'baseUrl': 'http://foreign'}, 422), ({'stage': 'LOCAL_LEDGER_V1'}, 422), ({'profile': []}, 422)]:
            self.assertEqual(self.gateway.route('POST', '/v1/plamo-caption-jobs', self.headers, {**self.body(), **changes})[0], status)
        self.gateway.plamo_runtime = None
        self.assertEqual(self.gateway.route('POST', '/v1/plamo-caption-jobs', self.headers, self.body())[1]['error']['code'], 'MODEL_NOT_INSTALLED')

    def test_plain_caption_success_only_after_owned_stop_and_shared_lease_release(self):
        stopped = []
        class Control:
            def check(self): pass
        response = {'content': '正しい訳。', 'stop_type': 'eos', 'truncated': False, 'timings': {'prompt_n': 10, 'predicted_n': 5, 'prompt_ms': 1.2, 'predicted_ms': 2.3}}
        with patch.object(self.runtime, 'unit', side_effect=lambda _: self.unit('active') if stopped == ['started'] else self.unit()), \
             patch.object(self.runtime, 'systemctl', side_effect=lambda *args: stopped.append('started') if args[0] == 'start' else None), \
             patch.object(self.runtime, 'processes', return_value={99: 123}), \
             patch.object(self.runtime, 'unit_processes', return_value={99: 123}), \
             patch.object(self.runtime, 'process_signature', return_value=123), \
             patch.object(self.runtime, 'verify_listener'), \
             patch.object(self.runtime, 'request', side_effect=lambda _profile, route, *_: {'status': 'ok'} if route == '/health' else response), \
             patch.object(self.runtime, 'placement', return_value={'backend': 'CUDA', 'observedOwnedGpuMemoryBytes': 1, 'source': 'NVIDIA_PROCESS_QUERY', 'gpuLayersRequested': 10}), \
             patch.object(self.runtime, 'stop', side_effect=lambda *_: stopped.append('stopped')):
            body = self.body()
            status, accepted = self.gateway.route('POST', '/v1/plamo-caption-jobs', self.headers, body)
            self.assertEqual(status, 202)
            self.gateway.run_one()
            result = self.gateway.store.get(accepted['id'], ORG)
            self.assertEqual((result['state'], result['cleanupConfirmed']), ('SUCCEEDED', True))
            self.assertEqual(stopped, ['started', 'stopped'])
            self.assertEqual(result['result']['receipt']['identity'], self.identity)
            self.assertTrue(result['result']['receipt']['runtimeProcessStopped'])
            with inference_lease(self.root / 'inference.lock'):
                pass

    def test_cancel_or_native_failure_stops_only_owned_unit_and_cleanup_failure_quarantines(self):
        body = self.body()
        with patch.object(self.runtime, 'unit', return_value=self.unit()), patch.object(self.runtime, 'run', side_effect=PlamoError('CLEANUP_FAILED')):
            accepted = self.gateway.route('POST', '/v1/plamo-caption-jobs', self.headers, body)[1]
            self.gateway.run_one()
        result = self.gateway.store.get(accepted['id'], ORG)
        self.assertEqual((result['state'], result['errorCode'], result['cleanupConfirmed']), ('FAILED', 'CLEANUP_FAILED', False))
        self.assertEqual(self.gateway.store.quarantined_profiles(), ['nvidia'])
        self.gateway.store.recover()
        self.assertEqual(self.gateway.store.quarantined_profiles(), ['nvidia'])
        with inference_lease(self.root / 'inference.lock'):
            pass

    def test_real_runtime_finally_stops_after_cancel_without_success_receipt(self):
        cancelled = threading.Event()
        stopped = []
        class Control:
            def check(self):
                if cancelled.is_set(): raise GatewayError('CANCELED')
        def request(_profile, route, *_):
            if route == '/health': return {'status': 'ok'}
            cancelled.set()
            raise GatewayError('CANCELED')
        active = []
        with patch.object(self.runtime, 'unit', side_effect=lambda _: self.unit('active') if active else self.unit()), \
             patch.object(self.runtime, 'systemctl', side_effect=lambda *_: active.append(True)), \
             patch.object(self.runtime, 'unit_processes', return_value={99: 123}), \
             patch.object(self.runtime, 'process_signature', return_value=123), \
             patch.object(self.runtime, 'processes', return_value={99: 123}), patch.object(self.runtime, 'request', side_effect=request), \
             patch.object(self.runtime, 'verify_listener'), \
             patch.object(self.runtime, 'placement', return_value={}), \
             patch.object(self.runtime, 'stop', side_effect=lambda *args: stopped.append(args)):
            with self.assertRaises(GatewayError):
                self.runtime.run('nvidia', self.body(), Control())
        self.assertEqual(stopped, [('nvidia', {99: 123}, ('1' * 32, 99, 123))])

    def test_preexisting_resident_or_changed_binary_never_starts_or_stops(self):
        with patch.object(self.runtime, 'unit', return_value=self.unit('active')), patch.object(self.runtime, 'systemctl') as commands:
            with self.assertRaisesRegex(PlamoError, 'RESOURCE_BUSY'):
                self.runtime.run('nvidia', self.body(), None)
            commands.assert_not_called()
        self.item['identity']['weightSha256'] = 'f' * 64
        self.config.write_text(json.dumps({'version': 'bitovp-plamo-private-v1', 'manifest': self.manifest, 'profiles': {'nvidia': self.item}}))
        invalid = InstalledPlamoRuntime(self.directory)
        self.assertEqual(invalid.metadata('nvidia', self.identity['manifestHash']), ('MODEL_MISMATCH', None))

    def test_own_stop_rejects_surviving_or_replaced_pid_and_unknown_effective_config(self):
        with patch.object(self.runtime, 'unit', return_value=self.unit('active')), patch.object(self.runtime, 'systemctl') as commands, patch.object(self.runtime, 'process_signature', return_value=999):
            with self.assertRaisesRegex(PlamoError, 'CLEANUP_FAILED'):
                self.runtime.stop('nvidia', {99: 123}, ('1' * 32, 99, 123))
            commands.assert_not_called()
        with patch.object(self.runtime, 'unit', side_effect=PlamoError('MODEL_MISMATCH')), patch.object(self.runtime, 'systemctl') as commands:
            with self.assertRaises(PlamoError): self.runtime.stop('nvidia', {99: 123}, ('1' * 32, 99, 123))
            commands.assert_not_called()

    def test_library_or_unit_budget_change_requires_a_new_public_recipe_identity(self):
        for key, value in [('gpuLayers', 11), ('memoryMaxBytes', 5 * 1024**3)]:
            changed = {**self.item, key: value}
            self.config.write_text(json.dumps({'version': 'bitovp-plamo-private-v1', 'manifest': self.manifest, 'profiles': {'nvidia': changed}}))
            invalid = InstalledPlamoRuntime(self.directory)
            self.assertEqual(invalid.metadata('nvidia', self.identity['manifestHash']), ('MODEL_MISMATCH', None))

    def test_foreign_loopback_listener_is_never_a_trusted_completion_endpoint(self):
        rows = 'header\n0: 0100007F:2CAE 00000000:0000 0A 0 0 0 1000 0 12345\n'
        self.runtime.verify_listener_rows('nvidia', rows, {'12345'})
        for owned in (set(), {'99999'}):
            with self.assertRaises(PlamoError): self.runtime.verify_listener_rows('nvidia', rows, owned)

    def test_generated_unit_is_inactive_only_and_effective_dropin_or_argv_override_is_rejected(self):
        output = self.root / 'generated'
        with patch('plamo_runtime.subprocess.run') as commands:
            self.assertEqual(generate(self.directory, output), ['nvidia'])
            commands.assert_not_called()
        home = self.root / 'home'
        unit = home / '.config/systemd/user' / unit_name('nvidia')
        unit.parent.mkdir(parents=True)
        unit.write_text((output / unit.name).read_text())
        good = {'LoadState': 'loaded', 'FragmentPath': str(unit), 'DropInPaths': '', 'NeedDaemonReload': 'no',
                'Type': 'simple', 'KillMode': 'control-group', 'Restart': 'no', 'MemoryMax': str(self.item['memoryMaxBytes']),
                'MemorySwapMax': '0', 'BindsTo': 'bitovp-semantic-gateway.service', 'ActiveState': 'inactive', 'MainPID': '0',
                'ExecStart': '{ path=/usr/bin/env ; argv[]=' + ' '.join(runtime_argv('nvidia', self.item)) + ' ; }'}
        for changes, expected in [({}, 'READY'), ({'DropInPaths': '/untrusted/override.conf'}, 'MODEL_MISMATCH'),
                                  ({'ExecStart': '{ path=/usr/bin/false ; argv[]=/usr/bin/false ; }'}, 'MODEL_MISMATCH')]:
            raw = '\n'.join(key + '=' + value for key, value in {**good, **changes}.items())
            with patch('plamo_runtime.Path.home', return_value=home), patch.object(self.runtime, 'systemctl', return_value=raw) as commands:
                self.assertEqual(self.runtime.metadata('nvidia', self.identity['manifestHash'])[0], expected)
                self.assertTrue(all(call.args[0] == 'show' for call in commands.call_args_list))

    def test_review_r1_same_soname_directory_order_changes_recipe_and_cache_identity(self):
        directories = [self.lab / 'first', self.lab / 'second']
        libraries = []
        for index, directory in enumerate(directories):
            directory.mkdir(mode=0o700)
            path = directory / 'same-soname.so'
            path.write_bytes(('SYNTHETIC_SAME_SONAME_' + str(index)).encode())
            path.chmod(0o600)
            libraries.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        item = {**self.item, 'libraries': libraries, 'libraryDirectories': [str(x) for x in directories]}
        reverse = {**item, 'libraryDirectories': list(reversed(item['libraryDirectories']))}
        first_hash = installation_recipe_hash('nvidia', item)
        reverse_hash = installation_recipe_hash('nvidia', reverse)
        self.assertNotEqual(first_hash, reverse_hash)
        first_manifest = json.loads(json.dumps(self.manifest))
        first_manifest['runtimes']['nvidia']['buildRecipeHash'] = first_hash
        second_manifest = json.loads(json.dumps(first_manifest))
        second_manifest['runtimes']['nvidia']['buildRecipeHash'] = reverse_hash
        self.assertNotEqual(fixture_identity(first_manifest)['manifestHash'], fixture_identity(second_manifest)['manifestHash'])
        item['identity'] = {**fixture_identity(first_manifest), 'runtimeBuildRecipeHash': first_hash}
        self.config.write_text(json.dumps({'version': 'bitovp-plamo-private-v1', 'manifest': first_manifest,
                                          'profiles': {'nvidia': {**item, 'libraryDirectories': reverse['libraryDirectories']}}}))
        self.assertEqual(InstalledPlamoRuntime(self.directory).metadata('nvidia', item['identity']['manifestHash']), ('MODEL_MISMATCH', None))

    def test_review_r2_waits_for_same_owned_env_exec_before_health_or_completion(self):
        state = {'active': False, 'checks': 0}
        calls = []
        class Control:
            def check(self):
                state['checks'] += 1
                if state['checks'] > 20: raise GatewayError('DEADLINE')
        def unit(_):
            return {'ActiveState': 'active' if state['active'] else 'inactive', 'MainPID': '99' if state['active'] else '0',
                    'InvocationID': '1' * 32 if state['active'] else ''}
        def command(*args):
            calls.append(args[0])
            if args[0] == 'start': state['active'] = True
        validations = []
        def processes(*_):
            validations.append(True)
            if len(validations) == 1: raise PlamoError('GPU_PLACEMENT_UNVERIFIED')
            return {99: 123}
        def request(_profile, route, *_):
            calls.append(route)
            self.assertGreaterEqual(len(validations), 2)
            if route == '/health': return {'status': 'ok'}
            return {'content': '正しい訳。', 'stop_type': 'eos', 'truncated': False,
                    'timings': {'prompt_n': 10, 'predicted_n': 5, 'prompt_ms': 1.2, 'predicted_ms': 2.3}}
        with patch.object(self.runtime, 'unit', side_effect=unit), patch.object(self.runtime, 'systemctl', side_effect=command), \
             patch.object(self.runtime, 'unit_processes', return_value={99: 123}, create=True), \
             patch.object(self.runtime, 'process_signature', return_value=123), \
             patch.object(self.runtime, 'exec_pending', return_value=True, create=True), \
             patch.object(self.runtime, 'processes', side_effect=processes), patch.object(self.runtime, 'request', side_effect=request), \
             patch.object(self.runtime, 'verify_listener'), patch.object(self.runtime, 'placement', return_value={}), \
             patch.object(self.runtime, 'stop', side_effect=lambda *_: calls.append('owned-stop')), patch('plamo_runtime.time.sleep'):
            content, *_ = self.runtime.run('nvidia', self.body(), Control())
        self.assertEqual(content, '正しい訳。')
        self.assertEqual(calls, ['start', '/health', '/completion', 'owned-stop'])

    def test_review_r3_real_run_finally_never_adopts_or_stops_restarted_or_reused_main_pid(self):
        for replacement, invocation in (({100: 456}, '2' * 32), ({99: 999}, '2' * 32), ({99: 999}, '1' * 32)):
            with self.subTest(replacement=replacement, invocation=invocation):
                state = {'active': False, 'replaced': False}
                commands = []
                initial = {99: 123}
                def unit(_):
                    current = replacement if state['replaced'] else initial
                    return {'ActiveState': 'active' if state['active'] else 'inactive',
                            'MainPID': str(next(iter(current))) if state['active'] else '0',
                            'InvocationID': (invocation if state['replaced'] else '1' * 32) if state['active'] else ''}
                def command(*args):
                    commands.append(args[0])
                    if args[0] == 'start': state['active'] = True
                    if args[0] == 'stop': state['active'] = False
                def signature(pid):
                    current = replacement if state['replaced'] else initial
                    if not state['active'] or pid not in current: raise FileNotFoundError()
                    return current[pid]
                body = self.body()
                with patch.object(self.runtime, 'unit', side_effect=unit), patch.object(self.runtime, 'systemctl', side_effect=command), \
                     patch.object(self.runtime, 'unit_processes', side_effect=lambda *_: dict(replacement if state['replaced'] else initial), create=True), \
                     patch.object(self.runtime, 'processes', side_effect=lambda *_: dict(replacement if state['replaced'] else initial)), \
                     patch.object(self.runtime, 'process_signature', side_effect=signature), patch.object(self.runtime, 'verify_listener'), \
                     patch.object(self.runtime, 'placement', return_value={}):
                    accepted = self.gateway.route('POST', '/v1/plamo-caption-jobs', self.headers, body)[1]
                    def request(_profile, route, *_):
                        if route == '/health': return {'status': 'ok'}
                        state['replaced'] = True
                        self.gateway.store.cancel(accepted['id'], ORG)
                        raise GatewayError('CANCELED')
                    with patch.object(self.runtime, 'request', side_effect=request):
                        self.gateway.run_one()
                result = self.gateway.store.get(accepted['id'], ORG)
                self.assertNotIn('stop', commands, 'replacement must never be reclassified as owned')
                self.assertEqual((result['state'], result['cleanupConfirmed']), ('FAILED', False))
                self.assertEqual(self.gateway.store.quarantined_profiles(), ['nvidia'])
                self.gateway.store.recover()
                self.assertEqual(self.gateway.store.quarantined_profiles(), ['nvidia'])
                # Each subcase has its own fake queue; reset only this temporary test DB fence.
                with self.gateway.store.connection() as db:
                    db.execute('DELETE FROM runtime_quarantines')

    def test_exec_wait_accepts_only_exact_owned_env_argv_and_has_a_five_second_bound(self):
        argv = ('\0'.join(runtime_argv('nvidia', self.item)) + '\0').encode()
        with patch('plamo_runtime.hash_file', return_value='same-system-env'), patch('plamo_runtime.Path.read_bytes', return_value=argv):
            self.assertTrue(self.runtime.exec_pending('nvidia', {'MainPID': '99'}))
        with patch('plamo_runtime.hash_file', return_value='same-system-env'), patch('plamo_runtime.Path.read_bytes', return_value=b'/usr/bin/env\0arbitrary\0'):
            self.assertFalse(self.runtime.exec_pending('nvidia', {'MainPID': '99'}))
        with patch('plamo_runtime.hash_file', side_effect=['unknown-exe', 'system-env']):
            self.assertFalse(self.runtime.exec_pending('nvidia', {'MainPID': '99'}))
        active, ticks, stops = [], [], []
        class Control:
            def check(self): pass
        def now():
            ticks.append(True)
            return len(ticks)
        with patch.object(self.runtime, 'unit', side_effect=lambda _: self.unit('active') if active else self.unit()), \
             patch.object(self.runtime, 'systemctl', side_effect=lambda *_: active.append(True)), \
             patch.object(self.runtime, 'unit_processes', return_value={99: 123}), \
             patch.object(self.runtime, 'process_signature', return_value=123), \
             patch.object(self.runtime, 'processes', side_effect=PlamoError('GPU_PLACEMENT_UNVERIFIED')), \
             patch.object(self.runtime, 'exec_pending', return_value=True), patch.object(self.runtime, 'request') as request, \
             patch.object(self.runtime, 'stop', side_effect=lambda *_: stops.append(True)), \
             patch('plamo_runtime.time.monotonic', side_effect=now), patch('plamo_runtime.time.sleep'):
            with self.assertRaisesRegex(PlamoError, 'GPU_PLACEMENT_UNVERIFIED'):
                self.runtime.run('nvidia', self.body(), Control())
            request.assert_not_called()
        self.assertEqual(stops, [True])
        self.assertLessEqual(len(ticks), 9)

    def test_v3_same_search_order_swapped_path_sha_bindings_change_identity(self):
        libraries, directories = [], []
        for name, content in [('first', b'SYNTHETIC_A'), ('second', b'SYNTHETIC_B')]:
            directory = self.lab / name
            directory.mkdir(mode=0o700)
            path = directory / 'libfoo.so'
            path.write_bytes(content); path.chmod(0o600)
            directories.append(str(directory))
            libraries.append({'path': str(path), 'sha256': hashlib.sha256(content).hexdigest()})
        item = {**self.item, 'libraries': libraries, 'libraryDirectories': directories}
        before = installation_recipe_hash('nvidia', item)
        manifest = json.loads(json.dumps(self.manifest))
        manifest['runtimes']['nvidia']['buildRecipeHash'] = before
        item['identity'] = {**fixture_identity(manifest), 'runtimeBuildRecipeHash': before}
        for index, content in enumerate((b'SYNTHETIC_B', b'SYNTHETIC_A')):
            Path(libraries[index]['path']).write_bytes(content)
            libraries[index]['sha256'] = hashlib.sha256(content).hexdigest()
        after = installation_recipe_hash('nvidia', item)
        self.assertNotEqual(before, after, 'Same SHA multiset must not erase path/SONAME binding')
        self.config.write_text(json.dumps({'version': 'bitovp-plamo-private-v1', 'manifest': manifest, 'profiles': {'nvidia': item}}))
        self.assertEqual(InstalledPlamoRuntime(self.directory).metadata('nvidia', item['identity']['manifestHash']), ('MODEL_MISMATCH', None))

    def test_v3_completed_exec_between_two_probes_revalidates_same_expected_owner(self):
        active, validations, calls = [], [], []
        class Control:
            def check(self): pass
        def processes(*_):
            validations.append(True)
            if len(validations) == 1: raise PlamoError('GPU_PLACEMENT_UNVERIFIED')
            return {99: 123}
        def request(_profile, route, *_):
            calls.append(route)
            self.assertGreaterEqual(len(validations), 3, 'Revalidate before rejoining the bounded loop')
            return {'status': 'ok'} if route == '/health' else {'content': '正しい訳。', 'stop_type': 'eos', 'truncated': False,
                'timings': {'prompt_n': 10, 'predicted_n': 5, 'prompt_ms': 1.2, 'predicted_ms': 2.3}}
        with patch.object(self.runtime, 'unit', side_effect=lambda _: self.unit('active') if active else self.unit()), \
             patch.object(self.runtime, 'systemctl', side_effect=lambda *_: active.append(True)), \
             patch.object(self.runtime, 'unit_processes', return_value={99: 123}), patch.object(self.runtime, 'process_signature', return_value=123), \
             patch.object(self.runtime, 'processes', side_effect=processes), patch.object(self.runtime, 'exec_pending', return_value=False), \
             patch.object(self.runtime, 'request', side_effect=request), patch.object(self.runtime, 'verify_listener'), \
             patch.object(self.runtime, 'placement', return_value={}), patch.object(self.runtime, 'stop'), patch('plamo_runtime.time.sleep'):
            content, *_ = self.runtime.run('nvidia', self.body(), Control())
        self.assertEqual(content, '正しい訳。')
        self.assertEqual(calls, ['/health', '/completion'])

    def test_v3_real_finally_rejects_foreign_invocation_even_with_zero_main_pid(self):
        for foreign_state in ('activating', 'inactive'):
            with self.subTest(foreign_state=foreign_state):
                state = {'started': False, 'foreign': False, 'ended': False}
                commands = []
                gateway = Gateway(self.root / ('zero-main-' + foreign_state), ORG, hashlib.sha256(TOKEN.encode()).hexdigest(),
                                  Registry({'version': 'bitovp-semantic-stages-v1', 'stages': {}}), SyntheticRuntime(), self.root / 'inference.lock', self.runtime)
                def unit(_):
                    if state['ended']: return self.unit()
                    if state['foreign']: return {'ActiveState': foreign_state, 'MainPID': '0', 'InvocationID': '2' * 32}
                    return self.unit('active') if state['started'] else self.unit()
                def command(*args):
                    commands.append(args[0])
                    if args[0] == 'start': state['started'] = True
                    if args[0] == 'stop': state['ended'] = True
                def signature(_):
                    if state['foreign'] or state['ended']: raise FileNotFoundError()
                    return 123
                with patch.object(self.runtime, 'unit', side_effect=unit), patch.object(self.runtime, 'systemctl', side_effect=command), \
                     patch.object(self.runtime, 'unit_processes', return_value={99: 123}), patch.object(self.runtime, 'process_signature', side_effect=signature), \
                     patch.object(self.runtime, 'processes', side_effect=lambda *_: {} if state['foreign'] else {99: 123}), \
                     patch.object(self.runtime, 'verify_listener'), patch.object(self.runtime, 'placement', return_value={}), \
                     patch.object(self.runtime, 'cgroup_pids', return_value=[]):
                    accepted = gateway.route('POST', '/v1/plamo-caption-jobs', self.headers, self.body())[1]
                    def request(_profile, route, *_):
                        if route == '/health': return {'status': 'ok'}
                        state['foreign'] = True
                        gateway.store.cancel(accepted['id'], ORG)
                        raise GatewayError('CANCELED')
                    with patch.object(self.runtime, 'request', side_effect=request): gateway.run_one()
                result = gateway.store.get(accepted['id'], ORG)
                self.assertNotIn('stop', commands)
                self.assertEqual((result['state'], result['cleanupConfirmed']), ('FAILED', False))
                self.assertEqual(gateway.store.quarantined_profiles(), ['nvidia'])

    def test_v3_already_inactive_ended_owner_needs_no_stop_command(self):
        with patch.object(self.runtime, 'unit', return_value=self.unit()), patch.object(self.runtime, 'cgroup_pids', return_value=[]), \
             patch.object(self.runtime, 'process_signature', side_effect=FileNotFoundError()), patch.object(self.runtime, 'systemctl') as commands:
            self.runtime.stop('nvidia', {99: 123}, ('1' * 32, 99, 123))
            commands.assert_not_called()

    def test_v3_unpinned_loader_alias_cannot_change_resolution_under_same_identity(self):
        alias = Path(self.item['libraryDirectories'][0]) / 'lib-alias.so'
        alias.symlink_to(Path(self.item['libraries'][0]['path']))
        fresh = InstalledPlamoRuntime(self.directory)
        with patch.object(fresh, 'unit', return_value=self.unit()), patch.object(self.runtime, 'unit', return_value=self.unit()):
            self.assertEqual(fresh.metadata('nvidia', self.identity['manifestHash']), ('MODEL_MISMATCH', None))
            self.assertEqual(self.runtime.metadata('nvidia', self.identity['manifestHash']), ('MODEL_MISMATCH', None))
        alias.unlink()
        alias.write_bytes(b'UNLISTED_LOADER_FILE')
        with patch.object(self.runtime, 'unit', return_value=self.unit()):
            self.assertEqual(self.runtime.metadata('nvidia', self.identity['manifestHash']), ('MODEL_MISMATCH', None))

    def test_v3_terminal_release_rejects_survivor_foreign_invocation_or_unknown_owner(self):
        for state, owner, signature in [
                (self.unit(), ('1' * 32, 99, 123), 123),
                ({'ActiveState': 'inactive', 'MainPID': '0', 'InvocationID': '2' * 32}, ('1' * 32, 99, 123), None),
                ({'ActiveState': 'activating', 'MainPID': '0', 'InvocationID': '1' * 32}, ('1' * 32, 99, 123), None),
                (self.unit(), None, None)]:
            with self.subTest(state=state, owner=owner):
                def process_signature(_):
                    if signature is None: raise FileNotFoundError()
                    return signature
                with patch.object(self.runtime, 'unit', return_value=state), patch.object(self.runtime, 'cgroup_pids', return_value=[]), \
                     patch.object(self.runtime, 'process_signature', side_effect=process_signature), patch.object(self.runtime, 'systemctl') as commands:
                    with self.assertRaisesRegex(PlamoError, 'CLEANUP_FAILED'):
                        self.runtime.stop('nvidia', {99: 123}, owner)
                    commands.assert_not_called()

    def test_v4_hwcaps_nested_alias_is_rejected_for_external_or_already_pinned_targets(self):
        # The old immediate-child scan ignored this standard loader preference directory.
        library_dir = Path(self.item['libraryDirectories'][0])
        second = library_dir / 'other-pinned.so'
        second.write_bytes(b'SYNTHETIC_SECOND_PINNED'); second.chmod(0o600)
        item = json.loads(json.dumps(self.item))
        item['libraries'].append({'path': str(second), 'sha256': hashlib.sha256(second.read_bytes()).hexdigest()})
        recipe = installation_recipe_hash('nvidia', item)
        manifest = json.loads(json.dumps(self.manifest))
        manifest['runtimes']['nvidia']['buildRecipeHash'] = recipe
        item['identity'] = {**fixture_identity(manifest), 'runtimeBuildRecipeHash': recipe}
        self.config.write_text(json.dumps({'version': 'bitovp-plamo-private-v1', 'manifest': manifest, 'profiles': {'nvidia': item}}))
        nested = library_dir / 'glibc-hwcaps' / 'x86-64-v3'
        nested.mkdir(parents=True, mode=0o700)
        external = self.root / 'external-compatible.so'
        external.write_bytes(b'SYNTHETIC_EXTERNAL'); external.chmod(0o600)
        alias = nested / 'libfoo.so'
        for target in (external, Path(item['libraries'][0]['path']), second):
            with self.subTest(target=target.name):
                if alias.is_symlink(): alias.unlink()
                alias.symlink_to(target)
                runtime = InstalledPlamoRuntime(self.directory)
                with patch.object(runtime, 'unit', return_value=self.unit()):
                    self.assertEqual(runtime.metadata('nvidia', item['identity']['manifestHash']), ('MODEL_MISMATCH', None))

    def test_v4_entry_budget_is_global_across_flat_loader_roots(self):
        directories = []
        for name in ('budget-one', 'budget-two'):
            directory = self.lab / name
            directory.mkdir(mode=0o700); directories.append(str(directory))
            for index in range(255):
                path = directory / ('pinned-' + str(index) + '.so')
                path.write_bytes(b'SYNTHETIC'); path.chmod(0o600)
                self.runtime.snapshots[str(path)] = ()
        # Direct policy test uses a synthetic expanded registry, not a deployed model.
        self.runtime.profiles['nvidia'] = {**self.item, 'libraryDirectories': directories}
        self.runtime.validate_loader_roots()  # 510 synthetic + binary + existing library = 512.
        overflow = Path(directories[0]) / 'overflow.so'
        overflow.write_bytes(b'SYNTHETIC'); overflow.chmod(0o600)
        self.runtime.snapshots[str(overflow)] = ()
        with self.assertRaisesRegex(PlamoError, 'MODEL_MISMATCH'):
            self.runtime.validate_loader_roots()

    def test_v4_flat_binary_and_two_explicit_library_roots_remain_metadata_ready(self):
        item = json.loads(json.dumps(self.item))
        second_dir = self.lab / 'second-flat-lib'
        second_dir.mkdir(mode=0o700)
        library = second_dir / 'second.so'
        library.write_bytes(b'SYNTHETIC_SECOND_LIBRARY'); library.chmod(0o600)
        item['libraries'].append({'path': str(library), 'sha256': hashlib.sha256(library.read_bytes()).hexdigest()})
        item['libraryDirectories'].append(str(second_dir))
        recipe = installation_recipe_hash('nvidia', item)
        manifest = json.loads(json.dumps(self.manifest))
        manifest['runtimes']['nvidia']['buildRecipeHash'] = recipe
        item['identity'] = {**fixture_identity(manifest), 'runtimeBuildRecipeHash': recipe}
        self.config.write_text(json.dumps({'version': 'bitovp-plamo-private-v1', 'manifest': manifest, 'profiles': {'nvidia': item}}))
        runtime = InstalledPlamoRuntime(self.directory)
        with patch.object(runtime, 'unit', return_value=self.unit()):
            self.assertEqual(runtime.metadata('nvidia', item['identity']['manifestHash']), ('READY', item['identity']))

    def test_v4_legacy_loader_root_with_even_an_empty_child_directory_is_disabled(self):
        legacy = Path(self.item['libraryDirectories'][0]) / 'legacy-subdirectory'
        legacy.mkdir(mode=0o700)
        fresh = InstalledPlamoRuntime(self.directory)
        with patch.object(fresh, 'unit', return_value=self.unit()), patch.object(self.runtime, 'unit', return_value=self.unit()):
            self.assertEqual(fresh.metadata('nvidia', self.identity['manifestHash']), ('MODEL_MISMATCH', None))
            self.assertEqual(self.runtime.metadata('nvidia', self.identity['manifestHash']), ('MODEL_MISMATCH', None))

    def test_v4_scan_is_lazy_bounded_and_closes_its_directory_handle(self):
        observed, closed = [], []
        path = self.item['binaryPath']
        class Entry:
            def __init__(self): self.path = path
            def is_symlink(self): return False
            def is_file(self, follow_symlinks=False): return True
        class Scanner:
            def __enter__(self): return self
            def __exit__(self, *_): closed.append(True)
            def __iter__(self): return self
            def __next__(self):
                observed.append(True)
                if len(observed) > 513: raise AssertionError('Unbounded directory enumeration')
                return Entry()
        with patch('plamo_runtime.os.scandir', return_value=Scanner()):
            with self.assertRaisesRegex(PlamoError, 'MODEL_MISMATCH'):
                self.runtime.validate_loader_roots()
        self.assertEqual(len(observed), 513)
        self.assertEqual(closed, [True])


    def configured_profile(self, profile, device, backend=None):
        manifest = json.loads(json.dumps(self.manifest))
        selected = {**manifest['runtimes']['nvidia']}
        if backend is not None: selected['backend'] = backend
        manifest['runtimes'] = {profile: selected}
        identity = fixture_identity(manifest, profile)
        item = {**self.item, 'identity': identity, 'gpuDevice': device}
        recipe = installation_recipe_hash(profile, item)
        selected['buildRecipeHash'] = recipe
        identity['runtimeBuildRecipeHash'] = recipe
        identity['manifestHash'] = digest(manifest)
        self.config.write_text(json.dumps({'version': 'bitovp-plamo-private-v1', 'manifest': manifest, 'profiles': {profile: item}}))
        return InstalledPlamoRuntime(self.directory), item

    def test_backend_admission_preserves_cuda_rocm_and_requires_explicit_amd_vulkan_identity(self):
        for profile, device, backend in [('nvidia', 'CUDA0', None), ('nvidia', 'CUDA0', 'CUDA'), ('amd', 'ROCm0', None), ('amd', 'ROCm0', 'ROCM'), ('amd', 'Vulkan1', 'VULKAN')]:
            with self.subTest(profile=profile, device=device):
                runtime, item = self.configured_profile(profile, device, backend)
                with patch.object(runtime, 'unit', return_value=self.unit()), patch.object(runtime, 'systemctl') as commands:
                    self.assertEqual(runtime.metadata(profile, item['identity']['manifestHash']), ('READY', item['identity']))
                    commands.assert_not_called()
                self.assertIn(device, runtime_argv(profile, item))
                self.assertIn(str(11438 if profile == 'nvidia' else 11439), runtime_argv(profile, item))
                if backend is None: self.assertNotIn('runtimeBackend', item['identity'])
                else: self.assertEqual(item['identity']['runtimeBackend'], backend)

    def test_omitted_backend_requires_identity_field_absence_including_null(self):
        for profile, device in [('nvidia', 'CUDA0'), ('amd', 'ROCm0')]:
            with self.subTest(profile=profile):
                runtime, item = self.configured_profile(profile, device)
                self.assertFalse(runtime.invalid)
                value = json.loads(self.config.read_text())
                value['profiles'][profile]['identity']['runtimeBackend'] = None
                self.config.write_text(json.dumps(value))
                changed = InstalledPlamoRuntime(self.directory)
                self.assertTrue(changed.invalid)
                self.assertEqual(changed.metadata(profile, item['identity']['manifestHash']), ('MODEL_MISMATCH', None))

    def test_backend_admission_rejects_profile_device_manifest_mismatches_and_stale_recipe(self):
        for profile, device, backend in [('amd', 'Vulkan0', None), ('amd', 'ROCm0', 'VULKAN'),
                ('nvidia', 'Vulkan0', 'VULKAN'), ('nvidia', 'CUDA0', 'ROCM'), ('amd', 'CUDA0', 'CUDA'),
                ('amd', 'OpenCL0', 'VULKAN'), ('amd', 'Vulkan0,1', 'VULKAN'), ('amd', 'Vulkan１', 'VULKAN'),
                ('amd', 'Vulkan-1', 'VULKAN'), ('amd', 'Vulkan0', 'UNKNOWN')]:
            with self.subTest(profile=profile, device=device, backend=backend):
                runtime, item = self.configured_profile(profile, device, backend)
                self.assertEqual(runtime.metadata(profile, item['identity']['manifestHash']), ('MODEL_MISMATCH', None))
        runtime, item = self.configured_profile('amd', 'Vulkan0', 'VULKAN')
        stale = json.loads(self.config.read_text())
        stale['profiles']['amd']['gpuDevice'] = 'Vulkan1'
        self.config.write_text(json.dumps(stale))
        changed = InstalledPlamoRuntime(self.directory)
        self.assertEqual(changed.metadata('amd', item['identity']['manifestHash']), ('MODEL_MISMATCH', None))
        _, item = self.configured_profile('amd', 'Vulkan0', 'VULKAN')
        forged = json.loads(self.config.read_text())
        forged['profiles']['amd']['identity']['runtimeBackend'] = 'ROCM'
        self.config.write_text(json.dumps(forged))
        self.assertEqual(InstalledPlamoRuntime(self.directory).metadata('amd', item['identity']['manifestHash']), ('MODEL_MISMATCH', None))

    def test_amd_vulkan_and_rocm_placement_uses_owned_drm_memory_and_exact_selected_backend(self):
        maps = '/proc/987654/maps'
        fdinfo = '/proc/987654/fdinfo'
        info = self.root / 'synthetic-fdinfo'
        info.write_text('drm-driver: amdgpu\ndrm-client-id: 1\ndrm-pdev: 0000:01:00.0\ndrm-memory-vram: 1 KiB\ndrm-memory-gtt: 2 KiB\n')
        original_read, original_iter = Path.read_text, Path.iterdir
        def read(path, *args, **kwargs):
            return '' if str(path) == maps else original_read(path, *args, **kwargs)
        def files(path):
            return iter([info]) if str(path) == fdinfo else original_iter(path)
        for device, backend, expected in [('ROCm0', None, 'ROCM'), ('Vulkan1', 'VULKAN', 'VULKAN')]:
            runtime, _ = self.configured_profile('amd', device, backend)
            self.assertFalse(runtime.invalid)
            with patch('plamo_runtime.Path.read_text', read), patch('plamo_runtime.Path.iterdir', files):
                self.assertEqual(runtime.placement('amd', {987654: 123}), {'backend': expected,
                    'observedOwnedGpuMemoryBytes': 3072, 'source': 'DRM_FDINFO', 'gpuLayersRequested': 10})
        info.write_text('drm-driver: i915\ndrm-client-id: 1\ndrm-memory-vram: 10 MiB\n')
        with patch('plamo_runtime.Path.read_text', read), patch('plamo_runtime.Path.iterdir', files):
            with self.assertRaisesRegex(PlamoError, 'GPU_PLACEMENT_UNVERIFIED'):
                runtime.placement('amd', {987654: 123})

if __name__ == '__main__':
    unittest.main()
