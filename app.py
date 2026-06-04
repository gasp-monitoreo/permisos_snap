from flask import Flask, jsonify, request, render_template, send_file, send_from_directory, redirect, session
from flask_cors import CORS
import requests
import io
import json
import os
import base64
import re as _re
import calendar as _calendar
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from openpyxl import Workbook
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# ── Gmail API ──────────────────────────────────────────────────────────────────
GMAIL_IMPORT_ERROR = None
try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request as GRequest
    from google_auth_oauthlib.flow import Flow
    from googleapiclient.discovery import build as gbuild
    GMAIL_AVAILABLE = True
except Exception as _e:
    GMAIL_AVAILABLE = False
    GMAIL_IMPORT_ERROR = str(_e)

GMAIL_SCOPES      = ['https://www.googleapis.com/auth/gmail.compose']
GMAIL_TOKEN_FILE  = os.path.join(os.path.dirname(__file__), 'gmail_token.json')
GMAIL_CREDS_FILE  = os.path.join(os.path.dirname(__file__), 'gmail_credentials.json')
GMAIL_REDIRECT    = os.environ.get("GMAIL_REDIRECT_URI", "http://localhost:5001/auth/gmail/callback")

def _gmail_creds():
    """Devuelve credenciales válidas o None si no hay token guardado."""
    if not GMAIL_AVAILABLE or not os.path.exists(GMAIL_TOKEN_FILE):
        return None
    creds = Credentials.from_authorized_user_file(GMAIL_TOKEN_FILE, GMAIL_SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(GRequest())
        with open(GMAIL_TOKEN_FILE, 'w') as f:
            f.write(creds.to_json())
    return creds if creds and creds.valid else None

def _gmail_service():
    creds = _gmail_creds()
    if not creds:
        return None
    return gbuild('gmail', 'v1', credentials=creds)

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", os.urandom(24).hex())
CORS(app)

API_BASE = os.environ.get("CEROFILAS_API_BASE", "https://conaf.cerofilas.gob.cl/backend/api")
TOKEN    = os.environ.get("CEROFILAS_TOKEN",    "GI1K0CaTKltnR9ziu60jBUKfsbNI13")

ESTADO_COLORES = {
    "pendiente": "#FFC107",
    "completado": "#28A745",
    "rechazado": "#DC3545",
    "en_proceso": "#17A2B8",
}

# Plazo máximo en meses calendario por proceso.
PROCESO_PLAZO_MESES = {
    517:  2,   # OLD_Permiso de Investigación ASP
    692:  2,   # Permiso de Investigación (importación)
    1992: 2,   # Permiso de Investigación ASP (activo)
    437:  1,   # Solicitud de Filmación y Fotografía SNASPE
    585:  1,   # Solicitud Filmación y Fotografía ASP (importación)
    631:  1,   # Solicitud de Filmación y Fotografía (prueba)
    632:  1,   # Solicitud de Filmación y Fotografía (importación)
    672:  1,   # Solicitud de Filmación y Fotografía SNASPE
}

# Regex para detectar etapa de finalización a cargo del solicitante
_pat_finalizacion = _re.compile(
    r'finaliz|recepci[oó]n\s+tramite|recepci[oó]n\s+tr[aá]mite|cierre\s+tr[aá]mite',
    _re.I
)

def _add_months(dt, months):
    """Suma N meses calendario a un datetime (respeta fin de mes)."""
    month = dt.month - 1 + months
    year  = dt.year + month // 12
    month = month % 12 + 1
    day   = min(dt.day, _calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _parse_date_flexible(s):
    """Parsea fechas en varios formatos comunes. Retorna datetime o None."""
    if not s:
        return None
    s = str(s).strip()
    for fmt, n in [
        ("%Y-%m-%d %H:%M:%S", 19),
        ("%Y-%m-%dT%H:%M:%S", 19),
        ("%Y-%m-%d", 10),
        ("%d-%m-%Y %H:%M:%S", 19),
        ("%d-%m-%Y", 10),
        ("%d/%m/%Y", 10),
    ]:
        try:
            return datetime.strptime(s[:n], fmt)
        except Exception:
            pass
    return None


def api_get(path, params=None):
    if params is None:
        params = {}
    params["token"] = TOKEN
    url = f"{API_BASE}{path}"
    import time as _time
    for attempt in range(3):
        try:
            resp = requests.get(url, params=params, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except requests.HTTPError as e:
            code = e.response.status_code if e.response is not None else 0
            if code in (502, 503, 504) and attempt < 2:
                _time.sleep(1.5 ** attempt)
                continue
            raise
        except (requests.ConnectionError, requests.Timeout) as e:
            if attempt < 2:
                _time.sleep(1.5 ** attempt)
                continue
            raise


def extract_datos(datos_list):
    result = {}
    if not datos_list:
        return result
    for item in (datos_list or []):
        if isinstance(item, dict):
            for k, v in item.items():
                result[k] = v
    return result


def _clean_name(s):
    return " ".join(s.split()) if s else ""


# ── Mapeos de regiones de Chile ───────────────────────────────────────────────
ROMAN_A_REGION = {
    'I': 'Tarapacá', 'II': 'Antofagasta', 'III': 'Atacama',
    'IV': 'Coquimbo', 'V': 'Valparaíso', 'VI': "O'Higgins",
    'VII': 'Maule', 'VIII': 'Biobío', 'IX': 'Araucanía',
    'X': 'Los Lagos', 'XI': 'Aysén', 'XII': 'Magallanes',
    'XIII': 'Metropolitana', 'XIV': 'Los Ríos',
    'XV': 'Arica y Parinacota', 'XVI': 'Ñuble',
    'RM': 'Metropolitana', 'RMS': 'Metropolitana',
}
NUMERO_A_REGION = {
    '1': 'Tarapacá', '2': 'Antofagasta', '3': 'Atacama', '4': 'Coquimbo',
    '5': 'Valparaíso', '6': "O'Higgins", '7': 'Maule', '8': 'Biobío',
    '9': 'Araucanía', '10': 'Los Lagos', '11': 'Aysén', '12': 'Magallanes',
    '13': 'Metropolitana', '14': 'Los Ríos', '15': 'Arica y Parinacota', '16': 'Ñuble',
}
NOMBRE_A_REGION = {
    'arica': 'Arica y Parinacota', 'parinacota': 'Arica y Parinacota',
    'tarapaca': 'Tarapacá', 'tarapacá': 'Tarapacá',
    'antofagasta': 'Antofagasta', 'atacama': 'Atacama', 'coquimbo': 'Coquimbo',
    'valparaiso': 'Valparaíso', 'valparaíso': 'Valparaíso',
    'metropolitana': 'Metropolitana', 'santiago': 'Metropolitana', 'rm': 'Metropolitana',
    'ohiggins': "O'Higgins", "o'higgins": "O'Higgins", 'libertador': "O'Higgins",
    'maule': 'Maule', 'nuble': 'Ñuble', 'ñuble': 'Ñuble',
    'biobio': 'Biobío', 'biobío': 'Biobío', 'bio-bio': 'Biobío', 'bío-bío': 'Biobío',
    'araucania': 'Araucanía', 'araucanía': 'Araucanía',
    'losrios': 'Los Ríos', 'losríos': 'Los Ríos', 'los rios': 'Los Ríos', 'los ríos': 'Los Ríos',
    'loslagos': 'Los Lagos', 'los lagos': 'Los Lagos',
    'aysen': 'Aysén', 'aysén': 'Aysén',
    'magallanes': 'Magallanes', 'antartica': 'Magallanes', 'antártica': 'Magallanes',
}

def parse_regiones(valor):
    """Convierte un valor de región (romano, número, nombre o lista) a lista de nombres canónicos."""
    import ast as _a_reg
    if not valor:
        return []
    if isinstance(valor, list):
        items = [str(v).strip() for v in valor]
    else:
        sv = str(valor).strip()
        if sv.startswith('['):
            try:
                items = [str(v).strip() for v in _a_reg.literal_eval(sv)]
            except Exception:
                items = [sv.strip("[]'\" ")]
        else:
            items = [sv]
    result = []
    seen = set()
    for item in items:
        item = item.strip().strip("'\" ")
        if not item:
            continue
        canon = (ROMAN_A_REGION.get(item.upper()) or
                 NUMERO_A_REGION.get(item) or
                 NOMBRE_A_REGION.get(item.lower().replace(' ', '').replace('-', '').replace('_', '')) or
                 NOMBRE_A_REGION.get(item.lower()))
        if not canon:
            kn = item.lower()
            for k, v in NOMBRE_A_REGION.items():
                if k in kn:
                    canon = v
                    break
        final = canon or item
        if final and final not in seen:
            seen.add(final)
            result.append(final)
    return result


def normalize_tramite(t):
    datos = extract_datos(t.get("datos") or [])
    etapas = t.get("etapas") or []
    etapa_actual = None
    etapas_info = []
    completadas = 0

    for etapa in etapas:
        estado_etapa = etapa.get("estado", "")
        # Support both nested usuario_asignado and flat structure
        ua = etapa.get("usuario_asignado") or {}
        nombre_ua = _clean_name(
            ua.get("nombres") or etapa.get("nombres") or ""
        )
        apellido_p = ua.get("apellido_paterno") or ""
        apellido_m = ua.get("apellido_materno") or ""
        nombre_completo_ua = _clean_name(f"{nombre_ua} {apellido_p} {apellido_m}")

        tarea = etapa.get("tarea") or {}
        etapa_info = {
            "id": etapa.get("id"),
            "estado": estado_etapa,
            "usuario": ua.get("usuario") or etapa.get("usuario") or "",
            "email": ua.get("email") or etapa.get("email") or "",
            "nombres": nombre_completo_ua,
            "fecha_inicio": etapa.get("fecha_inicio"),
            "fecha_termino": etapa.get("fecha_termino"),
            "fecha_vencimiento": etapa.get("fecha_vencimiento"),
            "tarea_id": tarea.get("id"),
            "tarea_nombre": tarea.get("nombre", ""),
        }
        etapas_info.append(etapa_info)
        if estado_etapa == "completado":
            completadas += 1
        if estado_etapa == "pendiente" and etapa_actual is None:
            etapa_actual = etapa_info

    total_etapas = len(etapas)
    porcentaje = int((completadas / total_etapas) * 100) if total_etapas > 0 else 0

    # ── Solicitante: from datos_raw first, fallback to last etapa (submitter) ──
    # Try many possible field names from the CONAF forms
    email_solicitante = (
        datos.get("correo_electronico") or datos.get("correo_electronico_grabacion1") or
        datos.get("email") or datos.get("correo") or datos.get("mail") or ""
    )

    # Name from datos: try coordinador/responsable fields first
    nombre_datos = _clean_name(
        datos.get("nombres_coordinador") or datos.get("nombre_coordinador") or
        datos.get("nombres") or datos.get("nombre") or ""
    )
    apellidos_datos = _clean_name(
        datos.get("apellidos_coordinador") or datos.get("apellidos") or
        datos.get("paterno", "") + " " + datos.get("materno", "") or ""
    )
    nombre_completo = _clean_name(f"{nombre_datos} {apellidos_datos}")

    # If datos didn't give us a name, use the LAST etapa (the one who submitted the form)
    # The submitter is typically the oldest etapa (last in list or with smallest id)
    if not nombre_completo and etapas_info:
        submitter = etapas_info[-1]  # oldest / the applicant's submission step
        nombre_completo = submitter.get("nombres", "")
        if not email_solicitante:
            email_solicitante = submitter.get("email", "")

    # ── Region from datos_raw ──
    region = (
        datos.get("region") or datos.get("region_id") or datos.get("zona") or
        datos.get("region_unidad") or datos.get("regional") or ""
    )
    # Some forms embed region in field names like "descripcion_ohiggins"
    if not region:
        for k in datos:
            lk = k.lower()
            for reg_kw in ("arica", "tarapaca", "antofagasta", "atacama", "coquimbo",
                           "valparaiso", "ohiggins", "metropolitana", "maule",
                           "nuble", "biobio", "araucania", "losrios", "loslagos",
                           "aysen", "magallanes", "parinacota"):
                if reg_kw in lk.replace("'", "").replace(" ", "").replace("-", ""):
                    region = reg_kw.title()
                    break
            if region:
                break

    # ── Áreas protegidas from datos_raw ──
    # Los formularios guardan áreas como valores de claves "region_de_XXX" (ej: "region_de_maule")
    # cuyo valor es una lista Python/JSON como "['parque_nacional_radal_siete_tazas', ...]"
    # También puede haber claves directas "area_protegida", "parque", etc.
    import re as _re, ast as _ast
    _area_key_pat = _re.compile(
        r'^(area_protegida|[aá]rea_protegida|unidad|parque|reserva|monumento|santuario)',
        _re.IGNORECASE
    )
    _region_de_pat = _re.compile(r'^region_de(?:l)?_', _re.IGNORECASE)

    areas_protegidas = []
    seen_areas = set()

    def _add_area(raw_val):
        """Parsea un valor que puede ser string, lista Python o JSON y agrega cada item."""
        if not raw_val:
            return
        val = str(raw_val).strip()
        # Intenta parsear como lista Python/JSON
        if val.startswith('['):
            try:
                items_list = _ast.literal_eval(val)
            except Exception:
                try:
                    import json as _json
                    items_list = _json.loads(val)
                except Exception:
                    items_list = [val]
        else:
            items_list = [val]
        for item in items_list:
            if not item:
                continue
            # Humanizar: reemplazar __ y _ por espacios, capitalizar
            human = str(item).replace('__', ' ').replace('_', ' ').strip().title()
            key = human.lower()
            if human and key not in seen_areas:
                seen_areas.add(key)
                areas_protegidas.append(human)

    for k, v in datos.items():
        if v:
            if _area_key_pat.match(k):
                _add_area(v)
            elif _region_de_pat.match(k):
                # Solo si el valor parece una lista de áreas (no texto libre)
                sv = str(v).strip()
                if sv.startswith('['):
                    _add_area(v)

    # ── Borrador: detectado con mismos criterios que es_borrador() ──────────────
    # (se llama aquí antes del return para incluirlo en el dict)
    _borrador_dict = {
        "etapas_completadas": completadas,
        "etapa_actual": etapa_actual,
        "email_solicitante": email_solicitante,
        "nombre_solicitante": nombre_completo,
    }
    borrador = es_borrador(_borrador_dict)

    regiones_list = parse_regiones(region)
    region_display = ", ".join(regiones_list) if regiones_list else (str(region) if region else "")

    # ── Helper: ¿email es de CONAF? ─────────────────────────────────────────────
    def _email_es_conaf(email):
        e = (email or "").strip().lower()
        return e.endswith("@conaf.cl") or e.endswith("@conaf.gob.cl")

    # ── Detectar rechazo real ────────────────────────────────────────────────────
    # Caso A: etapa "Rechazo*" completada (por CONAF)
    # Caso B: etapa "Rechazo*" pendiente asignada al solicitante
    #         → CONAF ya decidió rechazar, solo falta que el solicitante lo cierre
    _pat_rechazo = _re.compile(r'rechazo|rechaz', _re.I)
    estado_final = t.get("estado", "")
    recepcion_pendiente = False

    if estado_final != "rechazado":
        for _e in etapas_info:
            if not _pat_rechazo.search(_e.get("tarea_nombre", "")):
                continue
            if _e.get("estado") == "completado":
                estado_final = "rechazado"
                break
            if _e.get("estado") == "pendiente" and not _email_es_conaf(_e.get("email")):
                # CONAF rechazó; solicitante debe cerrar/acusar recibo
                estado_final = "rechazado"
                recepcion_pendiente = True
                break

    # ── Detectar "recepción pendiente solicitante" (caso aprobación) ─────────────
    # Si CONAF completó al menos una etapa y TODAS las etapas restantes están
    # asignadas a emails no-CONAF → CONAF terminó su parte.
    if estado_final == "pendiente" and completadas > 0:
        pendientes_etapas = [e for e in etapas_info if e.get("estado") == "pendiente"]
        if pendientes_etapas and all(
            not _email_es_conaf(ep.get("email")) for ep in pendientes_etapas
        ):
            recepcion_pendiente = True
            estado_final = "completado"

    # ── Fecha límite por tipo de proceso ────────────────────────────────────────
    proceso_id_val = t.get("proceso_id")
    fecha_limite_proceso = None
    fecha_inicio_str = t.get("fecha_inicio")
    if fecha_inicio_str and proceso_id_val in PROCESO_PLAZO_MESES:
        try:
            fi = datetime.strptime(str(fecha_inicio_str)[:19], "%Y-%m-%d %H:%M:%S")
            fl = _add_months(fi, PROCESO_PLAZO_MESES[proceso_id_val])
            fecha_limite_proceso = fl.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass

    return {
        "id": t.get("id"),
        "estado": estado_final,
        "proceso_id": t.get("proceso_id"),
        "proceso_nombre": t.get("proceso_nombre", ""),
        "fecha_inicio": t.get("fecha_inicio"),
        "fecha_modificacion": t.get("fecha_modificacion"),
        "fecha_termino": t.get("fecha_termino"),
        "fecha_limite_proceso": fecha_limite_proceso,
        "nombre_solicitante": nombre_completo,
        "email_solicitante": email_solicitante,
        "region": region_display,
        "regiones_list": regiones_list,
        "porcentaje_avance": porcentaje,
        "etapa_actual": etapa_actual,
        "etapas": etapas_info,
        "total_etapas": total_etapas,
        "etapas_completadas": completadas,
        "borrador": borrador,
        "recepcion_pendiente": recepcion_pendiente,
        "areas_protegidas": areas_protegidas,
        "archivo_autorizacion": (
            datos.get("autorizacion") or
            datos.get("autorizacion_firmada") or
            datos.get("resolucion") or
            datos.get("resolucion_aprobacion") or
            datos.get("documento_aprobacion") or
            None
        ),
        # ID de la etapa que contiene el documento de autorización
        # tarea_id 8715 = "Carga documento adjunto regional" (investigación)
        # También buscamos por nombre para cubrir filmaciones
        "etapa_autorizacion_id": next(
            (e["id"] for e in etapas_info if
             e.get("tarea_id") in (8715, 8752) or
             _re.search(r'adjunto|autori|firmad|aprob|resolu', e.get("tarea_nombre",""), _re.I)),
            None
        ),
        "datos_raw": datos,
    }


def fetch_all_tramites(proceso_id=None, created_at_start=None, created_at_end=None,
                        updated_at_start=None, updated_at_end=None,
                        ended_at_start=None, ended_at_end=None,
                        date_cutoff=None):
    """
    date_cutoff: datetime opcional. Si se indica, se deja de paginar en cuanto
    todos los items de una página son anteriores a esa fecha.
    """
    all_items = []
    page_token = None
    max_pages = 200

    params = {"maxResults": 50}
    if created_at_start:
        params["created_at_start"] = created_at_start
    if created_at_end:
        params["created_at_end"] = created_at_end
    if updated_at_start:
        params["updated_at_start"] = updated_at_start
    if updated_at_end:
        params["updated_at_end"] = updated_at_end
    if ended_at_start:
        params["ended_at_start"] = ended_at_start
    if ended_at_end:
        params["ended_at_end"] = ended_at_end

    for _ in range(max_pages):
        if page_token:
            params["pageToken"] = page_token

        if proceso_id:
            data = api_get(f"/procesos/{proceso_id}/tramites", params)
        else:
            data = api_get("/tramites", params)

        tramites_data = data.get("tramites") or {}
        items = tramites_data.get("items") or []

        if date_cutoff:
            page_valid = []
            stop = False
            for item in items:
                fecha = item.get("fecha_inicio") or item.get("created_at") or ""
                if fecha:
                    try:
                        # Puede venir como timestamp unix o como ISO string
                        if isinstance(fecha, (int, float)):
                            item_date = datetime.fromtimestamp(fecha)
                        else:
                            item_date = datetime.fromisoformat(str(fecha)[:19])
                        if item_date < date_cutoff:
                            stop = True
                            break
                    except Exception:
                        pass
                page_valid.append(item)
            all_items.extend(page_valid)
            if stop:
                break
        else:
            all_items.extend(items)

        page_token = tramites_data.get("nextPageToken")
        if not page_token:
            break

    return all_items


def _norm_nombre(s):
    """Normaliza nombre: minúsculas, sin tildes, sin espacios extra."""
    import unicodedata
    s = (s or "").strip().lower()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return ' '.join(s.split())


def es_borrador(t):
    """
    Detecta si un trámite es un 'borrador': el solicitante inició el proceso
    pero aún no terminó de completar/enviar el formulario inicial.

    Criterios (0 etapas completadas + alguno de los siguientes):
      1. Email de la etapa actual == email del solicitante (mismo correo)
      2. Nombre normalizado de la etapa == nombre normalizado del solicitante
         (cubre el caso de 2 emails distintos pero misma persona)
      3. La tarea de la etapa actual es claramente de llenado de formulario
         Y el email no pertenece a un dominio CONAF
    """
    if t.get("etapas_completadas", 0) > 0:
        return False  # ya avanzó → no es borrador

    etapa_actual = t.get("etapa_actual") or {}
    if not etapa_actual:
        return False

    email_etapa = (etapa_actual.get("email") or "").strip().lower()
    email_sol   = (t.get("email_solicitante") or "").strip().lower()

    # Criterio 1: mismo email
    if email_etapa and email_sol and email_etapa == email_sol:
        return True

    # Criterio 2: mismo nombre (insensible a tildes y mayúsculas)
    nombre_etapa = _norm_nombre(etapa_actual.get("nombres", ""))
    nombre_sol   = _norm_nombre(t.get("nombre_solicitante", ""))
    if nombre_etapa and nombre_sol and nombre_etapa == nombre_sol:
        return True

    # Criterio 3: la tarea es claramente de llenado de formulario inicial
    # y quien tiene la tarea NO es funcionario CONAF
    tarea = (etapa_actual.get("tarea_nombre") or "").strip()
    es_tarea_formulario = bool(_re.search(
        r'formulario\s+de\s+solicitud|formulario\s+solicitud|completar\s+formulario|'
        r'ingreso\s+solicitud|solicitud\s+ingreso|registro\s+solicitud',
        tarea, _re.I
    ))
    es_conaf = email_etapa.endswith('@conaf.cl') or email_etapa.endswith('@conaf.gob.cl')
    if es_tarea_formulario and not es_conaf:
        return True

    return False


def es_tramite_visible(t):
    """Retorna False si el trámite es un borrador (aún no enviado por el solicitante)."""
    return not es_borrador(t)


def fetch_all_processes():
    data = api_get("/procesos")
    items = (data.get("procesos") or {}).get("items") or []
    return items


# ─── Compliance helpers ───────────────────────────────────────────────────────

INVESTIGACION_PROCESO_IDS = [517, 692, 1992]

def _fetch_compliance_data():
    """
    Obtiene todos los trámites de investigación con >3 años transcurridos
    desde 'fecha_termino_actividades' (numeral 6 del reglamento).
    Retorna (lista_resultados, candidatos_revisados).
    """
    HOY = datetime.now()

    # 1. Listar solo tramites creados hace MAS de 3 años (created_at_end al API)
    #    y en paralelo para los 3 procesos de investigacion.
    #    Provably safe: fecha_termino_actividades >= fecha_inicio,
    #    por lo que si inicio < 3 años atras es imposible que termine > 3 años atras.
    corte = _add_months(HOY, -36)
    corte_ts = str(int(corte.timestamp()))

    def _fetch_list(pid):
        try:
            return fetch_all_tramites(proceso_id=pid, created_at_end=corte_ts)
        except Exception:
            return []

    all_raw = []
    with ThreadPoolExecutor(max_workers=len(INVESTIGACION_PROCESO_IDS)) as ex:
        for items in ex.map(_fetch_list, INVESTIGACION_PROCESO_IDS):
            all_raw.extend(items)

    # 2. Deduplicar IDs
    seen_ids = set()
    candidatos = []
    for t in all_raw:
        tid = t.get("id")
        if tid and tid not in seen_ids:
            seen_ids.add(tid)
            candidatos.append(tid)

    # 3. Descargar detalle individual en paralelo para acceder a datos_raw
    def _check(tid):
        try:
            data = api_get(f"/tramites/{tid}")
            t_raw = data.get("tramite", data)
            norm = normalize_tramite(t_raw)
            datos = norm.get("datos_raw", {})

            # Buscar fecha_termino_actividades con variantes de nombre de clave
            fta_str = (
                datos.get("fecha_termino_actividades") or
                datos.get("fecha_termino_actividad") or
                datos.get("fecha_fin_actividades") or
                datos.get("fecha_fin_investigacion") or
                datos.get("fecha_termino_trabajo_campo") or
                None
            )
            if not fta_str:
                return None

            fta_dt = _parse_date_flexible(fta_str)
            if fta_dt is None:
                return None

            # ¿Han pasado más de 3 años?
            if _add_months(fta_dt, 36) >= HOY:
                return None

            anios = round((HOY - fta_dt).days / 365.25, 1)

            titulo = (
                datos.get("titulo_investigacion") or
                datos.get("titulo_de_la_investigacion") or
                datos.get("titulo_proyecto") or
                datos.get("titulo_del_proyecto") or
                datos.get("nombre_de_la_investigacion") or
                datos.get("nombre_investigacion") or
                datos.get("titulo") or ""
            )

            return {
                "id": norm["id"],
                "estado": norm["estado"],
                "nombre_solicitante": norm["nombre_solicitante"],
                "email_solicitante": norm["email_solicitante"],
                "titulo_investigacion": str(titulo).strip(),
                "fecha_termino_actividades": str(fta_str).strip()[:10],
                "anios_transcurridos": anios,
                "fecha_modificacion": norm["fecha_modificacion"],
                "region": norm["region"],
                "regiones_list": norm["regiones_list"],
            }
        except Exception:
            return None

    resultados = []
    if candidatos:
        max_w = min(40, max(1, len(candidatos)))
        with ThreadPoolExecutor(max_workers=max_w) as executor:
            futures = {executor.submit(_check, tid): tid for tid in candidatos}
            for future in as_completed(futures):
                r = future.result()
                if r:
                    resultados.append(r)

    # Ordenar: primero los más antiguos (fecha_termino_actividades ascendente)
    resultados.sort(key=lambda x: x.get("fecha_termino_actividades") or "")
    return resultados, len(candidatos)


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/procesos")
def get_procesos():
    try:
        items = fetch_all_processes()
        return jsonify({"ok": True, "data": items})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/tramites")
def get_tramites():
    try:
        proceso_id = request.args.get("proceso_id")
        created_at_start = request.args.get("created_at_start")
        created_at_end = request.args.get("created_at_end")
        updated_at_start = request.args.get("updated_at_start")
        updated_at_end = request.args.get("updated_at_end")
        ended_at_start = request.args.get("ended_at_start")
        ended_at_end = request.args.get("ended_at_end")

        # Corte de paginación: si viene created_at_start, dejar de paginar
        # cuando los trámites sean anteriores a esa fecha
        date_cutoff = None
        if created_at_start:
            try:
                date_cutoff = datetime.fromtimestamp(int(created_at_start))
            except Exception:
                pass

        raw = fetch_all_tramites(
            proceso_id=proceso_id,
            created_at_start=created_at_start,
            created_at_end=created_at_end,
            updated_at_start=updated_at_start,
            updated_at_end=updated_at_end,
            ended_at_start=ended_at_start,
            ended_at_end=ended_at_end,
            date_cutoff=date_cutoff,
        )
        normalized = [normalize_tramite(t) for t in raw]
        normalized = [t for t in normalized if es_tramite_visible(t)]
        return jsonify({"ok": True, "data": normalized, "total": len(normalized)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/tramites/<int:tramite_id>")
def get_tramite(tramite_id):
    try:
        data = api_get(f"/tramites/{tramite_id}")
        t = data.get("tramite", data)
        normalized = normalize_tramite(t)
        return jsonify({"ok": True, "data": normalized})
    except requests.HTTPError as e:
        if e.response.status_code == 404:
            return jsonify({"ok": False, "error": "Trámite no encontrado"}), 404
        return jsonify({"ok": False, "error": str(e)}), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/export/excel")
def export_excel():
    try:
        proceso_id = request.args.get("proceso_id")
        created_at_start = request.args.get("created_at_start")
        created_at_end = request.args.get("created_at_end")
        ended_at_start = request.args.get("ended_at_start")
        ended_at_end = request.args.get("ended_at_end")
        estado_filter = request.args.get("estado")

        raw = fetch_all_tramites(
            proceso_id=proceso_id,
            created_at_start=created_at_start,
            created_at_end=created_at_end,
            ended_at_start=ended_at_start,
            ended_at_end=ended_at_end,
        )
        tramites = [normalize_tramite(t) for t in raw]
        tramites = [t for t in tramites if es_tramite_visible(t)]

        if estado_filter:
            tramites = [t for t in tramites if t["estado"] == estado_filter]

        # Fetch process names
        try:
            procesos = fetch_all_processes()
            proceso_map = {p.get("proceso", p).get("id") if "proceso" in p else p.get("id"):
                          p.get("proceso", p).get("nombre") if "proceso" in p else p.get("nombre")
                          for p in procesos}
        except:
            proceso_map = {}

        wb = Workbook()
        ws = wb.active
        ws.title = "Trámites"

        # Styles
        header_fill = PatternFill("solid", fgColor="1B4F72")
        header_font = Font(color="FFFFFF", bold=True, size=11)
        header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

        estado_fills = {
            "pendiente": PatternFill("solid", fgColor="FFF3CD"),
            "completado": PatternFill("solid", fgColor="D4EDDA"),
            "rechazado": PatternFill("solid", fgColor="F8D7DA"),
        }

        thin = Side(border_style="thin", color="CCCCCC")
        border = Border(left=thin, right=thin, top=thin, bottom=thin)

        headers = [
            "ID", "Estado", "Tipo de Trámite", "Proceso ID",
            "Nombre Solicitante", "Email Solicitante", "Región",
            "Fecha Inicio", "Fecha Modificación", "Fecha Término",
            "% Avance", "Etapas Completadas", "Total Etapas",
            "Etapa Actual", "Responsable Actual", "Email Responsable",
            "Fecha Vencimiento Etapa", "Archivo Autorización",
        ]

        for col, header in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col, value=header)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = header_align
            cell.border = border

        ws.row_dimensions[1].height = 30

        for row_num, t in enumerate(tramites, 2):
            proceso_nombre = proceso_map.get(t["proceso_id"], f"Proceso {t['proceso_id']}")
            etapa_actual = t.get("etapa_actual") or {}
            estado = t.get("estado", "")

            values = [
                t["id"],
                estado.capitalize(),
                proceso_nombre,
                t["proceso_id"],
                t["nombre_solicitante"],
                t["email_solicitante"],
                t["region"],
                t["fecha_inicio"],
                t["fecha_modificacion"],
                t["fecha_termino"],
                f"{t['porcentaje_avance']}%",
                t["etapas_completadas"],
                t["total_etapas"],
                etapa_actual.get("nombres", ""),
                etapa_actual.get("nombres", ""),
                etapa_actual.get("email", ""),
                etapa_actual.get("fecha_vencimiento", ""),
                t.get("archivo_autorizacion", ""),
            ]

            row_fill = estado_fills.get(estado)
            for col, val in enumerate(values, 1):
                cell = ws.cell(row=row_num, column=col, value=val)
                cell.border = border
                cell.alignment = Alignment(vertical="center")
                if row_fill:
                    cell.fill = row_fill

        # Column widths
        col_widths = [8, 12, 30, 12, 30, 30, 15, 20, 20, 20, 10, 10, 10, 25, 25, 30, 22, 35]
        for i, width in enumerate(col_widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = width

        # Summary sheet
        ws2 = wb.create_sheet("Resumen")
        ws2["A1"] = "RESUMEN DE TRÁMITES"
        ws2["A1"].font = Font(bold=True, size=14, color="1B4F72")
        ws2["A3"] = "Total Trámites"
        ws2["B3"] = len(tramites)
        ws2["A4"] = "Pendientes"
        ws2["B4"] = sum(1 for t in tramites if t["estado"] == "pendiente")
        ws2["B4"].fill = PatternFill("solid", fgColor="FFF3CD")
        ws2["A5"] = "Completados"
        ws2["B5"] = sum(1 for t in tramites if t["estado"] == "completado")
        ws2["B5"].fill = PatternFill("solid", fgColor="D4EDDA")
        ws2["A6"] = "Rechazados"
        ws2["B6"] = sum(1 for t in tramites if t["estado"] == "rechazado")
        ws2["B6"].fill = PatternFill("solid", fgColor="F8D7DA")
        ws2["A7"] = "Generado"
        ws2["B7"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for r in range(3, 8):
            ws2[f"A{r}"].font = Font(bold=True)
            ws2.column_dimensions["A"].width = 20
            ws2.column_dimensions["B"].width = 25

        output = io.BytesIO()
        wb.save(output)
        output.seek(0)

        filename = f"tramites_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        return send_file(
            output,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name=filename,
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/compliance/investigacion")
def compliance_investigacion():
    """Trámites de investigación con >3 años desde fecha_termino_actividades."""
    try:
        resultados, revisados = _fetch_compliance_data()
        return jsonify({
            "ok": True,
            "data": resultados,
            "total": len(resultados),
            "candidatos_revisados": revisados,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/export/compliance/excel")
def export_compliance_excel():
    """Exporta el informe de incumplimiento numeral 6 como Excel."""
    try:
        HOY = datetime.now()
        resultados, _ = _fetch_compliance_data()

        wb = Workbook()
        ws = wb.active
        ws.title = "Incumplimiento Numeral 6"

        header_fill  = PatternFill("solid", fgColor="7B1C1C")
        header_font  = Font(color="FFFFFF", bold=True, size=11)
        header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)
        thin   = Side(border_style="thin", color="CCCCCC")
        border = Border(left=thin, right=thin, top=thin, bottom=thin)

        headers = [
            "ID Trámite", "Estado", "Nombre Solicitante", "Email Solicitante",
            "Título de la Investigación", "Fecha Término Actividades",
            "Años Transcurridos", "Última Modificación", "Región(es)",
        ]
        for col, h in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col, value=h)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = header_align
            cell.border = border
        ws.row_dimensions[1].height = 35

        fill_alto  = PatternFill("solid", fgColor="F8D7DA")   # ≥5 años
        fill_medio = PatternFill("solid", fgColor="FFF3CD")   # 3–5 años

        for row_num, r in enumerate(resultados, 2):
            anios = r.get("anios_transcurridos", 0)
            fill  = fill_alto if anios >= 5 else fill_medio
            values = [
                r["id"],
                (r.get("estado") or "").capitalize(),
                r["nombre_solicitante"],
                r["email_solicitante"],
                r["titulo_investigacion"],
                r["fecha_termino_actividades"],
                anios,
                r["fecha_modificacion"],
                r["region"],
            ]
            for col, val in enumerate(values, 1):
                cell = ws.cell(row=row_num, column=col, value=val)
                cell.border = border
                cell.alignment = Alignment(vertical="center", wrap_text=(col == 5))
                cell.fill = fill

        col_widths = [12, 12, 30, 35, 50, 22, 16, 22, 30]
        for i, w in enumerate(col_widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w

        # Hoja informativa
        ws2 = wb.create_sheet("Información")
        ws2["A1"] = "INCUMPLIMIENTO NUMERAL 6 – REGLAMENTO DE INVESTIGACIÓN CONAF"
        ws2["A1"].font = Font(bold=True, size=13, color="7B1C1C")
        ws2["A3"] = "Descripción"
        ws2["B3"] = (
            "Trámites de Permiso de Investigación en el SNAP donde han transcurrido "
            "más de 3 años desde la Fecha de Término de Actividades declarada, "
            "según lo establecido en el numeral 6 del reglamento de investigación."
        )
        ws2["B3"].alignment = Alignment(wrap_text=True)
        ws2["A4"] = "Total en incumplimiento"
        ws2["B4"] = len(resultados)
        ws2["B4"].font = Font(bold=True, color="7B1C1C")
        ws2["A5"] = "Generado"
        ws2["B5"] = HOY.strftime("%Y-%m-%d %H:%M:%S")
        ws2["A6"] = "Numeral 6"
        ws2["B6"] = (
            "La no entrega, en un plazo máximo de tres años de finalizada la "
            "investigación de terreno, de los informes, separatas y material de holotipos "
            "estipulados en este instructivo inhabilitará a los/las investigadores/as "
            "involucrados/as…"
        )
        ws2["B6"].alignment = Alignment(wrap_text=True)
        for rn in range(3, 7):
            ws2[f"A{rn}"].font = Font(bold=True)
        ws2.column_dimensions["A"].width = 25
        ws2.column_dimensions["B"].width = 70
        ws2.row_dimensions[3].height = 50
        ws2.row_dimensions[6].height = 60

        output = io.BytesIO()
        wb.save(output)
        output.seek(0)
        filename = f"incumplimiento_numeral6_{HOY.strftime('%Y%m%d')}.xlsx"
        return send_file(
            output,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name=filename,
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


DOMAIN = "https://conaf.cerofilas.gob.cl"

def _candidatos_archivo(archivo, tramite_id=""):
    """Rutas posibles donde CONAF/Laravel puede servir archivos."""
    return [
        # Laravel storage link (más probable en instalación en subdirectorio)
        f"{DOMAIN}/backend/storage/{archivo}",
        f"{DOMAIN}/backend/storage/app/public/{archivo}",
        # Storage en raíz del dominio
        f"{DOMAIN}/storage/{archivo}",
        f"{DOMAIN}/storage/app/public/{archivo}",
        # Rutas de API
        f"{API_BASE}/archivos/{archivo}",
        f"{API_BASE}/uploads/{archivo}",
        f"{API_BASE}/tramites/{tramite_id}/archivos/{archivo}" if tramite_id else None,
        f"{API_BASE}/files/{archivo}",
        f"{API_BASE}/download/{archivo}",
    ]


def _descargar_url(url):
    """Intenta descargar una URL con token como query param y como Bearer header."""
    headers_bearer = {"Authorization": f"Bearer {TOKEN}"}
    for kwargs in [
        {"params": {"token": TOKEN}},
        {"headers": headers_bearer},
        {"params": {"token": TOKEN}, "headers": headers_bearer},
    ]:
        try:
            r = requests.get(url, timeout=30, **kwargs)
            if r.status_code == 200:
                ct = r.headers.get("Content-Type", "application/octet-stream")
                # Descartar respuestas HTML (página de error disfrazada de 200)
                if "text/html" not in ct:
                    return r, ct
        except Exception:
            pass
    return None, None


@app.route("/api/adjunto")
def descargar_adjunto():
    url        = request.args.get("url", "")
    archivo    = request.args.get("archivo", "")
    tramite_id = request.args.get("tramite_id", "")
    nombre     = request.args.get("nombre", "archivo")

    if not url and not archivo:
        return jsonify({"ok": False, "error": "Se requiere url o archivo"}), 400

    if url:
        if not url.startswith(DOMAIN):
            return jsonify({"ok": False, "error": "URL no permitida"}), 403
        candidatos = [url]
    else:
        candidatos = [c for c in _candidatos_archivo(archivo, tramite_id) if c]

    intentos = []
    for candidate_url in candidatos:
        resp, ct = _descargar_url(candidate_url)
        if resp is not None:
            return send_file(
                io.BytesIO(resp.content),
                mimetype=ct,
                as_attachment=True,
                download_name=nombre,
            )
        intentos.append(candidate_url)

    return jsonify({
        "ok": False,
        "error": f"No se pudo descargar '{archivo}'. URLs intentadas: {intentos}"
    }), 502


@app.route("/api/adjunto/debug")
def debug_adjunto():
    """Endpoint de diagnóstico: muestra el status de cada URL candidata."""
    archivo    = request.args.get("archivo", "")
    tramite_id = request.args.get("tramite_id", "")
    if not archivo:
        return jsonify({"ok": False, "error": "Falta archivo"}), 400

    resultados = []
    for url in [c for c in _candidatos_archivo(archivo, tramite_id) if c]:
        for kwargs, modo in [
            ({"params": {"token": TOKEN}},                                  "token_param"),
            ({"headers": {"Authorization": f"Bearer {TOKEN}"}},            "bearer_header"),
        ]:
            try:
                r = requests.get(url, timeout=10, **kwargs)
                ct = r.headers.get("Content-Type", "")
                resultados.append({"url": url, "modo": modo, "status": r.status_code, "content_type": ct})
            except Exception as e:
                resultados.append({"url": url, "modo": modo, "error": str(e)})

    return jsonify({"ok": True, "archivo": archivo, "resultados": resultados})


@app.route("/api/search/area")
def search_by_area():
    """
    Busca trámites por nombre de área protegida.
    Descarga el detalle individual de cada trámite en paralelo (datos no vienen en la lista).
    """
    q = request.args.get("q", "").strip().lower()
    if not q or len(q) < 2:
        return jsonify({"ok": False, "error": "Ingrese al menos 2 caracteres"}), 400

    # Determinar ventana temporal por año
    current_year = datetime.now().year
    year_from = int(request.args.get("year_from", current_year))
    year_to   = int(request.args.get("year_to",   current_year))
    # Clamp to reasonable range
    year_from = max(2019, min(year_from, current_year))
    year_to   = max(year_from, min(year_to, current_year))

    created_at_start = str(int(datetime(year_from, 1, 1, 0, 0, 0).timestamp()))
    created_at_end   = str(int(datetime(year_to, 12, 31, 23, 59, 59).timestamp()))

    # Obtener lista de IDs (sin datos) en el rango de años
    raw_list = fetch_all_tramites(created_at_start=created_at_start,
                                  created_at_end=created_at_end)
    if not raw_list:
        raw_list = fetch_all_tramites()

    tramite_ids = [t.get("id") for t in raw_list if t.get("id")]

    def fetch_and_check(tid):
        try:
            data = api_get(f"/tramites/{tid}")
            t = data.get("tramite", data)
            norm = normalize_tramite(t)
            # Texto completo de áreas para buscar
            areas_text = " ".join(norm.get("areas_protegidas", [])).lower()
            # También buscar en todos los valores de datos_raw que vengan de claves region_de_*
            datos = norm.get("datos_raw", {})
            for k, v in datos.items():
                if k.lower().startswith("region_de_"):
                    areas_text += " " + str(v).lower()
            if q in areas_text:
                return norm
        except Exception:
            pass
        return None

    results = []
    max_workers = min(30, len(tramite_ids))
    if max_workers > 0:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(fetch_and_check, tid): tid for tid in tramite_ids}
            for future in as_completed(futures):
                result = future.result()
                if result:
                    results.append(result)

    # Ordenar por fecha_inicio descendente
    results = [t for t in results if es_tramite_visible(t)]
    results.sort(key=lambda x: x.get("fecha_inicio") or "", reverse=True)

    return jsonify({"ok": True, "data": results, "total": len(results),
                    "searched": len(tramite_ids),
                    "year_from": year_from, "year_to": year_to})


def _email_html_body(nombre, titulo, anios, region):
    anios_fmt = str(anios).rstrip('0').rstrip('.')
    region_str = region or 'el SNAP'
    return f"""<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:680px;margin:0 auto;padding:20px">
<p>Estimado/a <strong>{nombre}</strong>,</p>
<p>Por medio de la presente, el Departamento de Gestión de Áreas Protegidas de CONAF le informa que han transcurrido más de <strong>{anios_fmt} años</strong> desde la fecha de término de actividades de terreno de su investigación:</p>
<blockquote style="border-left:4px solid #1B4F1E;padding:12px 16px;background:#f5faf5;font-style:italic;margin:16px 0">"{titulo}"</blockquote>
<p>realizada en el Sistema Nacional de Áreas Protegidas (SNAP) — <strong>{region_str}</strong>.</p>
<p>De acuerdo con el <strong>Numeral 6 del Reglamento de Investigación en Áreas Silvestres Protegidas del Estado</strong>:</p>
<blockquote style="border-left:4px solid #856404;padding:12px 16px;background:#fffbeb;margin:16px 0;font-style:italic">"La no entrega, en un plazo máximo de tres años de finalizada la investigación de terreno, de los informes, separatas y material de holotipos estipulados en este instructivo <strong>inhabilitará</strong> a los/las investigadores/as involucrados/as para participar en nuevas investigaciones en el SNAP."</blockquote>
<p>En consecuencia, le solicitamos que a la brevedad posible remita los siguientes documentos:</p>
<ol style="line-height:1.9">
  <li>Informe final de la investigación</li>
  <li>Paper(s) o publicaciones científicas derivadas de la investigación (en formato <strong>PDF</strong>)</li>
  <li>Material complementario (holotipos, colecciones biológicas, datos de campo u otro material estipulado en el instructivo)</li>
</ol>
<p>Por favor, envíe los documentos respondiendo este correo electrónico.</p>
<p>Agradecemos su colaboración y quedamos atentos/as a sus consultas.</p>
<br><hr style="border:none;border-top:1px solid #ddd;margin:20px 0">
<hr style="border:none;border-top:1px solid #ddd;margin:20px 0">
<p style="font-size:13px;color:#333;line-height:1.7;margin:0">
  <strong>Ignacio Sebastián Díaz Hormazábal</strong><br>
  <span style="color:#555">Jefe del Departamento de Gestión de Áreas Protegidas</span><br>
  <strong>CONAF – Corporación Nacional Forestal</strong>
</p>
</body></html>"""

def _email_text_body(nombre, titulo, anios, region):
    anios_fmt = str(anios).rstrip('0').rstrip('.')
    region_str = region or 'el SNAP'
    return f"""Estimado/a {nombre},\n\nPor medio de la presente, el Departamento de Gestión de Áreas Protegidas de CONAF le informa que han transcurrido más de {anios_fmt} años desde la fecha de término de actividades de terreno de su investigación:\n\n"{titulo}"\n\nrealizada en el Sistema Nacional de Áreas Protegidas (SNAP) — {region_str}.\n\nDe acuerdo con el Numeral 6 del Reglamento de Investigación en Áreas Silvestres Protegidas del Estado:\n\n"La no entrega, en un plazo máximo de tres años de finalizada la investigación de terreno, de los informes, separatas y material de holotipos estipulados en este instructivo inhabilitará a los/las investigadores/as involucrados/as para participar en nuevas investigaciones en el SNAP."\n\nEn consecuencia, le solicitamos que a la brevedad posible remita los siguientes documentos:\n\n1. Informe final de la investigación\n2. Paper(s) o publicaciones científicas derivadas de la investigación (en formato PDF)\n3. Material complementario (holotipos, colecciones biológicas, datos de campo u otro material estipulado en el instructivo)\n\nPor favor, envíe los documentos respondiendo este correo electrónico.\n\nAgradecemos su colaboración y quedamos atentos/as a sus consultas.\n\nAtentamente,\nIgnacio Sebastián Díaz Hormazábal\nJefe del Departamento de Gestión de Áreas Protegidas\nCONAF – Corporación Nacional Forestal"""

@app.route('/api/email/send', methods=['POST'])
def send_email_route():
    try:
        data = request.json or {}
        smtp = data.get('smtp', {})
        em   = data.get('email', {})
        missing = [k for k in ('smtp_server','smtp_port','smtp_user','smtp_pass','from_email') if not smtp.get(k)]
        if missing:
            return jsonify({'ok': False, 'error': f"Faltan campos SMTP: {', '.join(missing)}"}), 400
        if not em.get('to_email'):
            return jsonify({'ok': False, 'error': 'Falta email del destinatario'}), 400
        subject   = 'CONAF – Solicitud de entrega de informes y publicaciones de investigación en el SNAP'
        html_body = _email_html_body(em.get('nombre',''), em.get('titulo',''), em.get('anios',0), em.get('region',''))
        text_body = _email_text_body(em.get('nombre',''), em.get('titulo',''), em.get('anios',0), em.get('region',''))
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From']    = f"{smtp.get('from_name','CONAF')} <{smtp['from_email']}>"
        msg['To']      = f"{em.get('nombre','')} <{em['to_email']}>"
        msg.attach(MIMEText(text_body, 'plain', 'utf-8'))
        msg.attach(MIMEText(html_body, 'html',  'utf-8'))
        port = int(smtp['smtp_port'])
        host = smtp['smtp_server']
        raw  = msg.as_string()
        frm  = smtp['from_email']
        to   = em['to_email']
        # Intenta STARTTLS (587) o SSL (465) según el puerto configurado
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=30) as server:
                server.ehlo()
                server.login(smtp['smtp_user'], smtp['smtp_pass'])
                server.sendmail(frm, to, raw)
        else:
            try:
                with smtplib.SMTP(host, port, timeout=30) as server:
                    server.ehlo(); server.starttls(); server.ehlo()
                    server.login(smtp['smtp_user'], smtp['smtp_pass'])
                    server.sendmail(frm, to, raw)
            except (OSError, smtplib.SMTPConnectError):
                # Fallback a SSL en puerto 465
                with smtplib.SMTP_SSL(host, 465, timeout=30) as server:
                    server.ehlo()
                    server.login(smtp['smtp_user'], smtp['smtp_pass'])
                    server.sendmail(frm, to, raw)
        return jsonify({'ok': True})
    except smtplib.SMTPAuthenticationError:
        return jsonify({'ok': False, 'error': 'Contraseña incorrecta. Gmail requiere una Contraseña de Aplicación (no tu contraseña normal). Ve a myaccount.google.com/apppasswords'}), 401
    except smtplib.SMTPConnectError as e:
        return jsonify({'ok': False, 'error': f'No se pudo conectar al servidor SMTP (puerto bloqueado): {e}'}), 503
    except TimeoutError as e:
        return jsonify({'ok': False, 'error': f'Tiempo de espera agotado. El puerto SMTP puede estar bloqueado en tu red: {e}'}), 503
    except smtplib.SMTPException as e:
        return jsonify({'ok': False, 'error': f'Error SMTP: {e}'}), 500
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


# ── Gmail OAuth ───────────────────────────────────────────────────────────────

@app.route('/auth/gmail/status')
def gmail_auth_status():
    if not GMAIL_AVAILABLE:
        err_detail = f' ({GMAIL_IMPORT_ERROR})' if GMAIL_IMPORT_ERROR else ''
        return jsonify({'ok': False, 'error': f'Librerías de Google no disponibles{err_detail}. Ejecuta: pip install google-api-python-client google-auth-oauthlib google-auth-httplib2'})
    if not os.path.exists(GMAIL_CREDS_FILE):
        return jsonify({'ok': False, 'error': 'Falta gmail_credentials.json en la carpeta de la app'})
    creds = _gmail_creds()
    return jsonify({'ok': True, 'authenticated': creds is not None})

@app.route('/auth/gmail/start')
def gmail_auth_start():
    if not os.path.exists(GMAIL_CREDS_FILE):
        return 'Falta gmail_credentials.json', 400
    flow = Flow.from_client_secrets_file(GMAIL_CREDS_FILE, scopes=GMAIL_SCOPES,
                                         redirect_uri=GMAIL_REDIRECT)
    auth_url, state = flow.authorization_url(access_type='offline', prompt='consent')
    session['gmail_state'] = state
    return redirect(auth_url)

@app.route('/auth/gmail/callback')
def gmail_auth_callback():
    state = session.get('gmail_state', '')
    flow = Flow.from_client_secrets_file(GMAIL_CREDS_FILE, scopes=GMAIL_SCOPES,
                                         state=state, redirect_uri=GMAIL_REDIRECT)
    flow.fetch_token(authorization_response=request.url)
    creds = flow.credentials
    with open(GMAIL_TOKEN_FILE, 'w') as f:
        f.write(creds.to_json())
    return '''<html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2 style="color:#1B4F1E">✅ Gmail vinculado correctamente</h2>
        <p>Ya puedes cerrar esta pestaña y volver a la plataforma.</p>
        <script>setTimeout(()=>window.close(),3000)</script>
    </body></html>'''

@app.route('/api/email/draft', methods=['POST'])
def create_draft_route():
    if not GMAIL_AVAILABLE:
        return jsonify({'ok': False, 'error': 'Librerías de Google no instaladas'}), 500
    if not os.path.exists(GMAIL_CREDS_FILE):
        return jsonify({'ok': False, 'error': 'NO_CREDS'}), 400
    service = _gmail_service()
    if not service:
        return jsonify({'ok': False, 'error': 'NO_AUTH'}), 401
    try:
        data = request.json or {}
        em   = data.get('email', {})
        if not em.get('to_email'):
            return jsonify({'ok': False, 'error': 'Falta email del destinatario'}), 400
        subject   = 'CONAF – Solicitud de entrega de informes y publicaciones de investigación en el SNAP'
        html_body = _email_html_body(em.get('nombre',''), em.get('titulo',''), em.get('anios',0), em.get('region',''))
        text_body = _email_text_body(em.get('nombre',''), em.get('titulo',''), em.get('anios',0), em.get('region',''))
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['To']      = f"{em.get('nombre','')} <{em['to_email']}>"
        msg.attach(MIMEText(text_body, 'plain', 'utf-8'))
        msg.attach(MIMEText(html_body, 'html',  'utf-8'))
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        draft = service.users().drafts().create(
            userId='me', body={'message': {'raw': raw}}
        ).execute()
        return jsonify({'ok': True, 'draft_id': draft.get('id')})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


INVESTIGACIONES_DIR = os.path.join(os.path.dirname(__file__), 'Investigaciones')
INV_EXTENSIONS = {'.pdf', '.doc', '.docx', '.csv', '.xls', '.xlsx'}

def _inv_archivos(base_path, rel_to=None):
    """Devuelve lista de archivos filtrados por INV_EXTENSIONS bajo base_path."""
    rel_to = rel_to or INVESTIGACIONES_DIR
    result = []
    for root, dirs, files in os.walk(base_path):
        dirs.sort()
        for f in sorted(files):
            if f.startswith('.'):
                continue
            if os.path.splitext(f)[1].lower() not in INV_EXTENSIONS:
                continue
            full = os.path.join(root, f)
            rel  = os.path.relpath(full, rel_to).replace('\\', '/')
            result.append({
                'nombre':   f,
                'url':      '/investigaciones/' + rel,
                'size_kb':  round(os.path.getsize(full) / 1024, 1),
            })
    return result

def _inv_html(folder_display, archivos, back_url='/'):
    rows = ''.join(
        f'<tr><td><a href="{a["url"]}" target="_blank">{a["nombre"]}</a></td>'
        f'<td style="color:#666;text-align:right;white-space:nowrap">{a["size_kb"]} KB</td></tr>'
        for a in archivos
    )
    return f'''<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <title>{folder_display} – Archivos</title>
    <style>body{{font-family:Arial,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#222}}
    h2{{color:#1B4F1E}}table{{width:100%;border-collapse:collapse;margin-top:20px}}
    th{{background:#1B4F1E;color:#fff;padding:10px;text-align:left}}
    tr:nth-child(even){{background:#f5f5f5}}td{{padding:9px 10px;border-bottom:1px solid #ddd}}
    a{{color:#1B4F1E}}p{{color:#555;font-size:14px}}.back{{display:inline-block;margin-top:18px;color:#1B4F1E}}</style>
    </head><body>
    <h2>📁 {folder_display}</h2>
    <p>Archivos entregados en cumplimiento del Numeral 6 del Reglamento de Investigación en el SNAP.</p>
    <table><thead><tr><th>Archivo</th><th style="text-align:right">Tamaño</th></tr></thead>
    <tbody>{rows if rows else "<tr><td colspan='2' style='color:#999;text-align:center'>Sin archivos</td></tr>"}</tbody></table>
    <a class="back" href="javascript:history.back()">← Volver a la plataforma</a>
    </body></html>'''

@app.route('/investigaciones/')
@app.route('/investigaciones/<path:filepath>')
def serve_investigacion(filepath=''):
    """
    Ruta única para todo bajo /investigaciones/.
    - Si la ruta apunta a una carpeta → muestra HTML con listado de archivos.
    - Si la ruta apunta a un archivo  → descarga/muestra el archivo.
    - Raíz vacía                      → lista todas las carpetas de investigadores.
    """
    # Normalizar: quitar slash final para que os.path.isdir funcione
    clean = filepath.rstrip('/')
    full_path = os.path.join(INVESTIGACIONES_DIR, clean) if clean else INVESTIGACIONES_DIR

    # Seguridad: evitar path traversal
    if not os.path.abspath(full_path).startswith(os.path.abspath(INVESTIGACIONES_DIR)):
        return 'Acceso denegado', 403

    if os.path.isdir(full_path):
        # Mostrar listado HTML de la carpeta
        display = os.path.basename(clean).replace('_', ' ') if clean else 'Investigaciones'
        archivos = _inv_archivos(full_path)
        return _inv_html(display, archivos)

    if os.path.isfile(full_path):
        # Servir el archivo
        return send_from_directory(INVESTIGACIONES_DIR, clean)

    return f'No encontrado: {filepath}', 404

@app.route('/api/investigaciones/index')
def investigaciones_index():
    """
    Índice de carpetas de investigadores.
    Detecta automáticamente si la estructura es:
      - anidada: {Nombre}/{ID}/archivos  (subfolders con nombres numéricos)
      - plana:   {Nombre}/archivos
    """
    if not os.path.isdir(INVESTIGACIONES_DIR):
        return jsonify({'ok': True, 'data': {}})

    result = {}
    for investigador in sorted(os.listdir(INVESTIGACIONES_DIR)):
        inv_path = os.path.join(INVESTIGACIONES_DIR, investigador)
        if not os.path.isdir(inv_path):
            continue
        if investigador.startswith('_') or investigador.startswith('.'):
            continue

        # Detectar subcarpetas numéricas (estructura anidada)
        sub_dirs = [
            d for d in os.listdir(inv_path)
            if os.path.isdir(os.path.join(inv_path, d)) and d.isdigit()
        ]

        if sub_dirs:
            # Estructura anidada: {Nombre}/{ID}/archivos
            ids_data = {}
            for tid in sorted(sub_dirs, key=int):
                tid_path = os.path.join(inv_path, tid)
                ids_data[tid] = _inv_archivos(tid_path)
            result[investigador] = {'tipo': 'nested', 'ids': ids_data}
        else:
            # Estructura plana: {Nombre}/archivos directamente
            archivos = _inv_archivos(inv_path)
            result[investigador] = {'tipo': 'flat', 'archivos': archivos}

    return jsonify({'ok': True, 'data': result})


if __name__ == "__main__":
    app.run(debug=True, port=5001)
