// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "decoder_runtime.hpp"

#if defined(__linux__) && defined(__GLIBC__)
extern "C" {
#include <libavutil/mem.h>
#include <libavutil/sha.h>
}
#include <algorithm>
#include <array>
#include <cerrno>
#include <cinttypes>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <fcntl.h>
#include <fstream>
#include <iomanip>
#include <link.h>
#include <locale>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <sys/auxv.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>
#endif

namespace bitovp::gpu {
#if defined(__linux__) && defined(__GLIBC__)
namespace {
class Sha256 {
public:
    Sha256() : state_(av_sha_alloc(), &av_free) {
        if (!state_) throw std::bad_alloc();
        if (av_sha_init(state_.get(), 256)) throw std::runtime_error("Cannot initialize SHA-256");
    }
    void update(const std::uint8_t *bytes, std::size_t length) {
        av_sha_update(state_.get(), bytes, length);
    }
    std::string finish() {
        std::array<std::uint8_t, 32> digest{};
        av_sha_final(state_.get(), digest.data());
        std::ostringstream out;
        out.imbue(std::locale::classic());
        for (auto value : digest) out << std::hex << std::setw(2) << std::setfill('0') << unsigned(value);
        return out.str();
    }
private:
    std::unique_ptr<AVSHA, decltype(&av_free)> state_;
};

struct ExecutableMapping {
    std::uintptr_t start, end;
    unsigned int major, minor;
    std::uintmax_t inode;
};

std::vector<ExecutableMapping> executable_mappings() {
    std::vector<ExecutableMapping> mappings;
    std::ifstream maps("/proc/self/maps");
    for (std::string line; std::getline(maps, line);) {
        ExecutableMapping info{};
        char permissions[5]{};
        std::uintmax_t offset = 0;
        if (std::sscanf(line.c_str(),
                "%" SCNxPTR "-%" SCNxPTR " %4s %" SCNxMAX " %x:%x %" SCNuMAX,
                &info.start, &info.end, permissions, &offset,
                &info.major, &info.minor, &info.inode) == 7 &&
            permissions[2] == 'x' && info.inode)
            mappings.push_back(info);
    }
    return mappings;
}

class File {
public:
    explicit File(const std::string &path) : fd(open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NONBLOCK)) {}
    ~File() { if (fd >= 0) close(fd); }
    File(const File &) = delete;
    File &operator=(const File &) = delete;
    const int fd;
};

bool same_file(const struct stat &a, const struct stat &b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
           a.st_ctim.tv_sec == b.st_ctim.tv_sec && a.st_ctim.tv_nsec == b.st_ctim.tv_nsec &&
           a.st_mtim.tv_sec == b.st_mtim.tv_sec && a.st_mtim.tv_nsec == b.st_mtim.tv_nsec;
}

std::optional<std::string> library_identity(const DecoderRuntime::SharedObject &library,
                                             const std::vector<ExecutableMapping> &mappings) {
    const auto mapping = std::find_if(mappings.begin(), mappings.end(), [&](const auto &m) {
        return m.start <= library.executable_address && library.executable_address < m.end;
    });
    if (mapping == mappings.end()) return std::nullopt;
    // Resolve the loader's path to an FD and ensure it still names the file
    // actually mapped as executable. A rename can leave an old DSO mapped
    // while another file occupies its pathname.
    const File file(library.path);
    struct stat before{}, after{}, current{};
    if (file.fd < 0 || fstat(file.fd, &before) != 0 || !S_ISREG(before.st_mode) ||
        before.st_size <= 0 || mapping->major != major(before.st_dev) ||
        mapping->minor != minor(before.st_dev) || mapping->inode != before.st_ino)
        return std::nullopt;
    Sha256 hasher;
    std::array<std::uint8_t, 1 << 16> bytes{};
    for (;;) {
        const auto count = read(file.fd, bytes.data(), bytes.size());
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) return std::nullopt;
        if (count == 0) break;
        hasher.update(bytes.data(), static_cast<std::size_t>(count));
    }
    if (fstat(file.fd, &after) != 0 || stat(library.path.c_str(), &current) != 0 ||
        !same_file(before, after) || !same_file(before, current))
        return std::nullopt;
    // A change followed by restoration of old bytes still changes the inode
    // stamp. Encode it alongside the bytes to fence changes across scoring.
    std::ostringstream identity;
    identity.imbue(std::locale::classic());
    identity << library.path.size() << ':' << library.path << ':' << before.st_dev
             << ':' << before.st_ino << ':' << before.st_size << ':'
             << before.st_ctim.tv_sec << ':' << before.st_ctim.tv_nsec << ':'
             << before.st_mtim.tv_sec << ':' << before.st_mtim.tv_nsec << ':' << hasher.finish();
    return identity.str();
}

std::optional<std::string> decoder_symbol_providers(
    const std::vector<DecoderRuntime::SharedObject> &libraries) {
    std::ostringstream providers;
    providers.imbue(std::locale::classic());
    for (const auto *symbol : {"avformat_open_input", "avcodec_receive_frame", "av_pix_fmt_desc_get", "sws_scale"}) {
        const auto address = dlsym(RTLD_DEFAULT, symbol);
        Dl_info info{};
        if (!address || !dladdr(address, &info) || !info.dli_fname) return std::nullopt;
        const auto provider = std::find_if(libraries.begin(), libraries.end(), [&](const auto &library) {
            if (library.path != info.dli_fname) return false;
            Dl_info mapped{};
            return dladdr(reinterpret_cast<const void *>(library.executable_address), &mapped) &&
                   mapped.dli_fbase == info.dli_fbase;
        });
        if (provider == libraries.end()) return std::nullopt;
        providers << symbol << ':' << (provider - libraries.begin()) << '\n';
    }
    return providers.str();
}

