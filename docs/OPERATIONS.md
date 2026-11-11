# Operations

Use [Installation](./user-guide/INSTALLATION.md) for a new deployment.

## Upgrades

For an existing database, read [Database upgrades](./DATABASE-UPGRADES.md) before
applying pending migrations. Some older schemas require a writer pause, data
checks, or explicit backfill decisions. Fresh installations apply all migrations
automatically and do not require those manual repairs.

1. Record the current application/image revisions and active billable resources.
2. Back up the database and private environment files, including `MASTER_KEY`.
   Verify a restore in an isolated database before relying on the backup.
3. Stop admission of new work and stop the old web/worker services together.
4. Keep administrative database credentials in `.env.migrate` and restricted
   runtime URLs in `.env`. From freshly extracted source, run
   `pnpm install --frozen-lockfile` and `pnpm --filter @bitovp/db build` before
   these host-side database commands. For an existing installation that still has
   a single administrative URL, use `pnpm --filter @bitovp/db db:runtime:import-admin`
   before `db:runtime:prepare`; preserve encryption and authentication values.
5. Pull the chosen PostgreSQL/Redis image pins, build the chosen commit with fresh
   base and package layers, apply migrations, and replace web and worker together.
6. Check migration exit status, health, authentication, organization isolation,
   worker queues, and the image revision before accepting new work.

