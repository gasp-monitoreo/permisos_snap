/* ═══════════════════════════════════════════════
   CONAF – Sistema de Seguimiento de Trámites
   app.js – Lógica principal
   ═══════════════════════════════════════════════ */

'use strict';

// ─── Escape de HTML (prevención de XSS) ───────────────────────────────────────
// Todo dato externo (CeroFilas, Drive, nombres de archivo, etc.) que se interpole
// en HTML debe pasar por escHtml(); las URLs en href/src por safeUrl().
function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeUrl(u) {
  const s = String(u ?? '').trim();
  const ok = /^(https?:|mailto:)/i.test(s) || (s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\'));
  return escHtml(ok ? s : '#');
}

// ─── Estado global ────────────────────────────────────────────────────────────
const STATE = {
  tramites: [],
  procesos: [],
  procesoMap: {},
  searchType: 'id',
  investigaciones: {},
  duplicados: new Map(),
  complianceData: [],        // Permisos históricos (>3 años) para matching de carpetas
  portadaHistorico: [],      // TODOS los permisos de inv+film para los gráficos de Portada
  fromCache: false,
  dashFilter: 'inv',         // 'all' | 'inv' | 'film' — sigue a STATE.tipo
  tipo: 'inv',               // sección activa del menú: 'inv' | 'film'
  region: null,              // ámbito del Resumen: región (nombre en REGIONES_CHILE) o null = todo el país
  area: null,                // … y área protegida dentro de la región, o null
  mio: false,                // solo permisos cuya etapa actual está a cargo del usuario conectado
  driveNeedsAuth: false,
};
// El ámbito también viaja en la URL (?region=…&area=…&mio=1): un enlace abre la misma vista
(() => {
  const u = new URLSearchParams(location.search);
  STATE.region = u.get('region') || null;
  STATE.area = STATE.region ? (u.get('area') || null) : null;
  STATE.mio = u.get('mio') === '1';
})();

// ─── Investigaciones helpers ──────────────────────────────────────────────────
const _normInv = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();

// ─── Detección de duplicados regionales ───────────────────────────────────────
// Los permisos se otorgan por 12 meses. Si un nuevo permiso para el mismo
// proyecto se solicita con más de VENTANA_EXTENSION_DIAS de diferencia respecto
// al anterior, se considera extensión legítima, no duplicado.
const VENTANA_EXTENSION_DIAS = 240; // 8 meses — mayor gap = extensión del permiso

function _tituloTramite(t) {
  const d = t.datos_raw || {};
  return d.titulo_investigacion || d.titulo_de_la_investigacion ||
         d.titulo_proyecto || d.titulo_del_proyecto ||
         d.nombre_de_la_investigacion || d.nombre_investigacion ||
         d.nombre_del_proyecto || d.nombre_proyecto || d.titulo ||
         t.titulo_investigacion || ''; // fallback para objetos del endpoint compliance
}

function detectarDuplicadosRegionales(tramites) {
  const grupos = new Map();
  for (const t of tramites) {
    if (t.estado === 'rechazado' || t.borrador) continue;
    const email = _normInv(t.email_solicitante || '');
    if (!email) continue;
    const titulo = _normInv(_tituloTramite(t));
    const key = titulo.length >= 5
      ? `${email}§${titulo}`
      : `${email}§${grupoDeProcesoId ? grupoDeProcesoId(t.proceso_id) : t.proceso_id}`;
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(t);
  }

  const resultado = new Map();
  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;
    for (const t of grupo) {
      const fechaT = t.fecha_inicio ? new Date(t.fecha_inicio) : null;
      const cercanos = grupo.filter(o => {
        if (o.id === t.id) return false;
        const fechaO = o.fecha_inicio ? new Date(o.fecha_inicio) : null;
        if (!fechaT || !fechaO) return false;
        const diffDias = Math.abs(fechaT - fechaO) / (1000 * 60 * 60 * 24);
        return diffDias <= VENTANA_EXTENSION_DIAS;
      });
      if (cercanos.length > 0) {
        resultado.set(t.id, cercanos);
      }
    }
  }
  return resultado;
}

function getArchivosTramite(tramiteId, nombre) {
  const idStr = String(tramiteId || '');
  const hasIds = d => d.ids && typeof d.ids === 'object';
  // 1) Coincidencia exacta por ID en estructura anidada o mapeada
  if (idStr) {
    for (const [folder, data] of Object.entries(STATE.investigaciones)) {
      if ((data.tipo === 'nested' || data.tipo === 'mapped') && hasIds(data) && data.ids[idStr]) {
        return {
          folder, tipo: data.tipo, id: idStr,
          archivos: data.ids[idStr],
          url: `/investigaciones/${encodeURIComponent(folder)}/${idStr}/`,
        };
      }
    }
  }
  // 2) Token-matching por nombre (estructura plana o sin ID)
  const nNorm = _normInv(nombre || '');
  for (const [folder, data] of Object.entries(STATE.investigaciones)) {
    const tokens = _normInv(folder.replace(/_/g,' ')).split(' ').filter(Boolean);
    if (tokens.length >= 1 && tokens.every(tok => nNorm.includes(tok))) {
      // En nested/mapped: si el ID no matcheó, devolver todos los archivos
      if ((data.tipo === 'nested' || data.tipo === 'mapped') && hasIds(data)) {
        const firstId = Object.keys(data.ids)[0];
        const archivos = firstId
          ? Object.values(data.ids).flat()
          : [];
        return {
          folder, tipo: data.tipo, id: firstId || null,
          archivos,
          url: firstId
            ? `/investigaciones/${encodeURIComponent(folder)}/${firstId}/`
            : `/investigaciones/${encodeURIComponent(folder)}/`,
        };
      }
      return {
        folder, tipo: 'flat', id: null,
        archivos: data.archivos || [],
        url: `/investigaciones/${encodeURIComponent(folder)}/`,
      };
    }
  }
  return null;
}

async function loadInvestigaciones() {
  try {
    const [local, drive] = await Promise.allSettled([
      fetchJSON('/api/investigaciones/index'),
      fetchJSON('/api/investigaciones/drive/'),
    ]);
    const localData  = (local.status  === 'fulfilled' && local.value?.ok)  ? (local.value.data  || {}) : {};
    const driveData  = (drive.status  === 'fulfilled' && drive.value?.ok)  ? (drive.value.data  || {}) : {};
    STATE.driveNeedsAuth = drive.status === 'fulfilled' && drive.value?.needs_auth === true;
    STATE.investigaciones = { ...localData, ...driveData };
  } catch(e) {
    console.warn('No se pudo cargar índice de investigaciones:', e.message);
  }
}

// ─── Utilidades ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const qs = sel => document.querySelector(sel);
const qsa = sel => [...document.querySelectorAll(sel)];

function showLoading(msg = 'Cargando datos…') {
  $('loading-text').textContent = msg;
  $('loading-overlay').style.display = 'flex';
}
function hideLoading() {
  $('loading-overlay').style.display = 'none';
}

