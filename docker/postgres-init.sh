#!/bin/bash
# Runs once, the first time the Postgres volume is created.
# One database AND one login role per service: a service's credentials can
# only reach its own database, so the "never read another service's DB"
# rule is enforced by Postgres, not just by convention.
set -euo pipefail

create() {
  local db=$1 role=$2 password=$3
  if [ -z "$password" ]; then
    echo "postgres-init: password for $role is empty" >&2
    exit 1
  fi
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v role="$role" -v password="$password" -v db="$db" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'password';
CREATE DATABASE :"db" OWNER :"role";
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
SQL
}

create auth_db auth_user "${AUTH_DB_PASSWORD:-}"
create shift_db shift_user "${SHIFT_DB_PASSWORD:-}"
create attendance_db attendance_user "${ATTENDANCE_DB_PASSWORD:-}"
create notification_db notification_user "${NOTIFICATION_DB_PASSWORD:-}"
