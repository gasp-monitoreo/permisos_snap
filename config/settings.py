import os
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent.parent

DEBUG = os.environ.get('DJANGO_DEBUG', 'false').lower() == 'true'

SECRET_KEY = os.environ.get('SECRET_KEY', '')
if not SECRET_KEY:
    if not DEBUG and os.environ.get('DJANGO_PERMITIR_CLAVE_DEV') != '1':
        raise RuntimeError('Falta SECRET_KEY en el entorno.')
    SECRET_KEY = 'django-insecure-solo-desarrollo'

ALLOWED_HOSTS = os.environ.get('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',')
ALLOWED_HOSTS += ['app']  # Docker service name

CSRF_TRUSTED_ORIGINS = [
    h for h in os.environ.get('CSRF_TRUSTED_ORIGINS', 'http://localhost').split(',') if h
]

INSTALLED_APPS = [
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'tramites',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'tramites.seguridad.CSPMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'tramites.portal.AislamientoPortalMiddleware',   # cuentas de investigador: solo /portal/
    'tramites.usuarios.CambioClaveMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': False,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'

SESSION_ENGINE = 'django.contrib.sessions.backends.db'
SESSION_COOKIE_AGE = 3600

# ── Seguridad HTTP ────────────────────────────────────────────────────────────
# En producción el sitio va por HTTPS detrás de Caddy (que termina el TLS y avisa
# con X-Forwarded-Proto). En local (http://localhost) estas opciones quedan apagadas.
HTTPS = any(o.startswith('https://') for o in CSRF_TRUSTED_ORIGINS)
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
CSRF_COOKIE_SAMESITE = 'Lax'
SESSION_COOKIE_SECURE = CSRF_COOKIE_SECURE = HTTPS
if HTTPS:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_HSTS_SECONDS = 31536000
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'same-origin'
SECURE_CROSS_ORIGIN_OPENER_POLICY = 'same-origin'
X_FRAME_OPTIONS = 'DENY'
SILENCED_SYSTEM_CHECKS = [
    'security.W008',   # http→https lo redirige Caddy, antes de llegar a Django
    'security.W005',   # HSTS sin subdominios: otras plataformas comparten el dominio padre
    'security.W021',   # sin preload: decisión del dominio completo, no de esta app
]
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024      # cuerpos JSON / formularios
FILE_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024      # sobre esto, el archivo va a disco temporal
DATA_UPLOAD_MAX_NUMBER_FILES = 20

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 8}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
]

# ── Registro (stdout → docker logs) ───────────────────────────────────────────
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {'simple': {'format': '%(asctime)s %(levelname)s %(name)s: %(message)s'}},
    'handlers': {'console': {'class': 'logging.StreamHandler', 'formatter': 'simple'}},
    'root': {'handlers': ['console'], 'level': 'INFO'},
    'loggers': {
        'django.request': {'handlers': ['console'], 'level': 'ERROR', 'propagate': False},
        'django.security': {'handlers': ['console'], 'level': 'WARNING', 'propagate': False},
        'googleapiclient': {'level': 'WARNING'},
        'urllib3': {'level': 'WARNING'},
    },
}

# ── PostgreSQL ────────────────────────────────────────────────────────────────

def _parse_db_url(url: str) -> dict:
    r = urlparse(url)
    return {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME':     r.path.lstrip('/'),
        'USER':     r.username or 'cerofilas',
        'PASSWORD': r.password or 'cerofilas_secret',
        'HOST':     r.hostname or 'localhost',
        'PORT':     str(r.port or 5432),
        'OPTIONS':  {'connect_timeout': 10},
    }


DATABASES = {
    'default': _parse_db_url(
        os.environ.get('DATABASE_URL', 'postgresql://cerofilas:cerofilas_secret@localhost:5432/cerofilas')
    )
}

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ── Static files ──────────────────────────────────────────────────────────────

STATIC_URL  = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STATICFILES_DIRS = [BASE_DIR / 'static']
STORAGES = {
    'staticfiles': {
        'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage',
    },
}

# ── App config ────────────────────────────────────────────────────────────────

INVESTIGACIONES_DIR = str(BASE_DIR / 'Investigaciones')
GMAIL_AUTH_DIR      = str(BASE_DIR / 'gmail_auth')
FOTOS_DIR           = str(BASE_DIR / 'fotos_portada')

# Caché en Postgres: compartida entre workers de gunicorn y persistente entre reinicios
CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.db.DatabaseCache',
        'LOCATION': 'django_cache',
    }
}

CEROFILAS_API_BASE = os.environ.get('CEROFILAS_API_BASE', 'https://conaf.cerofilas.gob.cl/backend/api')
CEROFILAS_TOKEN    = os.environ.get('CEROFILAS_TOKEN',    '')
GMAIL_REDIRECT_URI = os.environ.get('GMAIL_REDIRECT_URI', 'http://localhost/auth/gmail/callback')
MYMEMORY_EMAIL     = os.environ.get('MYMEMORY_EMAIL', '')   # opcional: correo para la cuota de traducción
# Envío de correos a investigadores (Numeral 6): desactivado; ENVIO_CORREOS_ACTIVO=1 lo reactiva
ENVIO_CORREOS_ACTIVO = os.environ.get('ENVIO_CORREOS_ACTIVO', '0') == '1'

# Ingreso con el correo (sin distinguir mayúsculas)
AUTHENTICATION_BACKENDS = ['tramites.usuarios.EmailBackend']

LOGIN_URL = '/login/'
LOGIN_REDIRECT_URL = '/'
LOGOUT_REDIRECT_URL = '/login/'

LANGUAGE_CODE = 'es'
TIME_ZONE     = 'America/Santiago'
USE_TZ        = False