function formatDate(str) {
  if (!str) return '–';
  const d = new Date(str);
  if (isNaN(d)) return escHtml(str);
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatDateTime(str) {
  if (!str) return '–';
  const d = new Date(str);
  if (isNaN(d)) return escHtml(str);
  return d.toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function badgeHtml(estado, opts = {}) {
  const map = {
    pendiente:  'badge-pendiente',
    completado: 'badge-completado',
    rechazado:  'badge-rechazado',
  };
  const cls = map[estado] || 'badge-otro';
  const labels = { pendiente: 'Pendiente', completado: 'Completado', rechazado: 'Rechazado' };
  const badge = `<span class="badge ${cls}">${labels[estado] || escHtml(estado)}</span>`;
  if (opts.recepcionPendiente) {
    return badge + `<span class="badge-nota-recepcion" title="CONAF resolvió — falta que el solicitante cierre el trámite en Cero Filas">📬 Falta cierre del solicitante</span>`;
  }
  const t = opts.tramite;
  if (t && t.estado === 'pendiente') {
    if (t.suspendido) return badge + `<span class="badge-nota-suspension" title="Solicitud en suspensión: no corre como atraso de CONAF">⏸ En suspensión</span>`;
    if (tramiteEsperaSolicitante(t)) return badge + `<span class="badge-nota-recepcion" title="La etapa actual está en manos del solicitante: no es atraso de CONAF">✉️ Pendiente del solicitante</span>`;
  }
  return badge;
}

function progressHtml(pct) {
  return `
    <div style="display:flex;align-items:center;gap:6px">
      <div class="progress-bar-wrap" style="flex:1">
        <div class="progress-bar-fill" style="width:${escHtml(pct)}%"></div>
      </div>
      <span style="font-size:11px;font-weight:700;min-width:30px">${escHtml(pct)}%</span>
    </div>`;
}

function isVencida(fecha) {
  if (!fecha) return false;
  return new Date(fecha) < new Date();
}
function isProximaVencer(fecha, dias = 7) {
  if (!fecha) return false;
  const d = new Date(fecha);
  const now = new Date();
  const diff = (d - now) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= dias;
}

/**
 * Determina si un trámite está vencido considerando:
 * 1. La fecha_vencimiento de la etapa actual (si la tiene), O
 * 2. La fecha_limite_proceso calculada en backend (fecha_inicio + plazo por tipo)
 * No aplica a trámites completados o rechazados.
 */
const _esConaf = email => /@conaf\.(gob\.)?cl$/i.test((email || '').trim());

/** Etapa abierta en manos del solicitante (subsanar, responder, cerrar): no es atraso de CONAF. */
function tramiteEsperaSolicitante(t) {
  if (t.estado !== 'pendiente') return false;
  if (typeof t.espera_solicitante === 'boolean') return t.espera_solicitante;
  const abiertas = (t.etapas || []).filter(e => e.estado === 'pendiente');
  return (t.etapas_completadas || 0) > 0 && abiertas.length > 0 && abiertas.every(e => e.email && !_esConaf(e.email));
}

/**
 * Situación de un trámite para gráficos y conteos:
 *  completado · rechazado · cierre_solicitante (CONAF resolvió, el solicitante no ha cerrado)
 *  · espera_solicitante (etapa en manos del solicitante) · suspendido · vencido (atraso CONAF) · al_dia
 */
function situacionTramite(t) {
  if (t.ajuste?.sit) return t.ajuste.sit;          // estado ajustado por un funcionario (tramites/ajustes.py)
  if (t.estado === 'rechazado') return 'rechazado';
  if (t.estado === 'completado') return t.recepcion_pendiente ? 'cierre_solicitante' : 'completado';
  if (t.suspendido) return 'suspendido';
  if (tramiteEsperaSolicitante(t)) return 'espera_solicitante';
  return tramiteEsVencido(t) ? 'vencido' : 'al_dia';
}

function tramiteEsVencido(t) {
  if (t.ajuste) return false;
  if (t.estado === 'rechazado' || t.estado === 'completado') return false;
  if (t.suspendido || tramiteEsperaSolicitante(t)) return false;   // no es atraso de CONAF
  if (t.etapa_actual && t.etapa_actual.fecha_vencimiento &&
      isVencida(t.etapa_actual.fecha_vencimiento)) return true;
  if (t.fecha_limite_proceso && isVencida(t.fecha_limite_proceso)) return true;
  return false;
}

/**
 * Retorna la fecha de vencimiento efectiva del trámite:
 * la de su etapa actual, o si no tiene, la fecha_limite_proceso.
 */
function fechaVencimientoEfectiva(t) {
  if (t.etapa_actual && t.etapa_actual.fecha_vencimiento) return t.etapa_actual.fecha_vencimiento;
  if (t.fecha_limite_proceso) return t.fecha_limite_proceso;
  return null;
}

function dateToTimestamp(dateStr) {
  if (!dateStr) return null;
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

// nombreProceso() se define en populateProcesoSelects() junto a GRUPOS_PROCESO

// ─── Adjuntos ─────────────────────────────────────────────────────────────────
const ADJUNTO_NOMBRES = [
  { patron: /curricu|curr.c|vitae|cv_/i,            nombre: 'Currículum Vitae',                 icono: '📄' },
  { patron: /brochure|perfil.*empresa|empresa.*perfil/i, nombre: 'Perfil o Brochure',             icono: '📎' },
  { patron: /vigencia/i,                            nombre: 'Certificado de Vigencia',           icono: '🏢' },
  { patron: /escritura|estatuto/i,                  nombre: 'Escritura Pública / Estatuto',      icono: '📜' },
  { patron: /declaracion|declaraci/i,               nombre: 'Declaración',                       icono: '📝' },
  { patron: /certificado_domicilio/i,               nombre: 'Certificado de Domicilio',          icono: '🏠' },
  { patron: /doc.*proy|proy.*doc|proyecto/i,        nombre: 'Documento de Proyecto',             icono: '📋' },
  { patron: /carta.*comp|comp.*carta|compromiso/i,  nombre: 'Carta de Compromiso',               icono: '📝' },
  { patron: /carta.*pres|pres.*carta|presentacion/i,nombre: 'Carta de Presentación',             icono: '📝' },
  { patron: /autori/i,                              nombre: 'Carta de Autorización',             icono: '✅' },
  { patron: /formulario/i,                          nombre: 'Formulario',                        icono: '📋' },
  { patron: /plan.*trabajo|trabajo.*plan/i,         nombre: 'Plan de Trabajo',                   icono: '📊' },
  { patron: /informe/i,                             nombre: 'Informe',                           icono: '📊' },
  { patron: /mapa/i,                                nombre: 'Mapa',                              icono: '🗺️'  },
  { patron: /croquis|plano/i,                       nombre: 'Plano/Croquis',                     icono: '📐' },
  { patron: /resolucion/i,                          nombre: 'Resolución',                        icono: '📜' },
  { patron: /seguro/i,                              nombre: 'Seguro',                            icono: '🛡️'  },
  { patron: /cedula|copia_identi|identidad/i,       nombre: 'Documento de Identidad',            icono: '🪪' },
  { patron: /foto|imagen|image/i,                   nombre: 'Fotografía',                        icono: '🖼️'  },
];

function adjuntoNombreDesdeKey(key) {
  const kl = key.toLowerCase();
  for (const { patron, nombre, icono } of ADJUNTO_NOMBRES) {
    if (patron.test(kl)) return { nombre, icono };
  }
  // fallback: humanize the key
  const human = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { nombre: human, icono: '📎' };
}

const ADJUNTO_EXTS = /\.(pdf|docx|doc|jpg|jpeg|png|xlsx|xls|zip|rar|pptx|odt|csv)(\?.*)?$/i;

function isAdjuntoUrl(value) {
  if (typeof value !== 'string' || value.length < 4) return false;
  // URL completa
  if (value.startsWith('http')) return ADJUNTO_EXTS.test(value);
  // Solo nombre de archivo (ej: r0RZfH4WOq84JrQphv5l.pdf)
  return ADJUNTO_EXTS.test(value) && !value.includes(' ') && !value.includes('\n');
}

function adjuntoExtension(value) {
  const match = value.match(/\.([a-z0-9]{2,5})(\?|#|$)/i);
  return match ? match[1].toUpperCase() : 'FILE';
}

// Construye la URL de descarga según si el valor es un nombre de archivo o URL completa
function adjuntoDownloadUrl(value, nombre, tramiteId) {
  const ext = adjuntoExtension(value).toLowerCase();
  const nombreArchivo = encodeURIComponent(nombre + '.' + ext);
  if (value.startsWith('http')) {
    return `/api/adjunto?url=${encodeURIComponent(value)}&nombre=${nombreArchivo}`;
  }
  // Es solo nombre de archivo — el backend construirá la URL
  return `/api/adjunto?archivo=${encodeURIComponent(value)}&tramite_id=${tramiteId}&nombre=${nombreArchivo}`;
}

// Detect tipo using canonical process group (defined after GRUPOS_PROCESO)
function tipoTramite(t) {
  const grupo = grupoDeProcesoId(t.proceso_id);
  if (grupo === 'filmacion')    return 'Filmación';
  if (grupo === 'investigacion') return 'Investigación';
  // Fallback por nombre de proceso
  const nombre = (STATE.procesoMap[t.proceso_id] || '').toLowerCase();
  if (nombre.includes('filmac') || nombre.includes('film')) return 'Filmación';
  if (nombre.includes('invest'))                             return 'Investigación';
  return 'Trámite';
}

function tipoBadgeHtml(t) {
  const tipo = tipoTramite(t);
  if (tipo === 'Filmación')    return `<span class="badge badge-filmacion">🎬 Filmación</span>`;
  if (tipo === 'Investigación') return `<span class="badge badge-investigacion">🔬 Investigación</span>`;
  return `<span class="badge badge-otro">${tipo}</span>`;
}

// ─── MINI MAPA DE 16 REGIONES ────────────────────────────────────────────────
// Orden geográfico N→S en grilla 4×4
const REGIONES_CHILE = [
  { codigo: 'XV',   nombre: 'Arica y Parinacota' },
  { codigo: 'I',    nombre: 'Tarapacá' },
  { codigo: 'II',   nombre: 'Antofagasta' },
  { codigo: 'III',  nombre: 'Atacama' },
  { codigo: 'IV',   nombre: 'Coquimbo' },
  { codigo: 'V',    nombre: 'Valparaíso' },
  { codigo: 'RM',   nombre: 'Metropolitana' },
  { codigo: 'VI',   nombre: "O'Higgins" },
  { codigo: 'VII',  nombre: 'Maule' },
  { codigo: 'XVI',  nombre: 'Ñuble' },
  { codigo: 'VIII', nombre: 'Biobío' },
  { codigo: 'IX',   nombre: 'Araucanía' },
  { codigo: 'XIV',  nombre: 'Los Ríos' },
  { codigo: 'X',    nombre: 'Los Lagos' },
  { codigo: 'XI',   nombre: 'Aysén' },
  { codigo: 'XII',  nombre: 'Magallanes' },
];

function regionMiniMapHtml(t) {
  const regiones = new Set(
    (t.regiones_list || []).map(r =>
      r.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
    )
  );

  const estado = t.estado || '';
  // Verde = completado, Rojo = pendiente/rechazado
  const colorActiva  = estado === 'completado' ? '#28A745' : '#DC3545';
  const textActiva   = '#fff';
  const colorInactiva = '#E9ECEF';
  const textInactiva  = '#bbb';

  const celdas = REGIONES_CHILE.map(reg => {
    const key = reg.nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const activa = regiones.has(key);
    const bg    = activa ? colorActiva  : colorInactiva;
    const color = activa ? textActiva   : textInactiva;
    const tip   = reg.nombre + (activa ? (estado === 'completado' ? ' ✓ Completado' : ' ● Pendiente') : '');
    return `<div class="region-cell${activa ? ' activa' : ''}" style="background:${bg};color:${color}" title="${tip}">${reg.codigo}</div>`;
  }).join('');

  const hayRegiones = regiones.size > 0;
  if (!hayRegiones) {
    return `<div style="color:#bbb;font-size:11px;font-style:italic">–</div>`;
  }
  return `<div class="region-minimap">${celdas}</div>`;
}

// ─── HUMANIZADORES DE REGIONES Y ÁREAS ────────────────────────────────────────
const _IGNORAR_VAL = /^(si|sí|no|yes|true|false|1|0|s[ií])$/i;

function humanizarRegion(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') {
    const s = Array.isArray(raw) ? raw.join(',') : (raw.nombre || raw.name || raw.value || null);
    return s ? humanizarRegion(s) : null;
  }
  const sv = String(raw).trim();
  if (!sv || _IGNORAR_VAL.test(sv)) return null;
  if (sv.startsWith('{')) return null;  // JSON de objeto (ej: selector de ciudad/comuna)

  // Parsear lista Python ['XIV','X'] o JSON
  let items = [sv];
  if (sv.startsWith('[')) {
    try {
      const parsed = JSON.parse(sv.replace(/'/g, '"'));
      if (Array.isArray(parsed)) items = parsed.map(String).map(s => s.trim());
    } catch {
      items = sv.replace(/^\[|\]$/g, '').split(/,\s*/).map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    }
  } else if (sv.includes(',')) {
    items = sv.split(',').map(s => s.trim());
  }

  // Si el valor parece un nombre de área protegida, no es una región
  if (/parque|reserva|monumento|santuario|bernardo/i.test(sv)) return null;

  // Alias para grafías no estándar usadas en campos de CeroFilas
  const _REGION_ALIAS = { 'aisen': 'XI', 'aysen': 'XI' };

  const norms = items
    .filter(p => p && !_IGNORAR_VAL.test(p))
    .map(p => {
      // Código romano exacto
      const hit = REGIONES_CHILE.find(r => r.codigo === p.toUpperCase());
      if (hit) return hit.nombre;
      // Slug normalizado
      const pn = p.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[_\-\s']/g, '');
      // Alias explícitos (ej: aisen → Aysén)
      for (const [alias, cod] of Object.entries(_REGION_ALIAS)) {
        if (pn.startsWith(alias)) {
          const r = REGIONES_CHILE.find(r => r.codigo === cod);
          if (r) return r.nombre;
        }
      }
      // Slug o nombre parcial (lógica original preservada)
      const hit2 = REGIONES_CHILE.find(r => {
        const rn = r.nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s']/g, '');
        return rn === pn || rn.includes(pn) || pn.includes(rn.split(' ')[0]);
      });
      if (hit2) return hit2.nombre;
      return null;
    })
    .filter(Boolean);

  return norms.length ? norms.join(', ') : null;
}

function humanizarSlug(s) {
  const MIN = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en', 'a', 'al', 'o', 'u']);
  return s.trim()
    .replace(/__+/g, ' ')
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const wl = w.toLowerCase();
      return (i > 0 && MIN.has(wl)) ? wl : wl.charAt(0).toUpperCase() + wl.slice(1);
    })
    .join(' ');
}

function humanizarArea(raw) {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.flatMap(humanizarArea).filter(Boolean);
  if (typeof raw === 'object') {
    const n = raw.nombre || raw.name || raw.descripcion || null;
    return n ? humanizarArea(n) : [];
  }
  const sv = String(raw).trim();
  if (!sv || sv === '[]' || _IGNORAR_VAL.test(sv)) return [];

  // Parsear lista Python/JSON
  let slugs = [sv];
  if (sv.startsWith('[')) {
    try {
      const parsed = JSON.parse(sv.replace(/'/g, '"'));
      if (Array.isArray(parsed)) slugs = parsed.map(String);
    } catch {
      slugs = sv.replace(/^\[|\]$/g, '').split(/,\s*/).map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    }
  } else if (sv.includes(',')) {
    slugs = sv.split(',');
  }

  return slugs
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(s => s && !_IGNORAR_VAL.test(s))
    .map(humanizarSlug)
    .filter(Boolean);
}

// ─── API calls ────────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const body = await r.json(); if (body.error) msg = body.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function loadProcesos() {
  const data = await fetchJSON('/api/procesos');
  if (!data.ok) throw new Error(data.error);
  STATE.procesos = data.data || [];
  STATE.procesoMap = {};
  STATE.procesos.forEach(p => {
    const proc = p.proceso || p;
    STATE.procesoMap[proc.id] = proc.nombre;
  });
  if (data.from_cache) STATE.fromCache = true;
  return STATE.procesos;
}

async function loadTramites(params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v); });
  const data = await fetchJSON(`/api/tramites?${qs}`);
  if (!data.ok) throw new Error(data.error);
  if (data.from_cache) STATE.fromCache = true;
  STATE.actualizadoEn = data.actualizado_en || null;
  return data.data || [];
}

function showCacheBanner(source) {
  let banner = document.getElementById('cache-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'cache-banner';
    banner.style.cssText = [
      'position:fixed', 'bottom:16px', 'left:50%', 'transform:translateX(-50%)',
      'background:#92400e', 'color:#fef3c7', 'padding:10px 20px', 'border-radius:8px',
      'font-size:13px', 'font-weight:600', 'z-index:9999',
      'box-shadow:0 4px 12px rgba(0,0,0,.3)', 'display:flex', 'align-items:center', 'gap:10px',
    ].join(';');
    document.body.appendChild(banner);
  }
  const label = source === 'portada_historico' ? 'datos históricos parciales' : 'caché guardado';
  banner.innerHTML = `⚠️ Sin conexión a CeroFilas — mostrando ${label} <button onclick="this.parentElement.remove()" style="background:none;border:none;color:inherit;cursor:pointer;font-size:16px;line-height:1">✕</button>`;
}

async function loadTramite(id) {
  const data = await fetchJSON(`/api/tramites/${id}`);
  if (!data.ok) throw new Error(data.error);
  return data.data;
}

// ─── Rango de años ────────────────────────────────────────────────────────────
const ANIO_MIN = 2013;
const ANIO_MAX = new Date().getFullYear();

function populateAnioSelects() {
  const opts = [];
  for (let y = ANIO_MAX; y >= ANIO_MIN; y--) {
    opts.push(`<option value="${y}">${y}</option>`);
  }
  const html = opts.join('');
  $('rango-desde').innerHTML = html;
  $('rango-hasta').innerHTML = html;
  $('rango-desde').value = ANIO_MAX;
  $('rango-hasta').value = ANIO_MAX;
}

function paramsRango() {
  const desde = parseInt($('rango-desde').value);
  const hasta  = parseInt($('rango-hasta').value);
  return {
    created_at_start: Math.floor(new Date(desde, 0, 1, 0, 0, 0).getTime() / 1000),
    created_at_end:   Math.floor(new Date(hasta, 11, 31, 23, 59, 59).getTime() / 1000),
  };
}

function filtrarRango(lista) {
  const desde = parseInt($('rango-desde').value);
  const hasta  = parseInt($('rango-hasta').value);
  return lista.filter(t => {
    if (!t.fecha_inicio) return false;
    const y = new Date(t.fecha_inicio).getFullYear();
    return y >= desde && y <= hasta;
  });
}

// ─── Inicialización ───────────────────────────────────────────────────────────

async function init() {
  STATE.fromCache = false;
  showLoading('Cargando procesos…');
  try {
    // Procesos: no fatal — si falla, los selectores quedan vacíos pero continúa
    try {
      await loadProcesos();
    } catch (e) {
      console.warn('No se pudo cargar la lista de procesos:', e.message);
    }
    populateProcesoSelects();
    populateAnioSelects();
    await loadInvestigaciones();

    const { desde, hasta } = rangoActual();
    showLoading(`Descargando trámites (${desde}–${hasta})…`);
    let cargado = false;
    let cacheSource = null;
    let circuitOpen = false;
    try {
      const qs = new URLSearchParams();
      Object.entries(paramsRango()).forEach(([k, v]) => { if (v) qs.set(k, v); });
      const resp = await fetchJSON(`/api/tramites?${qs}`);
      if (!resp.ok) throw new Error(resp.error);
      if (resp.from_cache) { STATE.fromCache = true; cacheSource = resp.cache_source; }
      if (resp.circuit_open) circuitOpen = true;
      STATE.actualizadoEn = resp.actualizado_en || null;
      STATE.rangoCargado = `${desde}-${hasta}`;
      STATE.tramites = filtrarRango(resp.data || []);
      cargado = true;
    } catch {
      // Reintento sin filtro de rango
      try {
        showLoading('Reintentando sin filtro de fechas…');
        const resp2 = await fetchJSON('/api/tramites');
        if (!resp2.ok) throw new Error(resp2.error);
        if (resp2.from_cache) { STATE.fromCache = true; cacheSource = resp2.cache_source; }
        if (resp2.circuit_open) circuitOpen = true;
        STATE.tramites = filtrarRango(resp2.data || []);
        cargado = true;
      } catch (e2) {
        console.error('No se pudieron cargar los trámites:', e2.message);
      }
    }

    if (!cargado) {
      hideLoading();
      $('loading-text').textContent = '';
      $('loading-overlay').style.display = 'none';
      alert('No se pudo conectar con el servidor de CeroFilas (error 502/red). Intente actualizar en unos minutos.');
      return;
    }

    STATE.duplicados = detectarDuplicadosRegionales(STATE.tramites);
    updateLastUpdate();
    renderDashboard();
    renderPortada();

    // Mostrar banner solo si la API está caída o si servimos datos parciales (portada_historico)
    if (circuitOpen || cacheSource === 'portada_historico') showCacheBanner(cacheSource);
  } catch (err) {
    alert('Error inesperado al cargar datos: ' + err.message);
  } finally {
    hideLoading();
  }
}

function rangoActual() {
  return { desde: $('rango-desde').value, hasta: $('rango-hasta').value };
}

function updateLastUpdate() {
  // Hora real de los datos (pueden venir de la caché del servidor)
  const d = STATE.actualizadoEn ? new Date(STATE.actualizadoEn) : new Date();
  const hoy = d.toDateString() === new Date().toDateString();
  $('last-update').textContent = 'Actualizado: ' + (hoy
    ? d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('es-CL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
}

// Agrupación canónica de procesos — cubre todos los IDs históricos
const GRUPOS_PROCESO = {
  filmacion: {
    label: 'Solicitud de Filmación y Fotografía en el SNAP',
    ids: new Set([437, 585, 631, 632, 672]),
  },
  investigacion: {
    label: 'Permiso de Investigación en el SNAP',
    ids: new Set([517, 692, 1992]),
  },
};

function grupoDeProcesoId(procesoId) {
  const id = Number(procesoId);
  for (const [key, g] of Object.entries(GRUPOS_PROCESO)) {
    if (g.ids.has(id)) return key;
  }
  return null;
}

function nombreProceso(procesoId) {
  const grupo = grupoDeProcesoId(procesoId);
  if (grupo) return GRUPOS_PROCESO[grupo].label;
  return STATE.procesoMap[procesoId] || `Proceso ${procesoId}`;
}

function populateProcesoSelects() {
  const opts = Object.entries(GRUPOS_PROCESO)
    .map(([key, g]) => `<option value="${key}">${g.label}</option>`)
    .join('');
  const html = '<option value="">Todos</option>' + opts;
  if ($('export-proceso')) $('export-proceso').innerHTML = html;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function _statsFor(ts) {
  const total      = ts.length;
  const pendientes = ts.filter(t => t.estado === 'pendiente').length;
  const completados= ts.filter(t => t.estado === 'completado').length;
  const rechazados = ts.filter(t => t.estado === 'rechazado').length;
  const dias       = ts.filter(_resueltaConaf).map(calcularDias).filter(d => d !== null);   // resumen.js
  const mediana    = dias.length ? _mediana(dias) : '–';
  return { total, pendientes, completados, rechazados, mediana };
}

function _setSplit(id, inv, film) {
  const el = $(id);
  if (!el) return;
  if (STATE.dashFilter !== 'all') { el.innerHTML = ''; return; }
  el.innerHTML =
    `<span class="kpi-split-inv">🔬 ${inv}</span>` +
    `<span class="kpi-split-sep">·</span>` +
    `<span class="kpi-split-film">🎬 ${film}</span>`;
}

function renderDashboard() {
  const all  = filtrarPorRegion(STATE.tramites);
  const invs = all.filter(t => IDS_INVESTIGACION.has(t.proceso_id));
  const films= all.filter(t => IDS_FILMACION.has(t.proceso_id));

  const f    = STATE.dashFilter;
  const ts   = f === 'inv' ? invs : f === 'film' ? films : all;
  const s    = _statsFor(ts);
  const si   = _statsFor(invs);
  const sf   = _statsFor(films);

  $('kpi-total').textContent      = s.total;
  $('kpi-completado').textContent = s.completados;
  $('kpi-rechazado').textContent  = s.rechazados;
  $('kpi-mediana').textContent    = s.mediana;

  _setSplit('kpi-total-split',      si.total,      sf.total);
  _setSplit('kpi-completado-split', si.completados, sf.completados);
  _setSplit('kpi-rechazado-split',  si.rechazados,  sf.rechazados);
  _setSplit('kpi-mediana-split',    si.mediana,     sf.mediana);
  $('desempeno-res').textContent =
    `${s.total} ingresadas · ${s.completados} aprobadas · ${s.rechazados} rechazadas · mediana ${s.mediana} d`;

  // Orden: ámbito → requiere atención → territorio → desempeño (gráficos + tabla de permisos).
  // Todo usa el mismo ámbito (región, área protegida y «a mi cargo»).
  renderAmbito();
  renderAtencion(ts, STATE.region);   // static/js/atencion.js
  renderTerritorio(STATE.region || (window.PERFIL?.solo_su_region ? PERFIL.region : null), STATE.tipo, STATE.area);   // static/js/territorio.js
  // La matriz de regiones (escala país) usa todas las regiones del tipo
  renderResumenVisual(ts, f, tramitesDelTipo({ todasLasRegiones: true }), STATE.region);   // static/js/resumen.js
}

const IDS_INVESTIGACION = new Set([517, 692, 1992]);
const IDS_FILMACION     = new Set([437, 585, 631, 632, 672]);

// ─── Tipo activo (Investigación / Filmación y Fotografía) ─────────────────────
const GRUPO_DE_TIPO = { inv: 'investigacion', film: 'filmacion' };

// ─── Ámbito del Resumen: región → área protegida (+ «a mi cargo») ──────────────
// Un trámite multirregional cuenta en cada región; el área se compara sin tildes y de forma
// tolerante (el formulario y los límites oficiales escriben los nombres distinto).
const areaCoincide = (x, a) => { const n = _normInv(x), m = _normInv(a); return !!n && !!m && (n.includes(m) || m.includes(n)); };
// Áreas del permiso en una región: las que el formulario declara para esa región (un permiso
// multirregional no debe aportar áreas de otras regiones). Sin región: todas.
function areasEnRegion(t, region) {
  if (!region) return t.areas_protegidas || [];
  // Con desglose por región (backend lo construye de region_de_<x> o region_N/area_N): usar esos
  const porRegion = t.areas_region?.[region];
  if (porRegion?.length) return porRegion;
  // Si hay desglose para OTRAS regiones, no mezclar (este permiso no declaró áreas para esta región)
  const tieneOtras = t.areas_region
    && Object.values(t.areas_region).some(arr => arr.length > 0);
  if (tieneOtras) return [];
  // Sin ningún desglose: mostrar todas las áreas del permiso en esta región
  if ((t.regiones_list || []).includes(region)) return t.areas_protegidas || [];
  return [];
}

function filtrarPorAmbito(lista, { sinRegion = false, sinArea = false } = {}) {
  let r = lista;
  if (STATE.region && !sinRegion) r = r.filter(t => (t.regiones_list || []).includes(STATE.region));
  if (STATE.area && !sinArea && !sinRegion) r = r.filter(t => areasEnRegion(t, STATE.region).some(x => areaCoincide(x, STATE.area)));
  if (STATE.mio) {
    const yo = (window.PERFIL?.email || '').toLowerCase();
    r = r.filter(t => yo && (t.etapa_actual?.email || '').toLowerCase() === yo);
  }
  return r;
}
const filtrarPorRegion = lista => filtrarPorAmbito(lista);

function tramitesDelTipo({ todasLasRegiones = false, sinArea = false } = {}) {
  const ids = STATE.tipo === 'film' ? IDS_FILMACION : IDS_INVESTIGACION;
  const delTipo = STATE.tramites.filter(t => ids.has(t.proceso_id));
  return filtrarPorAmbito(delTipo, { sinRegion: todasLasRegiones, sinArea });
}

function _guardarAmbitoUrl() {
  const u = new URL(location.href);
  [['region', STATE.region], ['area', STATE.area], ['mio', STATE.mio ? '1' : null]].forEach(([k, v]) => {
    if (v) u.searchParams.set(k, v); else u.searchParams.delete(k);
  });
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}

function setAmbito(region, area = null) {
  if (window.PERFIL?.solo_su_region && !window.PERFIL?.superusuario) region = PERFIL.region;   // su región es fija
  STATE.region = region || null;
  STATE.area = STATE.region ? (area || null) : null;
  _guardarAmbitoUrl();
  if (STATE.tramites.length) renderDashboard();
}
// clic en la región o el área activa = quitarla
function setRegion(region) { setAmbito(region === STATE.region ? null : region); }
function setArea(area) { setAmbito(STATE.region, area && area === STATE.area ? null : area); }

function renderAmbito() {
  const el = $('filtro-regiones');
  if (!el) return;
  const fija = window.PERFIL?.solo_su_region && !window.PERFIL?.superusuario;
  const base = tramitesDelTipo({ todasLasRegiones: true });
  const nReg = nombre => base.filter(t => (t.regiones_list || []).includes(nombre)).length;
  const enRegion = STATE.region ? base.filter(t => (t.regiones_list || []).includes(STATE.region)) : [];
  const areas = new Map();
  enRegion.forEach(t => areasEnRegion(t, STATE.region).forEach(a => areas.set(a, (areas.get(a) || 0) + 1)));
  const listaAreas = [...areas.entries()].sort((a, b) => b[1] - a[1]);
  if (STATE.area && !listaAreas.some(([a]) => areaCoincide(a, STATE.area))) listaAreas.unshift([STATE.area, 0]);
  const sel = a => STATE.area && areaCoincide(a, STATE.area) && (a === STATE.area || !listaAreas.some(([x]) => x === STATE.area));
  const total = tramitesDelTipo().length;
  const yo = (window.PERFIL?.email || '').toLowerCase();
  const nMio = yo ? STATE.tramites.filter(t => (STATE.tipo === 'film' ? IDS_FILMACION : IDS_INVESTIGACION).has(t.proceso_id)
    && (t.etapa_actual?.email || '').toLowerCase() === yo).length : 0;
  el.innerHTML = `<div class="amb">
    <label class="amb-campo"><span>Región</span>
      <select id="amb-region" ${fija ? 'disabled' : ''}>
        ${fija ? '' : `<option value="">Todo el país (${base.length})</option>`}
        ${REGIONES_CHILE.map(r => `<option value="${escHtml(r.nombre)}" ${STATE.region === r.nombre ? 'selected' : ''}>${escHtml(r.codigo)} · ${escHtml(r.nombre)} (${nReg(r.nombre)})</option>`).join('')}
      </select></label>
    <label class="amb-campo"><span>Área protegida</span>
      <select id="amb-area" ${STATE.region ? '' : 'disabled'} title="${STATE.region ? '' : 'Elija primero una región'}">
        <option value="">${STATE.region ? `Todas las de la región (${enRegion.length})` : 'Elija primero una región'}</option>
        ${listaAreas.map(([a, n]) => `<option value="${escHtml(a)}" ${sel(a) ? 'selected' : ''}>${escHtml(a)}${n ? ` (${n})` : ''}</option>`).join('')}
      </select></label>
    ${yo ? `<label class="amb-mio" title="Permisos cuya etapa actual está asignada a ${escHtml(yo)}">
      <input type="checkbox" id="amb-mio" ${STATE.mio ? 'checked' : ''}> A mi cargo <b>${nMio}</b></label>` : ''}
    <span class="amb-total"><b>${total.toLocaleString('es-CL')}</b> permisos en este ámbito</span>
    ${(STATE.region && !fija) || STATE.area || STATE.mio ? '<button class="amb-limpiar" id="amb-limpiar">Ver todo</button>' : ''}
  </div>`;
}

function setTipo(tipo) {
  if (tipo === STATE.tipo) return;
  STATE.tipo = tipo;
  STATE.dashFilter = tipo;
  if (STATE.tramites.length) {
    renderDashboard();
  }
}

// ─── Taxonomía temática ───────────────────────────────────────────────────────
// Orden importa: el primer match gana. Lo más específico va antes de lo general.
// Las palabras clave se comparan sobre texto normalizado (minúsculas, sin tildes,
// rodeado de espacios) e incluyen términos en inglés: muchos títulos son de papers.
const TEMAS_INV = [
  // ── Proyectos e Infraestructura (líneas base de obras, minería, energía) ─────
  { tema: 'Proyectos e Infraestructura',
    kw: ['data center','campus','plan de reparacion','loteo','urbaniz','edificac','proyecto minero','minero ','mineros ','mineria','minera ','mining','mina ','exploracion minera',
         'sondaje','perforacion','drilling','pozo ','pozos ','carretera','camino basico','vialidad',
         'ruta 5','ruta c','ruta k','ruta a','ruta b','ruta d','ruta x','ruta y','ruta s','ruta t','ruta r','ruta v',
         'linea de transmision','tendido electrico','subestacion','central hidroelectrica',
         'hidroelectric','parque eolico','fotovoltaic','concesion','estudio de ingenieria','ingenieria ',
         'infraestructura','infrastructure','telecomunicac','antena','fibra optica','puente ',
         'estudio de impacto','declaracion de impacto','pas 160','andina minerals','gold ','lobo marte',
         'agua potable rural','inmobiliar','oleoducto','gasoducto','acueducto','muelle','borateras'] },

  // ── Aves (antes de Fauna Terrestre para no perder en el grupo general) ──────
  { tema: 'Aves',
    kw: ['ornitolog','avifauna','passeriforme','pelecaniforme','spheniscidae','sphenisc',
         'pinguin','condor','flamenco','albatros','petrel','gaviotin','cauquen',
         'quetru','rapaz','rapaces','halcon','aguila','buho','lechuza',
         'nidificac','canto de ave','migracion de ave','ruta migratoria',
         ' ave ',' aves ','parulidae','accipitridae','laridae','anatidae',
         'pato ','patos ','garza','becada','becacina','churrete','tapaculo',
         'picaflor','loro tricahue','cometocino','churrin','diuca',
         ' bird','songbird','seabird','shorebird','avian','penguin','raptor',' owl','hummingbird',
         'plover','chorlo','nest ','nesting','waterbird','pelican','cormoran','cormorant','rhea','nandu','huemul '] },

  // ── Mamíferos Marinos (antes de Ciencias del Mar) ──────────────────────────
  { tema: 'Mamíferos Marinos',
    kw: ['cetaceo','delfin','ballena','orca','lobo marino','lobo de mar',
         'foca ','focas','otaria','pinnipedo','elefante marino','nutria de mar',
         'chungungo','lontra felina','mamifero marino','mamiferos marinos',
         'whale','dolphin','sea lion','fur seal',' seal ','marine mammal','cetacean'] },

  // ── Mamíferos Terrestres ──────────────────────────────────────────────────
  { tema: 'Mamíferos Terrestres',
    kw: ['mamifero','mammal','puma','guanaco','vicuna','huemul','pudu','zorro',' fox','culpeo','chilla',
         'roedor','rodent','degu','octodon','abrocoma','chinchilla','vizcacha','tuco tuco','ctenomys',
         'murcielago','quiroptero',' bat ',' bats ','myotis','tadarida','histiotus','lasiurus',
         'marsupial','monito del monte','dromiciops','felino','felid','gato andino','guina','kodkod',
         'quique','huillin','vison','mink','castor','beaver','jabali','wild boar','ciervo','deer',
         'camelido','camelid','carnivoro','carnivore','radiocollar','radio collar','camara trampa',
         'camera trap','fototrampeo','micromamifero','small mammal','liebre','conejo','rabbit','hare'] },

  // ── Herpetología (antes de Fauna Terrestre) ────────────────────────────────
  { tema: 'Herpetología',
    kw: ['herpeto','reptil ','reptiles','lagartija','lagarto','culebra',
         'serpiente','anfibio','rana ','ranas ','sapo ','sapos ','salamandra',
         'pleurodema','rhinella','liolaemus','callopistes','tachymenis',
         'philodryas','alsodes','batrachyla','telmatobius','pristidactylus','phymaturus',
         'reptile','lizard',' frog','toad','amphibian','snake','gecko'] },

  // ── Ictiología / Peces ─────────────────────────────────────────────────────
  { tema: 'Ictiología / Peces',
    kw: ['ictio','pez ','peces ','trucha','salmon','salmones','pejerrey',
         'lamprea','bacalao','merluza','corvina','puye','galaxia','galaxiid',
         'percilia','trichomycterus','cheirodon','odontesthes','piscicola',
         ' fish','trout','salmonid','ichthy'] },

  // ── Salud / Zoonosis (antes de Entomología: vectores, parásitos) ──────────
  { tema: 'Salud / Zoonosis',
    kw: ['zoonos','zoonot','patogen','pathogen','enfermedad','disease','epidemiolog',
         'infeccion','infection','hantavirus','rabia','influenza aviar','avian influenza','sarna',
         'antimicrob','antibiotic','toxoplasm','tripanosom','trypanosom','chagas','vinchuca','triatom',
         'one health','una salud','salud publica','public health','health risk','riesgo sanitario',
         'parasito','parasite','parasit ','helminto','helminth','ectoparasit','garrapata','tick borne',
         'virus ','viral ','viroma','virome','sanitari'] },

  // ── Entomología / Invertebrados ────────────────────────────────────────────
  { tema: 'Entomología / Invertebrados',
    kw: ['entomolog','insecto','coleoptero','lepidoptero','diptera','himenoptero',
         'polilla','mariposa','escarabajo','abeja','avispa','hormiga','mosca',
         'mosquito','libelula','gorgojo','curculionidae','carabidae',
         'aracnido','arana','escorpion','artropodo','crustaceo',
         'invertebrado','molusco','gasteropodo','bivalvo','cefalopodo',
         'equinodermo','erizo','estrella de mar','pepino de mar','anelido',
         'lombriz','oligoqueto','nematodo','tenebrionid','gyriosomus','opilion',
         'insect','beetle',' bee ',' bees ','wasp',' ant ',' ants ','moth','butterfl','spider',
         'arachnid','invertebrate','arthropod','mollus','snail','scorpion','pollinat','polinizador',
         'polinizacion','hymenoptera','coleoptera','lepidoptera','crustacea','isopod','copepod',
         'amphipod','caddisfl','trichoptera','plecoptera','ephemeroptera','acaro','mite '] },

  // ── Microbiología ──────────────────────────────────────────────────────────
  { tema: 'Microbiología',
    kw: ['saccharomyces','levadura','yeast','sideroforo','siderophore','halophil','halofil','bioproduct','bioprospecc','bioprospect','microb','bacteria','bacteri','arquea','archaea','microorganism','microbiom',
         'cianobacteria','cyanobacteria','extremofil','extremophil','biofilm','tapete microbiano',
         'microbial mat','estromatolit','stromatolit','metagenom','biotecnolog','biotechnolog',
         'endofit','endophyt','rizobacteria','rhizobacteri','geomicrobiolog','marte',' mars '] },

  // ── Micología / Líquenes / Briófitas ──────────────────────────────────────
  { tema: 'Micología / Líquenes',
    kw: ['funga ','hongo','hongos','micolog','micelio','espora','basidiomiceto',
         'ascomiceto','macromiceto','ectomicorriza','micorriza','trufa',
         'boletus','amanita','cortinarius','suillus','fungo',
         'liquen','liquenes','liquenolog','cladonia','usnea','peltigera',
         'briofit','briolog','hepatica','antocerota','musgo ','musgos ',
         'esporofito','sphagnum','fungi','fungal','fungus','lichen','mycorrhiz','mushroom',
         'bryophyt',' moss','holobiont','verrucaria','lecanora','sticta','rinodina','acarospora'] },

  // ── Botánica / Flora ───────────────────────────────────────────────────────
  { tema: 'Botánica / Flora',
    kw: ['metabolit','fitoquim','phytochem','alcaloide','alkaloid','polifenol','polyphenol','bioactiv','germoplasma','germplasm','aceae ','helecho',' fern','desierto florido','rhodophiala','geofita','bulbo','botanic','florist','fitosociolog','dendrolog','fitoplancton','fitobentos',
         'flora ','planta ','plantas ','vegeta','arbol','arboles','arbusto',
         'matorral','hierba','herbaceo','pasto ','pastos ','bosque',
         'alerce','cipres','coigue','lenga','nirre','notofagus','nothofagus','pino ',
         'eucalipto','graminea','gramineas','bromelia','tillandsia',
         'cactacea','suculenta','xerofit','turbera','pompon',
         'fitomasa','cobertura vegetal','pradera','estepario','alga ',
         'algas ','kelp','macroalga','semilla','plantula','germinac','orquidea','araucaria',
         'polylepis','quenoa','tamarugo','prosopis','algarrobo','copiapoa','eriosyce','chloraea',
         'bomarea','ugni','quintral','fotosint','herbario','dendrocronolog','anillos de crecimiento',
         ' plant',' tree ',' trees ','forest','shrub',' seed','seedling','orchid','flower','pollen',
         ' leaf',' leaves','wood ','mistletoe','photosynth','vegetation','canopy','tree ring','herbarium',
         'sclerophyll','esclerofil','woody','botany','grassland','peatland'] },

  // ── Ecología ───────────────────────────────────────────────────────────────
  { tema: 'Ecología',
    kw: ['ecolog','ecosistema','biodiversidad','abundancia','densidad poblac',
         'dinamica poblac','comunidad biol','estructura de comunidad',
         'cadena trofica','red trofica','nicho','habitat','interacciones',
         'depredacion','competencia','mutualismo','parasitismo','simbiosis',
         'trofico','productividad primaria','biomasa','riqueza de especi',
         'diversidad alfa','diversidad beta','indice de diversidad',
         'ecology','ecosystem','biodiversity','species distribution','distribucion de especies',
         'invasive','invasora','introduced species','especie introducida','resilien','disturbance',
         'perturbac','wildfire','incendio','facilitation','facilitacion','succession','sucesion',
         'niche','gradient','gradiente','tolerance','tolerancia','functional trait','rasgos funcional',
         'food web','trophic','predator','depredador','population','poblacion','assemblage','ensamble'] },

  // ── Genética / Genómica ────────────────────────────────────────────────────
  { tema: 'Genética / Genómica',
    kw: ['genetic','genoma','genomic','filogeni','filogeograf','molecular',
         'adn ','dna ','microsatelit','haplotip','secuencia','genotip',
         'fenotip','transcriptoma','proteoma','bioinformatic','pcr ',
         'marcador molecular','divergencia genetica','flujo genico',
         'estructura genetica','variacion genetica','snp ','phylogen','genom','sequenc',
         'delimitacion de especies','species delimitation','taxonomi','sistematica','systematic',
         'barcod','edna','adn ambiental','environmental dna','nueva especie','new species',
         'revalidacion','especie nueva','phenotyp','phenotypic'] },

  // ── Arqueología / Patrimonio ───────────────────────────────────────────────
  { tema: 'Arqueología / Patrimonio',
    kw: ['arqueolog','patrimoni','prehispan','rupestre','petroglifo',
         'alfareria','alfarer','ceramica','sitio arqueol','conchale','tmidero',
         'etnoarqueolog','paleoindio','cazador recolector','arte rupestre',
         'pinturas rupestres','mortero','lithico','litico','fauna arqueol',
         'carbono 14','datacion','excavacion','prospeccio','archaeolog','archeolog','heritage',
         'geoglifo','geoglyph','rock art','prehistor','ancient','historia ','historic','historico',
         'museo','bioarqueolog','momia','mummy','inka','inca '] },

  // ── Ciencias Sociales / Comunidades ───────────────────────────────────────
  { tema: 'Ciencias Sociales / Comunidades',
    kw: ['toponim','arriero','comportamiento','conducta','behavio','psicolog','psycholog','intencion','deuda de la tierra','mongen','cosmovision','social','socio','comunidad local','comunidades','indigen','mapuche','aymara','atacamen',
         'lickanantay','likan antay','rapa nui','kawesqar','yagan','pehuenche','huilliche','diaguita',
         'etnograf','antropolog','sociolog','gobernanza','governance','politica publica','public polic',
         'percepcion','perception','conflict','agricultur','agrifood','alimentari','food ','economia',
         'economic','genero','gender','participacion','participat','valores','values','cultura',
         'cultural','territorio','territorial','water conflict','derecho','legal ','juridic',
         'educacion','education','escuela','school','tesis de pregrado','memoria de titulo'] },

  // ── Glaciología / Criosfera ────────────────────────────────────────────────
  { tema: 'Glaciología / Criosfera',
    kw: ['glaciar','glaciolog','glaciares','criosfera','hielo ','campo de hielo',
         'permafrost','periglacial','nieve ','nevado','deshielo','retroceso glaciar',
         'masa de hielo','lengua glaciar','frente glaciar','balance de masa',
         'glacier','glacial','icefield','ice field',' ice ','snow','cryospher','rock glacier',
         'glaciar rocoso','proglacial','calving'] },

  // ── Recursos Hídricos / Limnología ────────────────────────────────────────
  { tema: 'Recursos Hídricos / Limnología',
    kw: ['limnolog','hidrologi','cuenca hidro','caudal','calidad del agua',
         'aguas continen','lago ','lagos ','laguna ','lagunas ','rio ','rios ',
         'arroyo','estero','humedal','fitoplancton lacustre',
         'zooplancton','macroinvertebrado acuat','peces de agua dulce',
         'acuifer','aguas subterraneas','riego','escorrentia','hydrolog',' water',' river',
         ' lake','lagoon','wetland','stream','groundwater','aquifer','salar ','salares',
         'freshwater','bofedal','vega ','vegas ','agua ','hidrogeolog','hydrogeolog','cuenca'] },

  // ── Clima / Meteorología ──────────────────────────────────────────────────
  { tema: 'Clima / Meteorología',
    kw: ['hiperarid','hyperarid','nitrogen deposition','deposicion de nitrogeno','biogeoquim','biogeochem','variables ambientales','clima ','climatolog','cambio climatico','temperatura ','precipitacion',
         'meteo','fenologia','estacion climatica','patron climatico',
         'radiacion solar','viento ','presion atmosfer','humedad relativa',
         'sequia','ola de calor','evento extremo','enso','el nino','la nina',
         'variabilidad climatica','microclima','climate','climatic','drought','precipitation',
         'temperature','weather','fog ','niebla','camanchaca','atmospher','atmosfer','aerosol',
         'co2','carbon','carbono','greenhouse','emisiones','emission','paleoclim','astronom',
         'cielo oscuro','dark sky','contaminacion luminica','light pollution'] },

  // ── Geografía / Geología / Suelos ─────────────────────────────────────────
  { tema: 'Geografía / Geología',
    kw: ['geografi','geomorfolog','geolog','pedolog','edafolog',
         'suelo ','suelos ','sediment','erosion','relieve','litolog',
         'tectonica','volcan','vulcanolog','sismolog','terremoto',
         'paisaje','cartografi','sig ','gis ','teledeteccion','sensores remotos',
         'fotointerpretacion','topografi','altimetria','batimetria',
         'geology','geomorpholog','geochem','geoquim','volcanic','magma','caldera','lava ','eruption',
         'tephra','tefra','mineral','gabro','granit','skarn','rock ',' roca','fault','falla ',
         'sismic','seismic','earthquake','geotherm','geotermi','soil','landslide','remocion en masa',
         'paleontolog','fosil','fossil','geoparque','cueva','cave ','spatial','espacial','remote sensing',
         'mapping','dron','drone','lidar','satelit','landscape','tectonic','andean','andes'] },

  // ── Ciencias del Mar / Oceanografía ───────────────────────────────────────
  { tema: 'Ciencias del Mar',
    kw: ['oceanograf','plancton','zooplancton marino','fitoplancton marino',
         'intermareal','submareal','bentos','bentico','macrobentos',
         'litoral','costa ','costas ','playa ','playas ','fiordo',
         'marino ','marina ','marinos ','marinas ','algas marinas',
         'kelp','huiro','luga','submarino','buceo','marine','ocean',' sea ','coastal','coast ',
         'fjord','benthic','intertidal','seaweed','coral','changle','estuar','maritorio'] },

  // ── Monitoreo Ambiental ────────────────────────────────────────────────────
  { tema: 'Monitoreo Ambiental',
    kw: ['monitoreo','contaminac','microplastico','metal pesado','mercurio',
         'plomo ','arsenico','residuo','basura','impacto ambiental',
         'evaluacion ambiental','linea base','linea de base','presencia humana',
         'perturbacion','fragmentacion','deforestacion','monitoring','pollution','pollutant',
         'microplastic','heavy metal','impact','baseline','environmental assessment','fauna silvestre',
         'flora y fauna','fauna y flora','censo','census','catastro','inventario','inventory'] },

  // ── Turismo / Uso Público ─────────────────────────────────────────────────
  { tema: 'Turismo / Uso Público',
    kw: ['turismo','turista','visitante','recreacion','uso publico',
         'capacidad de carga','carga visit','gestion de visit',
         'sendero','senderismo','trekking','camping','impacto del turismo',
         'interpretacion ambiental','educacion ambiental',
         'satisfaccion del visit','voluntariado','tourism','visitor','recreation',' trail',
         'rescate','rescue','incidente','accidente','seguridad','montanis','andinismo','escalada'] },

  // ── Manejo y Conservación ─────────────────────────────────────────────────
  { tema: 'Manejo y Conservación',
    kw: ['conservacion','manejo','especie amenazada','en peligro',
         'vulnerable','lista roja','categoria de amenaza',
         'reintroducc','repoblacion','restauracion ecolog','revegetacion',
         'control de especie invasora','especie invasora','especie exotica',
         'erradicacion','plan de manejo','corredor biologico',
         'area protegida','areas protegidas','parque nacional','reserva','conservation','management',
         'protected area','threatened','endangered','restoration','restauracion','reforestac',
         'santuario','monumento natural','biosphere','biosfera'] },
];

const TEMAS_FILM = [
  { tema: 'Registro Científico / Técnico',
    kw: ['lahar','peligro','riesgo','microzonificac','rewilding','fundacion','cientific','investigacion','research','estudio ','study','monitoreo','monitoring',
         'levantamiento','topografic','escanear','escaneo','lidar','arqueolog','geoglifo',
         'equipo cientifico','tesis','muestreo','sampling','diagnostico','catastro','dron para',
         'registro de flora','registro de fauna','fotogrametri','ortofoto','modelo 3d'] },
  { tema: 'Turismo / Promoción de Destino',
    kw: ['turismo','turistic','tourism','destino','destination','hotel','lodge','hostal','viaje',
         'travel','itinerario','difusion de','promocion del destino','promocionar','prochile',
         'sernatur','ruta de los parques','conocer patagonia','en familia','vacaciones','agencia',
         'tour ','tours ','excursion','experiencia turistica','marca chile','imagen pais'] },
  { tema: 'Deporte / Aventura',
    kw: ['escalad','mujeres en altura','cumbre','summit','deporte','sport','ski ','esqui','snowboard','freeride','maraton','marathon','trail running',
         'carrera ','race ','rugby','futbol','ciclismo','bike','mountain bike','escalada','climbing',
         'montanismo','andinismo','alpin','kayak','rafting','surf','buceo','diving','outdoor',
         'aventura','adventure','expedicion','expedition','trekking','travesia','parapente'] },
  { tema: 'Arte / Danza / Música',
    kw: ['videodanza','danza','dance','musica','music','videoclip','cancion','song','album',
         'artista','artist','arte ','art ','performance','instalacion','libro objeto','fotolibro',
         'poesia','poema','teatro','orfebre','artesania','pintura','ilustracion','residencia artistica'] },
  { tema: 'Documental de Naturaleza',
    kw: ['mastodonte','postglacial','bosque nativo','aniversario del parque','conmemoracion','centenario','100 anos','naturaleza','wildlife','vida silvestre','documental','fauna silvestre',
         'flora silvestre','avistamiento','ecosistema','biodiversidad',
         'especie ','animal ','parque nacional','reserva natural','nature','documentary',
         'restauracion','conservacion','glaciar','humedal','paisaje','landscape','patagonia'] },
  { tema: 'Cine / Ficción',
    kw: ['largometraje','cortometraje','ficcion','pelicula','drama','thriller',
         'serie ','teleserie','guion','actores','rodaje','produccion cinemat',
         'animacion','film ','movie','feature','fiction'] },
  { tema: 'Publicidad / Comercial',
    kw: ['publicidad','comercial','marca ','producto ','campana publicitar',
         'spot ','aviso ','auspicio','marketing','promocion','branding','campana audiovisual',
         'campaign','brand','advertising','commercial','catalogo','catalog','empresa','corporativ'] },
  { tema: 'Contenido Educativo',
    kw: ['educativ','educacion','divulgacion','escolar','universitario',
         'pedagogico','ciencia','museo','exposicion educativa','recurso didactico',
         'mediacion','taller','capacitacion','educar','estudiantil','estudiantes','students',
         'biblioteca','aniversario','concurso','explora'] },
  { tema: 'Fotografía',
    kw: ['astropatrimon','observacion astronom','cielo nocturno','night sky','fotografi','fotografo','retrato','galeria','libro fotografi',
         'exposicion fotografica','fotoperiodismo','foto ','fotos ','imagen ',
         'paisaje fotografi','wildlife photo','photo','astrofotograf','timelapse','time lapse',
         'equinoccio','solsticio','eclipse'] },
  { tema: 'Reportaje / Periodismo',
    kw: ['nhk','chilevision','tvn','canal 13','mega ','programa ','capitulo','episodio','reportaje','periodismo','noticias','prensa','diario','revista',
         'entrevista','nota period','cobertura period','medio de comunicacion',
         'television','radio ','podcast','periodista','journalist','canal ','tv ','deutsche welle',
         'bbc','cnn','national geographic','noticiero','cronica'] },
  { tema: 'Contenido Digital / RRSS',
    kw: ['redes sociales','instagram','youtube','tiktok','contenido digital',
         'influencer','streaming','vlog','video digital','plataforma digital',
         'contenido audiovisual','short film','reels','creadores de contenido','creador de contenido',
         'live ','en vivo','internet satelital','plataformas digitales','facebook'] },
];

const PALETA_TEMAS = [
  // Colores del logo Permisos SNAP (bosque, lago, desierto, cordillera)
  '#013722','#0155A0','#D9A13B','#347A17','#026B59',
  '#2DA9EE','#B9412F','#8CC26B','#7A4E2D','#DC9564',
  '#0A4A2B','#5B7FA6','#C27C2C','#4A9324','#1E8C80',
  '#9B6A4A','#2C6B14','#7FB7D9','#A88A3D','#5E3A6E',
  '#16523E','#E0B97A','#3E6B8C','#6E8B3D','#B56A4C',
];

function clasificarTramite(t) {
  const texto = _textoClasificacion(t);
  const esInv = IDS_INVESTIGACION.has(t.proceso_id);
  const lista = esInv ? TEMAS_INV : TEMAS_FILM;
  for (const { tema, kw } of lista) {
    if (kw.some(k => texto.includes(k))) return tema;
  }
  return 'Otros';
}

// Texto normalizado del trámite usado para clasificar (título, objetivos, descripción…)
function _textoClasificacion(t) {
  const d = t.datos_raw || {};
  // Rodear con espacios para que ' ave ' no matchee "avena" al inicio/fin
  return ' ' + _normInv([
    _tituloTramite(t),
    t.titulo_investigacion,                  // compliance / portadaHistorico
    t.texto_clasificacion,                   // campo pre-agregado de portadaHistorico
    d.objetivos_del_proyecto,
    d.descripcion,
    d.descripcion_proyecto,
    d.segmentos_proyecto,
    d.objetivo_general,
    d.objetivos_especificos,
    d.actividades,
    d.actividades_a_realizar,
    d.palabras_clave,
    d.especie,
    d.especies,
    d.nombre_cientifico,
    d.nombre_comun,
    d.tipo_investigacion,
    d.linea_investigacion,
  ].filter(Boolean).join(' ')) + ' ';
}

// ─── Respaldo por similitud ───────────────────────────────────────────────────
// Lo que ninguna palabra clave reconoce recibe la temática de los trámites ya
// clasificados con vocabulario más parecido (palabras compartidas ponderadas por
// rareza, IDF). Así ningún trámite queda "sin clasificar".
const _STOP = new Set(('para como desde entre sobre sus los las del una unos unas este esta estos estas ' +
  'segun durante mediante cual cuales donde cuando proyecto proyectos estudio estudios objetivo objetivos ' +
  'general especifico especificos realizar realizacion actividad actividades permiso chile chilena chileno ' +
  'region parque nacional reserva area areas protegida protegidas sector zona the and for with from into ' +
  'their this that study project research analysis effects effect using based between under').split(' '));

function _palabras(t) {
  return new Set(_textoClasificacion(t).split(' ').filter(w => w.length >= 4 && !_STOP.has(w)));
}

function clasificarConjunto(tramites) {
  const temas = new Map();          // id → temática
  const porSimilitud = new Set();   // ids asignados por el respaldo
  const base = [], pendientes = [];
  for (const t of tramites) {
    const tema = clasificarTramite(t);
    if (tema === 'Otros') pendientes.push(t);
    else { temas.set(t.id, tema); base.push({ tema, inv: IDS_INVESTIGACION.has(t.proceso_id), w: _palabras(t) }); }
  }
  if (!pendientes.length) return { temas, porSimilitud };

  const df = new Map();
  base.forEach(b => b.w.forEach(w => df.set(w, (df.get(w) || 0) + 1)));
  const idf = w => Math.log((base.length + 1) / ((df.get(w) || 0) + 1));
  const masFrecuente = inv => {
    const c = {};
    base.filter(b => b.inv === inv).forEach(b => { c[b.tema] = (c[b.tema] || 0) + 1; });
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Otros';
  };

  for (const t of pendientes) {
    const inv = IDS_INVESTIGACION.has(t.proceso_id);
    const w = _palabras(t);
    const vecinos = base
      .filter(b => b.inv === inv)
      .map(b => {
        let s = 0;
        w.forEach(x => { if (b.w.has(x)) s += idf(x); });
        return { tema: b.tema, s: s / Math.sqrt(b.w.size + 1) };
      })
      .filter(v => v.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 7);
    let tema;
    if (vecinos.length) {
      const votos = {};
      vecinos.forEach(v => { votos[v.tema] = (votos[v.tema] || 0) + v.s; });
      tema = Object.entries(votos).sort((a, b) => b[1] - a[1])[0][0];
    } else {
      tema = masFrecuente(inv);   // sin texto útil: la temática más común de su tipo
    }
    temas.set(t.id, tema);
    porSimilitud.add(t.id);
  }
  return { temas, porSimilitud };
}

// Jerarquía de consolidación: si un tema tiene pocos items, se fusiona con su padre
const TEMA_PADRE = {
  'Herpetología':                  'Fauna Terrestre',
  'Entomología / Invertebrados':   'Fauna Terrestre',
  'Mamíferos Terrestres':          'Fauna Terrestre',
  'Ictiología / Peces':            'Ciencias del Mar',
  'Mamíferos Marinos':             'Ciencias del Mar',
  'Micología / Líquenes':          'Botánica / Flora',
  'Microbiología':                 'Genética / Genómica',
  'Salud / Zoonosis':              'Ecología',
  'Clima / Meteorología':          'Monitoreo Ambiental',
  'Turismo / Uso Público':         'Manejo y Conservación',
  'Recursos Hídricos / Limnología':'Ecología',
  'Geografía / Geología':          'Ecología',
};

function consolidarTemasPequenos(porTema, minItems) {
  const result = new Map(porTema);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [tema, items] of [...result.entries()]) {
      if (items.length < minItems && TEMA_PADRE[tema]) {
        const padre = TEMA_PADRE[tema];
        if (!result.has(padre)) result.set(padre, []);
        result.get(padre).push(...items);
        result.delete(tema);
        changed = true;
        break; // reiniciar iteración tras modificar el mapa
      }
    }
  }
  return result;
}

function archivosDeFolder(data) {
  if (data.tipo === 'flat') return data.archivos || [];
  // 'mapped': todos los IDs apuntan a los mismos archivos (DriveFolderMap); evitar duplicados
  if (data.tipo === 'mapped') return Object.values(data.ids || {})[0] || [];
  return Object.values(data.ids || {}).flat();
}

function getTramitePorCarpeta(folderName) {
  // Para carpetas con IDs mapeados explícitamente, buscar tramite por ID directo
  const data = STATE.investigaciones[folderName];
  if (data?.tipo === 'mapped' && data.ids) {
    for (const idStr of Object.keys(data.ids)) {
      const id = Number(idStr);
      const t = (STATE.tramites || []).find(t => t.id === id)
             || (STATE.complianceData || []).find(t => t.id === id);
      if (t) return t;
    }
  }
  // Fallback: token matching por nombre de carpeta
  const tokens = _normInv(folderName.replace(/_/g, ' ')).split(' ').filter(Boolean);
  if (!tokens.length) return null;
  const match = lista => lista.find(t => {
    const n = _normInv(t.nombre_solicitante || '');
    return tokens.every(tok => n.includes(tok));
  });
  // Busca primero en trámites recientes, luego en historial compliance (>3 años)
  return match(STATE.tramites) || match(STATE.complianceData) || null;
}

// ─── PORTADA ─────────────────────────────────────────────────────────────────
async function loadPortadaHistorico() {
  if (STATE.portadaHistorico.length > 0) return;
  try {
    const data = await fetchJSON('/api/portada/historico');
    if (data.ok) STATE.portadaHistorico = data.data || [];
  } catch(e) {
    console.warn('No se pudo cargar histórico de portada:', e.message);
  }
}

async function loadComplianceData() {
  if (STATE.complianceData.length > 0) return;
  const el = $('portada-tabla-entregadas');
  if (el) el.innerHTML = `<div class="empty-msg" style="padding:24px;text-align:center">
    <div style="font-size:22px;margin-bottom:8px">⏳</div>
    Cargando historial de investigaciones entregadas…<br>
    <small style="color:var(--muted)">Puede tardar 1–2 minutos la primera vez.</small>
  </div>`;
  try {
    const data = await fetchJSON('/api/compliance/investigacion');
    if (data.ok) STATE.complianceData = data.data || [];
  } catch(e) {
    console.warn('No se pudo cargar compliance data:', e.message);
  }
}

async function renderPortada() {
  // Cargar histórico de gráficos y compliance en paralelo
  const [, ] = await Promise.all([
    loadPortadaHistorico(),
    loadComplianceData(),
  ]);

  // Gráficos usan TODOS los permisos históricos aprobados (no rechazados, no borrador)
  const hist  = STATE.portadaHistorico.filter(t => t.estado !== 'rechazado');
  if (!hist.length) {
    // El servidor está regenerando el histórico: avisar y reintentar sin recargar la página
    $('panorama').innerHTML = '<div class="empty-msg">⏳ El histórico se está actualizando; los gráficos aparecerán en unos segundos.</div>';
    setTimeout(renderPortada, 20000);
  } else {
    renderPanorama(hist);   // static/js/panorama.js
  }

  // Tabla: solo carpetas con archivos entregados (usa compliance para matching histórico)
  renderTablaEntregadas();
}

// ─── Formato de texto ────────────────────────────────────────────────────────

const _PREP_ES = new Set([
  'de','del','la','las','el','los','un','una','en','y','e','o','u',
  'a','para','por','con','sin','sobre','entre','hacia','desde','hasta',
  'ante','bajo','según','tras','via','the','of','and','in','to','for',
  'with','on','at','by','from','an','as',
]);

function formatTitulo(titulo) {
  if (!titulo || titulo === '–') return titulo;
  const words = titulo.trim().split(/\s+/);
  return words.map((w, i) => {
    if (!w) return '';
    // Preservar siglas/acrónimos: 2-7 letras mayúsculas (ADN, SNAP, CO2, etc.)
    if (/^[A-ZÁÉÍÓÚÑÜ0-9]{2,7}$/.test(w) && /[A-ZÁÉÍÓÚÑÜ]{2}/.test(w)) return w;
    const lo = w.toLowerCase();
    if (i === 0) return lo.charAt(0).toUpperCase() + lo.slice(1);
    if (_PREP_ES.has(lo)) return lo;
    return lo.charAt(0).toUpperCase() + lo.slice(1);
  }).join(' ');
}

function formatNombre(nombre) {
  // Nombre propio: cada palabra capitalizada (Nombre Apellido)
  return (nombre || '').trim().split(/\s+/).map(w => {
    if (!w) return '';
    if (/^[A-ZÁÉÍÓÚÑÜ]{2,}$/.test(w)) return w; // sigla
    const lo = w.toLowerCase();
    return lo.charAt(0).toUpperCase() + lo.slice(1);
  }).join(' ');
}

// ─── Detección de inglés y traducción ────────────────────────────────────────

const _EN_WORDS = new Set([
  'the','of','and','in','a','to','for','with','on','at','by','from','an',
  'study','assessment','evaluation','analysis','distribution','effects','impact',
  'survey','monitoring','conservation','ecology','diversity','population',
  'species','habitat','birds','mammals','plants','insects','fish','marine',
  'forest','lake','river','island','national','park','reserve','spatial',
  'temporal','genetic','molecular','breeding','nesting','migration','feeding',
  'behavior','behaviour','abundance','richness','structure','community',
]);

function isLikelyEnglish(text) {
  if (!text || text === '–') return false;
  const words = text.toLowerCase().replace(/[^a-záéíóúñü\s]/g, '').split(/\s+/);
  if (words.length < 3) return false;
  const enCount = words.filter(w => _EN_WORDS.has(w)).length;
  return enCount >= 2 || (enCount / words.length) >= 0.25;
}

const _tradCache = {}; // texto original → traducción

async function _traducirTitulo(uid, textoOriginal) {
  if (_tradCache[textoOriginal]) {
    const el = document.getElementById(`trad-${uid}`);
    if (el) el.textContent = _tradCache[textoOriginal];
    return;
  }
  try {
    const resp = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: textoOriginal }),
    });
    const data = await resp.json();
    if (data.ok && data.traduccion !== textoOriginal) {
      _tradCache[textoOriginal] = data.traduccion;
      const el = document.getElementById(`trad-${uid}`);
      if (el) el.textContent = data.traduccion;
    } else {
      const el = document.getElementById(`trad-${uid}`);
      if (el) el.textContent = textoOriginal;
    }
  } catch(_) {}
}

