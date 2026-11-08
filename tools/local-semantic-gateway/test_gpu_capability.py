"""Local filesystem/subprocess fixtures only; never execute a runtime or contact a GPU."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from gpu_capability import RuntimeGpuCapability


class RuntimeGpuCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base, self.proc = self.root / 'lab', self.root / 'proc'
        self.binary = self.base / 'runtime/0.40.14/bin/ollama'
        self.library = self.base / 'runtime/0.40.14/lib/ollama/cuda_v13/libggml-cuda.so'
        for file in (self.binary, self.library):
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'pinned-fixture')
        self.pid = self.proc / '123'
        (self.pid / 'fd').mkdir(parents=True)
        (self.pid / 'exe').symlink_to(self.binary)
        (self.pid / 'fd/9').symlink_to('socket:[987]')
        (self.pid / 'cmdline').write_bytes(str(self.binary).encode() + b'\0serve\0')
        (self.pid / 'stat').write_text('123 (ollama) S ' + '0 ' * 19 + '77')
        (self.proc / 'net').mkdir()
        (self.proc / 'net/tcp').write_text('header\n 0: 0100007F:2CAB 00000000:0000 0A 0 0 0 1000 0 987\n')
        for name in ('mnt', 'user'):
            (self.pid / 'ns').mkdir(exist_ok=True)
            (self.proc / 'self/ns').mkdir(parents=True, exist_ok=True)
            (self.pid / 'ns' / name).symlink_to(name + ':[1]')
            (self.proc / 'self/ns' / name).symlink_to(name + ':[1]')
        status = f'Uid:\t{os.getuid()} {os.getuid()} {os.getuid()} {os.getuid()}\nGid:\t{os.getgid()} {os.getgid()} {os.getgid()} {os.getgid()}\nGroups:\t1 2\nCapEff:\t0000000000000000\nSeccomp:\t0\n'
        for folder in (self.pid, self.proc / 'self'):
            (folder / 'status').write_text(status)
            (folder / 'attr').mkdir()
            (folder / 'attr/current').write_text('unconfined\n')
        self.device_policy = 'auto'
        self.device_allow_response = 'a(ss) 0\n'
        self.env = {'OLLAMA_HOST': '127.0.0.1:11435', 'OLLAMA_NO_CLOUD': '1',
                    'CUDA_VISIBLE_DEVICES': 'GPU-11111111-1111-4111-8111-111111111111',
                    'ROCR_VISIBLE_DEVICES': '-1', 'HIP_VISIBLE_DEVICES': '-1',
                    'OLLAMA_VULKAN': '0', 'GGML_VK_VISIBLE_DEVICES': '-1', 'OLLAMA_IGPU_ENABLE': '0'}
        self.write_env()
        self.run = Mock(side_effect=self.command)
        self.devices = [{'library': 'CUDA', 'name': 'CUDA0', 'index': 0,
                         'index_matches_backend': True, 'total_memory': 16_000, 'free_memory': 10_000}]
        self.pins = patch.multiple('gpu_capability', RUNTIME_SHA256=hashlib.sha256(b'pinned-fixture').hexdigest(),
                                  BACKEND_PINS={'nvidia': ('cuda_v13', 'libggml-cuda.so', hashlib.sha256(b'pinned-fixture').hexdigest())})
        self.pins.start()
        self.addCleanup(self.pins.stop)
        self.gate = RuntimeGpuCapability(self.base, proc=self.proc, run=self.run, now=lambda: 1000)

    def write_env(self):
        (self.pid / 'environ').write_bytes(b'\0'.join((k + '=' + v).encode() for k, v in self.env.items()))

    def command(self, args, **kwargs):
        if args[0] == '/usr/bin/systemctl':
            profile = 'nvidia' if self.env['OLLAMA_HOST'].endswith('11435') else 'amd'
            self.assertEqual(args, ['/usr/bin/systemctl', '--user', 'show', f'bitovp-llm-{profile}.service',
                                    '--property=MainPID,DevicePolicy', '--no-pager'])
            return subprocess.CompletedProcess(args, 0, f'MainPID=123\nDevicePolicy={self.device_policy}\n', '')
        if args[0] == '/usr/bin/busctl':
            profile = 'nvidia' if self.env['OLLAMA_HOST'].endswith('11435') else 'amd'
            self.assertEqual(args, ['/usr/bin/busctl', '--user', 'get-property', 'org.freedesktop.systemd1',
                                    f'/org/freedesktop/systemd1/unit/bitovp_2dllm_2d{profile}_2eservice',
                                    'org.freedesktop.systemd1.Service', 'DeviceAllow'])
            self.assertEqual(kwargs, {'check': True, 'capture_output': True, 'text': True, 'timeout': 1})
            return subprocess.CompletedProcess(args, 0, self.device_allow_response, '')
        self.assertEqual(args, [str(self.binary), 'gpu-discover', '--lib-dir', str(self.library.parent.parent),
                                '--lib-dir', str(self.library.parent)])
        self.assertEqual(kwargs['env']['CUDA_VISIBLE_DEVICES'], self.env['CUDA_VISIBLE_DEVICES'])
        self.assertLessEqual(kwargs['timeout'], 3)
        return subprocess.CompletedProcess(args, 0, json.dumps({'devices': self.devices}), '')

    def test_cold_runtime_uses_same_pinned_backend_without_loading_a_model(self):
        result = self.gate.read('nvidia')
        self.assertEqual(result['backend'], 'CUDA')
        self.assertEqual(result['observedAt'], 1_000_000)
        self.assertEqual(result['method'], 'OLLAMA_NATIVE_DISCOVERY')
        self.assertNotIn('model', json.dumps([call.args for call in self.run.call_args_list]))

    def test_cold_amd_requires_backend_enumeration_not_only_sysfs_metadata(self):
        self.library = self.library.parent.parent / 'rocm_v7_2/libggml-hip.so'
        self.library.parent.mkdir()
        self.library.write_bytes(b'pinned-fixture')
        self.env.update(OLLAMA_HOST='127.0.0.1:11436', CUDA_VISIBLE_DEVICES='-1',
                        ROCR_VISIBLE_DEVICES='0', HIP_VISIBLE_DEVICES='0', OLLAMA_IGPU_ENABLE='1')
        self.write_env()
        (self.proc / 'net/tcp').write_text('header\n 0: 0100007F:2CAC 00000000:0000 0A 0 0 0 1000 0 987\n')
        self.devices = [{**self.devices[0], 'library': 'ROCm', 'name': 'ROCm0'}]
        with patch.dict('gpu_capability.BACKEND_PINS', {'amd': ('rocm_v7_2', 'libggml-hip.so', hashlib.sha256(b'pinned-fixture').hexdigest())}):
            self.assertEqual(self.gate.read('amd')['backend'], 'ROCm')
            self.devices[0].pop('name')
            self.assertIsNone(self.gate.read('amd'))

    def test_cpu_unknown_driver_only_and_empty_memory_never_prove_usable_gpu(self):
        good = self.devices[0]
        for devices in ([], [{'library': 'CPU', 'total_memory': 100}],
                        [{**good, 'name': ''}], [{**good, 'index_matches_backend': False}],
                        [{**good, 'free_memory': 0}], [{**good, 'library': 'ROCm'}]):
            with self.subTest(devices=devices):
                self.devices = devices
                self.assertIsNone(self.gate.read('nvidia'))

    def test_stopped_unowned_listener_and_cpu_forced_profile_fail_closed(self):
        for key, value in [('CUDA_VISIBLE_DEVICES', '-1'), ('OLLAMA_LLM_LIBRARY', 'cpu'), ('OLLAMA_NO_CLOUD', '0')]:
            with self.subTest(key=key):
                old = dict(self.env)
                self.env[key] = value
                self.write_env()
                self.assertIsNone(self.gate.read('nvidia'))
                self.env = old
        self.write_env()
        (self.pid / 'fd/9').unlink()
        self.assertIsNone(self.gate.read('nvidia'))
        self.run.side_effect = subprocess.TimeoutExpired('fixture', 1)
        self.assertIsNone(self.gate.read('nvidia'))

    def test_changed_pinned_binary_or_backend_is_rejected(self):
        for file in (self.binary, self.library):
            file.write_bytes(b'changed')
            self.assertIsNone(self.gate.read('nvidia'))
            file.write_bytes(b'pinned-fixture')

    def test_runtime_cannot_borrow_gateway_gpu_permissions(self):
        original = (self.pid / 'status').read_text()
        for status in (original.replace('Seccomp:\t0', 'Seccomp:\t2'), original.replace('Groups:\t1 2', 'Groups:\t1')):
            (self.pid / 'status').write_text(status)
            self.assertIsNone(self.gate.read('nvidia'))
        (self.pid / 'status').write_text(original)
        (self.pid / 'attr/current').write_text('restricted-runtime\n')
        self.assertIsNone(self.gate.read('nvidia'))
        (self.pid / 'attr/current').write_text('unconfined\n')
        self.device_policy = 'closed'
        self.assertIsNone(self.gate.read('nvidia'))
        self.device_policy, self.device_allow_response = 'auto', 'a(ss) 1 "/dev/another-device" "rw"'
        self.assertIsNone(self.gate.read('nvidia'))

    def test_typed_empty_device_policy_is_required_when_systemctl_omits_empty_property(self):
        # systemctl show on supported Ubuntu omits DeviceAllow even with --all.
        # Only D-Bus' explicit typed empty array establishes no device allowlist.
        self.assertIsNotNone(self.gate.read('nvidia'))
        for response in ('', 'a(ss)', 'as 0', 'a(ss) 0 trailing', 'a(ss) 1 "/dev/dri/renderD128" "rw"'):
            with self.subTest(response=response):
                self.device_allow_response = response
                self.assertIsNone(self.gate.read('nvidia'))

    def test_runtime_namespace_and_pid_replacement_cannot_borrow_a_gpu(self):
        (self.pid / 'ns/mnt').unlink()
        (self.pid / 'ns/mnt').symlink_to('mnt:[other]')
        self.assertIsNone(self.gate.read('nvidia'))
        (self.pid / 'ns/mnt').unlink()
        (self.pid / 'ns/mnt').symlink_to('mnt:[1]')
        original = self.command
        def replace_pid(args, **kwargs):
            result = original(args, **kwargs)
            if args[0] == str(self.binary):
                (self.pid / 'stat').write_text('123 (ollama) S ' + '1 ' * 22)
            return result
        self.run.side_effect = replace_pid
        self.assertIsNone(self.gate.read('nvidia'))


if __name__ == '__main__':
    unittest.main()
