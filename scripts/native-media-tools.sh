#!/bin/sh
# Installs the FFmpeg build and the VMAF models that the worker image pins
# into a directory, so that tests which drive real FFmpeg on a Linux host use
# the same bytes as the image. The pins are read from the Dockerfile and from
# docker/vmaf-models.sha256; nothing is pinned a second time here.
#
#   sh scripts/native-media-tools.sh <new directory>
#
# Leaves <directory>/bin/ffmpeg, <directory>/bin/ffprobe and <directory>/model.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
target=${1:?usage: native-media-tools.sh <new directory>}

# One line of the Dockerfile, holding only the characters that a build tag, a
# version, a commit or a checksum uses.
pin() {
	value=$(sed -n "s/^ARG $1=\"\([^\"]*\)\"\$/\1/p" "$root/Dockerfile")
	case "$value" in
		'' | *[!A-Za-z0-9._-]*)
			echo "The Dockerfile does not pin $1 once as a plain value" >&2
			exit 1
			;;
	esac
	printf '%s' "$value"
}

case "$(uname -s) $(uname -m)" in
	"Linux x86_64")
		arch=linux64
		sha=$(pin FFMPEG_SHA256_AMD64)
		;;
	"Linux aarch64" | "Linux arm64")
		arch=linuxarm64
		sha=$(pin FFMPEG_SHA256_ARM64)
		;;
	*)
		echo "The pinned FFmpeg build exists for Linux on x86_64 and arm64 only" >&2
		exit 1
		;;
esac
build=$(pin FFMPEG_BUILD)
version=$(pin FFMPEG_VER)
reference=$(pin VMAF_MODEL_REF)

# The asset name is the Dockerfile's, with its three variables filled in.
template=$(sed -n 's/.*FFMPEG_URL="\(https:[^"]*\)".*/\1/p' "$root/Dockerfile")
url=$(printf '%s' "$template" |
	sed "s|\${FFMPEG_BUILD}|$build|; s|\${FFMPEG_VER}|$version|; s|\${FF_ARCH}|$arch|")
case "$url" in
	# Empty, a variable left unfilled, or more than one line.
	'' | *[!A-Za-z0-9:/._-]*)
		echo "The Dockerfile's FFmpeg asset URL could not be read" >&2
		exit 1
		;;
	https://github.com/BtbN/FFmpeg-Builds/releases/download/*) ;;
	*)
		echo "The Dockerfile's FFmpeg asset URL has an unexpected origin" >&2
		exit 1
		;;
esac

# A model name is a file in the model directory, never a path.
grep -v '^#' "$root/docker/vmaf-models.sha256" | while read -r _ name; do
	case "$name" in
		'' | */* | .*)
			echo "docker/vmaf-models.sha256 holds an unexpected model name" >&2
			exit 1
			;;
	esac
done

# Refuses an existing directory before anything is written into it.
mkdir "$target"
mkdir "$target/bin" "$target/model"
archive="$target/ffmpeg.tar.xz"
curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --max-time 600 \
	"$url" -o "$archive"
printf '%s  %s\n' "$sha" "$archive" | sha256sum -c - >/dev/null
tar -xJf "$archive" -C "$target/bin" --strip-components=2 \
	--wildcards '*/bin/ffmpeg' '*/bin/ffprobe'
rm -f "$archive"
chmod +x "$target/bin/ffmpeg" "$target/bin/ffprobe"

# Each model keeps its name; upstream stores the v1 models in two directories.
base="https://raw.githubusercontent.com/Netflix/vmaf/$reference/model"
grep -v '^#' "$root/docker/vmaf-models.sha256" | while read -r _ name; do
	case "$name" in
		vmaf_v1.0.16_hfr_*) path="vmaf_v1.0.16_hfr/$name" ;;
		vmaf_v1.0.16_*) path="vmaf_v1.0.16/$name" ;;
		*) path=$name ;;
	esac
	curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --max-time 120 \
		"$base/$path" -o "$target/model/$name"
done
(cd "$target/model" && sha256sum -c --strict "$root/docker/vmaf-models.sha256" >/dev/null)

# The image build's own proof: this FFmpeg scores with a pinned model.
sh "$root/docker/vmaf-acceptance.sh" "$target/bin/ffmpeg" "$target/model"
"$target/bin/ffmpeg" -hide_banner -version | sed -n 1p
echo "VMAF models: $(ls "$target/model" | wc -l | tr -d ' ') files verified"
