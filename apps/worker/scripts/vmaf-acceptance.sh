#!/bin/sh
# VMAF acceptance proof (P4-PR3). Runs INSIDE the pinned worker image
# (bitovp-worker:latest) — that image bundles the static libvmaf ffmpeg
# (--enable-libvmaf) and the model JSONs at $VMAF_MODEL_DIR. NOT a CI gate:
# CI has no ffmpeg. Run it locally:
#
#   docker compose run --rm --entrypoint sh worker \
#       /app/apps/worker/scripts/vmaf-acceptance.sh
#
# What it proves:
#  1. The EXACT argv our packages/core buildVmafCommand emits scores a
#     deterministic clip pair, and re-running is reproducible to within
#     ±0.5 VMAF (the pinned image makes the encode + score deterministic).
#  2. model=path=$VMAF_MODEL_DIR/vmaf_v0.6.1.json yields the SAME score as
#     model=version=vmaf_v0.6.1 — validating the PR2-flagged path= branch
#     that the unit tests cannot exercise (no real libvmaf in CI).
#  3. (P4-PR5) The PSNR feature syntax buildVmafCommand emits —
#     libvmaf=…:feature=name=psnr:… — is accepted by the REAL binary, the JSON
#     then carries metrics.psnr_y per frame AND pooled_metrics.psnr_y, and the
#     VMAF score is unchanged by enabling the feature (PSNR rides the same
#     pass). The observed PSNR mean is reported. This is the only place the
#     feature syntax is validated against a real libvmaf (CI has none).
#
# The "known reference score" is the pinned-image score of the SYNTHETIC
# deterministic clip below (no external asset): testsrc2 1280x720@30 3s,
# reference at CRF 8, distorted re-encoded at a fixed low bitrate so VMAF
# lands well under 100. The ±0.5 assertion is reproducibility of THIS
# image+clip, not a portable absolute — a different ffmpeg/libvmaf build
# would have its own pinned number.
set -eu

FFMPEG="${FFMPEG_PATH:-ffmpeg}"
MODEL="${VMAF_MODEL:-vmaf_v0.6.1}"
MODEL_DIR="${VMAF_MODEL_DIR:-/opt/vmaf/model}"
# Tolerance for the reproducibility + version/path + pinned-value checks.
TOL="0.5"
# Known reference score: the pinned-image mean VMAF of the SYNTHETIC clip
# built below — NOT an external asset and NOT a portable absolute. Observed
# 65.146268 on bitovp-worker:latest (ffmpeg n8.1.1-146-g68c4d7ec8c, the
# static libvmaf build) with -threads 1 encodes, which are byte-exact run to
# run; a drift past ±0.5 means the ffmpeg/libvmaf pin moved and must be
# re-baselined. Override with VMAF_PINNED_SCORE when re-pinning the image.
PINNED="${VMAF_PINNED_SCORE:-65.146268}"

# The PRODUCT DEFAULT (core's DEFAULT_VMAF_MODEL, ledger #104). This script's
# own MODEL stays vmaf_v0.6.1 on purpose — its job is the version=/path=
# equivalence on a built-in, and its 65.146268 baseline is a known-good number
# that must not move to chase a constant (review-234 round 5). What was missing
# is that NOTHING exercised the model every unspecified plan actually gets, so
# the default gets its own case below with its own measured baseline.
DEFAULT_MODEL="${VMAF_DEFAULT_MODEL:-vmaf_v1.0.16_3d0h}"
# Measured on the pinned image 2026-08-16, three runs identical, version= and
# path= equivalent: 74.027285. Higher than the v0.6.1 baseline on the same
# bytes because v1's standard viewing condition is more forgiving — the same
# gap direction the 2026-08-11 model matrix measured.
DEFAULT_PINNED="${VMAF_DEFAULT_PINNED_SCORE:-74.027285}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REF="$WORK/ref.mp4"
DIST="$WORK/dist.mp4"

echo "[vmaf-accept] ffmpeg: $FFMPEG"
"$FFMPEG" -hide_banner -version | head -1
"$FFMPEG" -hide_banner -version | grep -q -- '--enable-libvmaf' \
	|| { echo "FAIL: this ffmpeg lacks --enable-libvmaf" >&2; exit 1; }

# --- deterministic reference + distorted clips (no external asset) --------
# testsrc2 is a fixed synthetic pattern → byte-deterministic per ffmpeg
# build. CRF 8 reference (near-lossless); the distorted leg is a fixed-
# bitrate re-encode of the SAME source so VMAF is a real (<100) score.
# -threads 1 makes libx264 byte-deterministic ACROSS container invocations
# (multi-threaded x264 has slice-scheduling jitter of ~0.3 VMAF run-to-run);
# single-threaded the score is bit-exact, so the pinned assertion below is a
# true equality check, not just "within tolerance".
echo "[vmaf-accept] generating reference (testsrc2 1280x720@30 3s, CRF 8, threads=1)…"
"$FFMPEG" -hide_banner -nostdin -y \
	-f lavfi -i testsrc2=size=1280x720:rate=30:duration=3 \
	-c:v libx264 -threads 1 -crf 8 -pix_fmt yuv420p "$REF" 2>/dev/null

