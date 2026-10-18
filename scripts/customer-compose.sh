#!/usr/bin/env bash
# No inherited Compose files/profiles, shell secrets, or repository .env.
set -euo pipefail
if [[ $# -lt 4 || ! "$1" =~ ^[a-z0-9][a-z0-9-]{0,39}$ || ! -f "$2" || ! -f "$3" ]]; then
  echo 'Usage: bash scripts/customer-compose.sh CUSTOMER PRIVATE_APP_ENV_FILE PRIVATE_MIGRATION_ENV_FILE COMMAND [ARGS...]' >&2
  exit 2
fi
customer="$1"
settings="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
migrations="$(cd "$(dirname "$3")" && pwd)/$(basename "$3")"
if [[ "$settings" == "$migrations" ]]; then
  echo 'Application and migration credentials require separate private files.' >&2
  exit 2
fi
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shift 3
# HOME preserves the explicitly selected local Docker context, not app secrets.
# --env-file drives app settings; only postgres/migrate read the admin file.
# Operators must not merge an additional Compose override.
exec env -i PATH="$PATH" HOME="$HOME" CUSTOMER_APP_ENV_FILE="$settings" CUSTOMER_MIGRATION_ENV_FILE="$migrations" docker compose \
  --project-directory "$repo" --env-file "$settings" \
  -p "bitovp-customer-$customer" -f "$repo/docker-compose.customer.yml" "$@"
