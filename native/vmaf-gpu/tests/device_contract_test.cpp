// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "cli_options.hpp"
#include "device_protocol.hpp"
#include "device_memory.hpp"
#include "driver_identity.hpp"
#include "pci_bus_id.hpp"
#include <functional>
#include <iostream>
#include <locale>
#include <stdexcept>
#include <vector>
#include <unistd.h>

using namespace bitovp::gpu;
namespace {
void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}
cli::Options options(std::vector<std::string> args) {
    args.insert(args.begin(), "bitovp-vmaf");
    std::vector<char *> argv;
    for (auto &arg : args) argv.push_back(arg.data());
    return cli::parse(int(argv.size()), argv.data());
}
void rejects(const std::function<void()> &operation, const char *message) {
    try { operation(); } catch (const std::invalid_argument &) { return; }
    throw std::runtime_error(message);
}
DeviceInfo fixture(const std::string &kind) {
    DeviceInfo info;
    info.backend = "vulkan"; info.index = 0;
    info.name = "GPU \"reference\"\n\\path 日本語";
    info.uuid = "0123456789abcdef0123456789abcdef";
    info.vendor_id = 0x1002; info.device_id = 0x150e;
    info.integrated = true;
    info.memory_budget = 1073741824;
    info.memory_total_bytes = 1073741824;
    info.memory_heap_index = 0;
    if (kind != "unknown") {
        info.pci_bus_id = "0000:c6:00.0";
        info.driver_version = "1048678;RADV;Mesa 25.2.8\n(driver)";
        info.driver_version_known = true;
        info.driver_version_source = "vulkan-driver-properties";
        info.memory_available_bytes = kind == "zero" ? 0 : 536870912;
        info.memory_available_source = "vulkan-process-budget-hint";
    }
    return info;
}
struct Grouping : std::numpunct<char> {
    char do_thousands_sep() const override { return ','; }
    std::string do_grouping() const override { return "\3"; }
};
}
int main(int argc, char **argv) {
    try {
        if (argc == 3 && std::string(argv[1]) == "--fixture") {
            std::locale::global(std::locale(std::locale::classic(), new Grouping));
            const std::optional<std::string> binary = std::string(argv[2]) == "binary-unknown" ?
                std::nullopt : std::optional<std::string>(std::string(64, 'b'));
            std::cout << protocol::device_info(fixture(argv[2]), std::string(64, 'a'),
                oracle_source_revision, binary) << '\n';
            return 0;
        }
        require(argc == 1, "Unexpected contract test argument");
        const auto cuda = options({"--device-info", "--backend", "cuda", "--device", "0", "--vendor", "nvidia"});
        require(cuda.device_info && cuda.backend == "cuda" && cuda.device.device_index == 0 &&
            cuda.device.vendor_id == 0x10de && cuda.reference.empty() && cuda.models.empty(),
            "Device probe unexpectedly needs comparison input or a model");
        const auto vulkan = options({"--backend", "vulkan", "--vendor", "amd", "--device-info"});
        require(vulkan.device_info && vulkan.device.device_index == -1 && vulkan.device.vendor_id == 0x1002,
                "Vulkan probe did not preserve explicit selection");
        const std::vector<std::vector<std::string>> invalid = {
            {"--device-info"}, {"--device-info", "--backend", "cpu"},
            {"--device-info", "--backend", "bogus"},
            {"--device-info", "--backend", "cuda", "--vendor", "amd"},
            {"--device-info", "--device-info", "--backend", "cuda"},
            {"--device-info", "--backend", "cuda", "--backend", "vulkan"},
            {"--device-info", "--backend", "cuda", "--vendor", "amd", "--vendor", "nvidia"},
            {"--device-info", "--backend", "cuda", "--device", "-1"},
            {"--device-info", "--backend", "cuda", "--device", "257"},
            {"--device-info", "--backend", "cuda", "--device", "1.5"},
            {"--device-info", "--backend", "cuda", "--device"},
            {"--device-info", "--backend", "cuda", "--unknown", "value"},
            {"--device-info", "--backend", "cuda", "--threads", "1"},
            {"--device-info", "--backend", "cuda", "--bit-depth", "8"},
            {"--device-info", "--backend", "cuda", "--inflight-frames", "4"},
            {"--device-info", "--backend", "cuda", "--profile"},
            {"--device-info", "--backend", "cuda", "--verify-cpu"},
            {"--device-info", "--backend", "cuda", "--model", "test=missing.json"},
            {"--device-info", "--backend", "cuda", "--reference", "missing.mp4"},
            {"--device-info", "--backend", "cuda", "--output", "unused.json"},
        };
        for (const auto &args : invalid) rejects([&] { options(args); }, "Invalid device probe arguments were accepted");
        const auto output = (std::filesystem::temp_directory_path() /
            ("bitovp-contract-" + std::to_string(getpid())) / "result.json").string();
        const auto normal = options({"--reference", "a.mp4", "--distorted", "b.mp4", "--model", "id=model.json",
                                     "--backend", "cuda", "--output", output,
                                     "--inflight-frames", "4", "--verify-cpu"});
        require(!normal.device_info && normal.verify && normal.inflight_frames == 4 && normal.models.size() == 1,
                "Device probe changed ordinary comparison parsing");
        require(vulkan_available_bytes(100, 90, 10) == 80, "Budget/usage headroom is incorrect");
        require(vulkan_available_bytes(100, 90, 90) == 0 && vulkan_available_bytes(100, 90, 110) == 0,
                "Over-budget usage did not produce zero available bytes");
        require(!vulkan_available_bytes(100, 0, 0) && !vulkan_available_bytes(100, 110, 0) &&
                !vulkan_available_bytes(0, 0, 0), "Invalid budgets became invented free memory");
        require(numeric_driver_version("580.178.04") && !numeric_driver_version("580..178") &&
                !numeric_driver_version("api 13000") &&
                nvidia_version_token("NVRM version: NVIDIA UNIX x86_64 580.178.04 Release Build") == "580.178.04",
                "Driver build identification accepted an API number or malformed version");
        require(normalize_pci_bus_id("00000000:C6:00.0") == "0000:c6:00.0" &&
                normalize_pci_bus_id("0:01:1f.7") == "0000:01:1f.7" &&
                !normalize_pci_bus_id("0000:01:20.0") && !normalize_pci_bus_id("0000:01:00.8") &&
                !normalize_pci_bus_id("00010000:01:00.0") && !normalize_pci_bus_id("0000:01:00.0 extra"),
                "PCI identity normalization changed or accepted an invalid address");
        auto invalid_device = fixture("known");
        invalid_device.memory_available_bytes = *invalid_device.memory_total_bytes + 1;
        rejects([&] { protocol::device_info(invalid_device, std::string(64, 'a'), oracle_source_revision,
                                           std::string(64, 'b')); }, "Available memory exceeded total memory");
        invalid_device = fixture("known"); invalid_device.memory_total_bytes.reset();
        rejects([&] { protocol::device_info(invalid_device, std::string(64, 'a'), oracle_source_revision,
                                           std::string(64, 'b')); }, "Available memory had no known total");
        invalid_device = fixture("known"); invalid_device.pci_bus_id = "00000000:c6:00.0";
        rejects([&] { protocol::device_info(invalid_device, std::string(64, 'a'), oracle_source_revision,
                                           std::string(64, 'b')); }, "A noncanonical PCI identity was emitted");
        invalid_device = fixture("known"); invalid_device.uuid = std::string(32, '0');
        rejects([&] { protocol::device_info(invalid_device, std::string(64, 'a'), oracle_source_revision,
                                           std::string(64, 'b')); }, "An unidentified GPU could enter a cache key");
        invalid_device = fixture("known"); invalid_device.memory_total_bytes = 9007199254740992ull;
        rejects([&] { protocol::device_info(invalid_device, std::string(64, 'a'), oracle_source_revision,
                                           std::string(64, 'b')); }, "Unsafe JSON memory integer was emitted");
        rejects([&] { protocol::device_info(fixture("known"), "unrecorded", oracle_source_revision,
                                           std::string(64, 'b')); }, "Missing source identity was accepted");
        std::cout << "PASS native device probe arguments, identity, memory boundaries and unknown semantics\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL native device contract: " << error.what() << '\n'; return 1;
    }
}
