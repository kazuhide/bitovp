// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "supervisor.hpp"
#include <iostream>
#include <cstdlib>
#include <sstream>

#ifndef BITOVP_NATIVE_SOURCE_SHA256
#define BITOVP_NATIVE_SOURCE_SHA256 "unrecorded"
#endif

#if defined(__linux__)
#include <atomic>
#include <cerrno>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <mutex>
#include <poll.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <thread>
#include <time.h>
extern char **environ;

namespace {
using bitovp::gpu::supervisor::Options;
// Boot time includes suspend, so a resumed host cannot retain expired ownership.
std::uint64_t boottime_ns() {
    timespec now{};
    if (clock_gettime(CLOCK_BOOTTIME, &now) || now.tv_sec < 0 || now.tv_nsec < 0 ||
        std::uint64_t(now.tv_sec) > (UINT64_MAX - std::uint64_t(now.tv_nsec)) / 1000000000)
        throw std::runtime_error("Cannot read the supervisor boot-time clock");
    return std::uint64_t(now.tv_sec) * 1000000000 + std::uint64_t(now.tv_nsec);
}
[[noreturn]] void stop_chain() noexcept {
    const int result = kill(getpid(), SIGKILL);
    _exit(result == 0 ? 125 : 126);
}
void guard_parent(unsigned expected) {
    if (getppid() != pid_t(expected) || prctl(PR_SET_PDEATHSIG, static_cast<unsigned long>(SIGKILL), 0UL, 0UL, 0UL) || getppid() != pid_t(expected))
        throw std::runtime_error("Supervisor parent is unavailable or changed");
}
void validate_heartbeat_fd(int fd) {
    struct stat status{};
    const int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || (flags & O_ACCMODE) == O_WRONLY || fstat(fd, &status) ||
        (!S_ISFIFO(status.st_mode) && !S_ISSOCK(status.st_mode)))
        throw std::invalid_argument("Supervisor heartbeat requires a readable pipe or socket");
}
std::string executable_path(const std::string &program) {
    const auto executable = [](const std::string &path) {
        struct stat status{};
        return stat(path.c_str(), &status) == 0 && S_ISREG(status.st_mode) && access(path.c_str(), X_OK) == 0;
    };
    std::string result;
    if (program.find('/') != std::string::npos) result = std::filesystem::absolute(program).string();
    else {
        const char *raw = std::getenv("PATH");
        std::string paths;
        if (raw) paths = raw;
        else {
            const auto size = confstr(_CS_PATH, nullptr, 0);
            if (!size) throw std::runtime_error("Cannot resolve the executable search path");
            std::vector<char> system_path(size);
            if (confstr(_CS_PATH, system_path.data(), size) != size)
                throw std::runtime_error("Executable search path changed");
            paths = system_path.data();
        }
        std::size_t offset = 0;
        for (;;) {
            const auto end = paths.find(':', offset);
            const auto entry = paths.substr(offset, end == std::string::npos ? end : end - offset);
            const auto candidate = (std::filesystem::path(entry.empty() ? "." : entry) / program).string();
            if (executable(candidate)) { result = std::filesystem::absolute(candidate).string(); break; }
            if (end == std::string::npos) break;
            offset = end + 1;
        }
    }
    struct stat status{};
    if (result.empty() || !executable(result) || stat(result.c_str(), &status))
        throw std::invalid_argument("Supervised executable is unavailable");
    if (status.st_mode & (S_ISUID | S_ISGID))
        throw std::invalid_argument("Supervised executables must not change credentials at exec");
    errno = 0;
    const auto capabilities = getxattr(result.c_str(), "security.capability", nullptr, 0);
    if (capabilities >= 0 || (errno != ENODATA && errno != ENOTSUP && errno != EOPNOTSUPP))
        throw std::invalid_argument("Supervised executable capabilities cannot preserve the parent-death guard");
    return result;
}
class Deadline {
public:
    explicit Deadline(unsigned timeout) : timeout_(timeout) {
        sigevent event{};
        event.sigev_notify = SIGEV_SIGNAL; event.sigev_signo = SIGKILL;
        if (timer_create(CLOCK_BOOTTIME, &event, &timer_))
            throw std::runtime_error("Cannot create the kernel supervisor deadline");
        try {
            const auto now = boottime_ns(), window = std::uint64_t(timeout_) * 1000000;
            if (now > UINT64_MAX - window) throw std::runtime_error("Supervisor clock deadline overflow");
            arm(now + window);
        } catch (...) { if (timer_delete(timer_)) stop_chain(); throw; }
    }
    ~Deadline() { if (timer_delete(timer_)) stop_chain(); }
    void accept(const std::string &line) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stopping_) return;
        const auto value = bitovp::gpu::supervisor::deadline(line, boottime_ns(), timeout_, previous_);
        arm(value); previous_ = value;
    }
    void stop() {
        std::lock_guard<std::mutex> lock(mutex_);
        stopping_ = true;
        itimerspec none{};
        if (timer_settime(timer_, 0, &none, nullptr)) stop_chain();
    }
