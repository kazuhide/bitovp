"""Translation-only installed runtime. No downloads or arbitrary caller commands.

Model processes belong to dedicated systemd user cgroups, never Gateway's 256M
cgroup. Nothing is installed or started by importing or constructing this module.
"""
from __future__ import annotations
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time
import uuid

STAGE = 'LOCAL_PLAMO_CAPTION_JA_V1'
PORTS = {'nvidia': 11438, 'amd': 11439}
DEFAULT_BACKENDS = {'nvidia': 'CUDA', 'amd': 'ROCM'}
BACKEND_DEVICES = {'CUDA': 'CUDA', 'ROCM': 'ROCm', 'VULKAN': 'Vulkan'}
PROMPT = 'plamo-pfml3-caption-v1'
SHA = re.compile(r'^[a-f0-9]{64}$')
REV = re.compile(r'^[a-f0-9]{40}$')
SAFE_PATH = re.compile(r'^/[A-Za-z0-9_./-]+$')
# Compiled core contract pins, not values supplied by an API caller or model.
PINS = {'templateHash': 'c9e9cb64b08d20a27fd455a837478f9f8a00bf84be0aada69f8f8ed1d5edb51b',
        'contextPolicyFingerprint': '3f635f2d95715b292bc559c9a2e6e92f3320cd85f248ad2642e157592a287913',
        'validationPolicyFingerprint': 'f1770a01029cb8739c6cbbf1ab4a67ff2c212a46d751395ee3b9f8406c7dcd6c',
        'schemaHash': 'f6b3d104fc0b74f8253d98b8ee690c861ad0e2bfd83411344111faf9c2624d33'}

def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()

class PlamoError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code

def regular(path, private=False):
    path = Path(path)
    if not SAFE_PATH.fullmatch(str(path)) or path.is_symlink() or path.resolve() != path:
        raise PlamoError('MODEL_MISMATCH')
    st = path.stat()
    if not path.is_file() or st.st_uid != os.getuid() or st.st_mode & (0o077 if private else 0o022):
        raise PlamoError('MODEL_MISMATCH')
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)

