FROM python:3.12-slim

WORKDIR /app

# psycopg2 requires libpq
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/Investigaciones /app/gmail_auth /app/fotos_portada /app/staticfiles /app/cache_adjuntos

EXPOSE 8000

CMD ["sh", "-c", "\
    python manage.py migrate --noinput && \
    python manage.py createcachetable && \
    python manage.py ensure_admin && \
    python manage.py collectstatic --noinput --clear && \
    exec gunicorn config.wsgi:application \
        --bind 0.0.0.0:8000 \
        --workers 2 \
        --worker-class gthread \
        --threads 4 \
        --timeout 120 \
        --access-logfile - \
        --error-logfile - \
"]