private:
    void arm(std::uint64_t value) {
        itimerspec setting{};
        setting.it_value.tv_sec = time_t(value / 1000000000);
        setting.it_value.tv_nsec = long(value % 1000000000);
        if (timer_settime(timer_, TIMER_ABSTIME, &setting, nullptr))
            throw std::runtime_error("Cannot arm the kernel supervisor deadline");
    }
    timer_t timer_{};
    unsigned timeout_;
    std::uint64_t previous_ = 0;
    std::mutex mutex_;
    bool stopping_ = false;
};
class Heartbeats {
public:
    Heartbeats(int fd, Deadline &deadline) : fd_(fd), deadline_(deadline) {}
    bool receive(int wait_ms) {
        pollfd descriptor{fd_, POLLIN, 0};
        const int ready = poll(&descriptor, 1, wait_ms);
        if (ready < 0 && errno == EINTR) return false;
        if (ready < 0 || (descriptor.revents & (POLLERR | POLLNVAL)))
            throw std::runtime_error("Supervisor heartbeat channel failed");
        if (!ready) return false;
        std::array<char, 256> bytes{};
        const auto size = read(fd_, bytes.data(), bytes.size());
        if (size < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return false;
        if (size <= 0) throw std::runtime_error("Supervisor heartbeat channel closed");
        bool accepted = false;
        for (ssize_t i = 0; i < size; ++i) {
            if (bytes[std::size_t(i)] == '\n') {
                deadline_.accept(line_); line_.clear(); accepted = true;
            } else {
                if (line_.size() == 20) throw std::invalid_argument("Supervisor heartbeat record is too long");
                line_.push_back(bytes[std::size_t(i)]);
            }
        }
        return accepted;
    }
private:
    int fd_;
    Deadline &deadline_;
    std::string line_;
};
int run(const Options &options) {
    guard_parent(options.parent_pid);
    validate_heartbeat_fd(int(options.heartbeat_fd));
    Deadline deadline(options.timeout_ms);
    Heartbeats heartbeats(int(options.heartbeat_fd), deadline);
    const auto program = executable_path(options.command.front());
    std::vector<std::string> environment;
    for (char **entry = environ; *entry; ++entry)
        if (std::strncmp(*entry, "CUDA_MPS_PIPE_DIRECTORY=", 24) != 0) environment.emplace_back(*entry);
    environment.emplace_back("CUDA_MPS_PIPE_DIRECTORY=");
    std::vector<char *> arguments, variables;
    for (const auto &arg : options.command) arguments.push_back(const_cast<char *>(arg.c_str()));
    for (auto &entry : environment) variables.push_back(entry.data());
    arguments.push_back(nullptr); variables.push_back(nullptr);
    // Validate an absolute heartbeat before starting work. No reader thread or
    // CUDA-linked code exists in this process before fork.
    while (!heartbeats.receive(100)) {}
    const auto expected_parent = getpid();
    const auto path = program.c_str();
    char *const *argv = arguments.data(), *const *env = variables.data();
    const int fd = int(options.heartbeat_fd);
    const pid_t child = fork();
    if (child < 0) throw std::runtime_error("Cannot fork the supervised command");
    if (!child) {
        // Only async-signal-safe operations and direct Linux syscalls precede exec.
        if (getppid() != expected_parent || syscall(SYS_prctl, long(PR_SET_PDEATHSIG), long(SIGKILL), 0L, 0L, 0L) < 0 ||
            getppid() != expected_parent) _exit(125);
        if (close(fd) && errno != EINTR) _exit(125);
        execve(path, argv, env);
        const int error = errno;
        constexpr char message[] = "Cannot execute supervised command\n";
        std::size_t offset = 0;
        while (offset < sizeof(message) - 1) {
            const auto written = write(STDERR_FILENO, message + offset, sizeof(message) - 1 - offset);
            if (written > 0) offset += std::size_t(written);
            else if (written < 0 && errno == EINTR) continue;
            else break;
        }
        _exit(error == ENOENT ? 127 : 126);
    }
    std::atomic<bool> finished{false};
    std::thread reader;
    try {
        reader = std::thread([&] {
            try { while (!finished.load()) heartbeats.receive(100); }
            catch (...) { if (!finished.load()) stop_chain(); }
        });
        int status = 0;
        pid_t result;
        do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
        if (result != child) stop_chain();
        finished.store(true); deadline.stop(); reader.join();
        if (WIFEXITED(status)) return WEXITSTATUS(status);
        return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 125;
    } catch (...) {
        // This process still owns the unreaped child. Its parent-death signal
        // terminates the command when the supervisor exits or is killed.
        stop_chain();
    }
}
} // namespace
#endif

int main(int argc, char **argv) {
    try {
        static constexpr char build_identity[] =
            "bitovp-vmaf-supervisor-v1-clock=boottime-source=" BITOVP_NATIVE_SOURCE_SHA256 "\n";
        if (argc == 2 && std::string(argv[1]) == "--identity") {
            std::cout << build_identity; return 0;
        }
        const auto options = bitovp::gpu::supervisor::parse(argc, argv);
        if (options.source != BITOVP_NATIVE_SOURCE_SHA256 ||
            options.protocol != bitovp::gpu::supervisor::protocol_version)
            throw std::invalid_argument("Supervisor build identity or protocol does not match");
#if defined(__linux__)
        return run(options);
#else
        throw std::runtime_error("Native command supervision requires Linux");
#endif
    } catch (const std::exception &error) {
        std::cerr << "Native supervisor failed: " << error.what() << '\n'; return 125;
    }
}