def hash_file(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()

def validate_identity(identity, manifest, profile):
    fields = {'version', 'provider', 'profile', 'modelId', 'sourceRevision', 'weightSha256', 'quantization',
              'runtimeSourceRevision', 'runtimeBinarySha256', 'promptTemplateHash', 'configId', 'context',
              'maxOutputTokens', 'temperature', 'seed', 'thinking', 'promptVersion', 'contextPolicyFingerprint',
              'validationPolicyFingerprint', 'schemaHash', 'manifestHash', 'weightBytes'}
    optional = {'conversionRecipeHash', 'runtimeBuildRecipeHash', 'runtimeBackend'}
    if not isinstance(identity, dict) or set(identity) - optional != fields:
        raise PlamoError('MODEL_MISMATCH')
    runtime = manifest['runtimes'].get(profile)
    expected = {'version': 'local-caption-model-v3', 'provider': 'LOCAL_LLAMA_CPP', 'profile': profile,
                'modelId': 'pfnet/plamo-3-translate-31b', 'sourceRevision': '01eac57bf80ef8114decd998f8f3a803ba795557',
                'context': 8192, 'maxOutputTokens': 1536, 'temperature': 0, 'seed': 41, 'thinking': False,
                'promptVersion': PROMPT, 'manifestHash': digest(manifest),
                'validationPolicyFingerprint': PINS['validationPolicyFingerprint'], 'schemaHash': PINS['schemaHash'],
                **{key: manifest[key] for key in ('configId', 'weightSha256', 'weightBytes', 'quantization', 'promptTemplateHash', 'contextPolicyFingerprint')}}
    if not isinstance(runtime, dict):
        raise PlamoError('MODEL_MISMATCH')
    expected.update(runtimeSourceRevision=runtime['sourceRevision'], runtimeBinarySha256=runtime['binarySha256'])
    for public, private in [('conversionRecipeHash', 'conversionRecipeHash')]:
        if public in manifest:
            expected[private] = manifest[public]
    if 'buildRecipeHash' in runtime:
        expected['runtimeBuildRecipeHash'] = runtime['buildRecipeHash']
    if 'backend' in runtime:
        expected['runtimeBackend'] = runtime['backend']
    if (any(identity.get(k) != v for k, v in expected.items())
            or any((k in identity) != (k in expected) or (k in identity and identity[k] != expected[k]) for k in optional)
            or any(not isinstance(identity.get(k), str) or not SHA.fullmatch(identity[k]) for k in
                   ('weightSha256', 'runtimeBinarySha256', 'promptTemplateHash', 'contextPolicyFingerprint', 'validationPolicyFingerprint', 'schemaHash', 'manifestHash'))
            or not REV.fullmatch(identity['runtimeSourceRevision']) or type(identity['thinking']) is not bool):
        raise PlamoError('MODEL_MISMATCH')
    return identity

def validate_manifest(value):
    fields = {'version', 'configId', 'modelId', 'sourceRevision', 'weightSha256', 'weightBytes', 'quantization', 'promptTemplateHash', 'contextPolicyFingerprint', 'runtimes'}
    if (not isinstance(value, dict) or set(value) - {'conversionRecipeHash'} != fields
            or value['version'] != 'bitovp-plamo-installed-manifest-v1'
            or value['modelId'] != 'pfnet/plamo-3-translate-31b'
            or value['sourceRevision'] != '01eac57bf80ef8114decd998f8f3a803ba795557'
            or value['promptTemplateHash'] != PINS['templateHash'] or value['contextPolicyFingerprint'] != PINS['contextPolicyFingerprint']
            or type(value['weightBytes']) is not int or not 0 < value['weightBytes'] <= 128 * 1024**3
            or value['quantization'] not in ('BF16', 'F16', 'Q8_0', 'Q4_K_M')
            or not isinstance(value['runtimes'], dict) or not value['runtimes'] or set(value['runtimes']) - set(PORTS)):
        raise PlamoError('MODEL_MISMATCH')
    try:
        if str(uuid.UUID(value['configId'])) != value['configId']:
            raise ValueError()
    except (ValueError, TypeError):
        raise PlamoError('MODEL_MISMATCH')
    for name in ('weightSha256', 'promptTemplateHash', 'contextPolicyFingerprint', 'conversionRecipeHash'):
        if name in value and (not isinstance(value[name], str) or not SHA.fullmatch(value[name])):
            raise PlamoError('MODEL_MISMATCH')
    for profile, runtime in value['runtimes'].items():
        if (not isinstance(runtime, dict) or set(runtime) - {'buildRecipeHash', 'backend'} != {'sourceRevision', 'binarySha256'}
                or runtime.get('backend', DEFAULT_BACKENDS[profile]) not in (('CUDA',) if profile == 'nvidia' else ('ROCM', 'VULKAN'))
                or not isinstance(runtime['sourceRevision'], str) or not REV.fullmatch(runtime['sourceRevision'])
                or any(not isinstance(runtime[key], str) or not SHA.fullmatch(runtime[key]) for key in runtime if key not in ('sourceRevision', 'backend'))):
            raise PlamoError('MODEL_MISMATCH')
    return value

def unit_name(profile):
    if profile not in PORTS:
        raise PlamoError('MODEL_MISMATCH')
    return 'bitovp-plamo-caption-' + profile + '.service'

def installation_recipe_hash(profile, item):
    """Opaque public pin; ordered private search paths remain private but affect identity."""
    return digest({'version': 'plamo-dedicated-runtime-v4', 'profile': profile,
                   'binarySha256': item['identity']['runtimeBinarySha256'],
                   'binaryPathHash': digest(item['binaryPath']),
                   'libraryBindings': sorted([{'pathHash': digest(library['path']), 'sha256': library['sha256']}
                                              for library in item['libraries']], key=lambda row: row['pathHash']),
                   'libraryDirectoryOrderHash': digest(item['libraryDirectories']),
                   'gpuLayers': item['gpuLayers'], 'gpuDevice': item['gpuDevice'],
                   'memoryMaxBytes': item['memoryMaxBytes'], 'context': 8192})

def runtime_argv(profile, item):
    return ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LD_LIBRARY_PATH=' + ':'.join(item['libraryDirectories']),
            item['binaryPath'], '--model', item['weightsPath'], '--host', '127.0.0.1', '--port', str(PORTS[profile]),
            '--ctx-size', '8192', '--parallel', '1', '--n-gpu-layers', str(item['gpuLayers']),
            '--device', item['gpuDevice'], '--fit', 'off', '--no-warmup', '--no-context-shift',
            '--no-cache-prompt', '--cache-ram', '0', '--no-webui', '--no-agent', '--no-jinja',
            '--offline', '--log-disable', '--threads-http', '2']

