// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <array>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#if defined(__linux__)
#include <dlfcn.h>
#endif

namespace bitovp::gpu {
struct DriverIdentity { std::string version, source; };
inline bool numeric_driver_version(const std::string &value) {
    return !value.empty() && value.front() >= '0' && value.front() <= '9' &&
        value.back() >= '0' && value.back() <= '9' &&
        value.find_first_not_of("0123456789.") == std::string::npos &&
        value.find('.') != std::string::npos && value.find("..") == std::string::npos;
}
inline std::string nvidia_version_token(const std::string &line) {
    std::istringstream tokens(line);
    std::string token;
    while (tokens >> token) if (numeric_driver_version(token)) return token;
    return {};
}
inline DriverIdentity nvidia_driver_identity() {
#if defined(__linux__)
    std::string line;
    std::ifstream sysfs("/sys/module/nvidia/version");
    if (std::getline(sysfs, line) && numeric_driver_version(line)) return {line, "sysfs-module-version"};
    // NVML is optional, resolved at runtime for containers without module sysfs.
    struct LibraryCloser {
        void operator()(void *handle) const noexcept { dlclose(handle); }
    };
    std::unique_ptr<void, LibraryCloser> library(
        dlopen("libnvidia-ml.so.1", RTLD_NOW | RTLD_LOCAL));
    if (library) {
        using Initialize = int (*)();
        using Version = int (*)(char *, unsigned);
        using Shutdown = int (*)();
        const auto initialize = reinterpret_cast<Initialize>(dlsym(library.get(), "nvmlInit_v2"));
        const auto version = reinterpret_cast<Version>(dlsym(library.get(), "nvmlSystemGetDriverVersion"));
        const auto shutdown = reinterpret_cast<Shutdown>(dlsym(library.get(), "nvmlShutdown"));
        std::string found;
        if (initialize && version && shutdown && initialize() == 0) {
            struct ShutdownScope {
                Shutdown call;
                ~ShutdownScope() { call(); }
            } shutdown_scope{shutdown};
            std::array<char, 128> buffer{};
            if (version(buffer.data(), unsigned(buffer.size())) == 0 && buffer.back() == '\0' &&
                numeric_driver_version(buffer.data())) found = buffer.data();
        }
        if (!found.empty()) return {found, "nvml-driver-version"};
    }
    std::ifstream proc("/proc/driver/nvidia/version");
    if (std::getline(proc, line) && line.rfind("NVRM version:", 0) == 0) {
        const auto version = nvidia_version_token(line);
        if (!version.empty()) return {version, "proc-driver-nvidia"};
    }
#endif
    return {};
}
} // namespace bitovp::gpu
