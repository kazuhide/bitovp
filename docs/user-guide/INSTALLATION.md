# Installation and first sign-in

[Back to the user guide](../USER-GUIDE.md)

These instructions install the browser application with Docker on macOS or
Linux. Encoding credentials are configured later in the GUI.

## 1. Requirements

- Docker Engine or Docker Desktop, running.
- Docker Compose 2.30.0 or newer.
- Node.js 24 or newer, pnpm 11, and Git for initial database setup.
- A current browser and outbound HTTPS access to image registries and providers.
- Available ports: 3100 for the web application, 5432 for PostgreSQL, and 6379
  for Redis. If these are in use, follow the separate-port and sign-in guidance
  under [multiple local installations](#optional-run-beside-another-local-installation).

Compose 2.30.0 is required because `env_file.format: raw` preserves the `$`
characters in password hashes.

The Web container allows up to **1 GiB (1,024 MiB) of memory**, without swap.
The former 512 MiB limit could terminate Web while opening pages.
For this installation, `WEB_MEMORY_LIMIT` changes the limit.
If an existing `.env` explicitly sets the old `WEB_MEMORY_LIMIT=512m`, update it
to `1g` before recreating Web; the new default does not replace explicit values.

## 2. Get the application

```bash
git clone https://github.com/kazuhide/bitovp.git
cd bitovp
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
```

## 3. Set encryption and authentication

Generate the encryption key and session secret separately:

```bash
openssl rand -base64 32
openssl rand -base64 48
```

Put the first value in `MASTER_KEY` and the second in `AUTH_SESSION_SECRET`
in `.env`. Keep both private. Losing `MASTER_KEY` prevents decryption of saved
credentials, including credentials needed for cleanup.

For an installation reachable only from your own computer, use:

```dotenv
AUTH_MODE=users
AUTH_SESSION_SECRET=<your-generated-session-secret>
PUBLIC_BASE_URL=http://localhost:3100
AUTH_ALLOW_INSECURE_HTTP=true
INGRESS_MODE=none
COMPOSE_PROFILES=
```

Replace the placeholder. Do not quote values or put comments after them:
Compose raw format preserves both quotes and inline comments literally.

| Mode | Behavior |
|---|---|
| `AUTH_MODE=users` | Individual accounts, organization membership, and roles; first administrator created at `/setup` |
| `AUTH_MODE=password` | One shared team password; requires `AUTH_PASSWORD_HASH` and `AUTH_SESSION_SECRET` |
| `AUTH_MODE=oidc` | Not implemented; requests fail closed with HTTP 503 |
| `AUTH_MODE=none` | Explicit local-development opt-out; anyone who can reach the service can use its session-free API |

Blank/unset mode defaults to password authentication. Copying `.env.example`
without configuring authentication leaves the application locked with HTTP 503.
For shared-password mode, run `pnpm --filter @bitovp/web auth:hash` and use the
generated values. The password is read from standard input, not a command argument.

For network access, remove `AUTH_ALLOW_INSECURE_HTTP=true`, configure an HTTPS
`PUBLIC_BASE_URL`, and review the host and trusted-proxy settings in
[Operations](../OPERATIONS.md). The HTTP exception is only for trusted local use.

### Optional: run beside another local installation

Use a separate checkout with its own `.env` and `.env.migrate` files. Before
initializing it, choose an unused Compose project name in `.env`, as shown below.
Compose groups containers and data volumes by that name; two checkouts with the
same folder name otherwise share the default project, even in different folders.
Keep the chosen project name for startup and shutdown. If you use `-p` or a shell
`COMPOSE_PROJECT_NAME`, set it to the same name.

Browser sign-in cookies are shared across ports on the same hostname. Changing
ports alone can replace another installation's sign-in cookie or sign you out.
Use a distinct hostname for each installation, or a separate browser profile.

For two local installations, keep the first at **http://localhost:3100** and
use **http://127.0.0.1:13100** for the second. These addresses reach the same
computer but keep the application's host-only sign-in cookies separate. Use
each installation's assigned hostname consistently for setup, sign-in and
bookmarks.

For the Docker runtime, choose unused host ports before database initialization.
For example, set these in `.env`:

```dotenv
COMPOSE_PROJECT_NAME=bitovp-secondary
POSTGRES_PORT=15432
REDIS_PORT=16379
WEB_PORT=13100
PUBLIC_BASE_URL=http://127.0.0.1:13100
REDIS_URL=redis://localhost:16379
```

In step 4, replace the default initialization command with
`pnpm --filter @bitovp/db db:runtime:init -- --database-port 15432`.
The flag must match `POSTGRES_PORT`: setting the Compose port alone does not
change the generated host database URL. Runtime preparation then preserves that
host port. Keep container-to-container database and Redis ports at 5432 and 6379.
Use **http://127.0.0.1:13100** for setup/sign-in and replace port 3100 in the
health-check URL below with 13100. These overrides do not change the port used
by `pnpm dev`.

For additional hostnames or network access, follow the HTTPS and
`ALLOWED_ORIGIN_HOSTS` Compose override instructions in
[Operations](../OPERATIONS.md#public-ingress).

## 4. Prepare the database

For a new installation:

```bash
pnpm --filter @bitovp/db db:runtime:init
docker compose up -d postgres redis
pnpm --filter @bitovp/db db:runtime:prepare
```

Administrative database credentials are kept in `.env.migrate`; restricted
runtime URLs are kept in `.env`. Keep both files private with mode 0600. The
application and worker must not use a superuser or a role that bypasses row-level
security. Existing installations should follow [upgrade instructions](../OPERATIONS.md#upgrades)
instead of initializing new credentials.

## 5. Start the application

```bash
export GIT_COMMIT=$(git rev-parse HEAD)
docker compose config --quiet
docker compose build migrate worker web
docker compose up -d --no-build
```

The migration service runs before the application. Do not continue if the
configuration check, build, or migration fails.

For automatic signed webhook and Live heartbeat delivery, optionally enable a
public receiver using these values before startup:

```dotenv
INGRESS_MODE=quick-tunnel
COMPOSE_PROFILES=quick-tunnel
INGRESS_ORIGIN_URL=http://web:3100
INGRESS_QUICKTUNNEL_METRICS_URL=
```

The resolved public hostname accepts only `/api/webhooks/*` and `/api/health`
unless the UI hostname is explicitly allowed. It does not automatically expose
the management interface. See [Operations](../OPERATIONS.md#public-ingress).

## 6. Check startup

```bash
curl --retry 60 --retry-all-errors --retry-delay 1 --retry-max-time 60 \
  --connect-timeout 2 --max-time 5 -fsS http://127.0.0.1:3100/api/health
docker compose ps
docker compose ps --all migrate
```

Expect HTTP 200 from health, a successful migration, healthy PostgreSQL/Redis,
and running web/worker services. Health confirms the web process is reachable;
it does not test Bitmovin, storage, encoding, or playback.

## 7. Create the first administrator

1. Open **http://localhost:3100/setup** in your browser first.
2. Read the one-time code emitted after opening the page:
   `docker compose logs web | grep setup-code`.
3. Enter the code, your email, display name, and a password of at least 12 characters.
4. Confirm that the dashboard opens and your role is `ADMIN`.

There are no default credentials. The first account is platform owner and Main
organization administrator. Setup does not reopen after users exist or after a
data reset. Continue with [Getting started](./GETTING-STARTED.md).

## 8. Stop the installation

```bash
docker compose down
```

This retains database volumes. Do not add `--volumes` unless you intend to
permanently delete stored application data. Stop any billable jobs, channels,
and cloud compute before shutting down the services that monitor them.
