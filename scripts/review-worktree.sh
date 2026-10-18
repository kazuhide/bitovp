#!/usr/bin/env bash
# Set up a detached git worktree a review agent can run the gate suite in,
# without a 10-minute pnpm install and WITHOUT the trap that linking saves you
# into: pnpm workspace deps are RELATIVE symlinks (@bitovp/core ->
# ../../../../packages/core), so symlinking a package's whole node_modules into
# the worktree makes @bitovp/* resolve back into MAIN'S checkout — the agent
# then "reviews" the branch while executing main's core. This script links
# third-party entries to main (they are identical under a frozen lockfile) and
# recreates the @bitovp entries in-tree, then PROVES the resolution before
# reporting success.
#
# SECOND STANDING LIMIT (review of PR #176): run test binaries DIRECTLY
# (node_modules/.bin/vitest ...), never `pnpm --filter <pkg> test` — a filtered
# pnpm run here fired an implicit install pass that re-linked MAIN's
# node_modules (.pnpm/.bin mtimes moved; verified a no-op that time, but the
# write went into the OWNER'S checkout through the linked dirs).
#
# STANDING LIMIT (review of PR #171): a worktree built this way verifies the
# source-level review gates — typecheck, check, test, and the ledger guards —
# only while the reviewed lockfile matches the owner's installed graph. It is
# not the complete T3 release gate: frozen install, dependency audit, build, and
# worker smoke rest on an isolated standalone copy. `pnpm build` CANNOT pass
# here and its failure is environmental, not a finding: Turbopack
# refuses apps/web/node_modules/next because it resolves through the linked
# node_modules out of the worktree's filesystem root ("Symlink … points out of
# the filesystem root", a panic before it reads any source). Build + smoke rest
# on that isolated standalone exact-tree run; reviewers should say so rather
# than report a red from this linked worktree.
#
# Usage: scripts/review-worktree.sh <ref> [dir]
#        scripts/review-worktree.sh --check [Biome paths/options]
#   ref  branch/commit the agent should review
#   dir  worktree location (default: ${TMPDIR:-/tmp}/bitovp-review-<shortsha>)
#
# Cleanup (after the agent is DONE — never while it runs; a pruned worktree
# under a live agent once put its `git checkout` in the main tree):
#   git worktree remove --force <dir>
set -euo pipefail

if [ "${1:-}" = "--check" ]; then
	shift
	[ "$#" -gt 0 ] || set -- .
	# An ignored worktree can report zero files with exit 0. Require an actual
	# positive population, but preserve a tool failure's original exit status.
	if output="$(./node_modules/.bin/biome check --error-on-warnings --colors=off "$@" 2>&1)"; then
		status=0
	else
		status=$?
	fi
	printf '%s\n' "$output"
	[ "$status" -eq 0 ] || exit "$status"
	if ! printf '%s\n' "$output" | grep -Eq '^Checked [1-9][0-9]* files? in '; then
		echo "FAIL: Biome did not confirm a positive processed file population" >&2
		exit 1
	fi
	exit 0
fi

REF="${1:?usage: scripts/review-worktree.sh <ref> [dir]}"
ROOT="$(git rev-parse --show-toplevel)"
SHA="$(git -C "$ROOT" rev-parse --short "$REF")"
TMPBASE="${TMPDIR:-/tmp}"
WT="${2:-${TMPBASE%/}/bitovp-review-$SHA}"

if [ -e "$WT" ]; then
	echo "refusing: $WT already exists (git worktree remove --force '$WT' first)" >&2
	exit 1
fi
# A registered-but-deleted worktree also blocks creation and -e cannot see it.
git -C "$ROOT" worktree prune

# Linking is also unsafe when the owner checkout has not been reinstalled after
# its own lockfile changed. pnpm records the dependency graph used for
# node_modules here; require byte identity before creating the review worktree.
INSTALLED_LOCK="$ROOT/node_modules/.pnpm/lock.yaml"
if [ ! -f "$INSTALLED_LOCK" ] || ! cmp -s "$ROOT/pnpm-lock.yaml" "$INSTALLED_LOCK"; then
	echo "owner node_modules is missing or stale for the current pnpm-lock.yaml." >&2
	echo "Refusing this linked review worktree; run pnpm install --frozen-lockfile" >&2
	echo "in the owner checkout, or use an isolated standalone copy." >&2
	exit 1
fi

git -C "$ROOT" worktree add --detach "$WT" "$REF"

# Any failure from here on removes the half-built worktree — a leaked one blocks
# every future run at the refusal above (stack review, I7).
cleanup_on_fail() {
	echo "setup failed — removing the half-built worktree" >&2
	git -C "$ROOT" worktree remove --force "$WT" 2>/dev/null || true
}
trap cleanup_on_fail ERR

