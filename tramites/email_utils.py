import base64
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from django.conf import settings

GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.compose']

_GMAIL_IMPORT_ERROR = None
try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request as GRequest
    from google_auth_oauthlib.flow import Flow
    from googleapiclient.discovery import build as gbuild
    GMAIL_AVAILABLE = True
except Exception as _e:
    GMAIL_AVAILABLE = False
    _GMAIL_IMPORT_ERROR = str(_e)


def _gmail_dir():
    d = settings.GMAIL_AUTH_DIR
    os.makedirs(d, exist_ok=True)
    return d


def gmail_creds_file():
    return os.path.join(_gmail_dir(), 'credentials.json')


def gmail_token_file():
    return os.path.join(_gmail_dir(), 'token.json')


def get_gmail_creds():
    if not GMAIL_AVAILABLE or not os.path.exists(gmail_token_file()):
        return None
    creds = Credentials.from_authorized_user_file(gmail_token_file(), GMAIL_SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(GRequest())
        with open(gmail_token_file(), 'w') as f:
            f.write(creds.to_json())
    return creds if creds and creds.valid else None


def get_gmail_service():
    creds = get_gmail_creds()
    return gbuild('gmail', 'v1', credentials=creds) if creds else None


def email_html_body(nombre, titulo, anios, region):
    anios_fmt  = str(anios).rstrip('0').rstrip('.')
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
<p style="font-size:13px;color:#333;line-height:1.7;margin:0">
  <strong>Ignacio Sebastián Díaz Hormazábal</strong><br>
  <span style="color:#555">Jefe del Departamento de Gestión de Áreas Protegidas</span><br>
  <strong>CONAF – Corporación Nacional Forestal</strong>
</p>
</body></html>"""


def email_text_body(nombre, titulo, anios, region):
    anios_fmt  = str(anios).rstrip('0').rstrip('.')
    region_str = region or 'el SNAP'
    return (
        f'Estimado/a {nombre},\n\n'
        f'CONAF le informa que han transcurrido más de {anios_fmt} años desde la fecha de término '
        f'de actividades de su investigación:\n\n"{titulo}"\n\n'
        f'realizada en el SNAP — {region_str}.\n\n'
        f'Conforme al Numeral 6 del Reglamento de Investigación, le solicitamos remitir:\n'
        f'1. Informe final\n2. Papers/publicaciones (PDF)\n3. Material complementario\n\n'
        f'Atentamente,\nIgnacio Sebastián Díaz Hormazábal\n'
        f'Jefe del Departamento de Gestión de Áreas Protegidas\nCONAF'
    )


def build_mime(nombre, titulo, anios, region, to_email):
    subject = 'CONAF – Solicitud de entrega de informes y publicaciones de investigación en el SNAP'
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['To']      = f'{nombre} <{to_email}>'
    msg.attach(MIMEText(email_text_body(nombre, titulo, anios, region), 'plain', 'utf-8'))
    msg.attach(MIMEText(email_html_body(nombre, titulo, anios, region), 'html',  'utf-8'))
    return msg


def send_via_smtp(smtp_cfg, email_cfg):
    msg  = build_mime(email_cfg.get('nombre',''), email_cfg.get('titulo',''),
                      email_cfg.get('anios',0), email_cfg.get('region',''), email_cfg['to_email'])
    msg['From'] = f"{smtp_cfg.get('from_name','CONAF')} <{smtp_cfg['from_email']}>"
    port, host  = int(smtp_cfg['smtp_port']), smtp_cfg['smtp_server']
    raw = msg.as_string()

    def _send(server):
        server.login(smtp_cfg['smtp_user'], smtp_cfg['smtp_pass'])
        server.sendmail(smtp_cfg['from_email'], email_cfg['to_email'], raw)

    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=30) as s:
            s.ehlo(); _send(s)
    else:
        try:
            with smtplib.SMTP(host, port, timeout=30) as s:
                s.ehlo(); s.starttls(); s.ehlo(); _send(s)
        except (OSError, smtplib.SMTPConnectError):
            with smtplib.SMTP_SSL(host, 465, timeout=30) as s:
                s.ehlo(); _send(s)


def create_gmail_draft(email_cfg):
    service = get_gmail_service()
    if not service:
        return None, 'NO_AUTH'
    msg = build_mime(email_cfg.get('nombre',''), email_cfg.get('titulo',''),
                     email_cfg.get('anios',0), email_cfg.get('region',''), email_cfg['to_email'])
    raw   = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    draft = service.users().drafts().create(userId='me', body={'message': {'raw': raw}}).execute()
    return draft.get('id'), None


def start_gmail_oauth_flow(redirect_uri):
    flow = Flow.from_client_secrets_file(
        gmail_creds_file(), scopes=GMAIL_SCOPES, redirect_uri=redirect_uri
    )
    auth_url, state = flow.authorization_url(access_type='offline', prompt='consent')
    return auth_url, state


def finish_gmail_oauth_flow(state, redirect_uri, authorization_response):
    flow = Flow.from_client_secrets_file(
        gmail_creds_file(), scopes=GMAIL_SCOPES, state=state, redirect_uri=redirect_uri
    )
    flow.fetch_token(authorization_response=authorization_response)
    creds = flow.credentials
    with open(gmail_token_file(), 'w') as f:
        f.write(creds.to_json())
