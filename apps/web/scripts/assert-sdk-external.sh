#!/bin/bash
# The ONLY check that can catch ledger #74 (and #112's bundling class) regressing.
#
# The defect lives in the bundler's OUTPUT, so nothing in vitest can see it: vitest
# resolves through Vite, not Turbopack, and a mocked SDK never constructs the class
# machinery that failed. A test asserting `next.config.ts` contains the string is
# near-worthless too — it pins the statement of intent, and would still pass if the
# shim tree failed to ship, if standalone tracing dropped the package, or if someone
# set the deprecated `experimental.serverComponentsExternalPackages`, which Next
# silently OVERWRITES this key with.
#
# So this asserts the artefact. Run it after `next build`.
set -euo pipefail
NEXT_DIR="${1:-$(dirname "$0")/../.next}"
fail() { echo "FAIL: $1" >&2; exit 1; }

[ -d "$NEXT_DIR/server" ] || fail "no build at $NEXT_DIR — run next build first"

# 1+2 per SDK (generalized 2026-08-17, ledger #112 — the guard watched only
#    @bitmovin/api-sdk while @google-cloud/storage and @azure/storage-blob sat
#    inlined in the same chunk, the exact class it exists to catch).
#
#    Each row: package label | inline-detection literal | shim scope dir | shim glob.
#    The literal is a string that lives INSIDE the package's own source (an
#    API-client/telemetry token), appears in server output iff the source was
#    compiled in, and — verified at adoption — has zero occurrences in our own
#    production code: Bitmovin's REST-client version header, GCS's invocation-id header, Azure's
#    telemetry prefix.
#    The Bitmovin repository name also appears in public source links, so it
#    cannot distinguish an ordinary URL from compiled REST-client machinery.
# `|| true`: grep exits 1 on NO MATCH, and with `pipefail` that aborted the whole
# script before it could report a pass — the instrument failing in a way that reads
# as a finding, which is the failure mode this file exists to avoid.
SDKS='
@bitmovin/api-sdk|X-Api-Client-Version|@bitmovin|api-sdk*
@google-cloud/storage|gccl-invocation-id|@google-cloud|storage*
@azure/storage-blob|azsdk-js-azure-storage-blob|@azure|storage-blob*
'
shims=""
n=0
while IFS='|' read -r pkg literal scope glob; do
	[ -n "$pkg" ] || continue
	n=$((n + 1))
	inlined=$( { grep -rl "$literal" "$NEXT_DIR/server/" 2>/dev/null || true; } | wc -l | tr -d ' ')
	[ "$inlined" = "0" ] || fail "$pkg is INLINED into server output ($inlined file(s) carry '$literal') — serverExternalPackages is not taking effect for it"

	# The external shim must exist and resolve. Turbopack emits a hash-suffixed
	# alias under .next/node_modules rather than a bare require, and the fix
	# depends on that tree shipping with .next and its relative symlink target
	# surviving.
	shim=$( { find "$NEXT_DIR/node_modules/$scope" -maxdepth 1 -name "$glob" 2>/dev/null || true; } | head -1)
	[ -n "$shim" ] || fail "no $pkg shim under $NEXT_DIR/node_modules — the external was not emitted"
	[ -e "$shim/package.json" ] || fail "the $pkg shim $shim does not resolve — a copy that dereferenced symlinks, a prune, or a build/run path mismatch"
	shims="$shims $shim"
done <<EOF_SDKS
$SDKS
EOF_SDKS

# 3. Packaging-mode tripwires (ledger #78). Each mode below would pass the two
#    artefact checks above on the BUILD box while breaking the DEPLOYED copy —
#    so the modes themselves are refused until someone re-verifies the shim
#    survives them. The runtime half (the /api/health SDK probe) catches what
#    no build-box check can: a prune or a symlink-dereferencing copy applied
#    AFTER this script ran.
config="$(dirname "$0")/../next.config.ts"
if grep -qE 'output:[[:space:]]*"standalone"' "$config" 2>/dev/null; then
	fail 'next.config.ts sets output: "standalone" — standalone tracing is not verified to carry the external shim tree (ledger #78); verify and update this guard before shipping that mode'
fi
if grep -q 'serverComponentsExternalPackages' "$config" 2>/dev/null; then
	fail 'next.config.ts uses deprecated serverComponentsExternalPackages — Next silently OVERWRITES serverExternalPackages with it (the exact regression class of ledger #74)'
fi

# The count is an assertion, not prose (review-248 112-A1): a bad merge eating a
# table row would otherwise leave an ONLY-check that silently narrowed while
# still claiming full coverage — this repo's "a guard can absorb its own defect".
[ "$n" = "3" ] || fail "SDK table parsed $n row(s), expected 3 — the guard silently narrowed"
echo "OK: all $n SDKs external (shims:$shims), none inlined; packaging-mode tripwires clear"