window._traducirTitulo = _traducirTitulo;

// ─── Muestras ─────────────────────────────────────────────────────────────────

function _parseMuestras(tramite) {
  if (!tramite) return null;
  // compliance data devuelve campo directo
  const v = tramite.colecta_muestras;
  if (v !== undefined) {
    const vl = String(v).toLowerCase().trim();
    if (!vl || vl === 'none' || vl === 'nan' || vl === '–') return null;
    const positivo = /^(s[íi]|yes|1|true|x|marca|si$)/.test(vl);
    const negativo = /^(no|0|false|ninguna|no\s)/.test(vl);
    if (positivo) return true;
    if (negativo) return false;
    return vl; // valor textual inesperado
  }
  // tramites recientes: buscar en datos_raw
  const d = tramite.datos_raw || {};
  const raw = d.colecta_de_muestras || d.colecta_muestras || d.recoleccion_muestras ||
              d.muestras_biologicas || d.colecta_material_biologico || d.colecta ||
              d.tipo_colecta || d.requiere_colecta || '';
  if (!raw) return null;
  const rl = String(raw).toLowerCase().trim();
  if (!rl || rl === 'no aplica') return null;
  const pos = /^(s[íi]|yes|1|true|x|se realizara|se realiz)/.test(rl);
  const neg = /^(no|0|false|no\s|ninguna)/.test(rl);
  if (pos) return true;
  if (neg) return false;
  return rl;
}