def render_unit(profile, item):
    """Pure recipe: operator must explicitly install it after licensing/artifact checks."""
    return ('[Unit]\nDescription=BitOVP dedicated PLaMo caption ' + profile + '\n'
            'BindsTo=bitovp-semantic-gateway.service\nAfter=bitovp-semantic-gateway.service\n\n'
            '[Service]\nType=simple\nExecStart=' + ' '.join(runtime_argv(profile, item)) + '\n'
            'Restart=no\nKillMode=control-group\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=yes\n'
            'StandardOutput=null\nStandardError=null\nMemoryMax=' + str(item['memoryMaxBytes']) + '\n'
            'MemorySwapMax=0\nTasksMax=128\n')

class InstalledPlamoRuntime:
    def __init__(self, directory):
        self.directory, self.profiles, self.snapshots, self.invalid = Path(directory), {}, {}, False
        config = self.directory / 'plamo-private.json'
        if not config.exists():
            return
        try:
            signature = regular(config, True)
            if signature[2] > 32768:
                raise PlamoError('MODEL_MISMATCH')
            value = json.loads(config.read_text(), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if set(value) != {'version', 'manifest', 'profiles'} or value['version'] != 'bitovp-plamo-private-v1':
                raise PlamoError('MODEL_MISMATCH')
            manifest = validate_manifest(value['manifest'])
            if not isinstance(value['profiles'], dict) or not value['profiles'] or set(value['profiles']) - set(manifest['runtimes']):
                raise PlamoError('MODEL_MISMATCH')
            for profile, item in value['profiles'].items():
                backend = manifest['runtimes'][profile].get('backend', DEFAULT_BACKENDS[profile])
                required = {'identity', 'binaryPath', 'weightsPath', 'libraries', 'libraryDirectories', 'gpuLayers', 'gpuDevice', 'memoryMaxBytes'}
                if (not isinstance(item, dict) or set(item) != required or type(item['gpuLayers']) is not int or not 1 <= item['gpuLayers'] <= 999
                        or type(item['memoryMaxBytes']) is not int or not manifest['weightBytes'] + 2 * 1024**3 <= item['memoryMaxBytes'] <= 80 * 1024**3
                        or not isinstance(item['gpuDevice'], str) or not re.fullmatch(BACKEND_DEVICES[backend] + r'[0-9]+', item['gpuDevice'])
                        or not isinstance(item['libraries'], list) or not 1 <= len(item['libraries']) <= 128
                        or not isinstance(item['libraryDirectories'], list) or not 1 <= len(item['libraryDirectories']) <= 8):
                    raise PlamoError('MODEL_MISMATCH')
                identity = validate_identity(item['identity'], manifest, profile)
                if identity.get('runtimeBuildRecipeHash') != installation_recipe_hash(profile, item):
                    raise PlamoError('MODEL_MISMATCH')
                lab = self.directory.parent / 'plamo'
                files = [(item['binaryPath'], identity['runtimeBinarySha256']), (item['weightsPath'], identity['weightSha256'])]
                for library in item['libraries']:
                    if not isinstance(library, dict) or set(library) != {'path', 'sha256'} or not SHA.fullmatch(library['sha256']):
                        raise PlamoError('MODEL_MISMATCH')
                    files.append((library['path'], library['sha256']))
                for path, expected_hash in files:
                    path = Path(path)
                    if not path.is_relative_to(lab) or path.resolve() != path:
                        raise PlamoError('MODEL_MISMATCH')
                    before = regular(path)
                    if hash_file(path) != expected_hash or regular(path) != before:
                        raise PlamoError('MODEL_MISMATCH')
                    self.snapshots[str(path)] = before
                if not os.access(item['binaryPath'], os.X_OK):
                    raise PlamoError('MODEL_MISMATCH')
                if regular(item['weightsPath'])[2] != manifest['weightBytes']:
                    raise PlamoError('MODEL_MISMATCH')
                for path in item['libraryDirectories']:
                    if (not SAFE_PATH.fullmatch(path) or Path(path).resolve() != Path(path) or not Path(path).is_relative_to(lab) or not Path(path).is_dir()
                            or Path(path).stat().st_uid != os.getuid() or Path(path).stat().st_mode & 0o022):
                        raise PlamoError('MODEL_MISMATCH')
                self.profiles[profile] = item
            if regular(config, True) != signature:
                raise PlamoError('MODEL_MISMATCH')
            self.snapshots[str(config)] = signature
            self.validate_loader_roots()
        except Exception:
            self.profiles, self.invalid = {}, True

    def validate_loader_roots(self):
        # Loader aliases/unlisted files must not choose a different already-pinned library.
        roots = set()
        for item in self.profiles.values():
            roots.update(item['libraryDirectories'])
            roots.add(str(Path(item['binaryPath']).parent))
            roots.update(str(Path(library['path']).parent) for library in item['libraries'])
        entries = 0
        for directory in sorted(roots):
            path = Path(directory)
            st = path.stat()
            if path.resolve() != path or not path.is_dir() or st.st_uid != os.getuid() or st.st_mode & 0o022:
                raise PlamoError('MODEL_MISMATCH')
            with os.scandir(path) as scan:
                for entry in scan:
                    entries += 1
                    # Flat roots forbid hwcaps without recursively or eagerly enumerating children.
                    if entries > 512 or entry.is_symlink() or not entry.is_file(follow_symlinks=False) or entry.path not in self.snapshots:
                        raise PlamoError('MODEL_MISMATCH')

    @staticmethod
    def systemctl(*args):
        return subprocess.run(['/usr/bin/systemctl', '--user', *args], capture_output=True, text=True, timeout=25, check=True, env={'PATH': '/usr/bin:/bin', 'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid()), 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(os.getuid()) + '/bus'}).stdout

    def unit(self, profile):
        item = self.profiles[profile]
        path = Path.home() / '.config/systemd/user' / unit_name(profile)
        regular(path)
        if path.read_text() != render_unit(profile, item):
            raise PlamoError('MODEL_MISMATCH')
        raw = self.systemctl('show', unit_name(profile), '--property=LoadState,FragmentPath,DropInPaths,NeedDaemonReload,ExecStart,Type,KillMode,Restart,ActiveState,MainPID,InvocationID,ControlGroup,MemoryMax,MemorySwapMax,BindsTo')
        values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        expected = {'LoadState': 'loaded', 'FragmentPath': str(path), 'DropInPaths': '', 'NeedDaemonReload': 'no', 'Type': 'simple', 'KillMode': 'control-group', 'Restart': 'no', 'MemoryMax': str(item['memoryMaxBytes']), 'MemorySwapMax': '0'}
        argv = ' '.join(runtime_argv(profile, item))
        if (any(values.get(k) != v for k, v in expected.items()) or 'bitovp-semantic-gateway.service' not in values.get('BindsTo', '').split()
                or not re.search(r'argv\[\]=' + re.escape(argv) + r' ;', values.get('ExecStart', ''))):
            raise PlamoError('MODEL_MISMATCH')
        return values

    def metadata(self, profile, expected_hash):
        try:
            if self.invalid:
                raise PlamoError('MODEL_MISMATCH')
            item = self.profiles.get(profile)
            if item is None:
                return 'MODEL_NOT_INSTALLED', None
            if item['identity']['manifestHash'] != expected_hash:
                raise PlamoError('MODEL_MISMATCH')
            if any(regular(path, path.endswith('plamo-private.json')) != before for path, before in self.snapshots.items()):
                raise PlamoError('MODEL_MISMATCH')
            self.validate_loader_roots()
            self.unit(profile)
            return 'READY', item['identity']
        except PlamoError as error:
            return error.code, None
        except FileNotFoundError:
            return 'MODEL_NOT_INSTALLED', None
        except Exception:
            return 'RUNTIME_UNAVAILABLE', None

    @staticmethod
    def process_signature(pid):
        # comm can contain spaces/parentheses; fields after its last ')' are stable.
        raw = (Path('/proc') / str(pid) / 'stat').read_text()
        return int(raw[raw.rfind(')') + 2:].split()[19])

    @staticmethod
    def cgroup_pids(profile):
        group = Path('/sys/fs/cgroup') / f'user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/app.slice/{unit_name(profile)}'
        return [int(pid) for pid in (group / 'cgroup.procs').read_text().split()] if group.exists() else []

    @staticmethod
    def verify_listener_rows(profile, rows, owned_inodes):
        listeners = []
        for row in rows.splitlines()[1:]:
            parts = row.split()
            if len(parts) > 9 and parts[1] == '0100007F:' + format(PORTS[profile], '04X') and parts[3] == '0A':
                listeners.append(parts[9])
        if len(listeners) != 1 or listeners[0] not in owned_inodes:
            raise PlamoError('GPU_PLACEMENT_UNVERIFIED')

    def verify_listener(self, profile, processes):
        owned = set()
        for pid in processes:
            for fd in (Path('/proc') / str(pid) / 'fd').iterdir():
                try:
                    match = re.fullmatch(r'socket:\[(\d+)\]', os.readlink(fd))
                    if match: owned.add(match[1])
                except FileNotFoundError:
                    pass
        self.verify_listener_rows(profile, Path('/proc/net/tcp').read_text(), owned)

    def unit_processes(self, profile, values):
        group = f'/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/app.slice/{unit_name(profile)}'
        if values.get('ControlGroup') != group:
            raise PlamoError('GPU_PLACEMENT_UNVERIFIED')
        pids = [int(p) for p in (Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.procs').read_text().split()]
        main = int(values.get('MainPID', '0'))
        if main <= 0 or main not in pids:
            raise PlamoError('GPU_PLACEMENT_UNVERIFIED')
        return {pid: self.process_signature(pid) for pid in pids}

    def processes(self, profile, values):
        snapshot = self.unit_processes(profile, values)
        main = int(values['MainPID'])
        item = self.profiles[profile]
        if hash_file(Path('/proc') / str(main) / 'exe') != item['identity']['runtimeBinarySha256']:
            raise PlamoError('GPU_PLACEMENT_UNVERIFIED')
        expected = runtime_argv(profile, item)[4:]
        actual = (Path('/proc') / str(main) / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
        if actual != expected:
            raise PlamoError('GPU_PLACEMENT_UNVERIFIED')
        return snapshot

    def exec_pending(self, profile, values):
        """Only the exact env launcher of this already captured unit may be transient."""
        try:
            main = int(values['MainPID'])
            return (hash_file(Path('/proc') / str(main) / 'exe') == hash_file('/usr/bin/env')
                    and (Path('/proc') / str(main) / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0') == runtime_argv(profile, self.profiles[profile]))
        except (OSError, ValueError):
            return False

    def placement(self, profile, processes):
        if any(regular(path, path.endswith('plamo-private.json')) != before for path, before in self.snapshots.items()):
            raise PlamoError('MODEL_MISMATCH')
        # Every mapped lab binary/library/weight must be part of the pinned private closure.
        lab = (self.directory.parent / 'plamo').resolve()
        for pid in processes:
            for line in (Path('/proc') / str(pid) / 'maps').read_text().splitlines():
                parts = line.split(None, 5)
                if len(parts) == 6 and parts[5].startswith(str(lab) + '/'):
                    if parts[5] not in self.snapshots:
                        raise PlamoError('GPU_PLACEMENT_UNVERIFIED')
        total = 0
        if profile == 'nvidia':
            raw = subprocess.run(['/usr/bin/nvidia-smi', '--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5, check=True).stdout
            for line in raw.splitlines():
                match = re.fullmatch(r'\s*(\d+)\s*,\s*(\d+)\s*', line)
                if match and int(match[1]) in processes:
                    total += int(match[2]) * 1024**2
        else:
            clients = {}
            for pid in processes:
                for file in (Path('/proc') / str(pid) / 'fdinfo').iterdir():
                    fields = dict(line.split(':', 1) for line in file.read_text().splitlines() if ':' in line)
                    if fields.get('drm-driver', '').strip() != 'amdgpu' or 'drm-client-id' not in fields:
                        continue
                    memory = 0
                    for key in ('drm-memory-vram', 'drm-memory-gtt'):
                        match = re.fullmatch(r'\s*(\d+)\s+(KiB|MiB|bytes)\s*', fields.get(key, ''))
                        if match:
                            memory += int(match[1]) * {'bytes': 1, 'KiB': 1024, 'MiB': 1024**2}[match[2]]
                    client = (fields.get('drm-pdev', '').strip(), fields['drm-client-id'].strip())
                    clients[client] = max(clients.get(client, 0), memory)
            total = sum(clients.values())
        if total <= 0:
            raise PlamoError('GPU_PLACEMENT_UNVERIFIED')
        return {'backend': self.profiles[profile]['identity'].get('runtimeBackend', DEFAULT_BACKENDS[profile]), 'observedOwnedGpuMemoryBytes': total,
                'source': 'NVIDIA_PROCESS_QUERY' if profile == 'nvidia' else 'DRM_FDINFO', 'gpuLayersRequested': self.profiles[profile]['gpuLayers']}

    @staticmethod
    def request(profile, route, payload=None, control=None):
        if profile not in PORTS or route not in ('/health', '/completion'):
            raise PlamoError('RUNTIME_FAILED')
        connection = http.client.HTTPConnection('127.0.0.1', PORTS[profile], timeout=5)
        result, wire, guard, cancel = {}, {}, threading.Lock(), threading.Event()
        def send():
            try:
                connection.connect()
                with guard:
                    if cancel.is_set():
                        return
                    wire['socket'] = connection.sock
                    connection.sock.settimeout(900 if control else 5)
                connection.request('POST' if payload is not None else 'GET', route, body=canonical(payload).encode() if payload is not None else None, headers={'Content-Type': 'application/json', 'Connection': 'close'})
                response = connection.getresponse()
                raw = response.read(128 * 1024 + 1)
                if response.status != 200 or len(raw) > 128 * 1024:
                    raise PlamoError('RUNTIME_FAILED')
                value = json.loads(raw)
                if not isinstance(value, dict) or value.get('error'):
                    raise PlamoError('RUNTIME_FAILED')
                result['value'] = value
            except Exception:
                result['error'] = True
            finally:
                connection.close()
        thread = threading.Thread(target=send, daemon=True)
        thread.start()
        try:
            while thread.is_alive():
                if control:
                    control.check()
                thread.join(.1)
        except Exception:
            cancel.set()
            with guard:
                if wire.get('socket'):
                    try: wire['socket'].shutdown(socket.SHUT_RDWR)
                    except OSError: pass
            thread.join(6)
            raise
        if result.get('error') or 'value' not in result:
            raise PlamoError('RUNTIME_FAILED')
        return result['value']

    def stop(self, profile, processes, main_identity):
        current = self.unit(profile)  # Refuse changed effective configuration before touching this fixed unit.
        if main_identity is None:
            raise PlamoError('CLEANUP_FAILED')
        owned = dict(processes)
        if main_identity[1] in owned and owned[main_identity[1]] != main_identity[2]:
            raise PlamoError('CLEANUP_FAILED')
        owned[main_identity[1]] = main_identity[2]
        def ended():
            if self.cgroup_pids(profile):
                raise PlamoError('CLEANUP_FAILED')
            for pid, start in owned.items():
                try:
                    if self.process_signature(pid) == start:
                        raise PlamoError('CLEANUP_FAILED')
                except FileNotFoundError:
                    pass
        def terminal(state):
            return (state.get('ActiveState') in ('inactive', 'failed') and state.get('MainPID') == '0'
                    and state.get('InvocationID') in (main_identity[0], ''))
        main = int(current.get('MainPID', '0'))
        if main == 0:
            # Already ended is a physical release proof, never permission to stop a later unit invocation.
            if not terminal(current):
                raise PlamoError('CLEANUP_FAILED')
            ended()
            return
        if ((current.get('InvocationID'), main, self.process_signature(main)) != main_identity
                or main not in owned or owned[main] != main_identity[2]):
            raise PlamoError('CLEANUP_FAILED')
        self.systemctl('stop', unit_name(profile))
        state = self.unit(profile)
        if not terminal(state):
            raise PlamoError('CLEANUP_FAILED')
        ended()

    def run(self, profile, body, control):
        code, identity = self.metadata(profile, body['manifestHash'])
        if code != 'READY':
            raise PlamoError(code)
        if body['schemaHash'] != identity['schemaHash']:
            raise PlamoError('MODEL_MISMATCH')
        for other in self.profiles:
            state = self.unit(other)
            if state.get('ActiveState') != 'inactive' or state.get('MainPID') != '0' or self.cgroup_pids(other):
                raise PlamoError('RESOURCE_BUSY')
        started, attempted, processes, main_identity = time.monotonic(), False, {}, None
        def capture(values):
            nonlocal main_identity
            invocation = values.get('InvocationID')
            if not isinstance(invocation, str) or not re.fullmatch(r'[a-f0-9]{32}', invocation) or invocation == '0' * 32:
                raise PlamoError('CLEANUP_FAILED')
            main = int(values['MainPID'])
            if main <= 0:
                raise PlamoError('CLEANUP_FAILED')
            identity = (invocation, main, self.process_signature(main))
            if main_identity is not None and identity != main_identity:
                raise PlamoError('CLEANUP_FAILED')
            if main_identity is None:
                main_identity = identity
            observed = self.unit_processes(profile, values)
            if observed.get(main) != identity[2]:
                raise PlamoError('CLEANUP_FAILED')
            if any(pid in processes and processes[pid] != start for pid, start in observed.items()):
                raise PlamoError('CLEANUP_FAILED')
            # Existing signatures have been compared; none may be overwritten by a replacement.
            processes.update(observed)
        try:
            control.check()
            attempted = True
            self.systemctl('start', unit_name(profile))
            exec_deadline = time.monotonic() + 5
            while True:
                if main_identity is not None:
                    control.check()
                values = self.unit(profile)
                try:
                    capture(values)
                    validated = self.processes(profile, values)
                    if any(pid in processes and processes[pid] != start for pid, start in validated.items()):
                        raise PlamoError('CLEANUP_FAILED')
                    processes.update(validated)
                except PlamoError as error:
                    if error.code == 'GPU_PLACEMENT_UNVERIFIED' and time.monotonic() < exec_deadline:
                        if self.exec_pending(profile, values):
                            time.sleep(.05)
                            continue
                        # The launcher can exec after the first probe but before exec_pending.
                        # Re-prove the same owner and expected binary/argv before rejoining the loop.
                        current = self.unit(profile)
                        capture(current)
                        validated = self.processes(profile, current)
                        if any(pid in processes and processes[pid] != start for pid, start in validated.items()):
                            raise PlamoError('CLEANUP_FAILED')
                        processes.update(validated)
                        continue
                    raise
                control.check()
                try:
                    if self.request(profile, '/health').get('status') == 'ok':
                        break
                except PlamoError:
                    pass
                time.sleep(.2)
            ready_ms = (time.monotonic() - started) * 1000
            code, _ = self.metadata(profile, body['manifestHash'])
            if code != 'READY':
                raise PlamoError(code)
            # Confirm the loaded dependency/GPU projection before sending any caption data.
            self.placement(profile, processes)
            self.verify_listener(profile, processes)
            response = self.request(profile, '/completion', {'prompt': body['prompt'], 'stream': False, 'n_predict': 1536,
                'temperature': 0, 'seed': 41, 'cache_prompt': False, 'stop': ['<|plamo:tag|>', '<|plamo:bos|>']}, control)
            control.check()
            content, timings = response.get('content'), response.get('timings')
            if (not isinstance(content, str) or not 0 < len(content.encode()) <= 16384 or response.get('stop_type') not in ('eos', 'word')
                    or response.get('truncated') is not False or not isinstance(timings, dict)):
                raise PlamoError('OUTPUT_INVALID')
            for field in ('prompt_n', 'predicted_n', 'prompt_ms', 'predicted_ms'):
                number = timings.get(field)
                if type(number) not in (int, float) or not math.isfinite(number) or number < 0 or (field.endswith('_n') and type(number) is not int):
                    raise PlamoError('OUTPUT_INVALID')
            if timings['prompt_n'] > 6656 or timings['predicted_n'] > 1536:
                raise PlamoError('OUTPUT_INVALID')
            placement = self.placement(profile, processes)
            return content, identity, ready_ms, {'promptEvalCount': timings['prompt_n'], 'evalCount': timings['predicted_n'],
                'promptEvalMs': timings['prompt_ms'], 'evalMs': timings['predicted_ms'], 'doneReason': 'stop'}, placement
        finally:
            if attempted:
                try:
                    current = self.unit(profile)
                    if int(current.get('MainPID', '0')) > 0:
                        # Never establish a new owner during cleanup or replace the first owner.
                        if main_identity is None:
                            raise PlamoError('CLEANUP_FAILED')
                        capture(current)
                    elif self.cgroup_pids(profile):
                        raise PlamoError('CLEANUP_FAILED')
                    self.stop(profile, processes, main_identity)
                except Exception as error:
                    raise PlamoError('CLEANUP_FAILED') from error