Web startup resolves the native Prisma query engine from the deployed
`packages/db/generated/client` directory before launching Next.js. Run the
database client build for the deployment host; a missing engine stops startup.
When packaging multiple platform engines, set `PRISMA_QUERY_ENGINE_LIBRARY` to
the correct deployed library. Remove or update any older release-specific
override when changing the release path. This uses Prisma 6's
[documented engine override](https://docs.prisma.io/docs/orm/v6/reference/environment-variables-reference#prisma_query_engine_library).

`/api/health` requires both SDK resolution and an actual identity database read.
A database or native-engine failure returns HTTP 503 with
`database: "unavailable"`; it does not return database connection details.
Also verify that an unauthenticated request to `/library` redirects to `/login`
and that an authenticated user can open the Library. A running Node process
alone does not establish readiness.

After the backup and drain steps, prepare the selected images with:

```bash
docker compose pull postgres redis
docker compose build --pull --no-cache migrate worker web
```

Pulling images does not replace running data services. Recreate PostgreSQL/Redis
during the maintenance window after checking their upgrade notes and preserving
their volumes. Record the selected versions and image digests. The Node and data
service pins must be updated for later security releases; `--no-cache` refreshes
the available OS packages within the selected base. It also compiles the worker
image's FFmpeg again, which takes several minutes.

Never run web or worker with a PostgreSQL superuser or BYPASSRLS role. An image
rollback may be incompatible with an already-applied migration. Preserve the
new worker while it owns pending cleanup or cancellation work.

### Worker FFmpeg

The worker image compiles FFmpeg and ffprobe in the `ffmpeg-*` stages of
`Dockerfile`. Each source is the archive of one commit or release, fixed by its
SHA-256, and the compile steps run without network access. Two inputs are not
fixed in that way: Debian's compiler and build tools, which `apt-get` installs
into the digest-pinned base image and parts of which are linked into the
programs, and the Dockerfile frontend that line 1 names. The image build fails
unless the result has libvmaf and SRT and scores with a pinned VMAF model.

To change a version:

- Change the commit and the SHA-256 of its `ADD` line together. For libvmaf,
  SVT-AV1, dav1d and FFmpeg the commit is the `ARG` above that line.
- Take a commit that is on the project's own branch. An archive URL also
  answers for a commit that exists only in a fork. For a GitHub repository,
  `gh api repos/<owner>/<repo>/compare/<commit>...<branch>` must report
  `behind_by: 0`. For x264,
  `https://code.videolan.org/api/v4/projects/videolan%2Fx264/repository/commits/<commit>/refs?type=branch`
  must list the branch.
- For FFmpeg, set `FFMPEG_VER` to what `git describe --tags` prints for the
  commit, with the revision cut to ten characters, and `SOURCE_DATE_EPOCH` to
  the commit's date (`git show -s --format=%ct`). The build checks only that
  `FFMPEG_VER` ends with the revision.
- With a new FreeType commit, take the dlg revision that it records for
  `subprojects/dlg`. With a newer FFmpeg release, check which branch of the
  NVIDIA headers that release needs.
- Meson's version is written twice in its URL and once in the check below it.

To build the image with another FFmpeg, replace the `ffmpeg` stage with a
directory that holds `bin/ffmpeg`, `bin/ffprobe` and `share/licenses/`:
`docker build --build-context ffmpeg=<directory> --file Dockerfile .`, or
`additional_contexts` in a Compose override. The build does not verify a
replaced FFmpeg. Check its SHA-256 yourself, keep the directory writable only
by you, and do not name a remote image or URL as the context unless a digest
fixes it. `share/licenses/` must hold the licences of what that FFmpeg
contains. bitovp needs libvmaf, libx264, libdav1d, libass with Fontconfig, SRT
with encryption, TLS for RTMPS, zlib for PNG image assets and, for GPU
decoding, NVDEC.

Building for another processor architecture, for example `--platform
linux/amd64` on an Apple silicon Mac for a cloud quality worker, compiles
FFmpeg under emulation. That took 12 to 17 minutes on a 10-core machine.

FFmpeg in the image is under the GPL, version 3 or later, which sets
conditions for giving the image to others, among them offering the source.
`Dockerfile` names every source by commit or release.

## Backup and rollback

Keep encrypted backups of the database, `.env`, and `.env.migrate` outside the
repository. Restrict access; database records and encryption keys together can
reveal credentials. Back up before migrations and destructive resets.

Test restores in a new isolated database/container, not over the running database.
Use `pg_restore --exit-on-error --no-owner --no-acl` when validating schema/data
without reproducing production roles and grants. Successful data restore is not
proof that production role privileges or a full rollback are correct.

Before rollback, stop new billable work, identify compatible images/migrations,
and reconcile in-flight jobs and remote resources. Keep required cleanup receipts
and credentials. Do not reverse an irreversible migration without a tested plan.

## Public ingress

`INGRESS_MODE` chooses the public webhook receiver URL:

| Value | Configuration |
|---|---|
| `none` | No public receiver; use polling |
| `static` | Use `PUBLIC_BASE_URL` |
| `quick-tunnel` | Start the `quick-tunnel` Compose profile; hostname may change |
| `named-tunnel` | Set `INGRESS_HOSTNAME`, private `TUNNEL_TOKEN`, and the matching profile |

The worker refreshes the resolved ingress and manages signed registrations.
The dynamic hostname permits only `/api/webhooks/*` and `/api/health` by default.
The UI hostname must be in `ALLOWED_ORIGIN_HOSTS` for management access. The
bundled Compose service environment can override `.env` values; use a reviewed
Compose override when exposing a UI hostname.

For externally reachable UI, use HTTPS, valid authentication, and narrowly
configured trusted proxies. Trust only actual proxy source ranges, verify
forwarded client IPs, and then configure organization IP policies.

## Host development runtime

The Docker worker contains ffmpeg/ffprobe. A host worker needs `ffmpeg -version`
and `ffprobe -version` to work; VMAF additionally needs the libvmaf filter.
Use `FFMPEG_PATH` and `FFPROBE_PATH` for custom executable paths.

To switch from container services to the host development loop, first release
the web port and stop the second queue consumer:

```bash
docker compose stop web worker
pnpm --filter @bitovp/db db:migrate
pnpm dev
```

Keep PostgreSQL/Redis running. Both runtime modes use port 3100; run only one.
For webhook push from Docker Desktop to host development, set:

```dotenv
INGRESS_ORIGIN_URL=http://host.docker.internal:3100
INGRESS_QUICKTUNNEL_METRICS_URL=http://127.0.0.1:20241/quicktunnel
```

Then run `docker compose --profile quick-tunnel up -d ingress`. Linux host-dev
push is not covered by this recipe: Next binds to `127.0.0.1`. Use the all-Docker
runtime for push on Linux, or `INGRESS_MODE=none` for polling-only development.

## Heartbeat history

Polling history is retained for seven days per channel. Pruning runs during
polling; an inactive channel can retain older rows until it runs again or is
deleted. Ended runs retain a summary. Unknown/pruned measurements remain unknown,
not zero. Avoid manually deleting live history while alerts depend on it.

During channel changes, background heartbeat and terminal updates may wait for
the next monitoring sweep so cancellation can finish promptly. A skipped
heartbeat adds no history. A skipped terminal update leaves the run's terminal
state unchanged; earlier accepted status observations are retained.

Per-encoding heartbeat hooks are owned and removed by the worker. Before an
upgrade that removes support for those hooks, disable registration with the new
worker and confirm cleanup first. Preserve signing keys and ownership records.

## Local quality resources

Leave `VMAF_THREADS` and `VMAF_CONCURRENCY` blank for automatic selection. The
worker considers its CPU allocation, available memory, input dimensions, pixel
format and video length. Container CPU and memory limits take precedence over
the host's size. It keeps extra memory for other work and checks headroom before
starting each comparison.

`VMAF_THREADS` fixes the number of libvmaf calculation threads per comparison.
`VMAF_CONCURRENCY` caps simultaneous VOD comparisons; memory checks can reduce
that overlap. The shared native execution policy applies this bound across
local jobs. Set either value independently to keep the other automatic. Live
comparisons keep their existing sequential order. Restart the worker after
changing these settings. Both bundled Compose configurations preserve explicit
values in the deployment's environment file.

On Linux, clean inactive disk cache can be reclaimed by the operating system.
The worker accounts for it only when host and container statistics provide
consistent bounds. It excludes dirty, mapped and shared-memory pages from this
estimate. Missing or inconsistent statistics retain the conservative free-memory
check, so memory pressure or changing samples can reduce parallelism or refuse a
comparison. Extra memory headroom remains reserved in either mode.

Memory estimates are conservative starting points, not a guarantee for every
codec or model. Unmeasured formats run alone; an estimate that cannot fit ends
with an actionable error. A comparison waits for active work to release memory
and remains cancellable. External memory pressure with no active comparison
produces a diagnostic after 30 seconds. If memory cannot be detected, automatic
selection stops; explicitly setting both values permits the legacy manual path
and reports that automatic memory protection is unavailable.

During a local job, the worker checks for deletion every 100 milliseconds, up
to ten database lookups per second per admitted job. With the matching Linux
native scorer and supervisor installed, local jobs share automatically selected
resource limits and excess parents remain queued. Other installations retain
one local job per worker, with several comparisons allowed inside it. Queued
parents add no deletion checks. See [GPU quality measurement](./user-guide/GPU-QUALITY.md#automatic-local-scheduling)
for calibration, queueing and native installation behavior. Cloud jobs retain
their one-second check interval. For ordinary local scoring, reset first asks
FFmpeg to stop; if it has not exited after 250 milliseconds, the worker force
stops that process and discards partial scores. Cancellation holds reserved
capacity until FFmpeg exits and its output streams close, so a replacement
cannot overlap a process that is still shutting down.

Resource selection keeps the model, resolution and scored frames unchanged.
`VMAF_SUBSAMPLE` remains a separate explicit quality tradeoff. Reports record the
selected resources for each comparison in `params.localResources`.

## Local clip planning

For the feasible-plan workflow, set `BITOVP_LOCAL_STORY_CHOICE_ENABLED=1` in
both Web and Worker deployment environments after the Gateway metadata probe
verifies the five-stage `bitovp-semantic-stages-planning-v1` registry, including
`LOCAL_STORY_CHOICE_V1`. Restart Web and Worker to load the setting. The Worker
builds complete candidate edits that satisfy duration, source order and speech
boundaries, and the Local LLM selects one of those edits. New draft requests and
retries record this planner in their task parameters. A missing capability
produces `LOCAL_STORY_ENGINE_UNAVAILABLE` before a new task is created.
The [Gateway guide](../tools/local-semantic-gateway/README.md#検証済み編集候補から選ぶ-choice-stage)
covers registry generation and capability checks.

## Cloud quality workers

Configure profiles in `/settings/vmaf` only after preparing the provider's
compute infrastructure, pinned worker image, workspace storage, and permissions.
Use private credentials or provider roles, and distinguish compute-management
access from workspace access. A profile save does not create compute.

Each execution needs its own budget and timeout. Budget checks prevent new
admissions; they cannot guarantee the final bill. Keep the worker, profile
ownership, encryption keys, and cleanup credentials until remote compute is
confirmed deleted. Disable profiles whose image or workspace no longer exists.

## Short end-to-end checks

Start with a ten-second test asset and, for HLS/DASH, two-second target segments.
Use a dedicated output prefix and the smallest useful ladder. Before starting,
confirm the account, maximum job count/run time, output, and a separate stop path.

Check provider completion, all expected manifests/renditions, actual media bytes,
playback, and cleanup. Audio frame boundaries may differ from video/segment
boundaries; see [alignment](./user-guide/QUALITY-AND-MONITORING.md#why-alignment-matters).
Keep actual measured results tied to the tested version and configuration;
unit tests and a healthy web process do not establish cloud encoding success.

## Shutdown and cleanup

Stop feeders, channels, jobs, and cloud quality compute before stopping their
monitoring services. Confirm provider terminal state and cleanup. Revoke temporary
tokens and remove temporary input/output resources only when their purpose ends.
`docker compose down` retains local data; `down --volumes` permanently deletes it
and does not clean external resources.
