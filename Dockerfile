# ── Plataforma de Seguimiento de Permisos SNAP – CONAF ─────────────────────────
FROM python:3.12-slim

WORKDIR /app

# Instalar curl para healthcheck y dependencias del sistema
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Instalar dependencias Python primero (capa cacheada)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copiar código fuente
# (.dockerignore excluye Investigaciones/, .env, logs, etc.)
COPY . .

# Crear carpeta de investigaciones si no está montada como volumen
RUN mkdir -p /app/Investigaciones

EXPOSE 8000

# Gunicorn: 2 workers, timeout de 5 min para las llamadas lentas a CeroFilas API
CMD ["gunicorn", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "2", \
     "--timeout", "300", \
     "--keep-alive", "5", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "app:app"]