function muestrasBadge(tramite) {
  const v = _parseMuestras(tramite);
  if (v === null) return '<span style="color:var(--muted);font-size:11px">–</span>';
  if (v === true) return '<span style="background:#E8F5E9;color:#1B5E20;border:1px solid #81C784;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:700">✓ Sí</span>';
  if (v === false) return '<span style="background:#fafafa;color:var(--muted);border:1px solid var(--border);border-radius:10px;padding:2px 8px;font-size:11px">✗ No</span>';
  return `<span title="${escHtml(v)}" style="background:#FFF8E1;color:#7D4E00;border:1px solid #FFB300;border-radius:10px;padding:2px 8px;font-size:11px">⚗ Sí</span>`;
}

// ─── Tabla de investigaciones entregadas ──────────────────────────────────────

function renderTablaEntregadas(filtroTema) {
  const el = $('portada-tabla-entregadas');
  if (!el) return;
  if (filtroTema === undefined) filtroTema = '';

  // 1. Construir entradas; sin trámite asociado se clasifica por los nombres de archivo
  const entradas = [];
  for (const [carpeta, data] of Object.entries(STATE.investigaciones)) {
    const archivos = archivosDeFolder(data);
    if (!archivos.length) continue;
    const tramite = getTramitePorCarpeta(carpeta);
    // Los registros de cumplimiento no traen proceso_id: sin él se clasificarían con los temas
    // de filmación. Las carpetas de entregas del Numeral 6 son de investigación.
    const item    = (tramite && (tramite.proceso_id ? tramite : { ...tramite, proceso_id: 1992 })) || {
      id: 'carpeta:' + carpeta, proceso_id: 1992,
      titulo_investigacion: archivos.map(a => a.nombre.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')).join(' '),
    };
    const titulo  = tramite ? (_tituloTramite(tramite) || '–') : '–';
    const regs    = tramite ? (tramite.regiones_list || []).join(', ') : '–';
    const estado  = tramite ? tramite.estado : null;
    const tid     = tramite ? tramite.id : null;
    entradas.push({ carpeta, archivos, tramite, item, titulo, regs, estado, tid });
  }
  // Temática con respaldo por similitud, usando el histórico como base de comparación
  const idsItems = new Set(entradas.map(e => e.item.id));
  const { temas: temaDe } = clasificarConjunto([
    ...STATE.portadaHistorico.filter(t => IDS_INVESTIGACION.has(t.proceso_id) && !idsItems.has(t.id)),
    ...entradas.map(e => e.item),
  ]);
  entradas.forEach(e => { e.tema = temaDe.get(e.item.id) || 'Ecología'; });

  // 2. Agrupar TODAS las entradas y consolidar (para obtener los temas canónicos)
  let porTemaTotal = new Map();
  for (const e of entradas) {
    if (!porTemaTotal.has(e.tema)) porTemaTotal.set(e.tema, []);
    porTemaTotal.get(e.tema).push(e);
  }
  porTemaTotal = consolidarTemasPequenos(porTemaTotal, 2);

  // Construir mapa: tema original → tema canónico (post-consolidación)
  const temaCanon = new Map();
  for (const e of entradas) {
    if (!temaCanon.has(e.tema)) {
      for (const [canon, lista] of porTemaTotal.entries()) {
        if (lista.includes(e)) { temaCanon.set(e.tema, canon); break; }
      }
    }
  }
  const temaEfectivo = e => temaCanon.get(e.tema) || e.tema;
  // Tema por carpeta del investigador en Drive: lo usa el filtro de la galería «Desde el terreno» (layout.js)
  window.TEMA_POR_CARPETA = new Map(entradas.map(e => [_normInv(e.carpeta.replace(/_/g, ' ')), temaEfectivo(e)]));
  window.TIPO_POR_CARPETA = new Map(entradas.map(e => [_normInv(e.carpeta.replace(/_/g, ' ')),
    e.tramite && IDS_FILMACION.has(e.tramite.proceso_id) ? 'film' : 'inv']));
  document.dispatchEvent(new Event('temas-galeria'));

  // 3. Botones de filtro usando temas canónicos
  const filtroEl = $('portada-filtro-tema');
  if (filtroEl) {
    const temasCanon = [...porTemaTotal.keys()].sort();
    filtroEl.innerHTML = ['', ...temasCanon].map(t => {
      const activo = t === filtroTema ? 'tema-filter-btn--active' : '';
      const label  = t || 'Todos';
      return `<button class="tema-filter-btn ${activo}" data-tema="${escHtml(t || '')}">${escHtml(label)}</button>`;
    }).join('');
    filtroEl.onclick = ev => {
      const btn = ev.target.closest('.tema-filter-btn');
      if (!btn) return;
      renderTablaEntregadas(btn.dataset.tema);
      document.dispatchEvent(new CustomEvent('entregadas-tema', { detail: { tema: btn.dataset.tema } }));
    };
  }

  // 4. Filtrar usando tema canónico
  const filtradas = filtroTema
    ? entradas.filter(e => temaEfectivo(e) === filtroTema)
    : entradas;

  if (!filtradas.length) {
    const authMsg = STATE.driveNeedsAuth && window.PERFIL?.superusuario
      ? `<div style="margin-top:10px;padding:10px 14px;background:#fff3cd;border:1px solid #ffc107;border-radius:8px;font-size:13px;color:#856404">
           ⚠️ Drive no autorizado. <a href="/auth/gmail/start" style="color:#856404;font-weight:700">Autorizar acceso</a> para vincular archivos de Google Drive.
         </div>`
      : '';
    el.innerHTML = '<div class="empty-msg">Sin investigaciones con archivos entregados</div>' + authMsg;
    return;
  }

  // 5. Agrupar filtradas por tema canónico
  let porTema = new Map();
  for (const e of filtradas) {
    const tc = temaEfectivo(e);
    if (!porTema.has(tc)) porTema.set(tc, []);
    porTema.get(tc).push(e);
  }

  let html = `<div style="padding:8px 16px;font-size:13px;color:var(--muted);border-bottom:1px solid var(--border)">
    ${filtradas.length} investigador${filtradas.length!==1?'es':''} con archivos entregados
  </div>`;

  const pendientesTraduccion = [];

  for (const [tema, lista] of [...porTema.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
    const filas = lista.sort((a,b)=>a.carpeta.localeCompare(b.carpeta)).map((e, idx) => {
      const nombre = formatNombre(e.carpeta.replace(/_/g,' '));

      const archivoLinks = e.archivos.map(a =>
        `<a href="${safeUrl(a.url)}" target="_blank" class="entregadas-archivo-link">📄 ${escHtml(a.nombre)}<small style="color:var(--muted);margin-left:4px">${escHtml(a.size_kb)} KB</small></a>`
      ).join('');

      const estadoCell = e.tramite
        ? badgeHtml(e.estado, {})
        : '<span style="color:var(--muted);font-size:11px">–</span>';

      const idCell = e.tid
        ? `<button class="btn-detalle" onclick="openModal(${e.tid})" style="font-size:11px;padding:3px 8px">#${e.tid}</button>`
        : '<span style="color:var(--muted);font-size:11px">–</span>';

      // Título formateado + detección inglés
      const tituloFmt = formatTitulo(e.titulo);
      const enIngles  = isLikelyEnglish(e.titulo);
      const uid       = `${tema.replace(/\W/g,'')}_${idx}`;
      let tituloHtml;
      if (enIngles) {
        pendientesTraduccion.push({ uid, texto: e.titulo });
        tituloHtml = `<span id="trad-${uid}" title="Traduciendo…">${escHtml(tituloFmt)}</span>
          <span style="font-size:10px;color:var(--muted);margin-left:4px">[EN]</span>`;
      } else {
        tituloHtml = `<span>${escHtml(tituloFmt)}</span>`;
      }

      const muestrasCell = muestrasBadge(e.tramite);

      return `<tr>
        <td style="font-weight:600;white-space:nowrap;font-size:13px">${escHtml(nombre)}</td>
        <td>${idCell}</td>
        <td style="font-size:12px;max-width:240px">${tituloHtml}</td>
        <td style="text-align:center">${muestrasCell}</td>
        <td>${archivoLinks}</td>
        <td style="font-size:12px;color:var(--muted)">${escHtml(e.regs || '–')}</td>
        <td>${estadoCell}</td>
      </tr>`;
    }).join('');

    html += `
      <div style="padding:8px 16px;font-weight:700;font-size:13px;background:var(--surface2);border-top:2px solid var(--border)">
        🏷️ ${escHtml(tema)} <span style="font-weight:400;color:var(--muted)">(${lista.length})</span>
      </div>
      <table>
        <thead><tr>
          <th style="color:#fff">Investigador</th>
          <th style="color:#fff">ID permiso</th>
          <th style="color:#fff">Proyecto</th>
          <th style="color:#fff;text-align:center">Muestras</th>
          <th style="color:#fff">Archivos</th>
          <th style="color:#fff">Regiones</th>
          <th style="color:#fff">Estado</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>`;
  }

  el.innerHTML = html;

  // Traducir títulos en inglés en background (sin bloquear el render)
  for (const { uid, texto } of pendientesTraduccion) {
    _traducirTitulo(uid, texto);
  }
}

function calcularDias(t) {
  const inicio = t.fecha_inicio;
  // Hasta que CONAF resolvió (aunque el solicitante aún no cierre el trámite)
  const fin    = t.fecha_resolucion || t.fecha_termino || t.fecha_modificacion;
  if (!inicio || !fin) return null;
  const ms = new Date(fin) - new Date(inicio);
  if (isNaN(ms) || ms <= 0) return null;
  return Math.round(ms / 86400000); // días
}

function _avancePorRegion(tramites) {
  const byRegion = {};
  REGIONES_CHILE.forEach(r => { byRegion[r.nombre] = { sum:0, count:0 }; });
  tramites.forEach(t => {
    const matched = new Set();
    (t.regiones_list || []).forEach(raw => {
      const hit = REGIONES_CHILE.find(r =>
        r.nombre.toLowerCase() === raw.toLowerCase() ||
        raw.toLowerCase().includes(r.nombre.toLowerCase().split(' ')[0].toLowerCase())
      );
      if (hit) matched.add(hit.nombre);
    });
    matched.forEach(nombre => {
      if (!byRegion[nombre]) return;
      byRegion[nombre].sum += t.porcentaje_avance;
      byRegion[nombre].count++;
    });
  });
  return byRegion;
}

// ─── BÚSQUEDA ─────────────────────────────────────────────────────────────────
// ─── Upload de archivos de investigación ─────────────────────────────────────

function _normCarpetaNombre(nombre) {
  return (nombre || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // quita tildes
    .replace(/[^\w\s]/g, '')                            // quita puntuación
    .trim().replace(/\s+/g, '_');
}

function _carpetaExistenteParaInv(nombre) {
  // Busca en STATE.investigaciones la carpeta que mejor matchea el nombre
  const tokens = _normInv(nombre).split('_').filter(Boolean);
  return Object.keys(STATE.investigaciones).find(k => {
    const kn = _normInv(k);
    return tokens.every(tok => kn.includes(tok));
  }) || null;
}

function _archivosExistentesPorId(carpeta, id) {
  const inv = STATE.investigaciones[carpeta];
  if (!inv) return [];
  if (inv.tipo === 'nested') return inv.ids[String(id)] || [];
  return []; // flat: no ID separado
}

function toggleUploadPanel(tramiteId) {
  const row = $(`upload-panel-${tramiteId}`);
  if (!row) return;
  const visible = row.style.display !== 'none';
  row.style.display = visible ? 'none' : 'table-row';
}

function _uploadPanelHtml(t) {
  if (!IDS_INVESTIGACION.has(t.proceso_id)) return '';
  const nombre     = t.nombre_solicitante || '';
  const carpeta    = _carpetaExistenteParaInv(nombre) || _normCarpetaNombre(nombre);
  const archExist  = _archivosExistentesPorId(carpeta, t.id);

  // Aviso si es posible duplicado/extensión
  const relacionados = STATE.duplicados.get(t.id) || [];
  const avisoExt = relacionados.length ? `
    <div class="upload-ext-warning">
      ⚠️ Este permiso tiene solicitudes relacionadas (#${relacionados.map(r=>r.id).join(', #')}).
      Si es una <strong>extensión</strong>, los archivos ya estarán en otra subcarpeta.
    </div>` : '';

  const archHtml = archExist.length
    ? `<div style="font-size:12px;color:var(--muted);margin-bottom:4px">Archivos ya subidos en esta solicitud:</div>
       <div class="upload-archivos-existentes">${archExist.map(a =>
         `<a class="upload-archivo-link" href="${safeUrl(a.url)}" target="_blank">📄 ${escHtml(a.nombre)}</a>`
       ).join('')}</div>`
    : `<div style="font-size:12px;color:var(--muted)">Sin archivos subidos aún para esta solicitud (ID ${t.id}).</div>`;

  return `
    <tr id="upload-panel-${t.id}" class="upload-panel-row" style="display:none">
      <td colspan="12">
        <div class="upload-panel">
          <div class="upload-panel-header">
            📁 Archivos de investigación — ${escHtml(nombre)}
            <span style="font-weight:400;font-size:12px;color:var(--muted)"> → Investigaciones/${escHtml(carpeta)}/${t.id}/</span>
          </div>
          ${avisoExt}
          ${archHtml}
          ${!window.PERFIL?.permisos?.agregar ? '<div style="font-size:12px;color:var(--muted)">Su perfil no permite subir archivos.</div>' : `
          <div class="upload-drop-zone" id="dropzone-${t.id}"
               onclick="document.getElementById('file-input-${t.id}').click()"
               ondragover="event.preventDefault();this.classList.add('drag-over')"
               ondragleave="this.classList.remove('drag-over')"
               ondrop="invHandleDrop(event,${t.id})">
            <input type="file" id="file-input-${t.id}" multiple
                   accept=".pdf,.doc,.docx,.csv,.xls,.xlsx"
                   onchange="invHandleFiles(${t.id}, this.files)">
            <div>📎 Haz clic o arrastra archivos aquí<br>
              <small>PDF, Word, Excel — máx. 50 MB por archivo</small></div>
          </div>
          <ul class="upload-file-list" id="file-list-${t.id}"></ul>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn-primary" style="padding:6px 18px"
                    onclick="invSubirArchivos(${t.id}, ${escHtml(JSON.stringify(nombre))}, ${escHtml(JSON.stringify(carpeta))})">
              ⬆️ Subir archivos
            </button>
            <span id="upload-status-${t.id}" style="font-size:12px;color:var(--muted)"></span>
          </div>`}
        </div>
      </td>
    </tr>`;
}

// Archivos pendientes de subir por tramite ID
const _uploadPendiente = {};

function invHandleFiles(tramiteId, files) {
  if (!_uploadPendiente[tramiteId]) _uploadPendiente[tramiteId] = [];
  for (const f of files) _uploadPendiente[tramiteId].push(f);
  _renderFileList(tramiteId);
}

function invHandleDrop(event, tramiteId) {
  event.preventDefault();
  $(`dropzone-${tramiteId}`).classList.remove('drag-over');
  invHandleFiles(tramiteId, event.dataTransfer.files);
}

function _renderFileList(tramiteId) {
  const ul = $(`file-list-${tramiteId}`);
  if (!ul) return;
  const files = _uploadPendiente[tramiteId] || [];
  ul.innerHTML = files.map((f, i) =>
    `<li class="upload-file-item">
      <span>📄 ${escHtml(f.name)} <small style="color:var(--muted)">(${(f.size/1024).toFixed(0)} KB)</small></span>
      <span class="rm" onclick="_removeFile(${tramiteId},${i})">✕</span>
    </li>`
  ).join('');
}

function _removeFile(tramiteId, idx) {
  if (_uploadPendiente[tramiteId]) {
    _uploadPendiente[tramiteId].splice(idx, 1);
    _renderFileList(tramiteId);
  }
}

async function invSubirArchivos(tramiteId, nombre, carpeta) {
  const files = _uploadPendiente[tramiteId] || [];
  const status = $(`upload-status-${tramiteId}`);
  if (!files.length) {
    if (status) status.textContent = 'Selecciona archivos primero.';
    return;
  }
  if (status) status.textContent = 'Subiendo…';
  const fd = new FormData();
  fd.append('tramite_id', tramiteId);
  fd.append('nombre', nombre);
  for (const f of files) fd.append('archivos', f);

  try {
    const resp = await fetch('/api/investigaciones/upload', { method: 'POST', body: fd });
    const data = await resp.json();
    if (data.ok) {
      _uploadPendiente[tramiteId] = [];
      _renderFileList(tramiteId);
      if (status) status.textContent = `✅ ${data.guardados.length} archivo(s) subido(s) en ${data.carpeta}`;
      // Actualizar STATE.investigaciones para reflejar nuevos archivos
      await loadInvestigaciones();
      // Refrescar el botón de archivos en la tabla
      const btn = $(`btn-archivos-${tramiteId}`);
      if (btn) {
        const inv = STATE.investigaciones[carpeta];
        const count = inv ? (inv.tipo === 'nested' ? (inv.ids[String(tramiteId)] || []).length : 0) : 0;
        btn.textContent = `📁 ${count}`;
        btn.className = `btn-archivos ${count > 0 ? 'btn-archivos--tiene' : ''}`;
      }
    } else {
      if (status) status.textContent = '❌ Error: ' + (data.error || 'desconocido');
    }
  } catch(e) {
    if (status) status.textContent = '❌ Error de red: ' + e.message;
  }
}

// ─── MODAL DETALLE ────────────────────────────────────────────────────────────
async function openModal(tramiteId) {
  const modal = $('modal-tramite');
  const body = $('modal-tramite-body');
  $('modal-tramite-title').textContent = `Trámite #${tramiteId}`;
  body.innerHTML = '<div class="empty-msg">Cargando…</div>';
  modal.style.display = 'flex';

  try {
    const t = await loadTramite(tramiteId);
    renderModalBody(t);
  } catch (err) {
    body.innerHTML = `<div class="empty-msg">Error: ${escHtml(err.message)}</div>`;
  }
}

// Orden de regiones de Chile de norte a sur
const ORDEN_REGIONES = [
  'arica', 'parinacota',
  'tarapaca', 'tarapacá',
  'antofagasta',
  'atacama',
  'coquimbo',
  'valparaiso', 'valparaíso',
  'metropolitana', 'santiago',
  "o'higgins", 'ohiggins', 'libertador',
  'maule',
  'nuble', 'ñuble',
  'biobio', 'biobío', 'bio-bio',
  'araucania', 'araucanía',
  'los rios', 'los ríos',
  'los lagos',
  'aysen', 'aysén',
  'magallanes', 'antartica', 'antártica'
];

function indiceRegion(texto) {
  if (!texto) return 999;
  const t = String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const idx = ORDEN_REGIONES.findIndex(r =>
    t.includes(r.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
  );
  return idx === -1 ? 998 : idx;
}

// Campos fijos del solicitante — todas las variantes posibles de cada campo
const CAMPOS_SOLICITANTE = [
  // Cédula
  'cedula_de_identidad','cedula_identidad','rut','run',
  // Título de la investigación
  'titulo_investigacion','titulo_de_la_investigacion',
  'titulo_proyecto','titulo_del_proyecto',
  'nombre_proyecto','nombre_de_la_investigacion','nombre_investigacion','titulo',
  // Teléfono fijo
  'telefono_fijo_coordinador','fono_fijo','telefono_fijo',
  'fono','telefono','fono_fijo_coordinador',
  // Teléfono móvil
  'telefono_movil_coordinador','fono_movil','celular',
  'telefono_movil','movil','celular_coordinador','fono_celular',
  // Institución
  'nombre_institucion_patrocinante','institucion_patrocinante','institucion',
  'nombre_institucion','organizacion',
];

// Claves relacionadas con región / área protegida
const RE_REGION      = /region|región/i;
const RE_AREA        = /area_protegida|área_protegida|unidad|parque|reserva|monumento|santuario/i;
const RE_REGION_AREA = /region|región|area_protegida|área_protegida|unidad|parque|reserva|monumento|santuario/i;

const ETIQUETA_MAP = {
  // ── Investigación ───────────────────────────────────────────────────────────
  titulo_proyecto:                    'Título de la Investigación',
  titulo_del_proyecto:                'Título de la Investigación',
  titulo_investigacion:               'Título de la Investigación',
  titulo_de_la_investigacion:         'Título de la Investigación',
  nombre_de_la_investigacion:         'Título de la Investigación',
  nombre_investigacion:               'Título de la Investigación',
  nombre_institucion_patrocinante:    'Institución Patrocinante',
  institucion_patrocinante:           'Institución Patrocinante',
  nombre_institucion:                 'Institución',
  // ── Filmación — empresa ─────────────────────────────────────────────────────
  es_una_empresa_productora:          '¿Es empresa productora?',
  nombre_empresa:                     'Nombre de la Empresa (según escritura)',
  nombre_empresa_escritura:           'Nombre de la Empresa (según escritura)',
  razon_social:                       'Razón Social',
  nombre_fantasia:                    'Nombre de Fantasía',
  rut_empresa:                        'RUT de la Empresa',
  sitio_web:                          'Sitio Web',
  representantes_legales:             'Representantes Legales',
  representantes_legales_1:           'Representantes Legales',
  // ── Filmación — proyecto ────────────────────────────────────────────────────
  nombre_del_proyecto:                'Nombre del Proyecto',
  nombre_proyecto:                    'Nombre del Proyecto',
  objetivos_del_proyecto:             'Objetivos del Proyecto',
  medio:                              'Medio a Utilizar',
  Medio:                              'Medio a Utilizar',
  destino_grabacion:                  '¿Destino comercial (grabación)?',
  'destino_grabación':           '¿Destino comercial (grabación)?',
  destino_fotografia:                 '¿Destino comercial (fotografía)?',
  segmentos_proyecto:                 'Segmentos del Proyecto',
  segmentos_proyectos:                'Segmentos del Proyecto',
  financiamiento_publico:             '¿Financiamiento público?',
  financiamiento_publico1:            '¿Financiamiento público? (2)',
  indicar_costos_de_proyecto:         'Costos del Proyecto',
  indicar_costos_del_proyecto:        'Costos del Proyecto',
  utiliza_equipamiento_especial:      '¿Equipamiento especial?',
  hace_uso_de_rpa:                    '¿Hace uso de RPA?',
  equipo_de_trabajo:                  'Equipo de Trabajo',
  cuantos_lugares_abarcara:           'Cantidad de lugares',
  proyecto_anterior_conaf:            '¿Proyecto previo con CONAF?',
  solicita_apoyo_conaf:               '¿Solicita apoyo CONAF?',
  // ── Comunes ─────────────────────────────────────────────────────────────────
  cedula_de_identidad:                'Cédula de Identidad',
  cedula_identidad:                   'Cédula de Identidad',
  rut:                                'RUT',
  telefono_fijo_coordinador:          'Teléfono Fijo',
  telefono_movil_coordinador:         'Teléfono Móvil',
  fono_fijo:                          'Teléfono Fijo',
  fono_movil:                         'Teléfono Móvil',
  celular:                            'Teléfono Móvil',
  correo_electronico:                 'Email',
  email:                              'Email',
  area_protegida:                     'Área Protegida',
  region:                             'Región',
  fecha_inicio_actividades:           'Fecha Inicio Actividades',
  fecha_termino_actividades:          'Fecha Término Actividades',
};

/**
 * Intenta parsear un valor como tabla 2D (array de arrays).
 * Si tiene éxito, devuelve HTML de tabla; si no, devuelve null.
 */
function renderTablaJson(rawVal) {
  if (!rawVal) return null;
  let arr;
  try {
    const str = typeof rawVal === 'string'
      ? rawVal.replace(/'/g, '"').replace(/None/g, 'null')
      : null;
    arr = str ? JSON.parse(str) : (Array.isArray(rawVal) ? rawVal : null);
  } catch { return null; }
  if (!Array.isArray(arr) || arr.length < 2 || !Array.isArray(arr[0])) return null;
  const headers = arr[0];
  const rows = arr.slice(1).filter(row =>
    Array.isArray(row) && row.some(c => c != null && c !== '')
  );
  if (!rows.length) return null;
  return `
    <div style="overflow-x:auto;margin-top:6px">
      <table class="tabla-json">
        <thead><tr>${headers.map(h => `<th>${escHtml(h ?? '')}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(row =>
          `<tr>${headers.map((_, i) => `<td>${escHtml(row[i] ?? '–')}</td>`).join('')}</tr>`
        ).join('')}</tbody>
      </table>
    </div>`;
}

/**
 * Humaniza el valor de un campo para mostrarlo legiblemente:
 * arrays JSON → etiquetas separadas por coma, booleans → Sí/No, etc.
 */
function humanizarValorCampo(raw) {
  if (raw == null || raw === '') return '–';
  // Intentar parsear como array
  let arr;
  try {
    const str = typeof raw === 'string'
      ? raw.replace(/'/g, '"').replace(/None/g, 'null')
      : null;
    arr = str ? JSON.parse(str) : (Array.isArray(raw) ? raw : null);
  } catch { arr = null; }
  if (Array.isArray(arr)) {
    if (arr.length && Array.isArray(arr[0])) return null; // tabla 2D → se maneja aparte
    return arr.filter(x => x != null && x !== '')
              .map(x => String(x).replace(/_/g, ' '))
              .join(', ');
  }
  const s = String(raw).trim();
  if (/^si$|^sí$|^yes$|^true$/i.test(s)) return 'Sí';
  if (/^no$|^false$/i.test(s)) return 'No';
  return s;
}

function etiquetaLegible(key) {
  return ETIQUETA_MAP[key.toLowerCase()]
    || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function renderModalBody(t) {
  const datos = t.datos_raw || {};

  // ── Separar adjuntos ────────────────────────────────────────────────────────
  const adjuntos    = Object.entries(datos).filter(([, v]) => isAdjuntoUrl(v));
  const adjuntosSet = new Set(adjuntos.map(([k]) => k));

  // ── Extraer campos fijos del solicitante ────────────────────────────────────
  const camposSolicitanteSet = new Set(CAMPOS_SOLICITANTE);
  const datosUsados = new Set(adjuntosSet);

  function kvFijo(campo, etiqueta, valor) {
    datosUsados.add(campo);
    const raw = valor ?? datos[campo];
    if (raw == null || raw === '') return ''; // omitir campos vacíos
    const vMostrar = humanizarValorCampo(raw) ?? String(raw);
    return `<div class="modal-kv-item"><span class="label">${escHtml(etiqueta)}</span><span class="value">${escHtml(vMostrar)}</span></div>`;
  }

  // Busca el valor en datos_raw por posibles nombres alternativos.
  // Marca TODAS las claves como usadas para que ninguna aparezca en Datos Adicionales.
  function buscarDato(...claves) {
    let found = null;
    for (const k of claves) {
      datosUsados.add(k);   // siempre excluir de Datos Adicionales
      if (found == null && datos[k] != null && datos[k] !== '') found = datos[k];
    }
    return found;
  }

  // ── Tabla de Regiones y Áreas Protegidas ────────────────────────────────────
  // Agrupa pares: detecta claves con sufijo numérico (region_1 / area_protegida_1)
  // o sin sufijo (region / area_protegida)
  const regAreaMap = {};   // índice → { region, area }
  for (const [k, v] of Object.entries(datos)) {
    if (adjuntosSet.has(k) || !v) continue;
    const matchReg  = k.match(/^(region|regi[oó]n)(?:_(\d+))?$/i);
    const matchArea = k.match(/^(area_protegida|[aá]rea_protegida|unidad|parque|reserva|monumento|santuario)(?:_(\d+))?$/i);
    if (matchReg) {
      const idx = matchReg[2] || '0';
      regAreaMap[idx] = regAreaMap[idx] || {};
      regAreaMap[idx].region = v;
      datosUsados.add(k);
    } else if (matchArea) {
      const idx = matchArea[2] || '0';
      regAreaMap[idx] = regAreaMap[idx] || {};
      regAreaMap[idx].area = v;
      datosUsados.add(k);
    }
  }

  // También acepta claves mixtas (region_de_*, region_area_1, etc.)
  for (const [k, v] of Object.entries(datos)) {
    if (adjuntosSet.has(k) || datosUsados.has(k) || !v) continue;
    if (!RE_REGION_AREA.test(k)) continue;

    // Normalizar valor (manejar objetos y arrays)
    const rawV = typeof v === 'object'
      ? (Array.isArray(v) ? JSON.stringify(v) : (v.nombre || v.name || JSON.stringify(v)))
      : String(v);

    const idx = (k.match(/(\d+)$/) || ['', k])[1];
    regAreaMap[idx] = regAreaMap[idx] || {};

    if (RE_REGION.test(k)) {
      // Patrones donde la CLAVE codifica el nombre de región y el VALOR son las áreas:
      //   region_de_magallanes → Magallanes
      //   region_del_biobio    → Biobío
      //   region_aisen_del_gral_carlos_iba → Aysén  (sin prefijo "de/del")
      const regionKeyMatch = k.match(/^region_(?:de(?:l)?_)?(.+)$/i);
      const regionFromKey  = regionKeyMatch ? humanizarRegion(regionKeyMatch[1]) : null;

      if (regionFromKey) {
        regAreaMap[idx].region = regionFromKey;
        // Si el valor no es "si/true" sino una lista de áreas → va a columna Área
        if (!_IGNORAR_VAL.test(rawV.trim()) && !rawV.startsWith('{')) {
          regAreaMap[idx].area = rawV;
        }
      } else if (!regionKeyMatch || !k.match(/^region_(?:de(?:l)?_)/i)) {
        // No es un patrón region_de/del_ → tratar el VALOR como nombre de región
        regAreaMap[idx].region = rawV;
      }
      // Si era region_de_ALGO pero ALGO no es una región válida → ignorar la fila
    } else {
      regAreaMap[idx].area = rawV;
    }
    datosUsados.add(k);
  }

  // Procesar, humanizar y filtrar las filas
  const filasProc = Object.values(regAreaMap)
    .map(r => {
      const regionNombre = humanizarRegion(r.region);
      const areas        = humanizarArea(r.area);
      if (!regionNombre && !areas.length) return null;  // fila basura → descartar
      return { regionNombre: regionNombre || '–', areas, sortKey: regionNombre || '' };
    })
    .filter(Boolean);

  // Suprimir filas combinadas redundantes:
  // Una fila "Biobío, Aysén, Magallanes" sin áreas se suprime si TODAS sus
  // regiones constituyentes ya aparecen como filas individuales (con o sin áreas).
  const regionesIndividuales = new Set(
    filasProc
      .filter(f => !f.sortKey.includes(','))   // solo filas de una región
      .map(f => f.sortKey.toLowerCase())
  );
  const filasRegion = filasProc
    .filter(f => {
      if (f.areas.length > 0) return true;      // tiene áreas → conservar siempre
      const partes = f.sortKey.split(',').map(s => s.trim().toLowerCase());
      if (partes.length <= 1) return true;       // fila individual sin área → conservar
      // Fila combinada sin áreas: suprimir si todas las partes ya están individuales
      return !partes.every(p => regionesIndividuales.has(p));
    })
    .sort((a, b) => indiceRegion(a.sortKey) - indiceRegion(b.sortKey));

  const tablaRegionesHtml = filasRegion.length ? `
    <div class="modal-section">
      <h3>Regiones y Áreas Protegidas Solicitadas</h3>
      <div class="tabla-regiones-wrap">
        <table class="tabla-regiones">
          <thead><tr><th>Región</th><th>Área Protegida / Unidad</th></tr></thead>
          <tbody>
            ${filasRegion.map(({ regionNombre, areas }) => `
              <tr>
                <td>${escHtml(regionNombre)}</td>
                <td>${areas.length
                  ? areas.map(a => `<div class="area-item">• ${escHtml(a)}</div>`).join('')
                  : '–'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : '';

  // ── Datos adicionales (lo que no se mostró en secciones anteriores) ─────────
  const IGNORAR_ADICIONALES = new Set([
    // Campos internos / sin valor para CONAF
    'aprobar_y_avanzar','derivacion','declaro_reglamento','marca_tiempo',
    'solicitante','responsable','ingrese_su_nombre','tipo_de_identificacion',
    'Declaración_veracidad','declaraci_n_veracidad',
    'regiones','especifique_compromisos',
  ]);
  const datosAdicionalesHtml = Object.entries(datos)
    .filter(([k, v]) =>
      !datosUsados.has(k) &&
      !camposSolicitanteSet.has(k) &&
      !adjuntosSet.has(k) &&
      !IGNORAR_ADICIONALES.has(k) &&
      !k.match(/^[0-9a-f]{10,}$/) &&
      v != null && v !== ''
    )
    .map(([k, v]) => {
      const label = etiquetaLegible(k);
      // Intentar tabla 2D → ocupa fila completa
      const tabla = renderTablaJson(v);
      if (tabla) {
        return `<div class="modal-kv-item modal-kv-item--full">
          <span class="label">${escHtml(label)}</span>${tabla}
        </div>`;
      }
      // Valor humanizado normal
      const display = humanizarValorCampo(v) ?? (typeof v === 'object' ? JSON.stringify(v) : String(v));
      // Texto largo → fila completa con salto de línea
      if (display.length > 80) {
        return `<div class="modal-kv-item modal-kv-item--full">
          <span class="label">${escHtml(label)}</span>
          <span class="value" style="margin-top:4px;line-height:1.6">${escHtml(display)}</span>
        </div>`;
      }
      return `<div class="modal-kv-item"><span class="label">${escHtml(label)}</span><span class="value">${escHtml(display)}</span></div>`;
    }).join('');

  // ── EMAIL con link ──────────────────────────────────────────────────────────
  const emailHtml = t.email_solicitante
    ? `<a href="${safeUrl('mailto:' + t.email_solicitante)}">${escHtml(t.email_solicitante)}</a>`
    : '–';

  // ── Banner de borrador ──────────────────────────────────────────────────────
  const borradorBannerHtml = t.borrador ? `
    <div style="
      background:#FFF3CD;
      border:2px solid #F0A500;
      border-radius:10px;
      padding:16px 20px;
      margin-bottom:18px;
      display:flex;
      align-items:flex-start;
      gap:14px;
    ">
      <span style="font-size:28px;line-height:1">⚠️</span>
      <div>
        <div style="font-weight:800;font-size:15px;color:#7D4E00;margin-bottom:4px">
          Formulario aún no enviado por el solicitante
        </div>
        <div style="font-size:13px;color:#7D4E00;line-height:1.5">
          Este trámite se encuentra en estado <strong>borrador</strong>: el solicitante
          <strong>${escHtml(t.nombre_solicitante || t.email_solicitante || 'desconocido')}</strong>
          inició la solicitud pero <strong>todavía no terminó de completar ni enviar el formulario</strong>.
          <br>No requiere acción de parte de CONAF hasta que el solicitante lo envíe.
        </div>
      </div>
    </div>` : '';

  // ── Banner de duplicado regional ────────────────────────────────────────────
  const relacionados = STATE.duplicados.get(t.id) || [];
  const duplicadoBannerHtml = relacionados.length > 0 ? `
    <div style="
      background:#FFF3CD;
      border:2px solid #F0A500;
      border-radius:10px;
      padding:16px 20px;
      margin-bottom:18px;
      display:flex;
      align-items:flex-start;
      gap:14px;
    ">
      <span style="font-size:28px;line-height:1">⚠️</span>
      <div style="flex:1">
        <div style="font-weight:800;font-size:15px;color:#7D4E00;margin-bottom:6px">
          Posible duplicado regional detectado
        </div>
        <div style="font-size:13px;color:#7D4E00;line-height:1.6;margin-bottom:10px">
          Este trámite podría ser una solicitud regional separada del mismo proyecto.<br>
          El solicitante tiene otros permisos con el mismo proyecto que deben ser consolidados en una sola solicitud:
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${relacionados.map(r => `
            <button onclick="openModal(${r.id})" class="btn-detalle" style="background:#E65100;font-size:12px">
              #${r.id} — ${escHtml((r.regiones_list||[]).join(', ')||'Sin región')}
            </button>`).join('')}
        </div>
      </div>
    </div>` : '';

  // ── Ficha (static/js/ficha.js): las piezas del formulario se arman aquí ──────
  const invEntregas = getArchivosTramite(t.id, t.nombre_solicitante || '');
  const piezas = {
    banners: borradorBannerHtml + duplicadoBannerHtml,
    adjuntos,
    regiones: tablaRegionesHtml,
    nEntregados: invEntregas ? invEntregas.archivos.length : 0,
    entregaOk: !!(invEntregas && invEntregas.archivos.length),
    solicitudHtml: `
    <!-- 2. DATOS DEL SOLICITANTE -->
    <div class="modal-section">
      <h3>Datos del Solicitante</h3>
      <div class="modal-kv">
        <div class="modal-kv-item"><span class="label">Nombre</span><span class="value fw-bold">${escHtml(t.nombre_solicitante || '–')}</span></div>
        <div class="modal-kv-item"><span class="label">Email</span><span class="value">${emailHtml}</span></div>
        ${kvFijo('cedula_de_identidad',        'Cédula de Identidad', buscarDato('cedula_de_identidad','cedula_identidad','rut','run'))}
        ${kvFijo('telefono_fijo_coordinador',  'Teléfono Fijo',       buscarDato('telefono_fijo_coordinador','fono_fijo','telefono_fijo','fono_fijo_coordinador','fono','telefono'))}
        ${kvFijo('telefono_movil_coordinador', 'Teléfono Móvil',      buscarDato('telefono_movil_coordinador','fono_movil','celular','telefono_movil','movil','celular_coordinador','fono_celular'))}
        ${tipoTramite(t) === 'Investigación' ? `
          ${kvFijo('titulo_investigacion',            'Título de la Investigación', buscarDato('titulo_investigacion','titulo_de_la_investigacion','titulo_proyecto','titulo_del_proyecto','nombre_de_la_investigacion','nombre_investigacion','titulo'))}
          ${kvFijo('nombre_institucion_patrocinante', 'Institución Patrocinante',   buscarDato('nombre_institucion_patrocinante','institucion_patrocinante','institucion','nombre_institucion','organizacion'))}
        ` : ''}
        ${tipoTramite(t) === 'Filmación' ? `
          ${kvFijo('es_una_empresa_productora', '¿Es empresa productora?', buscarDato('es_una_empresa_productora'))}
          ${kvFijo('nombre_empresa',            'Nombre Empresa (escritura)', buscarDato('nombre_empresa','nombre_empresa_escritura','razon_social'))}
          ${kvFijo('nombre_fantasia',           'Nombre de Fantasía',         buscarDato('nombre_fantasia'))}
          ${kvFijo('rut_empresa',               'RUT de la Empresa',          buscarDato('rut_empresa'))}
          ${kvFijo('sitio_web',                 'Sitio Web',                  buscarDato('sitio_web'))}
        ` : ''}
      </div>
    </div>

    <!-- 2b. DATOS DEL PROYECTO (solo Filmación) -->
    ${tipoTramite(t) === 'Filmación' ? `
    <div class="modal-section">
      <h3>Datos del Proyecto</h3>
      <div class="modal-kv">
        ${kvFijo('nombre_del_proyecto',           'Nombre del Proyecto',          buscarDato('nombre_del_proyecto','nombre_proyecto'))}
        ${kvFijo('Medio',                         'Medio a Utilizar',             buscarDato('Medio','medio'))}
        ${kvFijo('destino_grabacion',             '¿Destino comercial?',          buscarDato('destino_grabacion','destino_fotografia','destino_grabación'))}
        ${kvFijo('segmentos_proyecto',            'Segmentos',                    buscarDato('segmentos_proyecto','segmentos_proyectos'))}
        ${kvFijo('financiamiento_publico',        '¿Financiamiento público?',     buscarDato('financiamiento_publico','financiamiento_publico1'))}
        ${kvFijo('indicar_costos_del_proyecto',   'Costos del Proyecto',          buscarDato('indicar_costos_del_proyecto','indicar_costos_de_proyecto'))}
        ${kvFijo('cuantos_lugares_abarcara',      'Cantidad de lugares',          buscarDato('cuantos_lugares_abarcara'))}
        ${kvFijo('utiliza_equipamiento_especial', '¿Equipamiento especial?',      buscarDato('utiliza_equipamiento_especial'))}
        ${kvFijo('hace_uso_de_rpa',               '¿Hace uso de RPA?',           buscarDato('hace_uso_de_rpa'))}
        ${kvFijo('solicita_apoyo_conaf',          '¿Solicita apoyo CONAF?',       buscarDato('solicita_apoyo_conaf'))}
        ${kvFijo('proyecto_anterior_conaf',       '¿Proyecto previo con CONAF?',  buscarDato('proyecto_anterior_conaf'))}
      </div>
      ${(buscarDato('objetivos_del_proyecto') ? `
        <div class="modal-kv-item modal-kv-item--full" style="padding-top:8px">
          <span class="label">Objetivos del Proyecto</span>
          <span class="value" style="margin-top:4px;line-height:1.5">${escHtml(buscarDato('objetivos_del_proyecto'))}</span>
        </div>` : '')}
      ${(buscarDato('especifique_apoyo') ? `
        <div class="modal-kv-item modal-kv-item--full" style="padding-top:8px">
          <span class="label">Detalle apoyo solicitado</span>
          <span class="value" style="margin-top:4px;line-height:1.5">${escHtml(buscarDato('especifique_apoyo'))}</span>
        </div>` : '')}
    </div>

    <!-- 2c. EQUIPO DE TRABAJO (Filmación) -->
    ${(() => {
      const equipoRaw   = buscarDato('equipo_de_trabajo');
      const repRaw      = buscarDato('representantes_legales','representantes_legales_1');
      const equipoTabla = renderTablaJson(equipoRaw);
      const repTabla    = renderTablaJson(repRaw);
      if (!equipoTabla && !repTabla) return '';
      const partes = [];
      if (equipoTabla) partes.push('<div style="margin-bottom:12px"><strong>Equipo de Trabajo</strong>' + equipoTabla + '</div>');
      if (repTabla)    partes.push('<div><strong>Representantes Legales</strong>' + repTabla + '</div>');
      return '<div class="modal-section"><h3>Equipo y Representantes</h3>' + partes.join('') + '</div>';
    })()}
    ` : ''}


    ${datosAdicionalesHtml ? `
    <div class="modal-section">
      <h3>Otros datos del formulario</h3>
      <div class="modal-kv">${datosAdicionalesHtml}</div>
    </div>` : ''}`,
    entregados: `
    <!-- 9. ARCHIVOS INVESTIGACIONES (Numeral 6) -->
    ${(() => {
      const inv = getArchivosTramite(t.id, t.nombre_solicitante || '');
      if (!inv || inv.archivos.length === 0) return '';
      const fileRows = inv.archivos.map(a =>
        `<tr><td style="padding:7px 10px"><a href="${safeUrl(a.url)}" target="_blank" style="color:var(--accent)">${escHtml(a.nombre)}</a></td><td style="padding:7px 10px;color:var(--muted);text-align:right;white-space:nowrap">${escHtml(a.size_kb)} KB</td></tr>`
      ).join('');
      return `<div class="detail-section" style="margin-top:18px">
    <div class="detail-section-title">📁 Archivos entregados (Numeral 6)</div>
    <table style="width:100%;font-size:13px;border-collapse:collapse">
      <thead><tr style="background:var(--surface2)">
        <th style="padding:8px 10px;text-align:left;font-size:12px">Archivo</th>
        <th style="padding:8px 10px;text-align:right;font-size:12px">Tamaño</th>
      </tr></thead>
      <tbody>${fileRows}</tbody>
    </table>
  </div>`;
    })()}

`,
    cumplimiento: `
    <!-- 10. CUMPLIMIENTO INVESTIGACIÓN (solo para trámites de investigación) -->
    ${(() => {
      const IDS_INV = new Set([517, 692, 1992]);
      if (!IDS_INV.has(t.proceso_id)) return '';

      const hoy = new Date();
      const rl  = t.regiones_list || [];

      // Tipo de cobertura regional
      let regionBadge = '';
      if (rl.length === 0) {
        regionBadge = '<span class="badge-en-plazo">Sin información de región</span>';
      } else if (rl.length === 1) {
        regionBadge = `<span class="badge-regional">🗺 Regional — ${escHtml(rl[0])}</span>`;
      } else {
        regionBadge = `<span class="badge-multiregional">🗺 Multirregional — ${escHtml(rl.join(', '))}</span>`;
      }

      // Plazo 3 años desde fecha_termino
      let plazoBadge = '';
      let plazoRow   = '';
      if (t.fecha_termino) {
        const fin   = new Date(t.fecha_termino);
        const plazo = new Date(fin.getFullYear() + 3, fin.getMonth(), fin.getDate());
        const plazoStr = formatDate(plazo.toISOString());
        const vencido  = hoy > plazo;
        plazoBadge = vencido
          ? `<span class="badge-vencido">❌ Plazo vencido el ${plazoStr}</span>`
          : `<span class="badge-en-plazo">⏳ Plazo hasta ${plazoStr}</span>`;
        plazoRow = `<div class="modal-kv-item">
          <span class="label">Plazo entrega resultados</span>
          <span class="value">${plazoBadge}</span>
        </div>`;
      }

      // Estado de entrega de resultados
      const inv = getArchivosTramite(t.id, t.nombre_solicitante || '');
      const tieneArchivos = inv && inv.archivos.length > 0;
      const entregaBadge = tieneArchivos
        ? `<span class="badge-entregado">✅ Resultados entregados (${inv.archivos.length} archivo${inv.archivos.length !== 1 ? 's' : ''})</span>`
        : `<span class="badge-vencido" style="background:#fff3cd;color:#856404;border-color:#ffc107">⚠️ Sin resultados entregados</span>`;

      return `<div class="detail-section" style="margin-top:18px">
    <div class="detail-section-title">📋 Cumplimiento — Numeral 6 Reglamento de Investigación</div>
    <div class="modal-kv" style="margin-top:10px">
      <div class="modal-kv-item">
        <span class="label">Cobertura regional</span>
        <span class="value">${regionBadge}</span>
      </div>
      ${plazoRow}
      <div class="modal-kv-item">
        <span class="label">Entrega de resultados</span>
        <span class="value">${entregaBadge}</span>
      </div>
    </div>
  </div>`;
    })()}`,
  };
  $('modal-tramite-body').innerHTML = Ficha.html(t, piezas);
  Ficha.activar(t);
}

// ─── HISTORIAL INVESTIGACIONES ────────────────────────────────────────────────
function renderHistoricoInvestigaciones() {
  const contenedor = $('tabla-historico-inv');
  if (!contenedor) return;

  const IDS_INV = new Set([517, 692, 1992]);
  const ESTADOS_APROBADOS = new Set(['completado', 'terminado', 'rechazado']);

  const historicos = STATE.tramites.filter(t =>
    IDS_INV.has(t.proceso_id) && ESTADOS_APROBADOS.has(t.estado)
  );

  if (historicos.length === 0) {
    contenedor.innerHTML = '<p style="color:var(--muted);font-size:13px">No hay permisos de investigación completados o rechazados en el período cargado.</p>';
    return;
  }

  const hoy = new Date();

  function plazo3anos(fechaStr) {
    if (!fechaStr) return null;
    const d = new Date(fechaStr);
    if (isNaN(d)) return null;
    return new Date(d.getFullYear() + 3, d.getMonth(), d.getDate());
  }

  function tipoRegion(t) {
    const rl = t.regiones_list || [];
    if (rl.length === 0) return { label: '–', clase: '' };
    if (rl.length === 1) return { label: `Regional<br><small>${escHtml(rl[0])}</small>`, clase: 'badge-regional' };
    return { label: `Multirregional<br><small>${escHtml(rl.join(', '))}</small>`, clase: 'badge-multiregional' };
  }

  // Estado de entrega de resultados (solo aplica a completados, no rechazados)
  function estadoEntrega(t) {
    if (t.estado === 'rechazado') {
      return { html: '<span class="badge-rechazado-hist">✗ Rechazado</span>', sort: 3 };
    }
    const inv = getArchivosTramite(t.id, t.nombre_solicitante || '');
    const tieneArchivos = inv && inv.archivos.length > 0;
    if (tieneArchivos) {
      const url = inv.url;
      return {
        html: `<a href="${safeUrl(url)}" target="_blank" class="badge-entregado">✅ Entregados<br><small>${inv.archivos.length} archivo(s)</small></a>`,
        sort: 0,
      };
    }
    const plazo = plazo3anos(t.fecha_termino);
    if (!plazo) return { html: '<span class="badge-en-plazo">⏳ Sin plazo</span>', sort: 2 };
    if (hoy > plazo) {
      return {
        html: `<span class="badge-vencido">❌ Vencido<br><small>desde ${formatDate(plazo.toISOString())}</small></span>`,
        sort: 1,
      };
    }
    return {
      html: `<span class="badge-en-plazo">⏳ En plazo<br><small>hasta ${formatDate(plazo.toISOString())}</small></span>`,
      sort: 2,
    };
  }

  // Ordenar: primero vencidos sin archivos, luego en plazo, luego entregados, luego rechazados
  const rows = historicos.map(t => {
    const plazo  = plazo3anos(t.fecha_termino);
    const region = tipoRegion(t);
    const entrega = estadoEntrega(t);
    return { t, plazo, region, entrega };
  }).sort((a, b) => a.entrega.sort - b.entrega.sort || (a.plazo || 0) - (b.plazo || 0));

  const htmlRows = rows.map(({ t, plazo, region, entrega }) => `
    <tr>
      <td style="white-space:nowrap"><button class="btn-detalle" onclick="openModal(${t.id})">#${t.id}</button></td>
      <td>${escHtml(t.nombre_solicitante || '–')}</td>
      <td>${t.estado === 'rechazado'
        ? '<span class="badge" style="background:#f8d7da;color:#721c24">Rechazado</span>'
        : '<span class="badge" style="background:#d4edda;color:#155724">Aprobado</span>'}</td>
      <td>${region.clase
        ? `<span class="${region.clase}">${region.label}</span>`
        : '–'}</td>
      <td style="white-space:nowrap">${formatDate(t.fecha_termino)}</td>
      <td style="white-space:nowrap">${plazo ? formatDate(plazo.toISOString()) : '–'}</td>
      <td>${entrega.html}</td>
    </tr>`).join('');

  const entregados  = rows.filter(r => r.entrega.sort === 0).length;
  const vencidos    = rows.filter(r => r.entrega.sort === 1).length;
  const enPlazo     = rows.filter(r => r.entrega.sort === 2).length;
  const rechazados  = rows.filter(r => r.entrega.sort === 3).length;

  contenedor.innerHTML = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;font-size:13px">
      <span class="badge-entregado">✅ ${entregados} entregados</span>
      <span class="badge-vencido">❌ ${vencidos} vencidos</span>
      <span class="badge-en-plazo">⏳ ${enPlazo} en plazo</span>
      <span style="background:#e2e3e5;color:#383d41;border-radius:10px;padding:3px 10px">✗ ${rechazados} rechazados</span>
    </div>
    <div style="overflow-x:auto">
    <table>
      <thead><tr>
        <th>ID</th>
        <th>Investigador</th>
        <th>Estado</th>
        <th>Cobertura Regional</th>
        <th>Fin Permiso</th>
        <th>Plazo 3 Años</th>
        <th>Resultados</th>
      </tr></thead>
      <tbody>${htmlRows}</tbody>
    </table>
    </div>
    <p style="font-size:11px;color:var(--muted);margin-top:8px">
      * Solo se muestran permisos del período cargado. El plazo de 3 años se cuenta desde la fecha de término del permiso.
    </p>`;
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
function buildExportUrl(prefix = 'export') {
  const estado  = $(prefix + '-estado').value;
  const proceso = $(prefix + '-proceso').value;
  const fIni    = $(prefix + '-fecha-inicio').value;
  const fFin    = $(prefix + '-fecha-fin').value;
  const tIni    = prefix === 'export' ? $('export-termino-inicio').value : null;
  const tFin    = prefix === 'export' ? $('export-termino-fin').value : null;

  // Convertir grupo (filmacion/investigacion) al ID principal para el backend
  const procesoIdExport = proceso && GRUPOS_PROCESO[proceso]
    ? [...GRUPOS_PROCESO[proceso].ids].at(-1)  // el más reciente (mayor ID)
    : proceso;

  const params = new URLSearchParams();
  if (estado)          params.set('estado', estado);
  if (procesoIdExport) params.set('proceso_id', procesoIdExport);
  if (fIni)    params.set('created_at_start', dateToTimestamp(fIni));
  if (fFin)    params.set('created_at_end', dateToTimestamp(fFin + 'T23:59:59'));
  if (tIni)    params.set('ended_at_start', dateToTimestamp(tIni));
  if (tFin)    params.set('ended_at_end', dateToTimestamp(tFin + 'T23:59:59'));

  return `/api/export/excel?${params}`;
}

// ─── CORREOS (Gmail Compose) ───────────────────────────────────────────────────

STATE.correos = [];   // { ...caso, _status: 'pendiente'|'abierto'|'omitido', _error: '' }

function buildEmailText(nombre, titulo, anios, region) {
  const aniosFmt = String(anios).replace(/\.0$/, '');
  const regionStr = region || 'el SNAP';
  return `Estimado/a ${nombre},

Por medio de la presente, el Departamento de Gestión de Áreas Protegidas de CONAF le informa que han transcurrido más de ${aniosFmt} años desde la fecha de término de actividades de terreno de su investigación:

"${titulo}"

realizada en el Sistema Nacional de Áreas Protegidas (SNAP) — ${regionStr}.

De acuerdo con el Numeral 6 del Reglamento de Investigación en Áreas Protegidas del Estado:

"La no entrega, en un plazo máximo de tres años de finalizada la investigación de terreno, de los informes, separatas y material de holotipos estipulados en este instructivo inhabilitará a los/las investigadores/as involucrados/as para participar en nuevas investigaciones en el SNAP."

En consecuencia, le solicitamos que a la brevedad posible remita los siguientes documentos:

1. Informe final de la investigación
2. Paper(s) o publicaciones científicas derivadas de la investigación (en formato PDF)
3. Material complementario (holotipos, colecciones biológicas, datos de campo u otro material estipulado en el instructivo)

Por favor, envíe los documentos respondiendo este correo electrónico.

Agradecemos su colaboración y quedamos atentos/as a sus consultas.

Atentamente,
Ignacio Sebastián Díaz Hormazábal
Jefe del Departamento de Gestión de Áreas Protegidas
CONAF – Corporación Nacional Forestal`;
}

function correoAbrirGmail(i) {
  const c = STATE.correos[i];
  const subject = 'CONAF – Solicitud de entrega de informes y publicaciones de investigación en el SNAP';
  const body    = buildEmailText(c.nombre_solicitante, c.titulo_investigacion, c.anios_transcurridos, c.region);
  const url = 'https://mail.google.com/mail/?view=cm&fs=1'
    + '&to='  + encodeURIComponent(c.email_solicitante)
    + '&su='  + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(body);
  window.open(url, '_blank');
  STATE.correos[i]._status = 'abierto';
  correoRenderLista();
}

function buildEmailHtml(nombre, titulo, anios, region) {
  // Datos del solicitante escapados: este HTML se inserta con innerHTML en la vista previa
  nombre = escHtml(nombre);
  titulo = escHtml(titulo);
  const aniosFmt = escHtml(String(anios).replace(/\.0$/, ''));
  const regionStr = escHtml(region || 'el SNAP');
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:680px;margin:0 auto;padding:20px">
<p>Estimado/a <strong>${nombre}</strong>,</p>
<p>Por medio de la presente, el Departamento de Gestión de Áreas Protegidas de CONAF le informa que han transcurrido más de <strong>${aniosFmt} años</strong> desde la fecha de término de actividades de terreno de su investigación:</p>
<blockquote style="border-left:4px solid #1B4F1E;padding:12px 16px;background:#f5faf5;font-style:italic;margin:16px 0">"${titulo}"</blockquote>
<p>realizada en el Sistema Nacional de Áreas Protegidas (SNAP) — <strong>${regionStr}</strong>.</p>
<p>De acuerdo con el <strong>Numeral 6 del Reglamento de Investigación en Áreas Protegidas del Estado</strong>:</p>
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
<p style="font-size:13px;color:#555">
  <strong>Ignacio Sebastián Díaz Hormazábal</strong><br>
  <span style="color:#555">Jefe del Departamento de Gestión de Áreas Protegidas</span><br>
  <strong>CONAF – Corporación Nacional Forestal</strong>
</p>
</body></html>`;
}

function correoUpdateStats() {
  const total    = STATE.correos.length;
  const abiertos = STATE.correos.filter(c => c._status === 'abierto').length;
  const omitidos = STATE.correos.filter(c => c._status === 'omitido').length;
  const pct = total ? Math.round((abiertos + omitidos) / total * 100) : 0;
  $('correos-stats').textContent =
    `✉️ ${abiertos} abiertos en Gmail · ⏭ ${omitidos} omitidos · ⏳ ${total - abiertos - omitidos} pendientes de ${total}`;
  $('correos-progreso-fill').style.width = pct + '%';
}

function correoRenderLista() {
  const el = $('correos-lista');
  if (!STATE.correos.length) {
    el.innerHTML = '<div class="empty-msg">No hay casos cargados.</div>';
    return;
  }
  correoUpdateStats();
  const rows = STATE.correos.map((c, i) => {
    const st = c._status;
    const stBadge = st === 'abierto'  ? '<span class="badge-correo-enviado">✉️ Abierto en Gmail</span>'
                  : st === 'omitido' ? '<span class="badge-correo-omitido">⏭ Omitido</span>'
                  : '<span class="badge-correo-pendiente">⏳ Pendiente</span>';
    const acciones = st === 'pendiente'
      ? `<button class="btn-correo-ver"    onclick="correoVer(${i})">👁 Ver</button>
         <button class="btn-correo-enviar" onclick="correoAbrirGmail(${i})">✉️ Abrir en Gmail</button>
         <button class="btn-correo-omitir" onclick="correoOmitir(${i})">⏭ Omitir</button>`
      : `<button class="btn-correo-ver"    onclick="correoVer(${i})">👁 Ver</button>
         <button class="btn-correo-enviar" onclick="correoAbrirGmail(${i})">↩ Reabrir</button>`;
    const errorHtml = c._error ? `<div class="correo-error">${escHtml(c._error)}</div>` : '';
    return `<tr id="correo-row-${i}" class="correo-row correo-row--${escHtml(st)}">
      <td style="font-size:12px;font-weight:700;color:var(--muted)">#${escHtml(c.id)}</td>
      <td><strong>${escHtml(c.nombre_solicitante || '–')}</strong></td>
      <td><a href="${safeUrl('mailto:' + c.email_solicitante)}" style="color:inherit">${escHtml(c.email_solicitante || '–')}</a></td>
      <td class="correo-titulo">${escHtml((c.titulo_investigacion || '–').slice(0,70))}${c.titulo_investigacion?.length > 70 ? '…' : ''}</td>
      <td style="white-space:nowrap"><span class="badge-compliance-${c.anios_transcurridos >= 5 ? 'critico' : 'moderado'}">${escHtml(c.anios_transcurridos)} años</span></td>
      <td>${escHtml(c.region || '–')}</td>
      <td>${stBadge}${errorHtml}</td>
      <td class="correo-acciones">${acciones}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `<table class="correo-tabla">
    <thead><tr>
      <th>ID</th><th>Nombre</th><th>Email</th><th>Título</th><th>Años</th><th>Región</th><th>Estado</th><th>Acciones</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function correoVer(i) {
  const c = STATE.correos[i];
  const html = buildEmailHtml(c.nombre_solicitante, c.titulo_investigacion, c.anios_transcurridos, c.region);
  $('preview-meta').innerHTML =
    `<strong>Para:</strong> ${escHtml(c.nombre_solicitante)} &lt;${escHtml(c.email_solicitante)}&gt;<br>
     <strong>Asunto:</strong> CONAF – Solicitud de entrega de informes y publicaciones de investigación en el SNAP`;
  $('preview-html').innerHTML = html;
  $('correos-preview').style.display = '';
  $('correos-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function correoOmitir(i) {
  STATE.correos[i]._status = 'omitido';
  correoRenderLista();
}

async function abrirModalCorreos() {
  $('modal-correos').style.display = 'flex';
}

// Make correo functions global for inline onclick
window.correoVer             = correoVer;
window.correoAbrirGmail      = correoAbrirGmail;
window.correoOmitir          = correoOmitir;
window.renderTablaEntregadas = renderTablaEntregadas;

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Tabs
  qsa('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.tab-btn').forEach(b => b.classList.remove('active'));
      qsa('.tab-content').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tipo) setTipo(btn.dataset.tipo);
    });
  });

  // Filtro de tipo en el dashboard
  qsa('.dash-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.dash-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      STATE.dashFilter = btn.dataset.filter;
      renderDashboard();
    });
  });

  // Barra de ámbito del Resumen (región, área protegida, a mi cargo)
  $('filtro-regiones').addEventListener('change', e => {
    if (e.target.id === 'amb-region') setAmbito(e.target.value || null);
    else if (e.target.id === 'amb-area') setAmbito(STATE.region, e.target.value || null);
    else if (e.target.id === 'amb-mio') { STATE.mio = e.target.checked; _guardarAmbitoUrl(); renderDashboard(); }
  });
  $('filtro-regiones').addEventListener('click', e => {
    if (e.target.closest('#amb-limpiar')) { STATE.mio = false; setAmbito(null); }
  });

  // Rango de años — validar que desde ≤ hasta
  $('rango-desde').addEventListener('change', () => {
    if (parseInt($('rango-desde').value) > parseInt($('rango-hasta').value))
      $('rango-hasta').value = $('rango-desde').value;
  });
  $('rango-hasta').addEventListener('change', () => {
    if (parseInt($('rango-desde').value) > parseInt($('rango-hasta').value))
      $('rango-desde').value = $('rango-hasta').value;
  });

  // Refresh
  $('btn-refresh').addEventListener('click', async () => {
    $('btn-refresh').classList.add('spinning');
    try {
      const { desde, hasta } = rangoActual();
      // Mismo rango ya cargado → forzar datos frescos; rango nuevo → puede venir de la caché
      const fresco = `${desde}-${hasta}` === STATE.rangoCargado;
      showLoading(`Actualizando datos (${desde}–${hasta})…`);
      try {
        STATE.tramites = filtrarRango(await loadTramites({ ...paramsRango(), fresco: fresco ? 'true' : '' }));
        STATE.rangoCargado = `${desde}-${hasta}`;
      } catch {
        showLoading('Descargando todos los trámites…');
        STATE.tramites = filtrarRango(await loadTramites());
      }
      STATE.duplicados = detectarDuplicadosRegionales(STATE.tramites);
      updateLastUpdate();
      renderDashboard();
      renderPortada();
    } catch (err) {
      alert('Error actualizando: ' + err.message);
    } finally {
      hideLoading();
      $('btn-refresh').classList.remove('spinning');
    }
  });


  // Modal close
  $('modal-close').addEventListener('click', () => { $('modal-tramite').style.display = 'none'; });
  $('modal-tramite').addEventListener('click', e => {
    if (e.target === $('modal-tramite')) $('modal-tramite').style.display = 'none';
  });

  // Export big button
  $('btn-descargar-excel').addEventListener('click', () => {
    const url = buildExportUrl('export');
    window.location.href = url;
  });

  // Cumplimiento – descarga directa
  $('btn-descargar-compliance').addEventListener('click', () => {
    window.location.href = '/api/export/compliance/excel';
  });

  // Correos modal
  $('btn-abrir-correos')?.addEventListener('click', abrirModalCorreos);   // sección desactivable (ENVIO_CORREOS_ACTIVO)
  $('modal-correos-close').addEventListener('click', () => { $('modal-correos').style.display = 'none'; });
  $('modal-correos').addEventListener('click', e => { if (e.target === $('modal-correos')) $('modal-correos').style.display = 'none'; });
  $('preview-close').addEventListener('click', () => { $('correos-preview').style.display = 'none'; });

  $('btn-cargar-correos').addEventListener('click', async () => {
    const btn = $('btn-cargar-correos');
    const statusEl = $('correos-load-status');
    btn.disabled = true;
    btn.textContent = '⏳ Cargando…';
    statusEl.textContent = 'Descargando lista (puede tardar 1–2 min)…';
    $('correos-progreso').style.display = 'none';
    try {
      const data = await fetchJSON('/api/compliance/investigacion');
      if (!data.ok) throw new Error(data.error);
      STATE.correos = (data.data || []).map(c => ({ ...c, _status: 'pendiente', _error: '' }));
      statusEl.textContent = `${STATE.correos.length} casos cargados`;
      $('correos-progreso').style.display = '';
      correoRenderLista();
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 Recargar';
    }
  });

  // Start
  init();
});

// Make openModal global for inline onclick
window.openModal = openModal;
