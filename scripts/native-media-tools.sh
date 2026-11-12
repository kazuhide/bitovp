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
#
# A kept build is taken only when it agrees with the list of checksums that is
# kept with it. The list finds damage, not replacement: whoever can write the
# cache directory can put another build under the key, with a list of its own.
# That a kept build was compiled from these sources rests on who can write
# there.
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
	# A build is kept only after it is made and proven. A place that cannot
	# take it is refused here, before the build and not after it. Nothing is
	# made here: a run that is refused writes nothing.
	if [ -e "$cache" ] || [ -L "$cache" ]; then
		if [ ! -d "$cache" ] || [ ! -w "$cache" ] || [ ! -x "$cache" ]; then
			echo "The cache directory is not a directory that can be written and searched: $cache" >&2
			exit 1
		fi
	elif [ ! -w "$parent" ]; then
		echo "The cache directory cannot be made: $parent cannot be written" >&2
		exit 1
	fi
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
# The names of the list, each once and in one order: the model directory is
# compared with them, and they are counted.
models=$(grep -v '^#' "$root/docker/vmaf-models.sha256" | while read -r _ name; do
	printf '%s\n' "$name"
done | LC_ALL=C sort -u)

# Every file below a directory except a kept build's list, by its path from
# there and in one order: the list is written from these lines and compared
# with them.
files() {
	(cd "$1" && find . ! -type d ! -path ./SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort)
}

# Ends the script unless the directory $1 holds a whole build as it is kept:
# the list and the three directories, and no other name beside them; below
# them only plain files, and directories that hold something; each file that
# the list names, with the bytes that the list names, and no other file; and
# the two programs, which can be started. $2 says in the message which build
# it is. The list is compared with the files before sha256sum reads what the
# list names, so that sha256sum reads plain files of the build and nothing
# else: a list that names "-" would make it read its input.
whole() {
	if [ "$(ls -A "$1" | LC_ALL=C sort)" != "$(printf 'SHA256SUMS\nbin\nmodel\nshare')" ] ||
		[ ! -f "$1/SHA256SUMS" ] || [ ! -d "$1/bin" ] || [ ! -d "$1/model" ] || [ ! -d "$1/share" ]; then
		echo "$2: it does not hold SHA256SUMS, bin, model and share alone" >&2
		exit 1
	fi
	if ! other=$(find "$1" ! -type f ! -type d) || [ -n "$other" ]; then
		echo "$2: it holds something that is neither a file nor a directory" >&2
		exit 1
	fi
	if ! empty=$(find "$1" -type d -empty) || [ -n "$empty" ]; then
		echo "$2: it holds an empty directory" >&2
		exit 1
	fi
	if [ "$(files "$1")" != "$(sed 's/^[0-9a-f]\{64\}  //' "$1/SHA256SUMS")" ]; then
		echo "$2: its files are not the ones that SHA256SUMS lists" >&2
		exit 1
	fi
	if ! (cd "$1" && sha256sum -c --strict --quiet SHA256SUMS >&2); then
		echo "$2: sha256sum does not confirm SHA256SUMS" >&2
		exit 1
	fi
	for program in ffmpeg ffprobe; do
		if [ ! -x "$1/bin/$program" ]; then
			echo "$2: bin/$program is not a program that can be started" >&2
			exit 1
		fi
	done
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
	# Whatever stands under the key is taken only as a whole build. Anything
	# else ends the script: building in its place would hide that the cache
	# went wrong.
	if [ -e "$entry" ] || [ -L "$entry" ]; then
		whole "$entry" "The FFmpeg build kept in $entry is damaged"
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
# sha256sum passes over a file that the list does not name. The directory
# holds the models of the list and nothing else, so that the number printed
# below is of models that were verified.
if [ "$(ls -A "$target/model" | LC_ALL=C sort)" != "$models" ]; then
	echo "$target/model does not hold the models that docker/vmaf-models.sha256 names and nothing else" >&2
	exit 1
fi
(cd "$target/model" && sha256sum -c --strict "$root/docker/vmaf-models.sha256" >/dev/null)

# The image build's own proof: this FFmpeg scores with a pinned model.
sh "$root/docker/vmaf-build-proof.sh" "$target/bin/ffmpeg" "$target/model"

# Only a build that passed the proof is kept. It is written under another name
# and gets its key last, so that a run which is interrupted leaves no directory
# that a later run would take for a whole build.
partial=
if [ -n "$entry" ] && [ -z "$kept" ]; then
	# A run that finds the build copies bin, model and share and nothing else.
	# A build that holds more is not kept: both ways leave the same directory.
	if [ "$(ls -A "$target" | LC_ALL=C sort)" != "$(printf 'bin\nmodel\nshare')" ]; then
		echo "The build cannot be kept: it does not hold bin, model and share alone, and a run that reuses a build gets these three" >&2
		exit 1
	fi
	# The list has a line for each file, and sha256sum is given the paths as
	# words: a path with any other character would fall apart in both.
	if files "$target" | LC_ALL=C grep -q '[^A-Za-z0-9/._-]'; then
		echo "The build cannot be kept: the path of a file in it holds other characters than letters, digits and / . _ -" >&2
		exit 1
	fi
	# Two runs may both find that the directory is missing.
	mkdir -p "$cache"
	# Whatever ends the script from here on takes the directory of the other
	# name with it.
	trap '[ -z "$partial" ] || rm -rf "$partial"' EXIT
	partial=$(mktemp -d "$cache/partial.XXXXXX")
	cp -R -p "$target/bin" "$target/share" "$target/model" "$partial/"
	(cd "$partial" && files . | xargs sha256sum >SHA256SUMS)
	# The check of a build that is found, before the key says that this one is
	# whole: a list that went wrong while it was written would stop every later
	# run.
	whole "$partial" "The build is not kept: its copy in $cache is not whole"
	# One rename. Without -T, mv would put the directory into a build that
	# another run gave this key meanwhile.
	if reason=$(mv -T "$partial" "$entry" 2>&1); then
		partial=
	elif [ -e "$entry" ] || [ -L "$entry" ]; then
		# The other run's build stands under the same key, and the run that
		# takes it checks it.
		rm -rf "$partial"
		partial=
		echo "Another run kept a build under the key $key first: this run's copy is dropped" >&2
	else
		echo "The build could not be kept in $entry: $reason" >&2
		exit 1
	fi
fi

"$target/bin/ffmpeg" -hide_banner -version | sed -n 1p
echo "VMAF models: $(printf '%s\n' "$models" | wc -l | tr -d ' ') files verified"
if [ -n "$kept" ]; then
	echo "FFmpeg: reused the build kept under the key of these sources ($key)"
else
	echo "FFmpeg: built from the pinned sources"
fi
# The two checksums name the build in the log: a run that reuses a build shows
# the lines of the run that compiled it.
(cd "$target" && sha256sum bin/ffmpeg bin/ffprobe)