echo "[vmaf-accept] generating distorted (fixed 300k re-encode, threads=1)…"
"$FFMPEG" -hide_banner -nostdin -y \
	-i "$REF" \
	-c:v libx264 -threads 1 -b:v 300k -maxrate 300k -bufsize 600k \
	-pix_fmt yuv420p "$DIST" 2>/dev/null

# --- the EXACT argv buildVmafCommand(opts) emits --------------------------
# Mirrors packages/core/src/vmaf/command.ts for:
#   referencePath=REF, distortedPath=DIST, model=<sel>,
#   scaleToReference={1280,720}, fpsConform=30, logPath=<log>.
# Input order: -i #0 = distorted, -i #1 = reference. filter_complex:
#   [0:v]scale=1280:720:flags=bicubic,fps=30[dist];[dist][1:v]libvmaf=…[out]
# <sel> is either "version=<model>" or "path=<file>" — the only difference
# between the two runs below, exactly like the command builder's branch.
run_vmaf() {
	# $1 = libvmaf model selector spec, $2 = log path
	sel="$1"
	log="$2"
	"$FFMPEG" -hide_banner -nostdin \
		-i "$DIST" \
		-i "$REF" \
		-filter_complex \
		"[0:v]scale=1280:720:flags=bicubic,fps=30[dist];[dist][1:v]libvmaf=model=${sel}:log_path=${log}:log_fmt=json[out]" \
		-map "[out]" -f null - 2>/dev/null
}

# Same as run_vmaf but ALSO enables libvmaf's psnr feature — the exact token
# buildVmafCommand emits when psnr:true is set: `:feature=name=psnr:` between
# the model selector and log_path (packages/core/src/vmaf/command.ts §PSNR).
run_vmaf_psnr() {
	# $1 = libvmaf model selector spec, $2 = log path
	sel="$1"
	log="$2"
	"$FFMPEG" -hide_banner -nostdin \
		-i "$DIST" \
		-i "$REF" \
		-filter_complex \
		"[0:v]scale=1280:720:flags=bicubic,fps=30[dist];[dist][1:v]libvmaf=model=${sel}:feature=name=psnr:log_path=${log}:log_fmt=json[out]" \
		-map "[out]" -f null - 2>/dev/null
}

# Extract pooled_metrics.vmaf.mean from the libvmaf JSON log (node is always
# in the image; avoids a jq dependency the slim base lacks).
mean_of() {
	node -e 'const j=require(process.argv[1]);process.stdout.write(String(j.pooled_metrics.vmaf.mean));' "$1"
}

# Extract pooled_metrics.psnr_y.mean — empty string if absent (so the caller
# can fail loudly if the feature produced no psnr_y).
psnr_mean_of() {
	node -e 'const j=require(process.argv[1]);const p=j.pooled_metrics&&j.pooled_metrics.psnr_y;process.stdout.write(p&&typeof p.mean==="number"?String(p.mean):"");' "$1"
}

# True (exit 0) iff EVERY frame in the log carries a numeric metrics.psnr_y.
all_frames_have_psnr() {
	node -e 'const j=require(process.argv[1]);const fr=j.frames||[];process.exit(fr.length>0&&fr.every(f=>f.metrics&&typeof f.metrics.psnr_y==="number")?0:1);' "$1"
}

within_tol() {
	# |$1 - $2| <= $3
	node -e 'const[a,b,t]=process.argv.slice(1).map(Number);process.exit(Math.abs(a-b)<=t?0:1);' "$1" "$2" "$3"
}

LOG1="$WORK/run1.json"
LOG2="$WORK/run2.json"
LOGP="$WORK/runpath.json"

echo "[vmaf-accept] run 1 (model=version=$MODEL)…"
run_vmaf "version=$MODEL" "$LOG1"
S1="$(mean_of "$LOG1")"
echo "[vmaf-accept]   mean VMAF = $S1"

echo "[vmaf-accept] run 2 (model=version=$MODEL, reproducibility)…"
run_vmaf "version=$MODEL" "$LOG2"
S2="$(mean_of "$LOG2")"
echo "[vmaf-accept]   mean VMAF = $S2"

echo "[vmaf-accept] run path (model=path=$MODEL_DIR/$MODEL.json)…"
run_vmaf "path=$MODEL_DIR/$MODEL.json" "$LOGP"
SP="$(mean_of "$LOGP")"
echo "[vmaf-accept]   mean VMAF = $SP"

echo ""
echo "[vmaf-accept] reference score (pinned-image, synthetic clip): $S1"
echo "[vmaf-accept] reproducibility |run1-run2| within ±$TOL …"
within_tol "$S1" "$S2" "$TOL" \
	|| { echo "FAIL: run1=$S1 run2=$S2 differ by more than $TOL" >&2; exit 1; }
echo "[vmaf-accept]   OK ($S1 vs $S2)"

