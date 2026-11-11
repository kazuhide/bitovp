"""Use the kernel.org Ubuntu mirror only when hosted runner mirror DNS fails."""
import os
from pathlib import Path
import re
import subprocess
import sys

SOURCE = Path("/etc/apt/sources.list.d/ubuntu.sources")
MIRROR = b"https://mirrors.edge.kernel.org/ubuntu/"
HOSTS = ("azure.archive.ubuntu.com", "archive.ubuntu.com", "security.ubuntu.com")
KNOWN = {b"mirror+file:/etc/apt/apt-mirrors.txt"} | {
    f"{scheme}://{host}/ubuntu{slash}".encode()
    for scheme in ("http", "https") for host in HOSTS for slash in ("", "/")
}


def fallback_sources(data):
    blocks = re.split(rb"\n[ \t]*\n", data)
    count = 0
    for block in blocks:
        uris = re.findall(rb"(?m)^URIs:[ \t]*(.*)$", block)
        if not uris:
            continue
        if len(uris) != 1 or uris[0].strip() not in KNOWN:
            raise ValueError("Unexpected Ubuntu apt URI; sources unchanged")
        if not re.search(rb"(?m)^Signed-By:[ \t]*/usr/share/keyrings/ubuntu-archive-keyring\.gpg[ \t]*$", block):
            raise ValueError("Ubuntu archive Signed-By is required")
        if re.search(rb"(?im)^(?:Trusted|Allow-Insecure|Allow-Weak):", block):
            raise ValueError("Unexpected apt trust override")
        count += 1
    if not count:
        raise ValueError("No Ubuntu apt URIs found")
    return re.sub(rb"(?m)^(URIs:[ \t]*)[^\n]+$", lambda match: match[1] + MIRROR, data)


def resolves(host):
    print(f"Resolving {host}", flush=True)
    try:
        result = subprocess.run(["getent", "ahostsv4", host], timeout=10, capture_output=True)
        return result.returncode == 0 and bool(result.stdout.strip())
    except subprocess.TimeoutExpired:
        return False


def main():
    if not (sys.platform == "linux" and os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and os.environ.get("ImageOS") == "ubuntu24"):
        raise RuntimeError("Ubuntu mirror preparation requires a hosted Ubuntu 24.04 runner")
    print(f"Runner image: {os.environ['ImageOS']} {os.environ.get('ImageVersion', '')}")
    if any([resolves(host) for host in HOSTS]):
        print("Ubuntu mirror DNS available; apt sources unchanged")
        return
    if not resolves("mirrors.edge.kernel.org"):
        raise RuntimeError("Ubuntu and kernel.org mirror DNS unavailable; sources unchanged")
    subprocess.run(["curl", "--fail", "--silent", "--show-error", "--head",
                    "--proto", "=https", "--connect-timeout", "5", "--max-time", "15",
                    MIRROR.decode() + "dists/noble/InRelease"], check=True, stdout=subprocess.DEVNULL)
    if SOURCE.is_symlink() or not SOURCE.is_file():
        raise RuntimeError("Expected a regular Ubuntu apt source file")
    updated = fallback_sources(SOURCE.read_bytes())
    subprocess.run(["sudo", "tee", str(SOURCE)], input=updated, check=True, stdout=subprocess.DEVNULL)
    if SOURCE.read_bytes() != updated:
        raise RuntimeError("Ubuntu apt source write verification failed")
    for line in updated.decode().splitlines():
        if line.startswith(("URIs:", "Suites:", "Signed-By:")):
            print(line)
    # Strict update verifies Ubuntu signatures and current metadata before installation.
    subprocess.run(["sudo", "apt-get", "-o", "APT::Update::Error-Mode=any",
                    "-o", "Acquire::Retries=0", "-o", "Acquire::https::Timeout=15",
                    "-o", "Acquire::http::Timeout=15", "update"], check=True)


if __name__ == "__main__":
    main()
