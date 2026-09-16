import os
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ.get('SECRET_KEY', 'django-insecure-change-me-in-production')

DEBUG = os.environ.get('DJANGO_DEBUG', 'false').lower() == 'true'

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
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
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

CEROFILAS_API_BASE = os.environ.get('CEROFILAS_API_BASE', 'https://conaf.cerofilas.gob.cl/backend/api')
CEROFILAS_TOKEN    = os.environ.get('CEROFILAS_TOKEN',    '')
GMAIL_REDIRECT_URI = os.environ.get('GMAIL_REDIRECT_URI', 'http://localhost/auth/gmail/callback')

LOGIN_URL = '/login/'
LOGIN_REDIRECT_URL = '/'
LOGOUT_REDIRECT_URL = '/login/'

LANGUAGE_CODE = 'es'
TIME_ZONE     = 'America/Santiago'
USE_TZ        = False

