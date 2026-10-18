#!/bin/sh
# Nightly verification run
#
# Phase C: the live tier is included here and only here (`--live-feed-seconds 45`). Each
# live scenario provisions a channel, feeds it, samples it twice at least 10s apart, stops
# it and rolls it to VOD, so it costs encoder minutes rather than the seconds a short VOD
# encode costs. That is affordable once a night and not affordable on every ad-hoc run,
# which is why the flag is opt-in rather than a default: an engineer running
# `verify run --only …` gets the VOD loop and a named SKIP for live.
#
# 45s clears the engine's 10s sample-gap floor comfortably and still keeps the 7 live
# scenarios inside the night window alongside the VOD corpus.
#
# Invoked by com.bitovp.verify.nightly (D4).
#
# Deliberately does NOT use `pnpm dev`: the stack it verifies is the compose one, so a
# host dev server is neither started nor touched. `pnpm build` is never run here either
# — it shares apps/web/.next with a host `next dev` and corrupted it once already
# (ledger #39).
set -u
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
RUN_ID="$(date +%Y-%m-%dT%H-%M-%S)"
LOG="verify-runs/$RUN_ID/run.log"
mkdir -p "verify-runs/$RUN_ID" || exit 2
notify() {
  osascript -e "display notification \"$2\" with title \"bitovp verify\" subtitle \"$1\"" \
    >/dev/null 2>&1 || true
}
# Build provenance must describe the actual committed checkout, never unknown
# or locally modified source. No Docker/provider action precedes this check.
GIT_COMMIT="$(git rev-parse HEAD)" || exit 2
case "$GIT_COMMIT" in *[!0-9a-f]*|"") exit 2 ;; esac
[ "${#GIT_COMMIT}" -eq 40 ] || exit 2
SOURCE_STATUS="$(git status --porcelain --untracked-files=all)" || exit 2
if [ -n "$SOURCE_STATUS" ]; then
  echo "Refusing nightly: use a clean committed checkout" >>"$LOG"
  exit 2
fi
export GIT_COMMIT
# Fail fast on the credential rather than in 41 identical 401s.
#
# `verify run` drives the product over HTTP as an operator, so it needs the shared team
# password. Without it every submit returns `401 Authentication required` and the whole
# corpus comes back INVALID with no hint that the cause is one missing variable — which is
# exactly what the first real run of this harness did.
if [ -z "${VERIFY_PASSWORD:-}" ]; then
  if [ -f "$ROOT/.env" ]; then
    VERIFY_PASSWORD=$(grep -E '^VERIFY_PASSWORD=' "$ROOT/.env" | head -1 | cut -d= -f2-)
    export VERIFY_PASSWORD
  fi
fi
if [ -z "${VERIFY_PASSWORD:-}" ]; then
  notify "verify nightly cannot sign in" "set VERIFY_PASSWORD in .env — every scenario would report INVALID (401)"
  echo "VERIFY_PASSWORD is unset; refusing to run a corpus that can only 401" >>"$LOG"
  exit 2
fi

echo "=== bitovp nightly verification $RUN_ID" | tee "$LOG"

# The stack must be up and CURRENT. A stale worker image is the failure this whole
# harness exists to notice, so the nightly rebuilds rather than assuming.
# `web` too. The runner drives the product over HTTP — that is the whole point of layer
# 2 — so a nightly that starts only the worker has nothing to talk to. It was missing, and
# the run would have failed every scenario on a connection error rather than on anything
# the product did.
docker compose up -d --build postgres redis migrate worker web >>"$LOG" 2>&1 || {
  echo "compose up failed" | tee -a "$LOG"
  notify "INVALID" "the stack would not come up — see $LOG"
  exit 2
}

# Cross the seam BEFORE spending encoder minutes.
#
# A blind corpus reports one INVALID per scenario — honest, and an hour of encoder time to
# learn that one variable was unset. This answers "can the harness see anything at all" in
# a few seconds, and its failure names the variable.

# Where this credential may go (re-audit HIGH-6; see docs/VERIFICATION.md §7).
#
# `web:3100` is a compose service name on the private bridge network, reached over
# plaintext HTTP — which is deliberate and contained, but it is neither loopback nor an
# origin anyone allowlisted, so BOTH commands below refuse it unless this says otherwise.
# Named here rather than switched off with VERIFY_ALLOW_ANY_ORIGIN=1: the point of the
# control is that the one origin the password goes to is written down.
VERIFY_ORIGIN="http://web:3100"
VERIFY_ORIGIN_ENV="VERIFY_BASE_URL=$VERIFY_ORIGIN VERIFY_ALLOWED_ORIGINS=$VERIFY_ORIGIN \
     VERIFY_ALLOW_INSECURE_BASE_URL=1"

docker compose run --rm --entrypoint sh worker -c \
  "cd /app/apps/worker && $VERIFY_ORIGIN_ENV \
     VERIFY_PASSWORD=\"\$VERIFY_PASSWORD\" pnpm verify smoke" >>"$LOG" 2>&1 || {
  notify "verify nightly cannot see the product" "verify smoke failed — see $LOG for the variable to fix"
  exit 3
}

docker compose run --rm --entrypoint sh worker -c \
  "cd /app/apps/worker && VERIFY_RUN_ROOT=/verify-runs $VERIFY_ORIGIN_ENV \
     VERIFY_PASSWORD=\"\$VERIFY_PASSWORD\" \
     pnpm verify run --run-id $RUN_ID --concurrency 3 \
     --live-feed-seconds 45 --live-start-timeout 900" \
  >>"$LOG" 2>&1
STATUS=$?

# `latest` is what a human opens; it must point at the run that just finished, green
# or not.
ln -sfn "$RUN_ID" verify-runs/latest
{
  echo "run=$RUN_ID"
  echo "exit=$STATUS"
  echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > verify-runs/latest-status

if [ "$STATUS" -eq 0 ]; then
  echo "all scenarios green" | tee -a "$LOG"
else
  echo "$STATUS scenario(s) FAIL or INVALID" | tee -a "$LOG"
  notify "$STATUS not green" "run $RUN_ID — verify-runs/latest/report.md"
fi

# D5: prune artefacts older than 7 days, keep the reports.
docker compose run --rm --entrypoint sh worker -c \
  "cd /app/apps/worker && VERIFY_RUN_ROOT=/verify-runs pnpm verify clean 7" \
  >>"$LOG" 2>&1 || true

exit "$STATUS"
