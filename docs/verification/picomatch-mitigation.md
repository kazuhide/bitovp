# Picomatch supported syntax and mitigation

The dependency gate detected
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
in picomatch 4.0.7. At adoption, the advisory lists no patched release. The
registry package remains version 4.0.7, so native software-composition analysis
continues to report the finding. It is not reported as an audit-clean dependency.
The restriction below is the supported dependency contract until a verified
replacement meets the removal conditions. Harness completion does not depend on
an unpublished upstream repair, and does not imply full picomatch compatibility.

## Supported syntax and boundary

The six-line pnpm patch rejects recognized `+(...)` and `*(...)` extglob
operators at the common parser entry, before emitting a regular expression.
Rejection throws `SyntaxError` with `ERR_PICOMATCH_REPEATED_EXTGLOB`. Even simple
repeated extglobs such as `+(abc)` are temporarily unsupported. Ordinary globs,
quoted and escaped literals, and non-repeated extglobs retain their existing
behavior. Repeated operators nested inside otherwise supported constructs are
also rejected.

This protects string-glob compilation used by the repository's Vite, Vitest,
tinyglobby and fdir dependencies. Arbitrary precompiled parser states and raw
`RegExp` inputs are trusted low-level interfaces outside this guarantee. The
patch does not claim full picomatch API compatibility or removal of every
possible regular-expression denial of service.

Static inventory found no required repeated-extglob configuration. It inspected
3,803 repository files and 90 dependency files, including 398 candidate literals;
those are not 398 proven glob call sites or complete dynamic-input coverage.
Full test discovery, builds and browser checks still run with the patched package.
A future configuration or plugin that needs repeated extglobs must be reviewed;
silently dropping a rejected pattern is not an acceptable compatibility fix.

## One audit command

Run `node scripts/dependency-audit.mjs` after a complete frozen install.
The CI dependency job, scheduled security audit and local release gates use this
same command. Optional `--output /absolute/path` selects a fresh receipt directory.
The runner:

1. Executes native `pnpm audit --audit-level low --json` and retains raw stdout,
   stderr and exit status, including failures.
2. Verifies the workspace patch, registry integrity, locked version and all
   picomatch dependency edges. The installed lock must equal the committed lock.
3. Enumerates the pnpm workspace and virtual-store packages, rejects external
   resolutions or unexpected versions, and verifies every installed picomatch
   copy resolved through this lockfile against eight fixed runtime/package file
   hashes. Exact package and library file inventories also prevent extensionless
   files from shadowing a checked JavaScript module.
4. Resolves every reported finding path to a verified installed package and
   rejects additional advisories, contradictory counts, unknown output schemas,
   transport errors and incomplete installation state.
5. Executes each actual package in a bounded child: 1,152 typed rejection checks,
   3,264 supported-pattern checks and 48 disabled-extglob checks. A timeout fails.

The successful finding result is
`LOCALLY_MITIGATED_SCA_FINDING_REMAINS`. If the native service reports no findings,
the installed patch and regression checks still run. Signature verification
remains a separate CI step. No advisory ignore list or lower audit threshold is
used.

The eight-file manifest and integrity in
`scripts/picomatch-security-contract.mjs` bind the probe to the published package
plus this patch. The original MIT license is preserved. The patch SHA-256 is
`a2b6a6ddd143c9b315be925d1cb737f94338b02729afba274fb8798057088e7f`.
The patch was independently reviewed; the hashes establish identity rather than
proving correctness by themselves.

This inventory concerns pnpm's lock-resolved package instances and the native
advisory paths. Vendored implementations inside other packages, such as Next's
compiled copy, are outside that package inventory and are not certified by this
patch or its hash manifest.

## Evidence and removal

Bounded old-code controls reproduced the reported repeated-extglob timeout and
an additional character-class variant. Partial upstream candidate rewrites were
not adopted because investigation found remaining timeout cases or changed
matching/capture semantics. The chosen guard changes only recognition of the
explicitly unsupported syntax.

The 2026-11-18 check of the [official advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
and [published releases](https://github.com/micromatch/picomatch/releases) still
found no patched release. The new, unmerged
[PR254](https://github.com/micromatch/picomatch/pull/254), at
`c63a5bf4e61dbdb81bc41e97dc2616c30acce337`, completed bounded checks for
`+(*a)`, `+(*)c`, `+(a*)c` and `+(*[ab])c`. However, the separate multi-branch
`+(ab|abab)` case still exceeded the one-second child deadline, and
`capture: true` changed the inner capture for `+(*a)` matching `aba` from `b`
to `ab`. These observations do not replace the upstream suite or establish a
compatible replacement for the current rejection boundary.

## Next image configuration boundary

Next includes a separate, unpatched picomatch implementation. The official
[Next 16.4.5 package source](https://github.com/vercel/next.js/blob/v16.4.5/packages/next/package.json)
declares picomatch 4.0.1 for its build. The
[16.4.6 compiled copy](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/compiled/picomatch/index.js)
was byte-identical when checked on 2026-11-18: 23,909 bytes, SHA-256
`607dc79784c1161c33076903769dba23e63d9d9ccfe3c4695a32ebe3a5ab892d`.
This identity check is not a claim that the vendored implementation is fixed.

BitOVP currently uses the default image pattern configuration. Before exporting
the application configuration, `apps/web/next.config.ts` calls
`assertSupportedImagePatterns`. Omitted or empty `images.remotePatterns` and
`images.localPatterns` are supported; an empty local list denies local images.
Non-empty lists, including URL-form remote patterns, throw `TypeError` with code
`ERR_UNSUPPORTED_NEXT_IMAGE_PATTERNS`. `unoptimized: true` does not bypass this
policy. This deliberately rejects ordinary custom patterns as well as repeated
extglobs, without trying to classify or rewrite their syntax.

The helper tests use supplied configuration objects and do not import the
application configuration or load its `.env` file. This boundary covers custom
image patterns only. Next's build tracing, middleware and other compiled callers
remain separate scopes; the pnpm audit contract does not certify them. Adding
custom image patterns requires a matcher review and a corresponding policy change.

## Removal conditions

Regression tests cover changed or missing patch bytes, unpatched or additional
installed copies, missing and external dependency resolutions, changed lock
state, additional findings, malformed audit output and execution failure. The
existing test budgets and required inventories are retained.

When a trustworthy official release fixes the advisory, verify its published
bytes with bounded hostile cases, the required matching and capture semantics,
and actual consumer discovery, tests and builds. Then update the version and
remove this patch, its dedicated finding classification and probe together.
Restore an ordinary native audit gate. Reassess Next's separate image policy
against its actual vendored matcher before relaxing that boundary.
Changing the advisory's patched-version information deliberately requires a
review of this temporary mitigation.