bool has_elf_audit_tags(const dl_phdr_info &info) {
    for (unsigned int i = 0; i < info.dlpi_phnum; ++i) {
        const auto &dynamic = info.dlpi_phdr[i];
        if (dynamic.p_type != PT_DYNAMIC) continue;
        const auto *begin = info.dlpi_phdr;
        const auto *end = begin + info.dlpi_phnum;
        // Inspect only a dynamic table wholly contained in a readable segment.
        if (!dynamic.p_memsz || dynamic.p_memsz % sizeof(ElfW(Dyn)) ||
            std::none_of(begin, end, [&](const auto &segment) {
                if (segment.p_type != PT_LOAD || !(segment.p_flags & PF_R) ||
                    dynamic.p_vaddr < segment.p_vaddr)
                    return false;
                const auto offset = dynamic.p_vaddr - segment.p_vaddr;
                return offset <= segment.p_memsz && dynamic.p_memsz <= segment.p_memsz - offset;
            }))
            return true;
        const auto count = dynamic.p_memsz / sizeof(ElfW(Dyn));
        const auto *tags = reinterpret_cast<const ElfW(Dyn) *>(info.dlpi_addr + dynamic.p_vaddr);
        const auto *terminator = std::find_if(tags, tags + count, [](const auto &tag) {
            return tag.d_tag == DT_NULL || tag.d_tag == DT_AUDIT || tag.d_tag == DT_DEPAUDIT;
        });
        if (terminator == tags + count || terminator->d_tag != DT_NULL) return true;
    }
    return false;
}

bool loader_audit_possible() {
    // An auditor can use a separate namespace outside this loader census.
    // AT_BASE is absent for explicit loader execution. Check exec-time
    // LD_AUDIT as well since a constructor can unset the live variable.
    if (!getauxval(AT_BASE) || std::getenv("LD_AUDIT")) return true;
    std::ifstream environment("/proc/self/environ", std::ios::binary);
    for (std::string entry; std::getline(environment, entry, '\0');)
        if (entry.compare(0, 9, "LD_AUDIT=") == 0) return true;
    if (!environment.eof() || environment.bad()) return true;
    return dl_iterate_phdr([](dl_phdr_info *info, std::size_t, void *) {
        return has_elf_audit_tags(*info) ? 1 : 0;
    }, nullptr) != 0;
}

std::optional<std::string> fingerprint(const std::vector<DecoderRuntime::SharedObject> &libraries) {
    if (loader_audit_possible()) return std::nullopt;
    const auto providers = decoder_symbol_providers(libraries);
    if (!providers) return std::nullopt;
    const auto mappings = executable_mappings();
    // Preserve loader order. Identical mapped bytes can resolve different
    // definitions when multiple libraries export the same symbol.
    std::string bytes = "bitovp-decoder-runtime-v2\n";
    for (const auto &library : libraries) {
        const auto identity = library_identity(library, mappings);
        if (!identity) return std::nullopt;
        bytes += *identity + '\n';
    }
    bytes += *providers;
    Sha256 hasher;
    hasher.update(reinterpret_cast<const std::uint8_t *>(bytes.data()), bytes.size());
    return hasher.finish();
}
}

std::optional<LoaderGeneration> runtime_loader_generation() noexcept {
    std::optional<LoaderGeneration> generation;
    dl_iterate_phdr([](dl_phdr_info *info, std::size_t size, void *arg) {
        if (size >= offsetof(dl_phdr_info, dlpi_subs) + sizeof(info->dlpi_subs))
            *static_cast<std::optional<LoaderGeneration> *>(arg) =
                LoaderGeneration{info->dlpi_adds, info->dlpi_subs};
        return 1;
    }, &generation);
    return generation;
}

std::optional<DecoderRuntime> capture_decoder_runtime() noexcept {
    try {
        const auto generation = runtime_loader_generation();
        if (!generation) return std::nullopt;
        DecoderRuntime runtime{{}, {}, *generation};
        const int status = dl_iterate_phdr([](dl_phdr_info *info, std::size_t, void *arg) {
            const char *path = info->dlpi_name;
            if (!path || !*path || std::string_view(path) == "linux-vdso.so.1") return 0;
            if (*path != '/') return 1;
            for (unsigned int i = 0; i < info->dlpi_phnum; ++i) {
                const auto &header = info->dlpi_phdr[i];
                if (header.p_type != PT_LOAD || !(header.p_flags & PF_X) || !header.p_filesz) continue;
                try {
                    static_cast<DecoderRuntime *>(arg)->libraries.push_back(
                        {path, info->dlpi_addr + header.p_vaddr});
                } catch (...) {
                    return 1;
                }
                return 0;
            }
            return 1;
        }, &runtime);
        if (status != 0) return std::nullopt;
        const auto sha256 = fingerprint(runtime.libraries);
        if (!sha256 || runtime_loader_generation() != generation) return std::nullopt;
        runtime.sha256 = *sha256;
        return runtime;
    } catch (...) {
        return std::nullopt;
    }
}

bool decoder_runtime_unchanged(const DecoderRuntime &snapshot) noexcept {
    try {
        return fingerprint(snapshot.libraries) == std::optional<std::string>{snapshot.sha256};
    } catch (...) {
        return false;
    }
}
#else
std::optional<LoaderGeneration> runtime_loader_generation() noexcept { return std::nullopt; }
std::optional<DecoderRuntime> capture_decoder_runtime() noexcept { return std::nullopt; }
bool decoder_runtime_unchanged(const DecoderRuntime &) noexcept { return false; }
#endif
}
