// SPDX-License-Identifier: MIT
#include "cli_options.hpp"
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace bitovp::gpu::cli;
namespace {
Options options(std::vector<std::string> arguments) {
    arguments.insert(arguments.begin(), "bitovp-vmaf");
    std::vector<char *> argv;
    for (auto &value : arguments) argv.push_back(value.data());
    return parse(int(argv.size()), argv.data());
}
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
void rejects(const std::vector<std::string> &extra) {
    std::vector<std::string> args{"--metric", "cambi", "--distorted", "target.mp4", "--output",
                                  "/nonexistent/bitovp-banding-cli-receipt.json"};
    args.insert(args.end(), extra.begin(), extra.end());
    bool rejected = false;
    try { options(args); } catch (const std::invalid_argument &) { rejected = true; }
    require(rejected, "CAMBI accepted a conflicting, partial or unverified option");
}
}
int main() {
    try {
        const auto cpu = options({"--metric", "cambi", "--distorted", "target.mp4",
                                  "--output", "/nonexistent/bitovp-banding-cli-receipt.json"});
        require(cpu.reference.empty() && cpu.models.empty() && cpu.backend == "cpu",
                "CAMBI requires a reference or model");
        for (const auto &backend : {"cuda", "vulkan"}) {
            const auto gpu = options({"--metric", "cambi", "--distorted", "target.mp4",
                "--output", "/nonexistent/bitovp-banding-cli-receipt.json", "--backend", backend,
                "--verify-cpu", "--inflight-frames", "1"});
            require(gpu.verify, "CAMBI GPU verification is missing");
        }
        for (const auto &extra : std::vector<std::vector<std::string>>{
                 {"--reference", "ref.mp4"}, {"--model", "test=model.json"},
                 {"--width", "640", "--height", "360"}, {"--bit-depth", "8"},
                 {"--max-frames", "0"}, {"--decode", "cuda"},
                 {"--inflight-frames", "2"}, {"--backend", "cuda"},
                 {"--backend", "vulkan"}, {"--verify-cpu"}, {"--device", "0"},
                 {"--metric", "cambi"}})
            rejects(extra);
        const auto old = options({"--reference", "ref", "--distorted", "dist", "--model",
                                  "test=model", "--output", "/nonexistent/bitovp-vmaf-cli-receipt.json"});
        require(old.bits == 8 && !old.models.empty(), "Existing VMAF defaults changed");
        std::cout << "native_banding_cli: PASS (CPU/GPU/model-free/12 invalid cases/legacy)\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "native_banding_cli: FAIL: " << error.what() << '\n';
        return 1;
    }
}
