// SPDX-License-Identifier: MIT
#include <errno.h>
#include <libavutil/error.h>
#include <libavutil/hwcontext.h>

// The probe resolves this symbol without invoking it.
int avcodec_receive_frame(void *context, void *frame) {
    (void)context;
    (void)frame;
    return -1;
}

// Emulate libavutil without a working CUDA device provider.
int av_hwdevice_ctx_create(AVBufferRef **context, enum AVHWDeviceType type,
                           const char *device, AVDictionary *options, int flags) {
    (void)context;
    (void)type;
    (void)device;
    (void)options;
    (void)flags;
    return AVERROR(ENOSYS);
}
