// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "decoder.hpp"
#include "decoder_pair.hpp"
#include "prefetch.hpp"
#include <array>
#include <chrono>
#include <cmath>
#include <future>
#include <iostream>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using namespace bitovp::gpu;
namespace {
void require(bool condition, const std::string &message) {
    if (!condition) throw std::runtime_error(message);
}
std::vector<std::uint8_t> samples(const Picture &picture) {
    std::vector<std::uint8_t> result;
    const unsigned bytes = picture.bit_depth == 8 ? 1 : 2;
    for (const auto &plane : picture.planes) for (unsigned row = 0; row < plane.height; ++row) {
        const auto *first = static_cast<const std::uint8_t *>(plane.data) + row * plane.stride;
        result.insert(result.end(), first, first + plane.width * bytes);
    }
    return result;
}
struct Expected { std::vector<std::uint8_t> pixels; double time; };
using Address = std::array<std::uintptr_t, 3>;
Address address(const Picture &picture) {
    return {reinterpret_cast<std::uintptr_t>(picture.planes[0].data),
            reinterpret_cast<std::uintptr_t>(picture.planes[1].data),
            reinterpret_cast<std::uintptr_t>(picture.planes[2].data)};
}
void compare(const RetainedPicture &picture, const Expected &wanted) {
    require(samples(picture.picture()) == wanted.pixels, "A retained picture changed its active samples");
    require(picture.timestamp() == wanted.time, "A retained timestamp changed after the decoder advanced");
}
std::vector<Expected> expected(const std::string &file, unsigned width, unsigned height, unsigned depth, unsigned count = 6) {
    Decoder decoder(file, width, height, depth, 2);
    std::vector<Expected> values;
    for (unsigned frame = 0; frame < count; ++frame) {
        require(decoder.next(), "Decoder retention fixture has too few frames");
        values.push_back({samples(decoder.picture()), decoder.timestamp()});
    }
    return values;
}
void retained_surfaces(const std::string &file, unsigned width, unsigned height, unsigned depth) {
    const auto wanted = expected(file, width, height, depth);
    std::optional<RetainedPicture> survivor;
    std::set<Address> surfaces;
    {
        Decoder decoder(file, width, height, depth, 2);
        require(decoder.next(), "Missing first retention frame");
        std::optional<RetainedPicture> first(decoder.retain_picture());
        surfaces.insert(address(first->picture())); compare(*first, wanted[0]);
        require(decoder.next(), "Missing second retention frame");
        std::optional<RetainedPicture> previous(decoder.retain_picture());
        surfaces.insert(address(previous->picture())); compare(*first, wanted[0]); compare(*previous, wanted[1]);
        const auto decode_before = decoder.decode_ms(), conform_before = decoder.conform_ms();
        bool rejected = false;
        try { (void)decoder.next(); } catch (const std::logic_error &) { rejected = true; }
        require(rejected, "Decoder allocated a third live retained output surface");
        require(decoder.decode_ms() == decode_before && decoder.conform_ms() == conform_before,
                "Busy retained output consumed or converted another encoded frame");
        compare(*first, wanted[0]); compare(*previous, wanted[1]);
        first.reset();
        for (unsigned frame = 2; frame < wanted.size(); ++frame) {
            require(decoder.next(), "Missing retained frame after releasing the old slot");
            auto current = decoder.retain_picture();
            surfaces.insert(address(current.picture()));
            compare(*previous, wanted[frame - 1]); compare(current, wanted[frame]);
            previous = std::move(current);
        }
        require(surfaces.size() == 2, "Retained decoding did not reuse exactly two output surfaces");
        survivor = std::move(previous);
    }
    compare(*survivor, wanted.back());
}
void retained_pair_pipeline(const std::string &file, unsigned width, unsigned height, unsigned depth) {
    const auto wanted = expected(file, width, height, depth, 7);
    const auto maximum = wanted.size() - 1;
    Decoder reference(file, width, height, depth, 2), distorted(file, width, height, depth, 2);
    std::set<Address> reference_surfaces, distorted_surfaces;
    std::promise<void> second_pair;
    auto second_ready = second_pair.get_future();
    unsigned produced = 0;
    Prefetch<RetainedPair> reader([&] {
        auto pair = next_retained_pair(reference, distorted);
        if (pair && ++produced == 2) second_pair.set_value();
        return pair;
    }, maximum);
    unsigned count = 0;
    for (;;) {
        auto pair = reader.next();
        if (!pair) break;
        require(count < maximum, "Pair prefetch exceeded its maximum frame count");
        if (!count) require(second_ready.wait_for(std::chrono::seconds(10)) == std::future_status::ready,
                            "Pair prefetch did not produce while the consumer retained the first frame");
        compare(pair->reference, wanted[count]); compare(pair->distorted, wanted[count]);
        validate_comparison_timestamps(pair->reference.timestamp(), pair->distorted.timestamp(),
                                       reference.source_info().frames_per_second);
        reference_surfaces.insert(address(pair->reference.picture()));
        distorted_surfaces.insert(address(pair->distorted.picture()));
        ++count;
    }
    reader.stop();
    require(count == maximum, "Pair prefetch lost frames");
    require(reference_surfaces.size() == 2 && distorted_surfaces.size() == 2,
            "Pair prefetch failed to retain the bounded two-surface ring");
    require(std::isfinite(reference.decode_ms() + distorted.decode_ms() +
                          reference.conform_ms() + distorted.conform_ms()), "Post-join decoder timing is invalid");
    // No seventh decode was allowed by the prefetch maximum.
    require(reference.next() && distorted.next(), "Frame limit consumed a frame beyond its boundary");
    compare(reference.retain_picture(), wanted.back());
    compare(distorted.retain_picture(), wanted.back());
}
void paired_end_and_error(const std::string &file) {
    Decoder reference(file, 65, 67, 10, 1), distorted(file, 65, 67, 10, 1);
    while (distorted.next()) {}
    bool rejected = false;
    {
        Prefetch<RetainedPair> reader([&] { return next_retained_pair(reference, distorted); });
        try { (void)reader.next(); }
        catch (const std::runtime_error &error) {
            rejected = std::string(error.what()) == "Comparison inputs have different frame counts";
        }
        reader.stop();
    }
    require(rejected, "Producer did not propagate a reference/distorted EOF mismatch");
    while (reference.next()) {}
    require(!next_retained_pair(reference, distorted), "Two exhausted inputs did not end together");
}
void timestamp_boundary() {
    const double frames_per_second = 24, allowed = 0.25 / frames_per_second;
    validate_comparison_timestamps(0, allowed, frames_per_second);
    validate_comparison_timestamps(allowed, 0, frames_per_second);
    for (const bool reference_leads : {false, true}) {
        const auto beyond = std::nextafter(allowed, INFINITY);
        bool rejected = false;
        try { validate_comparison_timestamps(reference_leads ? beyond : 0, reference_leads ? 0 : beyond, frames_per_second); }
        catch (const std::runtime_error &error) {
            rejected = std::string(error.what()) == "Comparison presentation timestamps do not align";
        }
        require(rejected, "Timestamp drift beyond the original boundary was accepted");
    }
}
}
int main(int argc, char **argv) {
    try {
        require(argc == 2, "Usage: decoder_retention_test FIXTURE_FILE (at least seven frames)");
        for (const unsigned depth : {8u, 10u}) for (const auto dimensions :
             std::array<std::array<unsigned, 2>, 3>{{{65, 67}, {128, 96}, {129, 97}}}) {
            retained_surfaces(argv[1], dimensions[0], dimensions[1], depth);
            retained_pair_pipeline(argv[1], dimensions[0], dimensions[1], depth);
        }
        paired_end_and_error(argv[1]); timestamp_boundary();
        std::cout << "PASS decoder retention: 12 depth/stride/ownership cases, pair EOF/error and timestamp boundaries\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL decoder retention: " << error.what() << '\n'; return 1;
    }
}
