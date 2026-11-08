// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <array>
#include <charconv>
#include <climits>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#if defined(__linux__)
#include <unistd.h>
#endif

namespace bitovp::gpu::supervisor {
inline constexpr unsigned protocol_version = 1;
inline constexpr const char *clock_name = "boottime";
inline constexpr unsigned maximum_timeout_ms = 15000;
inline std::string identity(const std::string &source) {
    return "bitovp-vmaf-supervisor-v1-clock=boottime-source=" + source + "\n";
}
inline unsigned number(const std::string &text, unsigned minimum, unsigned maximum) {
    unsigned value = 0;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
    if (text.empty() || parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() ||
        value < minimum || value > maximum)
        throw std::invalid_argument("Invalid supervisor numeric option");
    return value;
}
struct Options {
    unsigned parent_pid = 0, heartbeat_fd = 0, timeout_ms = 0, protocol = 0;
    std::string source, clock;
    std::vector<std::string> command;
};
inline Options parse(int argc, char **argv) {
    Options result;
    std::set<std::string> used;
    for (int i = 1; i < argc; ++i) {
        const std::string key = argv[i];
        if (key == "--") {
            for (++i; i < argc; ++i) result.command.emplace_back(argv[i]);
            break;
        }
        if (!used.insert(key).second || i + 1 >= argc)
            throw std::invalid_argument("Duplicate or incomplete supervisor option");
        const std::string value = argv[++i];
        if (key == "--expected-source") result.source = value;
        else if (key == "--expected-protocol") result.protocol = number(value, 1, 1);
        else if (key == "--expected-clock") result.clock = value;
        else if (key == "--parent-pid") result.parent_pid = number(value, 1, INT_MAX);
        else if (key == "--heartbeat-fd") result.heartbeat_fd = number(value, 3, INT_MAX);
        else if (key == "--heartbeat-timeout-ms") result.timeout_ms = number(value, 20, maximum_timeout_ms);
        else throw std::invalid_argument("Unknown supervisor option");
    }
    if (used.size() != 6 || result.source.empty() || result.clock != clock_name || !result.protocol || !result.parent_pid ||
        !result.heartbeat_fd || !result.timeout_ms || result.command.empty() || result.command.front().empty())
        throw std::invalid_argument("Required supervisor identity, parent, heartbeat and command are missing");
    return result;
}
inline std::uint64_t deadline(const std::string &line, std::uint64_t now,
                              unsigned timeout_ms, std::uint64_t previous) {
    std::uint64_t value = 0;
    const auto parsed = std::from_chars(line.data(), line.data() + line.size(), value);
    const auto window = std::uint64_t(timeout_ms) * 1000000;
    if (line.empty() || line.size() > 20 || line.find_first_not_of("0123456789") != std::string::npos ||
        parsed.ec != std::errc{} || parsed.ptr != line.data() + line.size() || value <= now || value <= previous ||
        now > std::numeric_limits<std::uint64_t>::max() - window || value > now + window)
        throw std::invalid_argument("Malformed, stale or excessive supervisor heartbeat deadline");
    return value;
}
inline std::string companion_path() {
#if defined(__linux__)
    std::array<char, 4096> path{};
    const auto size = readlink("/proc/self/exe", path.data(), path.size());
    if (size <= 0 || std::size_t(size) == path.size())
        throw std::runtime_error("Cannot locate the native supervisor companion");
    return (std::filesystem::path(std::string(path.data(), std::size_t(size))).parent_path() /
            "bitovp-vmaf-supervisor").string();
#else
    throw std::runtime_error("Native command supervision requires Linux");
#endif
}
inline bool companion_matches(const std::string &path, const std::string &source) {
#if defined(__linux__)
    if (source.size() != 64 || access(path.c_str(), X_OK) != 0) return false;
    std::ifstream input(path, std::ios::binary);
    if (!input) return false;
    const auto marker = identity(source);
    std::string carry;
    std::array<char, 65536> chunk{};
    while (input.read(chunk.data(), chunk.size()) || input.gcount()) {
        carry.append(chunk.data(), std::size_t(input.gcount()));
        if (carry.find(marker) != std::string::npos) return true;
        if (carry.size() >= marker.size()) carry.erase(0, carry.size() - marker.size() + 1);
    }
#else
    (void)path; (void)source;
#endif
    return false;
}
inline int forward(int argc, char **argv, const std::string &source) {
#if defined(__linux__)
    const auto path = companion_path();
    if (!companion_matches(path, source))
        throw std::runtime_error("Native supervisor companion is missing or does not match this build");
    std::vector<std::string> arguments{path, "--expected-source", source,
        "--expected-protocol", std::to_string(protocol_version), "--expected-clock", clock_name};
    for (int i = 2; i < argc; ++i) arguments.emplace_back(argv[i]);
    std::vector<char *> values;
    for (auto &arg : arguments) values.push_back(arg.data());
    values.push_back(nullptr);
    execv(path.c_str(), values.data());
    throw std::runtime_error("Cannot execute the native supervisor companion");
#else
    (void)argc; (void)argv; (void)source;
    throw std::runtime_error("Native command supervision requires Linux");
#endif
}
} // namespace bitovp::gpu::supervisor
