#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Kazuhide Yamamoto
"""Adapt the pinned Netflix scalar math for device-only qualification kernels.

This tool never reads a fork, CUDA SDK output, PTX, or cubin. Generated headers
retain upstream notices; source hashes and transformations are recorded beside
them. These initial kernels preserve scalar operation order before parallelizing.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re

PIN = '74f930d17de8c58e7c2ce55e2b897b0030ebd8ef'
EXPECTED = {
    'integer_adm.c': '7633ef5f4d4a770ba10fd7e6cb872f8131fadf1e67e123cc84d2731fb29be07f',
    'integer_adm.h': 'e8fb14f45e1ff1d1e7b336b638bed84d3c57e98df49076c754ef4c52e988d34b',
    'barten_csf_tools.h': 'b59f9aa3fa10e105096d8bd83ec653c5d5ba9495ad84bbe5c52f818a6b24e345',
    'cambi.c': 'e371a621302e5ba06f38f33353a45bde17b85b7f6d67273c0a28a669804bb64f',
    'luminance_tools.h': '903033d5698806dc31ee62782ebcc373e0447609e9e6e06d5d2d877584574815',
    'luminance_tools.c': '6a4de8589771c5efcba5575cf0ded67d724ae82227a9d426bef6916d075ef0e6',
    'cambi.h': 'c406bf7a5cf5c8d90a45a36cf62d35db0450933aca3dfb91c54370e7114ed2df',
    'speed.c': '5acb123d6ea0356453b1faf9ef65a16cf62168ad90b29d8a7e00e32c7d968df2',
    'vif_tools.h': '93df689c478fbb13615f3229b2820a294b0b73315558247cbe977d3721143b46',
    'vif_tools.c': '403215bb215a2473196cb7ef0849403c40bde0a23c353a33205d9f7b57c42bb7',
    'picture_copy.c': 'aa21f7ad63631aee60945e851560ac0b70ae22402e100c88cfda709ae2e6cd48',
}
parser = argparse.ArgumentParser()
parser.add_argument('--upstream', type=Path, required=True)
args = parser.parse_args()
source = args.upstream / 'libvmaf/src/feature'
for filename, expected in EXPECTED.items():
    if hashlib.sha256((source / filename).read_bytes()).hexdigest() != expected:
        raise SystemExit('Source does not match pinned Netflix revision: ' + filename)
destination = Path(__file__).resolve().parent.parent / 'generated'
destination.mkdir(exist_ok=True)
manifest = []

def read(name):
    raw = (source / name).read_bytes()
    manifest.append({'path': 'libvmaf/src/feature/' + name,
        'url': 'https://github.com/Netflix/vmaf/blob/' + PIN + '/libvmaf/src/feature/' + name,
        'sha256': hashlib.sha256(raw).hexdigest()})
    return raw.decode()

def balanced(text, start, opening='{', closing='}'):
    depth = 0
    # All callers point to source declarations/blocks whose braces do not occur
    # in string literals. Comments have no unmatched braces in these sections.
    for i in range(start, len(text)):
        if text[i] == opening: depth += 1
        elif text[i] == closing:
            depth -= 1
            if not depth: return i + 1
    raise ValueError('Unbalanced pinned-source section')

def remove_function(text, name, replacement=None):
    match = re.search(r'(?m)^(?:static\s+)?(?:FORCE_INLINE\s+)?(?:inline\s+)?\w+[\s*]+\b' + name + r'\s*\(', text)
    if not match: return text
    opening = text.index('{', match.start())
    end = balanced(text, opening)
    return text[:match.start()] + (replacement or '') + text[end:]

def remove_block(text, condition):
    start = text.find(condition)
    if start < 0: return text
    opening = text.index('{', start)
    return text[:start] + text[balanced(text, opening):]

def option_table(text, declaration, state):
    start = text.index(declaration)
    opening = text.index('{', start)
    end = balanced(text, opening)
    raw = text[opening + 1:end - 1]
    descriptors, assignments = [], []
    for entry in re.findall(r'\{(.*?)\}', raw, re.S):
        name = re.search(r'\.name\s*=\s*"([^"]+)"', entry)
        field = re.search(r'offsetof\(' + state + r',\s*(\w+)\)', entry)
        default = re.search(r'\.default_val\.([bdis])\s*=\s*([^,\n]+)', entry)
        if not (name and field and default): continue
        n, f, kind, value = name.group(1), field.group(1), default.group(1), default.group(2).strip()
        lo = re.search(r'\.min\s*=\s*([^,\n]+)', entry)
        hi = re.search(r'\.max\s*=\s*([^,\n]+)', entry)
        index = len(descriptors)
        if kind == 's':
            descriptors.append('{"' + n + '",0,0,0,false,true,' + value + '}')
            assignments.append(f'    s->{f} = params->text[{index}][0] ? params->text[{index}] : nullptr;')
        else:
            descriptors.append('{"' + n + '",' + value + ',' +
                (lo.group(1).strip() if lo else '-DBL_MAX') + ',' +
                (hi.group(1).strip() if hi else 'DBL_MAX') + ',' +
                ('true' if kind == 'b' else 'false') + ',false,nullptr}')
            assignments.append(f'    s->{f} = static_cast<decltype(s->{f})>(params->number[{index}]);')
    new = text[:start] + text[end + 1:]
    generated = '\nstatic const Option own_options[] = {\n' + ',\n'.join(descriptors) + '\n};\n'
    generated += '__device__ void own_set_options(' + state + ' *s, Params *params) {\n'
    generated += '\n'.join(assignments) + '\n}\n'
    return new, generated

def adapt(text):
    text = re.sub(r'(?m)^\s*#\s*include[^\n]*\n', '', text)
    text = re.sub(r'\bvoid\s*\*', 'Pointer ', text)
    text = text.replace('__builtin_clz', '__clz')
    text = re.sub(r'(float final_shift\[3\]\s*=\s*\{)(.*?)(\};)',
        lambda m: m.group(1) + m.group(2).replace('pow(', '(float)pow(') + m.group(3), text, flags=re.S)
    text = re.sub(r'(?m)^(\s*#\s*define\s+MAX\()', r'#undef MAX\n\1', text)
    text = text.replace('static int32_t div_lookup[65537];', '#define div_lookup (active_arena()->division_lookup)')
    # Read-only lookup arrays live on the GPU. Scalar const expressions remain
    # host-readable for generated option descriptors and compile-time dimensions.
    text = re.sub(r'(?m)^static const ([^;=]+\[[^=]+)=', r'static __device__ const \1=', text)
    returns = r'(?:void|Pointer|bool|int|float|double|size_t|uint\d+_t|int\d+_t|Vmaf\w+|enum\s+\w+)'
    pattern = r'(?m)^((?:(?:static|FORCE_INLINE|inline|const)\s+)*' + returns + r'\s*\**\s*)([A-Za-z_]\w*)\s*\('
    text = re.sub(pattern, r'__device__ \1\2(', text)
    return text

def emit(name, text, options=''):
    header = ('// Device adaptation of Netflix/vmaf ' + PIN + '.\n'
        '// Scalar pixel math runs on the GPU; no host extractor is invoked.\n'
        '// See source-manifest.json for immutable original sources and hashes.\n')
    all_macros = re.findall(r'(?m)^\s*#\s*define\s+(\w+)', text)
    data = header + '#pragma once\nnamespace bitovp::gpu::scalar_cuda::' + name + ' {\n'
    data += adapt(text) + options
    data += '\n} // namespace\n'
    for macro in dict.fromkeys(all_macros): data += '#undef ' + macro + '\n'
    (destination / (name + '.cuh')).write_text(data)

adm = read('integer_adm.c')
adm, adm_options = option_table(adm, 'static const VmafOption options[]', 'AdmState')
adm = adm[:adm.index('static const char *provided_features[]')]
adm = remove_function(adm, 'init')
adm = remove_function(adm, 'extract')
adm = remove_function(adm, 'close')
adm = adm.replace('if (!buf->data_buf) goto fail;', 'if (!buf->data_buf) return -ENOMEM;')
adm = adm.replace('if (!buf->tmp_ref) goto fail;', 'if (!buf->tmp_ref) return -ENOMEM;')
adm = adm.replace('if (!buf->buf_x_orig) goto fail;', 'if (!buf->buf_x_orig) return -ENOMEM;')
adm = adm.replace('if (!buf->buf_y_orig) goto fail;', 'if (!buf->buf_y_orig) return -ENOMEM;')
adm = adm.replace('fail:\n    adm_buffer_free(buf);\n    return -ENOMEM;\n', '')
adm_header = read('integer_adm.h')
barten = read('barten_csf_tools.h')
emit('adm', adm_header + '\n' + barten + '\n' + adm, adm_options)

cambi = read('cambi.c')
cambi, cambi_options = option_table(cambi, 'static const VmafOption options[]', 'CambiState')
cambi = cambi[:cambi.index('static int close_cambi(')]
cambi = remove_block(cambi, 'if (s->heatmaps_path)')
cambi = remove_function(cambi, 'dump_c_values', '__device__ int dump_c_values(FILE **, const float *, int, int, int, uint16_t, uint16_t, const int *, int) { return -EINVAL; }')
luma_header = read('luminance_tools.h')
luma = read('luminance_tools.c')
# Luminance's file-local clip helper must not collide with cambi.c's helper.
luma = re.sub(r'\bclip\b', 'luminance_clip', luma)
cambi_header = read('cambi.h')
emit('cambi', luma_header + '\n' + luma + '\n' + cambi_header + '\n' + cambi, cambi_options)

speed = read('speed.c')
speed, speed_options = option_table(speed, 'static const VmafOption options_chroma[]', 'SpeedChromaState')
speed = speed[:speed.index('static int close_chroma(')]
vif_header = read('vif_tools.h')
vif = read('vif_tools.c')
picture_copy = read('picture_copy.c')
emit('speed', vif_header + '\n' + vif + '\n' + picture_copy + '\n' + speed, speed_options)

(destination / 'source-manifest.json').write_text(json.dumps({
    'upstream': 'Netflix/vmaf', 'revision': PIN, 'sources': manifest,
    'adaptations': ['CUDA device qualifiers', 'device-local arena allocation',
        'no CPU SIMD paths', 'no filesystem heatmap output',
        'host option descriptors with original defaults',
        'collector emits hashed base feature identifiers for host canonical mapping']
}, indent=2) + '\n')
print('Generated device-only scalar adapters from', len(manifest), 'official source files')
