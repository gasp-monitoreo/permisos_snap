#!/bin/bash
# Configura la app para usar el PostgreSQL del host (base permisos_snap)
# y establece backups automáticos diarios.
# Ejecutar con: sudo bash setup_host_db.sh
set -e

APP_DIR="/opt/permisos_snap"
BACKUP_DIR="/opt/permisos_snap/backups"
DB_NAME="permisos_snap"
DB_USER="snap_app"

echo "=== 1. Crear usuario PostgreSQL para la app ==="
sudo -u postgres psql -c "
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
      CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_USER' NOSUPERUSER NOCREATEDB NOCREATEROLE;
      RAISE NOTICE 'Usuario $DB_USER creado';
    ELSE
      RAISE NOTICE 'Usuario $DB_USER ya existe';
    END IF;
  END
  \$\$;
  GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
  ALTER DATABASE $DB_NAME OWNER TO $DB_USER;
"
sudo -u postgres psql -d "$DB_NAME" -c "
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO $DB_USER;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO $DB_USER;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $DB_USER;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO $DB_USER;
"

echo "=== 2. Habilitar acceso desde contenedor Docker ==="
PG_HBA=$(sudo -u postgres psql -t -c "SHOW hba_file;" | tr -d ' ')
DOCKER_SUBNET="172.16.0.0/12"

if ! sudo grep -q "$DOCKER_SUBNET" "$PG_HBA" 2>/dev/null; then
  echo "host    $DB_NAME    $DB_USER    $DOCKER_SUBNET    md5" | sudo tee -a "$PG_HBA"
  sudo -u postgres pg_ctlcluster $(pg_lsclusters -h | head -1 | awk '{print $1, $2}') reload 2>/dev/null || \
  sudo -u postgres psql -c "SELECT pg_reload_conf();"
  echo "Acceso Docker habilitado en pg_hba.conf"
else
  echo "Acceso Docker ya configurado"
fi

echo "=== 3. Verificar tablas en $DB_NAME ==="
sudo -u postgres psql -d "$DB_NAME" -c "
  SELECT tablename, pg_size_pretty(pg_total_relation_size(quote_ident(tablename))) AS size
  FROM pg_tables WHERE schemaname='public'
  ORDER BY pg_total_relation_size(quote_ident(tablename)) DESC
  LIMIT 20;
"

echo "=== 4. Actualizar DATABASE_URL en .env.prod ==="
DB_HOST="host.docker.internal"
DB_PORT="5432"

# Leer password actual o usar el por defecto
if [ -f "$APP_DIR/.env.prod" ]; then
  OLD_URL=$(grep "^DATABASE_URL=" "$APP_DIR/.env.prod" | head -1 | cut -d= -f2-)
  echo "URL anterior: $OLD_URL"
fi

# Usar la clave ya configurada para snap_app
NEW_URL="postgresql://$DB_USER:$DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
if grep -q "^DATABASE_URL=" "$APP_DIR/.env.prod" 2>/dev/null; then
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$NEW_URL|" "$APP_DIR/.env.prod"
else
  echo "DATABASE_URL=$NEW_URL" >> "$APP_DIR/.env.prod"
fi
echo "DATABASE_URL actualizado"

echo "=== 5. Crear script de backup ==="
mkdir -p "$BACKUP_DIR"
cat > "$APP_DIR/backup_db.sh" <<'BACKUP'
#!/bin/bash
BACKUP_DIR="/opt/permisos_snap/backups"
DB_NAME="permisos_snap"
DATE=$(date +%Y%m%d_%H%M%S)
FILE="$BACKUP_DIR/${DB_NAME}_${DATE}.sql.gz"

mkdir -p "$BACKUP_DIR"
sudo -u postgres pg_dump "$DB_NAME" | gzip > "$FILE"
echo "Backup creado: $FILE ($(du -sh "$FILE" | cut -f1))"

# Mantener solo los últimos 14 backups
ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +15 | xargs rm -f
echo "Backups disponibles: $(ls "$BACKUP_DIR"/*.sql.gz 2>/dev/null | wc -l)"
BACKUP
chmod +x "$APP_DIR/backup_db.sh"

echo "=== 6. Configurar cron de backup diario a las 03:00 ==="
CRON_LINE="0 3 * * * /bin/bash $APP_DIR/backup_db.sh >> $BACKUP_DIR/backup.log 2>&1"
(sudo crontab -l 2>/dev/null | grep -v "backup_db.sh"; echo "$CRON_LINE") | sudo crontab -
echo "Cron configurado: backup diario a las 03:00"

echo ""
echo "=== LISTO. Ejecutar primer backup ahora ==="
bash "$APP_DIR/backup_db.sh"

echo ""
echo "=== Reiniciar app Docker ==="
cd "$APP_DIR"
docker compose down app
docker compose up -d app
docker compose logs app --tail=20
