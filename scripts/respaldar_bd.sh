#!/usr/bin/env bash
# Respaldo comprimido de la base de datos de esta plataforma. Guarda 14 días.
# Cron diario sugerido (como root):
#   30 3 * * * cd /opt/permisos_snap && bash scripts/respaldar_bd.sh >> /var/log/permisos_respaldo.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
DESTINO=${RESPALDOS_DIR:-/var/backups/permisos_snap}
mkdir -p "$DESTINO" && chmod 700 "$DESTINO"
# misma URL que usa la app: la toma del contenedor en marcha (o de .env.prod)
APP=$(docker ps --format '{{.Names}}' | grep -E 'permisos.*app' | head -1 || true)
URL=""
[ -n "$APP" ] && URL=$(docker inspect "$APP" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^DATABASE_URL=//p')
[ -z "$URL" ] && URL=$(sed -n 's/^[[:space:]]*\(export \)\?DATABASE_URL=//p' .env.prod | tr -d "\"'" | head -1)
[ -z "$URL" ] && { echo "No se encontró DATABASE_URL"; exit 1; }
ARCHIVO="$DESTINO/permisos_$(date +%Y%m%d-%H%M%S).sql.gz"
# pg_dump de la misma versión mayor que el servidor, desde un contenedor temporal
VERSION=$(docker run --rm --network host postgres:16-alpine psql "$URL" -tAc 'SHOW server_version_num' | cut -c1-2)
docker run --rm --network host "postgres:${VERSION}-alpine" pg_dump --no-owner --exclude-table-data=django_cache "$URL" | gzip > "$ARCHIVO"
chmod 600 "$ARCHIVO"
find "$DESTINO" -name 'permisos_*.sql.gz' -mtime +14 -delete
echo "Respaldo: $ARCHIVO ($(du -h "$ARCHIVO" | cut -f1))"
