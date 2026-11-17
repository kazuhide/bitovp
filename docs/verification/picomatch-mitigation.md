# Temporary picomatch mitigation

The dependency gate detected
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
in picomatch 4.0.7. At adoption, the advisory lists no patched release. The
registry package remains version 4.0.7, so native software-composition analysis
continues to report the finding. It is not reported as an audit-clean dependency.

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

Regression tests cover changed or missing patch bytes, unpatched or additional
installed copies, missing and external dependency resolutions, changed lock
state, additional findings, malformed audit output and execution failure. The
existing test budgets and required inventories are retained.

When a trustworthy official release fixes the advisory while preserving required
semantics, update the version and remove this patch, its dedicated finding
classification and probe together. Restore an ordinary native audit gate.
Changing the advisory's patched-version information deliberately requires a
review of this temporary mitigation.
