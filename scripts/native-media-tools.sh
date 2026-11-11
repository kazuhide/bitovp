#!/bin/sh
# Puts the FFmpeg that the worker image builds, and the VMAF models that it
# pins, into a directory, so that tests which drive real FFmpeg on a Linux host
# use the image's own build. FFmpeg comes from the Dockerfile's "ffmpeg" stage:
# the same sources and the same commands as the image. The models' pins are
# read from the Dockerfile and from docker/vmaf-models.sha256. Nothing is
# pinned a second time here.
#
#   sh scripts/native-media-tools.sh <new directory>
#
# Leaves <directory>/bin/ffmpeg, <directory>/bin/ffprobe and <directory>/model.
# Needs Docker with BuildKit, and glibc 2.36 or newer on the host: the programs
# are linked in the image, which is Debian 12.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
target=${1:?usage: native-media-tools.sh <new directory>}
# In a statement of its own, so that a parent directory that does not exist
# stops the script.
parent=$(cd "$(dirname "$target")" && pwd)
target=$parent/$(basename "$target")
# Docker reads the place of the build's output from a list that commas and
# equals signs divide.
case "$target" in
	*[!A-Za-z0-9/._-]*)
		echo "The directory's path may hold only letters, digits and / . _ -" >&2
		exit 1
		;;
esac

# One line of the Dockerfile, holding only the characters that a commit uses.
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
reference=$(pin VMAF_MODEL_REF)

if [ "$(uname -s)" != Linux ]; then
	echo "The image's FFmpeg runs on Linux only" >&2
	exit 1
fi

# The list names a model, and a model name is a plain file name: it becomes a
# file in the model directory and a part of a URL.
if ! grep -q -v '^#' "$root/docker/vmaf-models.sha256"; then
	echo "docker/vmaf-models.sha256 names no model" >&2
	exit 1
fi
grep -v '^#' "$root/docker/vmaf-models.sha256" | while read -r _ name; do
	case "$name" in
		'' | .* | *[!A-Za-z0-9._-]*)
			echo "docker/vmaf-models.sha256 holds an unexpected model name" >&2
			exit 1
			;;
	esac
done

# Refuses an existing directory before anything is written into it.
mkdir "$target"
# The stage holds bin/ffmpeg, bin/ffprobe and the licences of what they contain.
# A failed build leaves no empty directory in the way of the next run.
docker build --file "$root/Dockerfile" --target ffmpeg \
	--output "type=local,dest=$target" "$root" || {
	status=$?
	rmdir "$target" 2>/dev/null || :
	exit "$status"
}
for program in ffmpeg ffprobe; do
	if [ ! -x "$target/bin/$program" ]; then
		echo "The Dockerfile's ffmpeg stage did not provide bin/$program" >&2
		exit 1
	fi
done
mkdir "$target/model"

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
sh "$root/docker/vmaf-build-proof.sh" "$target/bin/ffmpeg" "$target/model"
"$target/bin/ffmpeg" -hide_banner -version | sed -n 1p
echo "VMAF models: $(ls "$target/model" | wc -l | tr -d ' ') files verified"
