// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <iomanip>
#include <locale>
#include <optional>
#include <sstream>
#include <string>

namespace bitovp::gpu {
inline std::optional<std::string> pci_bus_id(unsigned domain, unsigned bus, unsigned device, unsigned function) {
    if (domain > 0xffff || bus > 0xff || device > 0x1f || function > 7) return std::nullopt;
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::hex << std::setfill('0') << std::setw(4) << domain << ':'
        << std::setw(2) << bus << ':' << std::setw(2) << device << '.' << function;
    return out.str();
}
inline std::optional<std::string> normalize_pci_bus_id(const std::string &value) {
    const auto first = value.find(':'), second = value.find(':', first == std::string::npos ? 0 : first + 1);
    const auto dot = value.find('.');
    if (first == std::string::npos || second == std::string::npos || dot == std::string::npos ||
        first < 1 || first > 8 || second != first + 3 || dot != second + 3 || value.size() != dot + 2)
        return std::nullopt;
    const auto parse = [](const std::string &part) -> std::optional<unsigned> {
        if (part.empty() || part.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) return std::nullopt;
        return static_cast<unsigned>(std::stoul(part, nullptr, 16));
    };
    const auto domain = parse(value.substr(0, first)), bus = parse(value.substr(first + 1, 2));
    const auto device = parse(value.substr(second + 1, 2)), function = parse(value.substr(dot + 1));
    if (!domain || !bus || !device || !function) return std::nullopt;
    return pci_bus_id(*domain, *bus, *device, *function);
}
} // namespace bitovp::gpu
