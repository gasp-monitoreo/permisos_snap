#!/usr/bin/env bash
# Despliegue en la VM de producción con respaldo y vuelta atrás automática.
# Uso (en la VM):  cd /opt/permisos_snap && sudo bash scripts/desplegar.sh
# Solo toca el contenedor de esta plataforma (permisos-app); no afecta otros servicios.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml"
SELLO=$(date +%Y%m%d-%H%M%S)

echo "▶ 1/5 Respaldo de la base de datos"
bash scripts/respaldar_bd.sh

echo "▶ 2/5 Imagen actual guardada como permisos-snap:previa-$SELLO"
docker tag permisos-snap:latest "permisos-snap:previa-$SELLO"
COMMIT_PREVIO=$(git -c safe.directory="$PWD" rev-parse HEAD)

echo "▶ 3/5 Código nuevo"
git -c safe.directory="$PWD" pull --ff-only
$COMPOSE build

echo "▶ 4/5 Reinicio"
$COMPOSE up -d

echo "▶ 5/5 Esperando que responda /salud (hasta 4 minutos)"
for i in $(seq 1 48); do
  if curl -fsS http://localhost:8000/salud >/dev/null 2>&1; then
    echo "✔ Desplegado $(git -c safe.directory="$PWD" rev-parse --short HEAD). Imagen anterior: permisos-snap:previa-$SELLO"
    # conserva solo las 3 imágenes previas más recientes
    docker images --format '{{.Repository}}:{{.Tag}}' | grep '^permisos-snap:previa-' | sort -r | tail -n +4 | xargs -r docker rmi >/dev/null || true
    exit 0
  fi
  sleep 5
done

echo "✘ La nueva versión no respondió: volviendo a la anterior"
$COMPOSE logs --tail 80 permisos-app || true
git -c safe.directory="$PWD" reset --hard "$COMMIT_PREVIO"
docker tag "permisos-snap:previa-$SELLO" permisos-snap:latest
$COMPOSE up -d --no-build
exit 1
