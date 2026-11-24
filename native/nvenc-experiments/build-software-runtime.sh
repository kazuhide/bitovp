#!/usr/bin/env bash
# Local CPU-only encoding experiments. Uses the worker FFmpeg revision and
# the experiment scorer revision. Distro codec versions are recorded below.
# Debian trixie build dependencies: build-essential ca-certificates curl meson
# ninja-build nasm pkg-config python3 libx264-dev libx265-dev libvpx-dev
# libsvtav1enc-dev libdav1d-dev.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ! ${2:-6} =~ ^[1-9][0-9]*$ ]]; then
    echo 'usage: build-software-runtime.sh NEW_WORK_DIRECTORY [JOBS]' >&2
    exit 2
fi
script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
jobs=${2:-6}
libraries=(x264 x265 vpx SvtAv1Enc dav1d)
pkg-config --print-errors --exists "${libraries[@]}" 'SvtAv1Enc >= 2.0.0'
umask 022
mkdir -- "$1"
cd -- "$1"
prefix="$PWD/prefix"
mkdir -p "$prefix/share/encoding-experiments"
for lib in "${libraries[@]}"; do
    printf '%s %s\n' "$lib" "$(pkg-config --modversion "$lib")"
done > "$prefix/share/encoding-experiments/codec-versions.txt"

fetch() {
    local name=$1 repo=$2 revision=$3 sha=$4
    curl -fsSL --retry 2 --connect-timeout 10 "https://codeload.github.com/$repo/tar.gz/$revision" -o "$name.tar.gz"
    printf '%s  %s\n' "$sha" "$name.tar.gz" | sha256sum -c -
    mkdir "$name"
    tar -xzf "$name.tar.gz" --strip-components=1 -C "$name"
}

fetch vmaf Netflix/vmaf f85a853692a8c730d0270cd733c8bb30b5b93b7c \
    0cafe43e1798e6ba5d47cb1cb475665cd8b81a8f6965ff19112d062449b6bacd
fetch ffmpeg FFmpeg/FFmpeg a35157abb96167fd7308edc92b55408d5bb084b0 \
    0dd30eb8eca5370dc2dad5f9958d9d7221fa4e8a1d407fd06fbc305c15c9314e

meson setup vmaf/build vmaf/libvmaf --prefix "$prefix" --libdir lib --wrap-mode=nodownload \
    --default-library static --buildtype release -Denable_tools=false -Denable_tests=false -Denable_docs=false
meson compile -C vmaf/build -j "$jobs"
meson install -C vmaf/build
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
(
    cd ffmpeg
    printf '%s\n' n8.1.3-34-ga35157abb9 > VERSION
    ./configure --prefix="$prefix" --disable-autodetect --disable-everything --disable-network \
        --disable-doc --disable-debug --disable-ffplay --enable-gpl --enable-version3 --extra-libs='-lstdc++ -lm' \
        --enable-libvmaf --enable-libx264 --enable-libx265 --enable-libvpx --enable-libsvtav1 --enable-libdav1d \
        --enable-protocol=file,pipe --enable-demuxer=matroska,mov --enable-muxer=matroska,mov,mp4,null \
        --enable-parser=h264,hevc,vp9,av1 --enable-decoder=h264,hevc,vp9,libdav1d,ffv1,wrapped_avframe \
        --enable-encoder=libx264,libx265,libvpx_vp9,libsvtav1,wrapped_avframe \
        --enable-indev=lavfi --enable-filter=buffer,buffersink,null,trim,settb,setpts,showinfo,scale,format,libvmaf,testsrc2,setsar,setparams
    make -j"$jobs"
    make install
)

model="$prefix/share/encoding-experiments/vmaf_v0.6.1.json"
install -m 0644 vmaf/model/vmaf_v0.6.1.json "$model"
printf '%s  %s\n' 5950d61fa1f861bd45d8149d80539ed9f3376cfc2495b8f0fa8e9f57cb131ee3 "$model" | sha256sum -c -
BITOVP_SOFTWARE_E2E=1 BITOVP_SOFTWARE_FFMPEG="$prefix/bin/ffmpeg" BITOVP_SOFTWARE_FFPROBE="$prefix/bin/ffprobe" \
    BITOVP_SOFTWARE_VMAF_MODEL="$model" python3 -B "$script_dir/runner_test.py" SoftwareRunnerTest.test_real_cpu_encoder_passes_and_vmaf
printf 'Verified FFmpeg and FFprobe in %s/bin\nVMAF model: %s\n' "$prefix" "$model"
