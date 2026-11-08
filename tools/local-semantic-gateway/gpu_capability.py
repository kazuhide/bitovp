"""Pinned, model-free GPU enumeration in the dedicated runtime's OS context."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

RUNTIME_SHA256 = '4a525117528467da41be4188ef8efbc3dbbca9da420fb25cd61cf49d104732fd'
BACKEND_PINS = {
    'nvidia': ('cuda_v13', 'libggml-cuda.so', '64fc38049d7b3d392db02859562c4f5d6f8cb534f5b82df7b2a91d5fd0d5060d'),
    'amd': ('rocm_v7_2', 'libggml-hip.so', 'e391c6eb97e70cd55c14984ff2fa2b4a843b89290ca0d539f9d2ee61e06beefc'),
}
PORTS = {'nvidia': 11435, 'amd': 11436}


class RuntimeGpuCapability:
    def __init__(self, base=None, *, proc=Path('/proc'), run=subprocess.run, now=time.time):
        self.base = base or Path.home() / '.local/share/bitovp-llm-lab'
        self.proc, self.run, self.now = proc, run, now
        self.verified_files = {}

    def pinned(self, file, expected):
        stat = file.stat()
        identity = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        if self.verified_files.get(str(file)) == (identity, expected):
            return True
        digest = hashlib.sha256()
        with file.open('rb') as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            return False
        self.verified_files[str(file)] = (identity, expected)
        return True

    def process(self, profile, binary):
        unit = self.run(['/usr/bin/systemctl', '--user', 'show', f'bitovp-llm-{profile}.service',
                         '--property=MainPID,DevicePolicy', '--no-pager'], check=True, capture_output=True,
                        text=True, timeout=1).stdout
        if len(unit) > 4096:
            raise ValueError('invalid runtime unit metadata')
        properties = dict(line.split('=', 1) for line in unit.splitlines() if line)
        if properties.get('DevicePolicy') != 'auto':
            raise ValueError('unverified runtime device restrictions')
        # systemctl show omits an empty DeviceAllow on supported systemd builds.
        # Require the typed D-Bus empty array; absence is never treated as empty.
        device_allow = self.run(['/usr/bin/busctl', '--user', 'get-property', 'org.freedesktop.systemd1',
                                 f'/org/freedesktop/systemd1/unit/bitovp_2dllm_2d{profile}_2eservice',
                                 'org.freedesktop.systemd1.Service', 'DeviceAllow'], check=True,
                                capture_output=True, text=True, timeout=1).stdout
        if device_allow.strip() != 'a(ss) 0':
            raise ValueError('unverified runtime device restrictions')
        pid = properties.get('MainPID', '')
        if not re.fullmatch(r'[1-9][0-9]{0,9}', pid):
            raise ValueError('inactive runtime')
        folder = self.proc / pid
        if (folder.stat().st_uid != os.getuid() or (folder / 'exe').resolve(strict=True) != binary.resolve(strict=True)
                or (folder / 'cmdline').read_bytes().split(b'\0') != [str(binary).encode(), b'serve', b'']):
            raise ValueError('runtime identity mismatch')
        for name in ('mnt', 'user'):
            if os.readlink(folder / 'ns' / name) != os.readlink(self.proc / 'self/ns' / name):
                raise ValueError('runtime context mismatch')
        def status(path):
            return dict(line.split(':', 1) for line in path.read_text().splitlines() if ':' in line)
        own, runtime = status(self.proc / 'self/status'), status(folder / 'status')
        if (runtime.get('Seccomp', '').strip() != '0'
                or any(runtime.get(key, '').split() != own.get(key, '').split() for key in ('Uid', 'Gid', 'Groups', 'CapEff'))
                or any(key not in runtime or key not in own for key in ('Uid', 'Gid', 'Groups', 'CapEff'))
                or (folder / 'attr/current').read_text() != (self.proc / 'self/attr/current').read_text()):
            raise ValueError('runtime access context mismatch')
        # The exact service must own the fixed loopback listener; a different
        # process returning the same version/model must not borrow its GPU proof.
        address = f'0100007F:{PORTS[profile]:04X}'
        inodes = {parts[9] for row in (self.proc / 'net/tcp').read_text().splitlines()[1:]
                  if len(parts := row.split()) >= 10 and parts[1] == address and parts[3] == '0A'}
        if not any(os.readlink(fd) in {f'socket:[{inode}]' for inode in inodes} for fd in (folder / 'fd').iterdir()):
            raise ValueError('runtime listener mismatch')
        entries = [item.decode().split('=', 1) for item in (folder / 'environ').read_bytes().split(b'\0') if item]
        env = dict(entries)
        if len(entries) != len(env):
            raise ValueError('ambiguous runtime environment')
        expected = {'OLLAMA_HOST': f'127.0.0.1:{PORTS[profile]}', 'OLLAMA_NO_CLOUD': '1',
                    'OLLAMA_VULKAN': '0', 'GGML_VK_VISIBLE_DEVICES': '-1',
                    'OLLAMA_IGPU_ENABLE': '1' if profile == 'amd' else '0'}
        if profile == 'nvidia':
            expected.update(ROCR_VISIBLE_DEVICES='-1', HIP_VISIBLE_DEVICES='-1')
            if not re.fullmatch(r'GPU-[a-fA-F0-9-]{36}', env.get('CUDA_VISIBLE_DEVICES', '')):
                raise ValueError('GPU selector mismatch')
        else:
            expected['CUDA_VISIBLE_DEVICES'] = '-1'
            if (not re.fullmatch(r'[0-9]{1,2}', env.get('ROCR_VISIBLE_DEVICES', ''))
                    or env.get('HIP_VISIBLE_DEVICES') != env['ROCR_VISIBLE_DEVICES']):
                raise ValueError('GPU selector mismatch')
        if (any(env.get(key) != value for key, value in expected.items())
                or env.get('OLLAMA_LLM_LIBRARY', '') not in ('', BACKEND_PINS[profile][0])
                or any(env.get(key) for key in ('LD_PRELOAD', 'LD_AUDIT', 'HSA_OVERRIDE_GFX_VERSION', 'GPU_DEVICE_ORDINAL'))):
            raise ValueError('runtime environment mismatch')
        return folder, (folder / 'stat').read_text().rsplit(')', 1)[1].split()[19], env

    def read(self, profile):
        """No model file, server start, chat, generate, download, unload or shell."""
        try:
            if profile not in BACKEND_PINS:
                return None
            prefix = self.base / 'runtime/0.40.14'
            binary, library_root = prefix / 'bin/ollama', prefix / 'lib/ollama'
            backend, library, expected_hash = BACKEND_PINS[profile]
            if not self.pinned(binary, RUNTIME_SHA256) or not self.pinned(library_root / backend / library, expected_hash):
                return None
            folder, identity, env = self.process(profile, binary)
            # Use the active service's selectors and only the fixed backend's
            # libraries. No request or ambient Gateway environment selects code.
            probe_env = {key: value for key, value in env.items() if key in {
                'CUDA_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES',
                'OLLAMA_IGPU_ENABLE', 'OLLAMA_VULKAN', 'GGML_VK_VISIBLE_DEVICES'}}
            probe_env.update(PATH='/usr/bin:/bin', HOME=str(Path.home()), OLLAMA_NO_CLOUD='1',
                             LD_LIBRARY_PATH=f'{library_root}:{library_root / backend}')
            result = self.run([str(binary), 'gpu-discover', '--lib-dir', str(library_root),
                               '--lib-dir', str(library_root / backend)], env=probe_env, check=True,
                              capture_output=True, text=True, timeout=3)
            if len(result.stdout) > 16_384 or len(result.stderr) > 131_072:
                return None
            devices = json.loads(result.stdout)['devices']
            expected_library = 'CUDA' if profile == 'nvidia' else 'ROCm'
            if not isinstance(devices, list) or not 1 <= len(devices) <= 16:
                return None
            usable = [row for row in devices if isinstance(row, dict)
                      and row.get('library') == expected_library and row.get('index_matches_backend') is True
                      and isinstance(row.get('name'), str) and re.fullmatch(expected_library + r'[0-9]{1,2}', row['name'])
                      and type(row.get('total_memory')) is int and type(row.get('free_memory')) is int
                      and 0 < row['free_memory'] <= row['total_memory']]
            if not usable or self.process(profile, binary)[:2] != (folder, identity):
                return None
            return {'version': 'bitovp-runtime-gpu-capability-v1', 'profile': profile,
                    'method': 'OLLAMA_NATIVE_DISCOVERY', 'backend': expected_library,
                    'observedAt': round(self.now() * 1000)}
        except (OSError, ValueError, KeyError, IndexError, TypeError, subprocess.SubprocessError):
            return None
