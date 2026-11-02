// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <cuda_runtime.h>
#include <cstddef>
#include <cstdint>
#include <cfloat>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <cassert>

namespace bitovp::gpu::scalar_cuda {
struct Pointer {
    void *value = nullptr;
    __host__ __device__ Pointer() : value(nullptr) {}
    __host__ __device__ Pointer(std::nullptr_t) {}
    template<class T> __host__ __device__ Pointer(T *p) : value((void *)p) {}
    template<class T> __host__ __device__ operator T *() const { return (T *)value; }
    __host__ __device__ explicit operator bool() const { return value != nullptr; }
    __host__ __device__ unsigned char *operator+(std::ptrdiff_t n) const {
        return (unsigned char *)value + n;
    }
};
struct Arena {
    unsigned char *data;
    std::size_t capacity, used, persistent, peak;
    int error;
    std::int32_t *division_lookup;
};
__device__ inline Arena *&active_arena() {
    __shared__ Arena *current;
    return current;
}
__device__ inline Pointer allocate(std::size_t bytes, std::size_t alignment = 32) {
    auto *arena = active_arena();
    const std::size_t start = (arena->used + alignment - 1) & ~(alignment - 1);
    if (start > arena->capacity || bytes > arena->capacity - start) {
        arena->error = ENOMEM;
        return {};
    }
    arena->used = start + bytes;
    if (arena->used > arena->peak) arena->peak = arena->used;
    return arena->data + start;
}
__device__ inline void release(Pointer) {}
__device__ inline int string_compare(const char *a, const char *b) {
    while (*a && *a == *b) { ++a; ++b; }
    return (unsigned char)*a - (unsigned char)*b;
}
// Original files are C: unsuffixed math functions take double even when their
// arguments are float or integer. Preserve those conversions in CUDA C++.
template<class T> __device__ inline double c_sqrt(T x) { return ::sqrt((double)x); }
template<class T> __device__ inline double c_log2(T x) { return ::log2((double)x); }
template<class T> __device__ inline double c_log(T x) { return ::log((double)x); }
template<class T> __device__ inline double c_log10(T x) { return ::log10((double)x); }
template<class T> __device__ inline double c_exp(T x) { return ::exp((double)x); }
template<class T> __device__ inline double c_ceil(T x) { return ::ceil((double)x); }
template<class T> __device__ inline double c_floor(T x) { return ::floor((double)x); }
template<class T> __device__ inline double c_fabs(T x) { return ::fabs((double)x); }
template<class T, class U> __device__ inline double c_pow(T x, U y) { return ::pow((double)x, (double)y); }
enum VmafPixelFormat { VMAF_PIX_FMT_UNKNOWN, VMAF_PIX_FMT_YUV420P,
    VMAF_PIX_FMT_YUV422P, VMAF_PIX_FMT_YUV444P, VMAF_PIX_FMT_YUV400P };
enum { VMAF_COLOR_TRC_UNKNOWN, VMAF_COLOR_TRC_BT709, VMAF_COLOR_TRC_SMPTE2084 };
struct VmafPicture {
    VmafPixelFormat pix_fmt = VMAF_PIX_FMT_UNKNOWN;
    unsigned bpc = 0, w[3]{}, h[3]{};
    std::ptrdiff_t stride[3]{};
    Pointer data[3];
    void *ref = nullptr;
    struct { int trc = VMAF_COLOR_TRC_UNKNOWN; } color;
};
struct VmafDictionary {};
struct VmafFeatureExtractor {
    Pointer priv;
    const char **provided_features = nullptr;
    const void *options = nullptr;
};
struct Record { std::uint64_t name; double value; unsigned index; };
struct VmafFeatureCollector { Record values[64]; unsigned count = 0; };
__host__ __device__ inline std::uint64_t name_hash(const char *name) {
    std::uint64_t hash = 1469598103934665603ull;
    while (*name) { hash ^= (unsigned char)*name++; hash *= 1099511628211ull; }
    return hash;
}
__device__ inline VmafDictionary *vmaf_feature_name_dict_from_provided_features(
    const char **, const void *, Pointer) { return (VmafDictionary *)1; }
__device__ inline int vmaf_dictionary_free(VmafDictionary **) { return 0; }
__device__ inline int vmaf_feature_collector_append_with_dict(VmafFeatureCollector *out,
    VmafDictionary *, const char *name, double value, unsigned index) {
    if (out->count >= 64) return -ENOMEM;
    out->values[out->count++] = {name_hash(name), value, index};
    return 0;
}
__device__ inline int vmaf_picture_alloc(VmafPicture *pic, VmafPixelFormat format,
    unsigned bpc, unsigned w, unsigned h) {
    *pic = {};
    pic->pix_fmt = format; pic->bpc = bpc;
    pic->w[0] = w; pic->h[0] = h;
    pic->stride[0] = ((w * ((bpc + 7) / 8) + 31) / 32) * 32;
    pic->data[0] = allocate(pic->stride[0] * h);
    if (!pic->data[0]) return -ENOMEM;
    memset((void *)pic->data[0], 0, pic->stride[0] * h);
    pic->ref = (void *)1;
    return 0;
}
struct Params { double number[64]; char text[64][128]; };
struct Option { const char *name; double value, minimum, maximum; bool boolean, string;
    const char *text; };
}

// Source adapters below execute exclusively inside a CUDA device kernel.
#define ARCH_X86 0
#define ARCH_AARCH64 0
#define HAVE_AVX512 0
#define FORCE_INLINE
#define MAX_ALIGN 32
#define ALIGN_CEIL(x) (((x) + MAX_ALIGN - 1) & ~(MAX_ALIGN - 1))
#define aligned_malloc bitovp::gpu::scalar_cuda::allocate
#define aligned_free bitovp::gpu::scalar_cuda::release
#define vmaf_log(...) ((void)0)
#define strcmp bitovp::gpu::scalar_cuda::string_compare
#define sqrt bitovp::gpu::scalar_cuda::c_sqrt
#define log2 bitovp::gpu::scalar_cuda::c_log2
#define log bitovp::gpu::scalar_cuda::c_log
#define log10 bitovp::gpu::scalar_cuda::c_log10
#define exp bitovp::gpu::scalar_cuda::c_exp
#define ceil bitovp::gpu::scalar_cuda::c_ceil
#define floor bitovp::gpu::scalar_cuda::c_floor
#define fabs bitovp::gpu::scalar_cuda::c_fabs
#define pow bitovp::gpu::scalar_cuda::c_pow
