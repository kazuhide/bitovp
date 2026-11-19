// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "decoder_runtime.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libswscale/swscale.h>
}
#include <cstdlib>
#include <dlfcn.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>

using namespace bitovp::gpu;
namespace {
void require(bool valid, const char *message) {
    if (!valid) throw std::runtime_error(message);
}
struct Scratch {
    std::filesystem::path path;
    ~Scratch() {
        std::error_code error;
        std::filesystem::remove_all(path, error);
    }
};
}

int main(int argc, char **argv) {
    try {
        require(argc == 2, "Expected shared object fixture path");
        // Keep the actual FFmpeg dependencies in DT_NEEDED under --as-needed.
        require(avformat_version() && avcodec_version() && avutil_version() && swscale_version(),
                "Expected FFmpeg libraries");
#if defined(__GLIBC__)
        const auto startup = capture_decoder_runtime();
        require(startup && decoder_runtime_unchanged(*startup), "Expected stable mapped FFmpeg identity");
        if (std::string(argv[1]) == "--print-fingerprint") {
            std::cout << startup->sha256 << '\n';
            return 0;
        }
        char scratch_name[] = "/tmp/bitovp-decoder-runtime-XXXXXX";
        const auto *created = mkdtemp(scratch_name);
        require(created, "Cannot create scratch directory");
        Scratch scratch{created};
        const auto plugin = scratch.path / "codec-fixture.so";
        std::filesystem::copy_file(argv[1], plugin);
        auto *module = dlopen(plugin.c_str(), RTLD_NOW | RTLD_LOCAL);
        require(module, "Cannot load extra codec library");
        const auto loaded = capture_decoder_runtime();
        require(loaded && loaded->sha256 != startup->sha256,
                "A loaded dependency must change the runtime identity");
        require(loaded->generation != startup->generation, "A late load must invalidate a decode checkpoint");
        require(decoder_runtime_unchanged(*startup),
                "Extra modules in the isolated backend setup window leave initial mappings valid");
        std::ofstream(plugin, std::ios::binary | std::ios::app) << 'x';
        require(!decoder_runtime_unchanged(*loaded), "Changed mapped bytes must invalidate attestation");
        const auto updated = capture_decoder_runtime();
        require(updated && updated->sha256 != loaded->sha256,
                "A new byte-level dependency identity must be observed");
        std::filesystem::rename(plugin, scratch.path / "old-codec-fixture.so");
        std::filesystem::copy_file(argv[1], plugin);
        require(!decoder_runtime_unchanged(*updated), "Replacement cannot attest the old mapped inode");
        require(!capture_decoder_runtime(), "A pathname pointing at a different inode cannot be attested");
        require(dlclose(module) == 0, "Could not unload codec fixture");
        require(runtime_loader_generation() != std::optional<LoaderGeneration>{loaded->generation},
                "An unload must invalidate a decode checkpoint");
#else
        if (std::string(argv[1]) == "--print-fingerprint") return 77;
        require(!capture_decoder_runtime(), "Unsupported loader must leave runtime identity unavailable");
#endif
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
