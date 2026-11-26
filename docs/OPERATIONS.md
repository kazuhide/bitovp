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

### Redis queue memory

The worker removes each finished periodic Live heartbeat and slate promotion
job, including failed ticks. After a tick completes or fails, the worker
examines up to 100 older entries in each terminal state of that queue in the
background. Tenant job history keeps its existing retention settings.
Worker logs record failures.

For a new standard installation, `.env.example` sets `REDIS_MAXMEMORY=128mb`
in the default 256 MiB Redis container. Standard and customer Compose accept
this setting. Existing environment files that omit it retain the previous
Redis budget of `0` (unlimited within the container). For customer Compose,
set the value in the private application settings file.

Check the current dataset and container consumption before enabling or lowering
the budget on a populated installation. Use the Compose project for that
installation. For customer installations, pass the same subcommands to
`scripts/customer-compose.sh` with the usual project and settings files.

```bash
docker compose exec -T redis redis-cli INFO memory
docker compose exec -T redis redis-cli INFO persistence
docker compose stats --no-stream redis
```

Compare `used_memory`, `used_memory_rss` and `maxmemory` over representative
load, including an AOF rewrite. Choose a budget above normal queue usage and
leave container headroom for allocator overhead, buffers and copy-on-write.
With `noeviction`, writes that require more memory can fail at the budget.
Allow the worker to drain old periodic-job history before tightening the
budget and apply the Compose setting during a maintenance window.

### Worker FFmpeg

The worker image compiles FFmpeg and ffprobe in the `ffmpeg-*` stages of
`Dockerfile`. Each source is the archive of one commit or release, fixed by its
SHA-256, and the compile steps run without network access. Two inputs are not
fixed in that way: Debian's compiler and build tools, which `apt-get` installs
into the digest-pinned base image and parts of which are linked into the
programs, and the Dockerfile frontend that line 1 names. The image build fails
unless the result has libvmaf and SRT and scores with a pinned VMAF model.

[FFMPEG-BUILD.md](FFMPEG-BUILD.md) records this build: every source and
command, what the logs of a build showed, the programs that came out, what was
checked on them, what the build leaves out, and its known limits.

To change a version:

- Change the commit and the SHA-256 of its `ADD` line together. For libvmaf,
  SVT-AV1, dav1d and FFmpeg the commit is the `ARG` above that line.
- Take a commit that is on the project's own branch. An archive URL also
  answers for a commit that exists only in a fork. For a GitHub repository,
  `gh api repos/<owner>/<repo>/compare/<commit>...<branch>` must report
  `behind_by: 0`. For x264,
  `https://code.videolan.org/api/v4/projects/videolan%2Fx264/repository/commits/<commit>/refs?type=branch`
  must list the branch.
- For FFmpeg, set `FFMPEG_VER` to what
  `git describe --tags --long --abbrev=10` prints for the commit, and
  `SOURCE_DATE_EPOCH` to the commit's date (`git show -s --format=%ct`).
  `--long` keeps the number of commits and the revision in the name of a
  commit that is itself a tag. The build checks only that `FFMPEG_VER` ends
  with the first ten characters of the revision.
- With a new FreeType commit, take the dlg revision that it records for
  `subprojects/dlg`. With a newer FFmpeg release, check which branch of the
  NVIDIA headers that release needs.
- Meson's version is written twice in its URL and once in the check below it.
- Renew [FFMPEG-BUILD.md](FFMPEG-BUILD.md) as its section "Renewing this
  record" says. A test fails until the record's stages, sources and commands
  are those of `Dockerfile`; the logs, the checksums of the programs and the
  measurements in it are renewed by hand.

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

CI keeps the build of the `ffmpeg` stage and reuses it.
`scripts/native-media-tools.sh --cache <directory>` keeps the build, with the
VMAF models, under a key made from `Dockerfile`, `docker/vmaf-models.sha256`,
the script itself and the processor architecture, and GitHub's cache carries
that directory from run to run under a key of the same three files. A run
that finds a build under its key copies it instead of compiling. A run
compiles when no build is kept for its key where it may read: after a change
to one of the three files; on `main` after such a change is merged, because
GitHub keeps what a pull request stores for that pull request alone; and when
GitHub has removed the entry, which it does when no run has read it for 7 days
and may do earlier when the repository's caches exceed their size limit. The
three jobs do not wait for each other: those that start before a build is
stored each compile, GitHub stores one build, and the others log
`Failed to save: Unable to reserve cache` and pass all the same. A job that
fails keeps nothing. The step's log says which of the two happened:
`FFmpeg: built from the pinned sources` or `FFmpeg: reused the build kept
under the key of these sources (<key>)`.

Every run, whether it compiled or copied, checks that the model directory
holds the models of `docker/vmaf-models.sha256`, with their SHA-256, and
nothing else, proves that this FFmpeg scores with a pinned model, and prints
the SHA-256 of `ffmpeg` and `ffprobe`. The two jobs that build the worker
image give the same directory to the image build, so the image holds the
programs that the run has just proven: the offline media job with
`--build-context ffmpeg=<directory>`, the installed GUI job with
`additional_contexts` in its Compose override.

