#!/bin/sh
# Takes the redis-server program out of the Redis image that docker-compose.yml
# pins, so that tests which start their own server on a Linux host run the
# build that production runs. Nothing is pinned a second time here.
#
#   sh scripts/redis-server-tools.sh <new directory>
#
# Leaves <directory>/bin/redis-server. The image is built for musl, so the
# program runs through the image's own loader and libraries, which are copied
# with it. Needs Docker.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
target=${1:?usage: redis-server-tools.sh <new directory>}
# In a statement of its own, so that a parent directory that does not exist
# stops the script.
parent=$(cd "$(dirname "$target")" && pwd)
target=$parent/$(basename "$target")
# Paths are written into the script that starts the server.
plain() {
	case "$1" in
		*[!A-Za-z0-9/._-]*) return 1 ;;
	esac
}
if ! plain "$target"; then
	echo "The directory's path may hold only letters, digits and / . _ -" >&2
	exit 1
fi

# One image, by version and digest.
image=$(sed -n 's/^ *image: \(redis:[^ ]*\)$/\1/p' "$root/docker-compose.yml")
case "$image" in
	# Empty, or more than one line.
	'' | *[!A-Za-z0-9:@._-]*) version= ;;
	*)
		version=$(printf '%s\n' "$image" |
			sed -n 's/^redis:\([0-9][0-9.]*\)-alpine@sha256:[a-f0-9]\{64\}$/\1/p')
		;;
esac
if [ -z "$version" ]; then
	echo "docker-compose.yml does not pin one Redis image by version and digest" >&2
	exit 1
fi
if [ "$(uname -s)" != Linux ]; then
	echo "The image's redis-server runs on Linux only" >&2
	exit 1
fi

# Refuses an existing directory before anything is written into it.
mkdir "$target"
mkdir "$target/bin" "$target/lib" "$target/libexec"
container=$(docker create "$image")
# With the anonymous volume of the image's /data. A signal ends the script
# through the same trap.
trap 'docker rm --force --volumes "$container" >/dev/null' EXIT
trap 'exit 1' HUP INT TERM
docker cp --follow-link "$container:/usr/local/bin/redis-server" \
	"$target/libexec/redis-server"
docker cp "$container:/lib/." "$target/lib/"
docker cp "$container:/usr/lib/." "$target/lib/"

loader=$(ls "$target"/lib/ld-musl-*.so.1 2>/dev/null || true)
if [ ! -f "$loader" ] || ! plain "$loader"; then
	echo "The image holds no single musl loader with a plain name" >&2
	exit 1
fi
# exec keeps the process id, so a signal to the program reaches the server.
cat >"$target/bin/redis-server" <<EOF
#!/bin/sh
exec "$loader" --library-path "$target/lib" "$target/libexec/redis-server" "\$@"
EOF
chmod +x "$target/bin/redis-server"

reported=$("$target/bin/redis-server" --version)
case "$reported" in
	"Redis server v=$version "*) ;;
	*)
		echo "The image's redis-server reports another version than its tag" >&2
		exit 1
		;;
esac
printf '%s\n' "$reported"