echo "[vmaf-accept] version= vs path= equivalence within ±$TOL …"
within_tol "$S1" "$SP" "$TOL" \
	|| { echo "FAIL: version=$S1 path=$SP differ by more than $TOL" >&2; exit 1; }
echo "[vmaf-accept]   OK ($S1 vs $SP)"

echo "[vmaf-accept] score within ±$TOL of the pinned $PINNED …"
within_tol "$S1" "$PINNED" "$TOL" \
	|| { echo "FAIL: score $S1 drifted past ±$TOL from pinned $PINNED — the ffmpeg/libvmaf pin moved; re-baseline VMAF_PINNED_SCORE if intentional" >&2; exit 1; }
echo "[vmaf-accept]   OK ($S1 vs pinned $PINNED)"

# --- the PRODUCT DEFAULT model (ledger #104) -------------------------------
# A file-only VMAF v1 model: it can only load via model=path=, so this case
# also proves the bundled JSON is present and loadable in the shipped image —
# the half the round-2 review called unproven ("what happens without the
# files" vs "does it score").
LOGDEF="$WORK/run_default.json"
echo ""
echo "[vmaf-accept] run default (model=path=$MODEL_DIR/$DEFAULT_MODEL.json)…"
run_vmaf "path=$MODEL_DIR/$DEFAULT_MODEL.json" "$LOGDEF"
SDEF="$(mean_of "$LOGDEF")"
echo "[vmaf-accept]   mean VMAF ($DEFAULT_MODEL) = $SDEF"
echo "[vmaf-accept] default-model score within ±$TOL of the pinned $DEFAULT_PINNED …"
within_tol "$SDEF" "$DEFAULT_PINNED" "$TOL" \
	|| { echo "FAIL: default-model score $SDEF drifted past ±$TOL from pinned $DEFAULT_PINNED — re-baseline VMAF_DEFAULT_PINNED_SCORE if the image's model or libvmaf moved" >&2; exit 1; }
echo "[vmaf-accept]   OK ($SDEF vs pinned $DEFAULT_PINNED)"
# The default MUST differ from the v0.6.1 baseline: identical numbers would
# mean the path= selector silently fell back to the built-in, which is exactly
# the failure this case exists to catch.
if within_tol "$SDEF" "$S1" "$TOL"; then
	echo "FAIL: $DEFAULT_MODEL scored $SDEF, indistinguishable from $MODEL's $S1 — the model file was probably ignored" >&2
	exit 1
fi
echo "[vmaf-accept]   OK — $DEFAULT_MODEL ($SDEF) is distinguishable from $MODEL ($S1)"

# --- PSNR feature (P4-PR5) ------------------------------------------------
# Run the SAME clip pair with libvmaf's psnr feature enabled (the exact
# :feature=name=psnr: token buildVmafCommand emits) and prove the real binary
# (a) accepts the syntax, (b) emits metrics.psnr_y per frame + pooled
# psnr_y, and (c) leaves the VMAF score unchanged (PSNR rides the same pass).
LOGPSNR="$WORK/run_psnr.json"
echo ""
echo "[vmaf-accept] run psnr (model=version=$MODEL, feature=name=psnr)…"
run_vmaf_psnr "version=$MODEL" "$LOGPSNR"
SPSNR_VMAF="$(mean_of "$LOGPSNR")"
PSNR_MEAN="$(psnr_mean_of "$LOGPSNR")"
echo "[vmaf-accept]   mean VMAF (psnr run) = $SPSNR_VMAF"
echo "[vmaf-accept]   mean PSNR (psnr_y)   = ${PSNR_MEAN:-<absent>} dB"

echo "[vmaf-accept] pooled_metrics.psnr_y present …"
[ -n "$PSNR_MEAN" ] \
	|| { echo "FAIL: feature=name=psnr produced no pooled_metrics.psnr_y — the libvmaf feature syntax is wrong for this build" >&2; exit 1; }
echo "[vmaf-accept]   OK (psnr_y.mean = $PSNR_MEAN dB)"

echo "[vmaf-accept] every frame carries metrics.psnr_y …"
all_frames_have_psnr "$LOGPSNR" \
	|| { echo "FAIL: not every frame has metrics.psnr_y in the psnr run" >&2; exit 1; }
echo "[vmaf-accept]   OK (per-frame psnr_y present)"

echo "[vmaf-accept] enabling psnr leaves VMAF unchanged within ±$TOL …"
within_tol "$S1" "$SPSNR_VMAF" "$TOL" \
	|| { echo "FAIL: VMAF moved when psnr enabled (vmaf=$S1 psnr-run=$SPSNR_VMAF)" >&2; exit 1; }
echo "[vmaf-accept]   OK ($S1 vs $SPSNR_VMAF)"

echo ""
echo "[vmaf-accept] PASS — mean VMAF ~$S1, reproducible to ±$TOL, version=/path= equivalent, matches pinned $PINNED; PSNR feature OK (psnr_y.mean ~$PSNR_MEAN dB, per-frame + pooled present, VMAF unchanged)."
