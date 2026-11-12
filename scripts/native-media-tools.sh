#!/bin/sh
# Puts the FFmpeg that the worker image builds, and the VMAF models that it
# pins, into a directory, so that tests which drive real FFmpeg on a Linux host
# use the image's own build. FFmpeg comes from the Dockerfile's "ffmpeg" stage:
# the same sources and the same commands as the image. The models' pins are
# read from the Dockerfile and from docker/vmaf-models.sha256. Nothing is
# pinned a second time here.
#
#   sh scripts/native-media-tools.sh [--cache <cache directory>] <new directory>
#
# Leaves <directory>/bin/ffmpeg, <directory>/bin/ffprobe, <directory>/model and
# the licences below <directory>/share. An image build can take the directory
# in place of the "ffmpeg" stage: docker build --build-context ffmpeg=<directory>.
# Needs Docker with BuildKit, and glibc 2.36 or newer on the host: the programs
# are linked in the image, which is Debian 12.
#
# The build takes more than ten minutes in CI. With --cache, a build is kept in
# <cache directory> under a key of what it is made from, and a run that finds
# its key there copies that build instead of building and downloading. Every
# run verifies the models and proves the FFmpeg that it leaves.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
usage='usage: native-media-tools.sh [--cache <cache directory>] <new directory>'
cache=
if [ "${1-}" = --cache ]; then
	cache=${2:?$usage}
	shift 2
fi
target=${1:?$usage}
# An option after the directory would be passed over without a word.
if [ "$#" -ne 1 ]; then
	echo "$usage" >&2
	exit 1
fi
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
if [ -n "$cache" ]; then
	parent=$(cd "$(dirname "$cache")" && pwd)
	cache=$parent/$(basename "$cache")
	# The same characters as in the target's path: one rule for both paths.
	case "$cache" in
		*[!A-Za-z0-9/._-]*)
			echo "The cache directory's path may hold only letters, digits and / . _ -" >&2
			exit 1
			;;
	esac
fi

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

# Every file below a directory except a kept build's list, by its path from
# there and in one order: the list is written from these lines and compared
# with them.
files() {
	(cd "$1" && find . ! -type d ! -path ./SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort)
}
damaged() {
	echo "The FFmpeg build kept in $entry is damaged: $1" >&2
	exit 1
}

# A build is kept under a key that names what it is made from: the processor
# that it runs on, and the three files that fix the sources, the models and
# these steps. The key is the SHA-256 of the processor's name and of the
# sha256sum lines of the files. The workflows that keep the cache directory
# between runs give the same three files to hashFiles.
entry=
kept=
if [ -n "$cache" ]; then
	machine=$(uname -m)
	sums=$(cd "$root" && sha256sum Dockerfile docker/vmaf-models.sha256 scripts/native-media-tools.sh)
	key=$(printf '%s\n%s\n' "$machine" "$sums" | sha256sum)
	key=${key%% *}
	# The key becomes the name of a directory.
	case "$key" in
		*[!a-f0-9]*) key= ;;
	esac
	if [ "${#key}" -ne 64 ]; then
		echo "sha256sum gave no key for the build" >&2
		exit 1
	fi
	entry=$cache/$key
	# A kept build is used only whole: each file that its list names, with the
	# bytes that the list names, and no other file. A damaged one ends the
	# script. Building in its place would hide that the cache went wrong.
	if [ -e "$entry" ]; then
		if ! (cd "$entry" && sha256sum -c --strict --quiet SHA256SUMS >&2); then
			damaged "a file is missing or differs from SHA256SUMS"
		fi
		if [ "$(files "$entry")" != "$(sed 's/^[0-9a-f]\{64\}  //' "$entry/SHA256SUMS")" ]; then
			damaged "it holds a file that SHA256SUMS does not list"
		fi
		for program in ffmpeg ffprobe; do
			if [ ! -x "$entry/bin/$program" ]; then
				damaged "bin/$program is not a program that can be started"
			fi
		done
		kept=$entry
	fi
fi

# Refuses an existing directory before anything is written into it.
mkdir "$target"
if [ -n "$kept" ]; then
	# With their modes: the two programs stay executable.
	cp -R -p "$kept/bin" "$kept/share" "$kept/model" "$target/"
else
	# The stage holds bin/ffmpeg, bin/ffprobe and the licences of what they
	# contain. A failed build leaves no empty directory in the way of the next
	# run.
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
fi
(cd "$target/model" && sha256sum -c --strict "$root/docker/vmaf-models.sha256" >/dev/null)

# The image build's own proof: this FFmpeg scores with a pinned model.
sh "$root/docker/vmaf-build-proof.sh" "$target/bin/ffmpeg" "$target/model"

# Only a build that passed the proof is kept. It is written under another name
# and gets its key last, so that a run which is interrupted leaves no directory
# that a later run would take for a whole build.
if [ -n "$entry" ] && [ -z "$kept" ]; then
	# The list has a line for each file, and sha256sum is given the paths as
	# words: a path with any other character would fall apart in both.
	if files "$target" | LC_ALL=C grep -q '[^A-Za-z0-9/._-]'; then
		echo "The build cannot be kept: the path of a file in it holds other characters than letters, digits and / . _ -" >&2
		exit 1
	fi
	[ -d "$cache" ] || mkdir "$cache"
	partial=$(mktemp -d "$cache/partial.XXXXXX")
	cp -R -p "$target/bin" "$target/share" "$target/model" "$partial/"
	(cd "$partial" && files . | xargs sha256sum >SHA256SUMS)
	mv "$partial" "$entry"
fi

"$target/bin/ffmpeg" -hide_banner -version | sed -n 1p
echo "VMAF models: $(ls "$target/model" | wc -l | tr -d ' ') files verified"
if [ -n "$kept" ]; then
	echo "FFmpeg: reused the build of the same sources ($key)"
else
	echo "FFmpeg: built from the pinned sources"
fi
# The two checksums name the build in the log: a run that reuses a build shows
# the lines of the run that compiled it.
(cd "$target" && sha256sum bin/ffmpeg bin/ffprobe)