A kept build is taken only when it holds the files that the list kept with it
names, with the SHA-256 recorded there, and nothing else. That check finds
damage, not replacement: whoever can write the cache can store another build
with a list of its own. Reuse is safe for two reasons. First, GitHub lets a
run restore only an entry that its own branch or pull request stored, one
that the default branch stored, or one that the base branch of its pull
request stored. So what a pull request stores is read by that pull request
alone, and an entry that `main` and the pull requests into `main` restore is
written only by a run on `main`. Second, the three jobs that restore one hold
a read-only token and no secret and publish nothing. A workflow that holds a
secret, may write to the repository or publishes an image must not restore
this cache. A kept build that fails the check stops the job and is not built
again in its place. Then, and after any doubt about a run on `main`, delete
every `ffmpeg-…` entry, so that the next runs compile:

```bash
gh cache list --key ffmpeg- --limit 100
gh cache list --key ffmpeg- --limit 100 --json id --jq '.[].id' | xargs -n 1 gh cache delete
```

On your own machine, keep a `--cache` directory writable only by you.

A run that copies a build does not show that the pinned sources can still be
downloaded and compiled, and no run of these jobs shows that `Dockerfile`
alone still builds the image that an installation gets: the two image jobs
build it with the directory in place of the `ffmpeg` stage. The `FFmpeg from
source` workflow shows both every week and on request, without the cache. Its
job `ffmpeg-from-source` runs the script with no `--cache`: it downloads the
sources and the models, compiles FFmpeg and runs the proof. Its job
`image-from-source` builds the whole worker image from `Dockerfile` and
validates the ten-second asset with it. A failure there blocks no pull
request, so look at its runs: `gh run list --workflow ffmpeg-source-build.yml`.
In a public repository GitHub turns a schedule off after 60 days without
activity in the repository: `gh workflow enable ffmpeg-source-build.yml` turns
it on again, and `gh workflow run ffmpeg-source-build.yml` starts a run at any
time.

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

Memory estimates use observed working sets and padding for input geometry and
frame count. A calculation without shared admission keeps the existing
exclusive reservation for uncalibrated models. CPU scoring that can use CUDA
decoding keeps an exclusive reservation on a shared host. An estimate that
cannot fit ends with an actionable error. A comparison waits for active work to release memory
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

### Dedicated QC worker

The primary worker consumes the QC queue by default. To move consumption to a
dedicated process, stop existing QC consumers after their active jobs complete.
Set `VMAF_QUEUE_OWNER=dedicated` in the shared environment for both processes.
Use the same BitOVP revision, PostgreSQL and Redis database, and model
configuration. Keep older worker binaries stopped after the handoff. Restart
the primary worker and then run this command on the QC host.

```sh
pnpm --filter @bitovp/worker start:vmaf
```

Run one dedicated process per queue. It requires Linux, a matching native
scorer and supervisor, readable host resource limits, and a Redis connection
that can list existing clients. Use the bundled Redis version or Redis 7.2 or
later, with persistent AOF storage and `maxmemory-policy noeviction`. The Redis
credentials must allow `INFO` and `WAITAOF`. The primary announces
its writable PostgreSQL database while its orchestration and notification
workers are ready. Dedicated startup and job acceptance require the same Redis
database and a current announcement for the same PostgreSQL writer and
database. Restart the dedicated worker after a PostgreSQL restart or failover
to verify the new writer. The primary enqueues measurements, delivers events,
and reconciles QC and cloud resources.

The queue registry permits multiple standard consumers or one dedicated
consumer. A standard worker started during dedicated operation continues its
other queues. A consumer keeps its registration through Redis disconnects and
until active QC work drains on shutdown. When ownership or the primary
announcement is unavailable, QC jobs wait for verification.
If a standard worker could not acquire QC ownership at startup, restart it
after Redis recovers and any dedicated consumer has drained.

To inspect a registration after an interrupted shutdown, use `redis-cli`
against the deployment's Redis database and run the following commands.

```text
HGETALL bitovp:vmaf-queue:{owner-v1}:standard
HGETALL bitovp:vmaf-queue:{owner-v1}:dedicated
```

The values identify the registering host, process ID and timestamp. Before
removing a stale token, confirm that the worker and its native and cloud jobs
have stopped or have been reconciled. Delete only that token with
`HDEL <registry-key> <token>`. If the Redis database must be restored or
reinitialized, drain all QC consumers before bringing the queue back online.

For Live QC, share the feeder spool when possible so the QC worker can read the
original normalized file. Otherwise it rebuilds the reference using the
recorded profile and verifies the source checksum. To move QC back, stop the
dedicated worker after its active jobs complete and restart the primary with
`VMAF_QUEUE_OWNER=worker`. Both modes use the same Redis queue, so waiting jobs
carry over.

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