# The linking shortcut is only sound while the branch's lockfile IS main's
# lockfile — otherwise the branch expects packages main never installed.
# Against the WORKING TREE, not HEAD: node_modules reflects the working-tree
# lockfile, and an uncommitted lockfile edit in main is exactly the drift this
# check exists to catch (review of PR #152).
if ! git -C "$ROOT" diff --quiet "$REF" -- pnpm-lock.yaml; then
	echo "pnpm-lock.yaml differs between HEAD and $REF — linking main's" >&2
	echo "node_modules would run the WRONG dependency versions." >&2
	echo "Refusing this linked review worktree; use an isolated standalone" >&2
	echo "copy and run pnpm install --frozen-lockfile there." >&2
	cleanup_on_fail
	trap - ERR
	exit 1
else
	# Every dir that carries a node_modules in main gets one in the worktree.
	# Derived, not hard-coded: a new workspace package must not silently run
	# with no deps (a named slot is not a filled one).
	(cd "$ROOT" && find . -maxdepth 3 -name node_modules -type d -not -path '*/node_modules/*') |
		while IFS= read -r nm; do
			pkgdir="${nm#./}"
			mkdir -p "$WT/$pkgdir"
			for entry in "$ROOT/$pkgdir"/*; do
				[ -e "$entry" ] || continue # empty dir: the glob stays literal
				name="$(basename "$entry")"
				if [ "$name" = "@bitovp" ]; then
					# Recreate the workspace scope with main's own RELATIVE targets so
					# they resolve inside the worktree, i.e. to the branch's code.
					mkdir -p "$WT/$pkgdir/@bitovp"
					for pkg in "$entry"/*; do
						target="$(readlink "$pkg" || true)"
						# A REAL directory here (not a symlink) means the layout changed
						# under us — `ln -s ""` would "succeed" and dangle (stack review
						# I7); fail loud instead, the self-verify would only see it later.
						if [ -z "$target" ]; then
							echo "FAIL: $pkg is not a symlink — workspace layout changed" >&2
							exit 1
						fi
						ln -s "$target" "$WT/$pkgdir/@bitovp/$(basename "$pkg")"
					done
				else
					ln -s "$entry" "$WT/$pkgdir/$name"
				fi
			done
			# Hidden entries (.bin, .pnpm, .modules.yaml) — the glob above skips them.
			for entry in "$ROOT/$pkgdir"/.[!.]*; do
				[ -e "$entry" ] || continue
				ln -s "$entry" "$WT/$pkgdir/$(basename "$entry")"
			done
		done
fi

# The Prisma client is generated in-tree (packages/db/generated/client), so the
# worktree needs its own, built from ITS schema. Direct binary, not
# `pnpm --filter … exec` — that path re-checks the store and bails.
(cd "$WT/packages/db" && ./node_modules/.bin/prisma generate >/dev/null)

trap - ERR

# ---- Self-verification: the exact failure this script exists to prevent ----
# EVERY @bitovp link, not a spot check — the first version probed 1 of 8 and
# could report "ready" while apps/worker's @bitovp/db still resolved to main,
# which is precisely the silent-wrong-code case (review of PR #152). `|| echo`
# keeps set -e from aborting past the cleanup when a probe path is absent.
fail=0
WT_REAL="$(cd "$WT" && pwd -P)"
probes="$(cd "$WT" && find . apps packages -maxdepth 4 -path '*/node_modules/@bitovp/*' -type l 2>/dev/null | sed 's|^\./||' | sort -u)"
if [ -z "$probes" ]; then
	echo "FAIL: no @bitovp links found to verify — the linking step produced nothing" >&2
	fail=1
fi
for probe in $probes packages/db/generated/client; do
	real="$(cd "$WT" && node -p "require('node:fs').realpathSync('$probe')" 2>/dev/null || echo MISSING)"
	case "$real" in
	"$WT_REAL"/*) ;; # resolves inside the worktree: correct
	*)
		echo "FAIL: $probe resolves OUTSIDE the worktree -> $real" >&2
		fail=1
		;;
	esac
done
[ -x "$WT/apps/web/node_modules/.bin/vitest" ] || {
	echo "FAIL: vitest not executable in the worktree" >&2
	fail=1
}
if [ "$fail" -ne 0 ]; then
	echo "worktree is NOT safe to review in; removing it" >&2
	git -C "$ROOT" worktree remove --force "$WT"
	exit 1
fi

cat <<EOF
worktree ready: $WT  (detached at $SHA)

Reviewer contract:
  - run every gate from INSIDE the worktree, and read each gate's own exit code
  - Biome: bash scripts/review-worktree.sh --check (rejects zero processed files)
  - exit codes (review-223b): the interactive shell here is zsh — \$PIPESTATUS
    is bash; zsh spells it \$pipestatus (1-indexed). Prefer plain \$? from an
    unpiped command. A blank echo is NOT a green.
  - binaries are PER-PACKAGE: there is no root node_modules/.bin/vitest — run
    apps/<pkg>/node_modules/.bin/vitest from inside that package
  - count populations: 'Test Files N passed (N)' — compare N against main's;
    a silently smaller N means part of the suite never ran (this has happened:
    22 files / 217 tests were once absent and everything looked green)
  - when DONE (not before): git worktree remove --force '$WT'
EOF
