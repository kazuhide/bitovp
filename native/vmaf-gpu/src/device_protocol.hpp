// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "bitovp_gpu.hpp"
#include "pci_bus_id.hpp"
#include <algorithm>
#include <iomanip>
#include <locale>
#include <ostream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace bitovp::gpu::protocol {
inline std::string quoted(const std::string &value) {
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << '"';
    for (const unsigned char c : value) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 0x20) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(c);
        else out << c;
    }
    out << '"';
    return out.str();
}
inline void bytes(std::ostream &out, const std::optional<std::uint64_t> &value) {
    if (value && *value > 9007199254740991ull)
        throw std::invalid_argument("Device memory exceeds the JSON safe-integer range");
    if (value) out << *value;
    else out << "null";
}
inline void write_device(std::ostream &out, const DeviceInfo &device) {
    if (device.pci_bus_id && normalize_pci_bus_id(*device.pci_bus_id) != device.pci_bus_id)
        throw std::invalid_argument("Device PCI identity must use canonical domain:bus:device.function");
    if (device.memory_available_bytes && (!device.memory_total_bytes ||
        *device.memory_available_bytes > *device.memory_total_bytes))
        throw std::invalid_argument("Device available memory exceeds its known total");
    out << "{\"index\":" << device.index << ",\"name\":" << quoted(device.name)
        << ",\"uuid\":" << quoted(device.uuid) << ",\"vendorId\":" << device.vendor_id
        << ",\"deviceId\":" << device.device_id
        << ",\"integrated\":" << (device.integrated ? "true" : "false")
        << ",\"memoryBudgetBytes\":" << device.memory_budget
        << ",\"pciBusId\":";
    if (device.pci_bus_id) out << quoted(*device.pci_bus_id);
    else out << "null";
    out << ",\"driverVersion\":" << quoted(device.driver_version.empty() ? "unknown" : device.driver_version)
        << ",\"driverVersionKnown\":" << (device.driver_version_known ? "true" : "false")
        << ",\"driverVersionSource\":" << quoted(device.driver_version_source)
        << ",\"memoryTotalBytes\":";
    bytes(out, device.memory_total_bytes);
    out << ",\"memoryAvailableBytes\":";
    bytes(out, device.memory_available_bytes);
    out << ",\"memoryAvailableSource\":" << quoted(device.memory_available_source)
        << ",\"memoryHeapIndex\":";
    if (device.memory_heap_index) out << *device.memory_heap_index;
    else out << "null";
    out << '}';
}
inline bool hex_digest(const std::string &value, std::size_t length) {
    return value.size() == length && value.find_first_not_of("0123456789abcdef") == std::string::npos;
}
inline std::string device_info(const DeviceInfo &device, const std::string &source,
                               const std::string &official_revision,
                               const std::optional<std::string> &binary,
                               const ProcessSupervisorInfo &supervisor = {}) {
    if ((device.backend != "cuda" && device.backend != "vulkan") || device.index < 0 ||
        !hex_digest(device.uuid, 32) || device.uuid.find_first_not_of('0') == std::string::npos)
        throw std::invalid_argument("Device probe requires an identified hardware GPU");
    if (!hex_digest(source, 64) || (binary && !hex_digest(*binary, 64)) || !hex_digest(official_revision, 40))
        throw std::invalid_argument("Device probe requires recorded source and binary identities");
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << "{\"schemaVersion\":1,\"sourceSha256\":" << quoted(source)
        << ",\"binarySha256\":";
    if (binary) out << quoted(*binary);
    else out << "null";
    out << ",\"officialSourceRevision\":" << quoted(official_revision)
        << ",\"backend\":" << quoted(device.backend)
        << ",\"device\":";
    write_device(out, device);
    if ((supervisor.available && !supervisor.binary_sha256) ||
        (supervisor.binary_sha256 && !hex_digest(*supervisor.binary_sha256, 64)))
        throw std::invalid_argument("Supervisor binary identity is invalid");
    out << ",\"capabilities\":{\"inflightFrames\":[1,2,4],\"cpuParity\":true,\"processSupervisor\":"
        << (supervisor.available ? "true" : "false") << ",\"supervisorBinarySha256\":";
    if (supervisor.binary_sha256) out << quoted(*supervisor.binary_sha256);
    else out << "null";
    out << "}}";
    return out.str();
}
} // namespace bitovp::gpu::protocol
