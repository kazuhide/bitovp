// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "supervisor.hpp"
#include <functional>
#include <iostream>
#include <stdexcept>

using namespace bitovp::gpu::supervisor;
namespace {
void require(bool condition, const char *message) { if (!condition) throw std::runtime_error(message); }
void rejects(const std::function<void()> &operation) {
    try { operation(); } catch (const std::invalid_argument &) { return; }
    throw std::runtime_error("Invalid supervisor input was accepted");
}
Options options(std::vector<std::string> args) {
    args.insert(args.begin(), "bitovp-vmaf-supervisor");
    std::vector<char *> argv;
    for (auto &arg : args) argv.push_back(arg.data());
    return parse(int(argv.size()), argv.data());
}
}
int main() {
    try {
        const std::vector<std::string> valid{"--expected-source", std::string(64, 'a'), "--expected-protocol", "1",
            "--parent-pid", "123", "--heartbeat-fd", "3", "--heartbeat-timeout-ms", "15000",
            "--expected-clock", "boottime",
            "--", "/a program", "argument with spaces", "$(literal)", "--parent-pid"};
        const auto parsed = options(valid);
        require(parsed.parent_pid == 123 && parsed.heartbeat_fd == 3 && parsed.timeout_ms == 15000 &&
            parsed.command == std::vector<std::string>({"/a program", "argument with spaces", "$(literal)", "--parent-pid"}),
            "Supervisor command argument boundaries were changed");
        auto args = valid; args[7] = "2"; rejects([&] { options(args); });
        args = valid; args[5] = "0"; rejects([&] { options(args); });
        args = valid; args[9] = "15001"; rejects([&] { options(args); });
        args = valid; args[9] = "0"; rejects([&] { options(args); });
        args = valid; args[9] = "-1"; rejects([&] { options(args); });
        args = valid; args[11] = "monotonic"; rejects([&] { options(args); });
        args = valid; args[3] = "2"; rejects([&] { options(args); });
        args = valid; args.resize(13); rejects([&] { options(args); });
        args = valid; args.erase(args.begin() + 12); rejects([&] { options(args); });
        args = valid; args.insert(args.begin(), {"--parent-pid", "123"}); rejects([&] { options(args); });
        args = valid; args[0] = "--unknown"; rejects([&] { options(args); });
        constexpr std::uint64_t now = 10000000000, window = 15000000000;
        require(deadline(std::to_string(now + window), now, 15000, 0) == now + window,
                "Absolute sender deadline was not retained");
        require(deadline(std::to_string(now + 100), now, 15000, now + 99) == now + 100,
                "A short remaining absolute deadline was extended or rejected");
        for (const auto &line : {"", "-1", "+1", "1e9", " 1", "1 ", "1\r", "18446744073709551616"})
            rejects([&] { deadline(line, now, 15000, 0); });
        rejects([&] { deadline(std::to_string(now), now, 15000, 0); });
        rejects([&] { deadline(std::to_string(now + window + 1), now, 15000, 0); });
        rejects([&] { deadline(std::to_string(now + 100), now, 15000, now + 100); });
        rejects([&] { deadline(std::to_string(now + 100), now, 15000, now + 101); });
        rejects([&] { deadline(std::to_string(UINT64_MAX), UINT64_MAX - 1, 15000, 0); });
        // Simulate suspend advancing boot time beyond a previously issued deadline.
        rejects([&] { deadline(std::to_string(now + window), now + window + 1, 15000, 0); });
        require(identity(std::string(64, 'a')) == "bitovp-vmaf-supervisor-v1-clock=boottime-source=" + std::string(64, 'a') + "\n",
                "Companion clock/protocol/source marker changed");
#if !defined(__linux__)
        try { companion_path(); throw std::runtime_error("Unsupported platform claimed a companion"); }
        catch (const std::runtime_error &error) {
            require(std::string(error.what()).find("requires Linux") != std::string::npos,
                    "Unsupported platform did not fail explicitly");
        }
#endif
        std::cout << "PASS supervisor arguments, absolute-deadline bounds, replay rejection and platform contract\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL supervisor contract: " << error.what() << '\n'; return 1;
    }
}
