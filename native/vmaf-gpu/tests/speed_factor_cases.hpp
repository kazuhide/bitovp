// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <array>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace bitovp::gpu::speed_factor_test {
inline std::uint32_t bits(float value) {
    std::uint32_t result;
    std::memcpy(&result, &value, sizeof(result));
    return result;
}
inline float value(std::uint32_t bits) {
    float result;
    std::memcpy(&result, &bits, sizeof(result));
    return result;
}
inline std::string hexadecimal(std::uint32_t word) {
    std::ostringstream result;
    result << "0x" << std::hex << std::setw(8) << std::setfill('0') << word;
    return result.str();
}
struct Slot { unsigned covariance, eigenvalues, temporary, result, failure, pattern; };

struct Fixture {
    std::array<std::uint32_t, 8> parameters{7, 1, 1, 0, 0, 0, 0, 0};
    std::vector<std::uint32_t> words;
    std::array<Slot, 4> slots{};
    unsigned blocks;

    Fixture(unsigned first_pattern, unsigned rhs_blocks) : blocks(rhs_blocks) {
        words.resize(64, 0);
        words[6] = blocks * 5; words[7] = 5;
        const auto allocate = [&](unsigned count) {
            const auto offset = static_cast<unsigned>(words.size());
            words.resize(words.size() + count + 16, 0x5a193c7du);
            return offset;
        };
        for (unsigned i = 0; i < slots.size(); ++i) {
            auto &s = slots[i];
            s.pattern = (first_pattern + i) % 8;
            s.covariance = allocate(625);
            s.eigenvalues = allocate(25);
            s.temporary = allocate(3125);
            s.result = allocate(26 + blocks);
            s.failure = allocate(1);
            words[36 + 7 * i] = s.covariance;
            words[37 + 7 * i] = s.eigenvalues;
            words[40 + 7 * i] = s.temporary;
            words[41 + 7 * i] = s.result;
            words[42 + 7 * i] = s.failure;
            for (unsigned row = 0; row < 25; ++row) for (unsigned column = 0; column < 25; ++column) {
                float covariance = 0;
                if (s.pattern == 5) {
                    // Gram matrix of distinct integer rows plus a positive
                    // diagonal. It is symmetric positive definite by construction.
                    for (unsigned k = 0; k < 25; ++k) {
                        const float left = float(int((row * 7 + k * 3) % 11) - 5) / 16.0f;
                        const float right = float(int((column * 7 + k * 3) % 11) - 5) / 16.0f;
                        covariance += left * right;
                    }
                    if (row == column) covariance += 2.0f;
                } else if (s.pattern == 6) {
                    covariance = float((row + 1) * (column + 1)) / 64.0f;
                } else if (row == column) {
                    covariance = s.pattern == 0 ? 2.0f : s.pattern == 2 ? 0.0f : 1.0f + float(row) / 8.0f;
                    if (s.pattern == 3 && row == 24) covariance = 0;
                    if (s.pattern == 4 && row == 12) covariance = -1;
                    if (s.pattern == 7 && row == 0) covariance = 0.0000001f;
                }
                words[s.covariance + row * 25 + column] = bits(covariance);
            }
        }
    }

    void verify_contract(const std::vector<std::uint32_t> &actual, unsigned groups) const {
        if (actual.size() != words.size()) throw std::runtime_error("Factor workspace length changed");
        auto wanted = words;
        std::vector<bool> mutable_word(words.size(), false);
        const auto allow = [&](unsigned offset, unsigned count) {
            for (unsigned i = 0; i < count; ++i) mutable_word[offset + i] = true;
        };
        for (unsigned slot = 0; slot < groups; ++slot) {
            const auto &s = slots.at(slot);
            allow(s.eigenvalues, 25); allow(s.result, 25); allow(s.result + 25 + blocks, 1); allow(s.failure, 1);
            bool factor_entered = true;
            for (unsigned row = 0; row < 25; ++row)
                if (value(actual[s.eigenvalues + row]) < 0.000001f) factor_entered = false;
            if (factor_entered) allow(s.temporary + 625, 1250);
            if (s.pattern == 5 || s.pattern == 6) continue;
            // Independent analytic oracle for diagonal matrices. Tridiagonal
            // conversion is unchanged; positive diagonal QR reflects one
            // coordinate at a time, giving Q=diag(-1,...,-1,+1) and R=Q*A.
            bool failed = false;
            for (unsigned row = 0; row < 25; ++row) {
                const auto diagonal = words[s.covariance + row * 25 + row];
                failed = failed || value(diagonal) < 0.000001f;
                wanted[s.eigenvalues + row] = wanted[s.result + row] = diagonal;
            }
            wanted[s.failure] = failed ? 1 : 0;
            wanted[s.result + 25 + blocks] = bits(failed ? 1.0f : 0.0f);
            if (!failed) for (unsigned row = 0; row < 25; ++row) for (unsigned column = 0; column < 25; ++column) {
                const float sign = row == 24 ? 1.0f : -1.0f;
                wanted[s.temporary + 625 + row * 25 + column] = bits(row == column ? sign : 0.0f);
                wanted[s.temporary + 1250 + row * 25 + column] = bits(row == column ?
                    sign * value(words[s.covariance + row * 25 + row]) : 0.0f);
            }
            for (unsigned offset : {s.eigenvalues, s.result}) for (unsigned row = 0; row < 25; ++row)
                if (actual[offset + row] != wanted[offset + row])
                    throw std::runtime_error("Analytic diagonal eigenvalue mismatch");
            if (actual[s.failure] != wanted[s.failure] ||
                actual[s.result + 25 + blocks] != wanted[s.result + 25 + blocks])
                throw std::runtime_error("Analytic diagonal failure-path mismatch");
            if (!failed) for (unsigned i = 0; i < 1250; ++i) {
                const auto observed = actual[s.temporary + 625 + i];
                const auto expected = wanted[s.temporary + 625 + i];
                // The real-valued closed form specifies an off-diagonal
                // zero, not its IEEE sign. This exception is restricted to
                // exactly -0 versus +0; all nonzero and diagonal bits stay
                // exact. The scalar/cooperative GPU comparison is separately
                // bit-exact over every workspace word, including zero signs.
                const bool zero_sign_only = (i % 625) / 25 != i % 25 &&
                    observed == 0x80000000u && expected == 0u;
                if (observed != expected && !zero_sign_only)
                    throw std::runtime_error("Analytic diagonal QR mismatch at " + std::to_string(i) +
                        " pattern=" + std::to_string(s.pattern) + " slot=" + std::to_string(slot) +
                        " groups=" + std::to_string(groups) + " matrix=" + (i < 625 ? "Q" : "R") +
                        " row=" + std::to_string((i % 625) / 25) + " column=" + std::to_string(i % 25) +
                        " actual=" + hexadecimal(actual[s.temporary + 625 + i]) +
                        " expected=" + hexadecimal(wanted[s.temporary + 625 + i]));
            }
        }
        for (std::size_t i = 0; i < words.size(); ++i)
            if (!mutable_word[i] && actual[i] != words[i])
                throw std::runtime_error("Factor wrote outside its owned outputs at " + std::to_string(i));
    }
};

template <typename Runner> unsigned cases(Runner run) {
    unsigned count = 0;
    for (unsigned pattern = 0; pattern < 8; ++pattern)
        for (unsigned blocks : {1u, 7u, 72u}) {
            Fixture fixture(pattern, blocks);
            for (unsigned groups : {1u, 3u, 4u}) {
                run(fixture, groups);
                ++count;
            }
        }
    return count;
}
} // namespace bitovp::gpu::speed_factor_test
