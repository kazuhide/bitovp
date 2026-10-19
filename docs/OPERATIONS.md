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
   runtime URLs in `.env`. For an existing installation that still has a single
   administrative URL, use `pnpm --filter @bitovp/db db:runtime:import-admin`
   before `db:runtime:prepare`; preserve encryption and authentication values.
5. Build the chosen commit, apply migrations, and replace web and worker together.
6. Check migration exit status, health, authentication, organization isolation,
   worker queues, and the image revision before accepting new work.

Never run web or worker with a PostgreSQL superuser or BYPASSRLS role. An image
rollback may be incompatible with an already-applied migration. Preserve the
new worker while it owns pending cleanup or cancellation work.

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

During channel transitions, background monitoring may skip a sample so
cancellation can finish promptly. The next monitoring sweep retries. A skipped
sample adds no heartbeat history or saved provider status change.

Per-encoding heartbeat hooks are owned and removed by the worker. Before an
upgrade that removes support for those hooks, disable registration with the new
worker and confirm cleanup first. Preserve signing keys and ownership records.

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
