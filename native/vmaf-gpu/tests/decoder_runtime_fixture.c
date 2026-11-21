// SPDX-License-Identifier: MIT
// The probe resolves this symbol without invoking it.
int avcodec_receive_frame(void *context, void *frame) {
    (void)context;
    (void)frame;
    return -1;
}
