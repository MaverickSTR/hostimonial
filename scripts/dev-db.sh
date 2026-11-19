#!/usr/bin/env bash
# Local Postgres for dev/tests. Mimics the Supabase bits we rely on (roles + auth.uid()).
# Usage: scripts/dev-db.sh [start|stop]   -> DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
set -euo pipefail
BIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1)
DIR=${PGDATA_DIR:-/tmp/aggregator-pg}
PORT=${PGPORT:-54322}
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
case "${1:-start}" in
  start)
    if [ ! -d "$DIR" ]; then
      mkdir -p "$DIR"; [ "$(id -u)" = 0 ] && chown postgres "$DIR"
      run "$BIN/initdb -D $DIR -U postgres --auth=trust >/dev/null"
    fi
    run "$BIN/pg_ctl -D $DIR -o '-p $PORT -k /tmp' -l $DIR/log -w start" || true
    psql -h 127.0.0.1 -p $PORT -U postgres -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/supabase-shim.sql"
    ;;
  stop) run "$BIN/pg_ctl -D $DIR stop" ;;
esac
