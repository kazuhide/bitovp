#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ! ${2:-6} =~ ^[1-9][0-9]*$ ]]; then
    printf 'usage: %s NEW_WORK_DIRECTORY [JOBS]\n' "$0" >&2
    exit 2
fi
jobs=${2:-6}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
umask 077
mkdir -- "$1"
cd -- "$1"
work_dir=$(pwd -P)
prefix="$work_dir/prefix"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"

fetch() {
    local name=$1 repository=$2 revision=$3 hash=$4
    curl -fsSL --retry 2 --connect-timeout 10 \
        "https://codeload.github.com/$repository/tar.gz/$revision" -o "$name.tar.gz"
    printf '%s  %s\n' "$hash" "$name.tar.gz" | sha256sum -c -
    mkdir "$name"
    tar -xzf "$name.tar.gz" --strip-components=1 -C "$name"
}

# The libvmaf release requires newer CUDA loader bindings than n13.0.19.0.
# This commit keeps the same Video Codec SDK 13.0 nvEncodeAPI.h.
fetch nv-codec-headers FFmpeg/nv-codec-headers \
    876af32a202d0de83bd1d36fe74ee0f7fcf86b0d \
    5e83af9e86efe7a1f4393ef342a299e5e7ca9f57fe210307afed3ae0f39d4a3f
make -C nv-codec-headers PREFIX="$prefix" install

fetch dav1d videolan/dav1d \
    42b2b24fb8819f1ed3643aa9cf2a62f03868e3aa \
    e26d41e2f496c1598f418726b871ce252ce9f18f8dbe3ad199349a42ed2cb02f
meson setup dav1d/build dav1d --prefix "$prefix" --libdir lib \
    --default-library static --buildtype release -Denable_tools=false -Denable_tests=false
meson compile -C dav1d/build -j "$jobs"
meson install -C dav1d/build

fetch vmaf Netflix/vmaf \
    f85a853692a8c730d0270cd733c8bb30b5b93b7c \
    0cafe43e1798e6ba5d47cb1cb475665cd8b81a8f6965ff19112d062449b6bacd
(
    cd vmaf/libvmaf
    CFLAGS="-I\"$prefix/include\"" meson setup build --prefix "$prefix" --libdir lib \
        --default-library static --buildtype release -Denable_cuda=true -Denable_nvcc=true \
        -Denable_tools=false -Denable_tests=false -Denable_docs=false
    NVCC_PREPEND_FLAGS="-I\"$prefix/include\"" meson compile -C build -j "$jobs"
    meson install -C build
)

fetch ffmpeg FFmpeg/FFmpeg \
    894da5ca7d742e4429ffb2af534fcda0103ef593 \
    9dad3557314f1b7923b61aff15e30079e964c3b41276bbd43dd8bb15b8028b5f
python3 -B "$script_dir/sdk/prepare_ffmpeg.py" "$work_dir/ffmpeg"
(
    cd ffmpeg
    ./configure --prefix="$prefix" --disable-autodetect --disable-everything --disable-network \
        --disable-doc --disable-ffplay --enable-nonfree --enable-libvmaf --enable-libdav1d \
        --enable-ffnvcodec --enable-cuda-nvcc --enable-cuvid --enable-nvdec --enable-nvenc \
        --nvccflags='-gencode arch=compute_75,code=compute_75 -O2' \
        --pkg-config-flags=--static --extra-libs='-lstdc++ -ldl' \
        --enable-protocol=file,pipe --enable-demuxer=matroska,mov --enable-muxer=matroska,null \
        --enable-parser=h264,hevc,av1 \
        --enable-decoder=h264,hevc,libdav1d,ffv1,h264_cuvid,hevc_cuvid,av1_cuvid \
        --enable-encoder=h264_nvenc,hevc_nvenc,av1_nvenc,wrapped_avframe \
        --enable-filter=buffer,buffersink,null,trim,format,settb,setpts,showinfo,scale,scale_cuda,hwupload,libvmaf,libvmaf_cuda
    make -j"$jobs"
    make install
)
"${CXX:-c++}" -std=c++17 -O2 -Wall -Wextra -Werror -I"$prefix/include" \
    "$script_dir/catalog/sdk-probe.cpp" -ldl -o "$prefix/bin/sdk-probe"
install -d "$prefix/share/nvenc-experiments"
install -m 0644 vmaf/model/vmaf_v0.6.1.json "$prefix/share/nvenc-experiments/vmaf_v0.6.1.json"
printf 'Runtime built in %s\n' "$prefix"
