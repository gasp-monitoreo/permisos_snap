/* ═══════════════════════════════════════════════
   CONAF – Sistema de Seguimiento de Trámites
   app.js – Lógica principal
   ═══════════════════════════════════════════════ */

'use strict';

// ─── Estado global ────────────────────────────────────────────────────────────
const STATE = {
  tramites: [],
  tramitesFiltrados: [],
  procesos: [],
  procesoMap: {},
  charts: {},
  searchType: 'id',
  investigaciones: {},
};

// ─── Investigaciones helpers ──────────────────────────────────────────────────
const _normInv = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();

function getArchivosTramite(tramiteId, nombre) {
  const idStr = String(tramiteId || '');
  // 1) Coincidencia exacta por ID en estructura anidada
  if (idStr) {
    for (const [folder, data] of Object.entries(STATE.investigaciones)) {
      if (data.tipo === 'nested' && data.ids && data.ids[idStr]) {
        return {
          folder, tipo: 'nested', id: idStr,
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
      // En nested: si el ID no matcheó, devolver todos los archivos del primer ID
      if (data.tipo === 'nested' && data.ids) {
        const firstId = Object.keys(data.ids)[0];
        const archivos = firstId
          ? Object.values(data.ids).flat()
          : [];
        return {
          folder, tipo: 'nested', id: firstId || null,
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
    const data = await fetchJSON('/api/investigaciones/index');
    if (data.ok) STATE.investigaciones = data.data || {};
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
  if (isNaN(d)) return str;
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatDateTime(str) {
  if (!str) return '–';
  const d = new Date(str);
  if (isNaN(d)) return str;
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
  const badge = `<span class="badge ${cls}">${labels[estado] || estado}</span>`;
  if (opts.recepcionPendiente) {
    return badge + `<span class="badge-nota-recepcion" title="CONAF aprobó — pendiente recepción formal por parte del solicitante">📬 Recepción solicitante</span>`;
  }
  return badge;
}

function progressHtml(pct) {
  return `
    <div style="display:flex;align-items:center;gap:6px">
      <div class="progress-bar-wrap" style="flex:1">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>
      <span style="font-size:11px;font-weight:700;min-width:30px">${pct}%</span>
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
function tramiteEsVencido(t) {
  if (t.estado === 'rechazado' || t.estado === 'completado') return false;
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

  const norms = items
    .filter(p => p && !_IGNORAR_VAL.test(p))
    .map(p => {
      // Código romano exacto
      const hit = REGIONES_CHILE.find(r => r.codigo === p.toUpperCase());
      if (hit) return hit.nombre;
      // Slug o nombre parcial
      const pn = p.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[_\-\s]/g, '');
      const hit2 = REGIONES_CHILE.find(r => {
        const rn = r.nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s']/g, '');
        return rn === pn || rn.includes(pn) || pn.includes(rn.split(' ')[0]);
      });
      if (hit2) return hit2.nombre;
      return null;  // Valor no reconocido como región → descartar
    })
    .filter(Boolean);  // eliminar nulls

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
  return STATE.procesos;
}

async function loadTramites(params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v); });
  const data = await fetchJSON(`/api/tramites?${qs}`);
  if (!data.ok) throw new Error(data.error);
  return data.data || [];
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
    try {
      STATE.tramites = filtrarRango(await loadTramites(paramsRango()));
      cargado = true;
    } catch {
      // Reintento sin filtro de rango
      try {
        showLoading('Reintentando sin filtro de fechas…');
        STATE.tramites = filtrarRango(await loadTramites());
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

    STATE.tramitesFiltrados = [...STATE.tramites];
    updateLastUpdate();
    renderDashboard();
    renderTramitesTable(STATE.tramitesFiltrados);
    populateRegionSelect();
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
  $('last-update').textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-CL');
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
  $('filter-proceso').innerHTML = html;
  if ($('export-proceso')) $('export-proceso').innerHTML = html;
}

function populateRegionSelect() {
  // Recolectar regiones individuales de regiones_list (no el campo combinado "region")
  const regionesSet = new Set();
  STATE.tramites.forEach(t => {
    (t.regiones_list || []).forEach(r => { if (r) regionesSet.add(r); });
  });
  // Ordenar de norte a sur según REGIONES_CHILE
  const ordenadas = REGIONES_CHILE
    .map(r => r.nombre)
    .filter(n => regionesSet.has(n));
  // Agregar al final cualquier región que no esté en REGIONES_CHILE (por si acaso)
  regionesSet.forEach(r => { if (!ordenadas.includes(r)) ordenadas.push(r); });

  const opts = ordenadas.map(r => `<option value="${r}">${r}</option>`).join('');
  $('filter-region').innerHTML = '<option value="">Todas</option>' + opts;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function renderDashboard() {
  const ts = STATE.tramites;
  const total = ts.length;
  const pendientes = ts.filter(t => t.estado === 'pendiente').length;
  const completados = ts.filter(t => t.estado === 'completado').length;
  const rechazados = ts.filter(t => t.estado === 'rechazado').length;
  const avgAvance = total ? Math.round(ts.reduce((s, t) => s + t.porcentaje_avance, 0) / total) : 0;

  const vencidos = ts.filter(t => tramiteEsVencido(t)).length;

  $('kpi-total').textContent = total;
  $('kpi-pendiente').textContent = pendientes;
  $('kpi-completado').textContent = completados;
  $('kpi-rechazado').textContent = rechazados;
  $('kpi-avance').textContent = avgAvance + '%';
  $('kpi-vencidos').textContent = vencidos;

  renderChartEstados({ pendientes, completados, rechazados });
  renderChartProcesos();
  renderChartAvance();
  renderTablaVencimientos();
  renderTablaRecientes();
  renderTiemposRespuesta();
}

const IDS_INVESTIGACION = new Set([517, 692, 1992]);
const IDS_FILMACION     = new Set([437, 585, 631, 632, 672]);

function calcularDias(t) {
  const inicio = t.fecha_inicio;
  const fin    = t.fecha_termino || t.fecha_modificacion;
  if (!inicio || !fin) return null;
  const ms = new Date(fin) - new Date(inicio);
  if (isNaN(ms) || ms <= 0) return null;
  return Math.round(ms / 86400000); // días
}

function promediosDias(lista) {
  const completados = lista.filter(t => t.estado === 'completado').map(calcularDias).filter(d => d !== null);
  const rechazados  = lista.filter(t => t.estado === 'rechazado' ).map(calcularDias).filter(d => d !== null);
  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  return {
    completados: { n: completados.length, avg: avg(completados) },
    rechazados:  { n: rechazados.length,  avg: avg(rechazados)  },
  };
}

function fmtDias(val) {
  if (val === null) return '<span style="color:var(--muted)">–</span>';
  if (val < 30)   return `<strong>${val} días</strong>`;
  const meses = (val / 30.44).toFixed(1);
  return `<strong>${val} días</strong> <span style="color:var(--muted)">(≈ ${meses} meses)</span>`;
}

function renderTiemposRespuesta() {
  const ts   = STATE.tramites;
  const inv  = ts.filter(t => IDS_INVESTIGACION.has(t.proceso_id));
  const film = ts.filter(t => IDS_FILMACION.has(t.proceso_id));
  const pInv  = promediosDias(inv);
  const pFilm = promediosDias(film);

  const row = (label, p) => `
    <tr>
      <td style="font-weight:600;padding:10px 14px">${label}</td>
      <td style="padding:10px 14px;color:#155724">${fmtDias(p.completados.avg)}
        <span style="font-size:11px;color:var(--muted)">(n=${p.completados.n})</span></td>
      <td style="padding:10px 14px;color:#721c24">${fmtDias(p.rechazados.avg)}
        <span style="font-size:11px;color:var(--muted)">(n=${p.rechazados.n})</span></td>
    </tr>`;

  $('tabla-tiempos-respuesta').innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:var(--surface2);font-size:12px;text-transform:uppercase;letter-spacing:.5px">
          <th style="padding:10px 14px;text-align:left;font-weight:600;color:#fff">Tipo de trámite</th>
          <th style="padding:10px 14px;text-align:left;font-weight:600;color:#fff">✅ Completados</th>
          <th style="padding:10px 14px;text-align:left;font-weight:600;color:#fff">❌ Rechazados</th>
        </tr>
      </thead>
      <tbody>
        ${row('🔬 Investigación', pInv)}
        ${row('🎥 Filmación', pFilm)}
      </tbody>
    </table>
    <div style="font-size:11px;color:var(--muted);padding:8px 14px">
      Tiempo medido desde fecha de inicio hasta fecha de término o última modificación del trámite, en el rango de años seleccionado.
    </div>`;
}

function renderChartEstados({ pendientes, completados, rechazados }) {
  const ctx = $('chart-estados').getContext('2d');
  if (STATE.charts.estados) STATE.charts.estados.destroy();
  STATE.charts.estados = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Pendientes', 'Completados', 'Rechazados'],
      datasets: [{
        data: [pendientes, completados, rechazados],
        backgroundColor: ['#FFC107', '#28A745', '#DC3545'],
        borderWidth: 2,
        borderColor: '#fff',
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { padding: 16, font: { size: 12 } } },
        tooltip: { callbacks: {
          label: ctx => ` ${ctx.label}: ${ctx.raw} (${Math.round(ctx.raw / (ctx.dataset.data.reduce((a,b)=>a+b,0)||1) * 100)}%)`
        }}
      }
    }
  });
}

function renderChartProcesos() {
  const ctx = $('chart-procesos').getContext('2d');
  if (STATE.charts.procesos) STATE.charts.procesos.destroy();

  // Contar tramites por región y estado — un tramite puede contar en varias regiones
  const byRegion = {};
  REGIONES_CHILE.forEach(r => {
    byRegion[r.nombre] = { pendiente: 0, completado: 0, rechazado: 0 };
  });

  STATE.tramites.forEach(t => {
    const regs = (t.regiones_list || []);
    // Normalizar nombres para hacer match con REGIONES_CHILE
    const matched = new Set();
    regs.forEach(raw => {
      const hit = REGIONES_CHILE.find(r =>
        r.nombre.toLowerCase() === raw.toLowerCase() ||
        raw.toLowerCase().includes(r.nombre.toLowerCase().split(' ')[0].toLowerCase())
      );
      if (hit) matched.add(hit.nombre);
    });
    matched.forEach(nombre => {
      if (!byRegion[nombre]) return;
      const est = t.estado === 'rechazado' ? 'rechazado'
                : t.estado === 'completado' ? 'completado'
                : 'pendiente';
      byRegion[nombre][est]++;
    });
  });

  // Solo regiones con al menos 1 tramite, en orden N→S
  const labels = REGIONES_CHILE.map(r => r.nombre).filter(n =>
    byRegion[n] && (byRegion[n].pendiente + byRegion[n].completado + byRegion[n].rechazado) > 0
  );

  STATE.charts.procesos = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Pendiente',
          data: labels.map(n => byRegion[n].pendiente),
          backgroundColor: '#FFC107',
          borderRadius: 2,
        },
        {
          label: 'Completado',
          data: labels.map(n => byRegion[n].completado),
          backgroundColor: '#2E7D32',
          borderRadius: 2,
        },
        {
          label: 'Rechazado',
          data: labels.map(n => byRegion[n].rechazado),
          backgroundColor: '#E53935',
          borderRadius: 2,
        },
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } }
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 9 }, maxRotation: 45 } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }
      }
    }
  });
}

function renderChartAvance() {
  const ctx = $('chart-avance').getContext('2d');
  if (STATE.charts.avance) STATE.charts.avance.destroy();

  // Avance promedio por región, orden N→S
  const byRegion = {};
  REGIONES_CHILE.forEach(r => { byRegion[r.nombre] = { sum: 0, count: 0 }; });

  STATE.tramites.forEach(t => {
    const regs = (t.regiones_list || []);
    const matched = new Set();
    regs.forEach(raw => {
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

  // Solo regiones con datos, en orden N→S
  const labels = REGIONES_CHILE.map(r => r.nombre).filter(n =>
    byRegion[n] && byRegion[n].count > 0
  );
  const valores = labels.map(n => Math.round(byRegion[n].sum / byRegion[n].count));

  STATE.charts.avance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '% Avance Promedio',
        data: valores,
        backgroundColor: valores.map(v =>
          v >= 80 ? '#2E7D32' : v >= 50 ? '#FFC107' : '#E53935'
        ),
        borderRadius: 4,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } },
        y: { ticks: { font: { size: 10 } } }
      }
    }
  });
}

function renderTablaVencimientos() {
  const hoy = new Date();
  const seen = new Set();   // evitar duplicados si ya está por etapa Y por fecha_limite
  const items = [];

  STATE.tramites.forEach(t => {
    if (t.estado === 'rechazado' || t.estado === 'completado') return;

    // 1) Vencimiento por etapa individual
    (t.etapas || []).forEach(e => {
      if (e.estado === 'pendiente' && e.fecha_vencimiento) {
        const fv = new Date(e.fecha_vencimiento);
        const diff = Math.ceil((fv - hoy) / (1000 * 60 * 60 * 24));
        if (diff <= 7) {
          seen.add(t.id);
          items.push({ tramite: t, fv: e.fecha_vencimiento, diff,
                       responsable: e.nombres || '–', email: e.email || '–',
                       origen: 'etapa' });
        }
      }
    });

    // 2) Vencimiento por plazo de proceso (fecha_limite_proceso)
    if (t.fecha_limite_proceso && !seen.has(t.id)) {
      const fv = new Date(t.fecha_limite_proceso);
      const diff = Math.ceil((fv - hoy) / (1000 * 60 * 60 * 24));
      if (diff <= 7) {
        seen.add(t.id);
        const ea = t.etapa_actual || {};
        items.push({ tramite: t, fv: t.fecha_limite_proceso, diff,
                     responsable: ea.nombres || '–', email: ea.email || '–',
                     origen: 'plazo' });
      }
    }
  });

  items.sort((a, b) => a.diff - b.diff);

  if (!items.length) {
    $('tabla-vencimientos').innerHTML = '<div class="empty-msg">Sin vencimientos próximos</div>';
    return;
  }

  const rows = items.map(({ tramite: t, fv, diff, responsable, email, origen }) => {
    const rechazado = t.estado === 'rechazado';
    const clase = rechazado ? 'row-rechazado' : diff < 0 ? 'row-vencido' : 'row-pendiente';
    const diffLabel = diff < 0 ? `⚠️ Vencido hace ${-diff}d` : diff === 0 ? '🔴 Hoy' : `⏰ En ${diff}d`;
    const origenLabel = origen === 'plazo'
      ? `<span title="Plazo máximo del proceso (${tipoTramite(t)})" style="font-size:10px;color:#888">📋 plazo proceso</span>`
      : '';
    return `
      <tr class="${clase}">
        <td><button class="btn-detalle" onclick="openModal(${t.id})">#${t.id}</button></td>
        <td>${badgeHtml(t.estado, { recepcionPendiente: t.recepcion_pendiente })}</td>
        <td>${tipoBadgeHtml(t)}</td>
        <td>${t.nombre_solicitante || '–'}</td>
        <td>${regionMiniMapHtml(t)}</td>
        <td>${responsable}</td>
        <td>${email}</td>
        <td><strong>${diffLabel}</strong>${origenLabel}</td>
        <td>${formatDate(fv)}</td>
      </tr>`;
  }).join('');

  $('tabla-vencimientos').innerHTML = `
    <table>
      <thead><tr>
        <th>ID</th><th>Estado</th><th>Tipo</th><th>Solicitante</th>
        <th>Regiones</th><th>Responsable</th><th>Email</th><th>Tiempo</th><th>Vencimiento</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderTablaRecientes() {
  const ahora = new Date();
  const hace3meses = new Date(ahora);
  hace3meses.setMonth(ahora.getMonth() - 3);

  const ORDEN_GRUPO = { pendiente: 0, completado: 1, rechazado: 2 };

  const recientes = [...STATE.tramites]
    .filter(t => t.fecha_inicio && new Date(t.fecha_inicio) >= hace3meses)
    .sort((a, b) => {
      // 1° criterio: grupo (pendiente → completado → rechazado)
      const ga = ORDEN_GRUPO[a.estado] ?? 3;
      const gb = ORDEN_GRUPO[b.estado] ?? 3;
      if (ga !== gb) return ga - gb;
      // 2° criterio: dentro del grupo, más antiguos primero
      return new Date(a.fecha_inicio) - new Date(b.fecha_inicio);
    });

  if (!recientes.length) {
    $('tabla-recientes').innerHTML = '<div class="empty-msg">Sin trámites en los últimos 3 meses</div>';
    return;
  }

  const rows = recientes.map(t => {
    const vencida   = tramiteEsVencido(t);
    const rechazado = t.estado === 'rechazado';
    const rowClass  = rechazado ? 'row-rechazado'
                    : vencida   ? 'row-vencido'
                    : t.estado === 'pendiente' ? 'row-pendiente' : '';
    return `
    <tr class="${rowClass}">
      <td><button class="btn-detalle" onclick="openModal(${t.id})">#${t.id}</button></td>
      <td>${badgeHtml(t.estado, { recepcionPendiente: t.recepcion_pendiente })}</td>
      <td>${tipoBadgeHtml(t)}</td>
      <td>${t.nombre_solicitante || '–'}</td>
      <td>${regionMiniMapHtml(t)}</td>
      <td>${progressHtml(t.porcentaje_avance)}</td>
      <td>${formatDate(t.fecha_inicio)}</td>
    </tr>`;
  }).join('');

  $('tabla-recientes').innerHTML = `
    <div style="padding:8px 12px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border)">
      ${recientes.length} trámite${recientes.length !== 1 ? 's' : ''} en los últimos 3 meses
    </div>
    <table>
      <thead><tr>
        <th>ID</th><th>Estado</th><th>Tipo</th><th>Solicitante</th>
        <th>Regiones</th><th>Avance</th><th>Fecha Inicio</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ─── TRÁMITES TABLE ───────────────────────────────────────────────────────────
function renderTramitesTable(tramites) {
  $('tramites-count').textContent = `${tramites.length} trámite${tramites.length !== 1 ? 's' : ''}`;

  if (!tramites.length) {
    $('tabla-tramites').innerHTML = '<div class="empty-msg">No se encontraron trámites con los filtros aplicados</div>';
    return;
  }

  const rows = tramites.map(t => {
    const etapaActual = t.etapa_actual;
    const vencida     = tramiteEsVencido(t);
    const rechazado   = t.estado === 'rechazado';
    const rowClass    = rechazado         ? 'row-rechazado'
                      : vencida           ? 'row-vencido'
                      : t.estado === 'pendiente' ? 'row-pendiente'
                      : '';
    const fvEfectiva  = fechaVencimientoEfectiva(t);
    const fvLabel     = fvEfectiva
      ? (vencida
          ? `<span style="color:#C0392B;font-weight:700">⚠️ ${formatDate(fvEfectiva)}</span>`
          : formatDate(fvEfectiva))
      : '–';
    const inv = getArchivosTramite(t.id, t.nombre_solicitante || '');
    const invCell = inv && inv.archivos.length > 0
      ? `<a href="${inv.url}" target="_blank" class="inv-link">📁 ${inv.archivos.length} archivo${inv.archivos.length !== 1 ? 's' : ''}</a>`
      : `<span style="color:var(--muted)">–</span>`;
    let estadoBadge = badgeHtml(t.estado, { recepcionPendiente: t.recepcion_pendiente });
    if (inv && inv.archivos.length > 0 && t.estado === 'pendiente') {
      estadoBadge = `<span class="badge-inv-completado" title="Completado – archivos entregados">✅ Completado*</span>`;
    }
    return `
      <tr class="${rowClass}">
        <td><button class="btn-detalle" onclick="openModal(${t.id})">#${t.id}</button></td>
        <td>${estadoBadge}</td>
        <td>${tipoBadgeHtml(t)}</td>
        <td>${t.nombre_solicitante || '–'}</td>
        <td>${invCell}</td>
        <td><a href="mailto:${t.email_solicitante}" style="color:inherit">${t.email_solicitante || '–'}</a></td>
        <td>${regionMiniMapHtml(t)}</td>
        <td>${progressHtml(t.porcentaje_avance)}</td>
        <td>${etapaActual ? (etapaActual.nombres || '–') : '–'}</td>
        <td>${etapaActual ? `<a href="mailto:${etapaActual.email}" style="color:inherit">${etapaActual.email || '–'}</a>` : '–'}</td>
        <td>${fvLabel}</td>
        <td>${formatDate(t.fecha_inicio)}</td>
        <td>${formatDate(t.fecha_termino)}</td>
      </tr>`;
  }).join('');

  $('tabla-tramites').innerHTML = `
    <table>
      <thead><tr>
        <th>ID</th><th>Estado</th><th>Tipo</th>
        <th>Solicitante</th><th>📁 Archivos</th><th>Email Solicitante</th><th>Regiones</th>
        <th style="min-width:130px">Avance</th>
        <th>Responsable Actual</th><th>Email Responsable</th>
        <th>Vencimiento Etapa</th><th>Fecha Inicio</th><th>Fecha Término</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ─── FILTROS ──────────────────────────────────────────────────────────────────
function aplicarFiltros() {
  const estado   = $('filter-estado').value;
  const proceso  = $('filter-proceso').value;
  const region   = $('filter-region').value;
  const fechaIni = $('filter-fecha-inicio').value;
  const fechaFin = $('filter-fecha-fin').value;

  let lista = [...STATE.tramites];

  if (estado)  lista = lista.filter(t => t.estado === estado);
  if (proceso) lista = lista.filter(t => grupoDeProcesoId(t.proceso_id) === proceso);
  // Filtro de región: busca en regiones_list (un tramite puede cubrir varias regiones)
  if (region)  lista = lista.filter(t => (t.regiones_list || []).includes(region));
  if (fechaIni) lista = lista.filter(t => t.fecha_inicio && t.fecha_inicio >= fechaIni);
  if (fechaFin) lista = lista.filter(t => t.fecha_inicio && t.fecha_inicio.slice(0,10) <= fechaFin);

  STATE.tramitesFiltrados = lista;
  renderTramitesTable(lista);
}

function limpiarFiltros() {
  $('filter-estado').value = '';
  $('filter-proceso').value = '';
  $('filter-region').value = '';
  $('filter-fecha-inicio').value = '';
  $('filter-fecha-fin').value = '';
  STATE.tramitesFiltrados = [...STATE.tramites];
  renderTramitesTable(STATE.tramites);
}

// ─── BÚSQUEDA ─────────────────────────────────────────────────────────────────
async function ejecutarBusqueda() {
  const query = $('search-input').value.trim();
  if (!query) return;

  let resultados = [];

  // Auto-detectar tipo de búsqueda
  const esId    = /^\d{6,}$/.test(query);                 // solo dígitos, ≥6 → ID
  const esEmail = query.includes('@');                     // contiene @ → email

  if (esId) {
    // Búsqueda por ID: llama al endpoint individual (más completo)
    showLoading('Buscando trámite…');
    try {
      const t = await loadTramite(parseInt(query));
      resultados = [t];
    } catch {
      resultados = [];
    } finally {
      hideLoading();
    }
  } else {
    // Normaliza texto: minúsculas + sin tildes
    const norm = s => (s || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');

    const tokens = norm(query).split(/\s+/).filter(Boolean);

    resultados = STATE.tramites.filter(t => {
      if (esEmail) {
        // Para email: todos los tokens deben aparecer en el email
        const emailTexto = norm(t.email_solicitante) + ' ' +
          (t.etapas || []).map(e => norm(e.email)).join(' ');
        return tokens.every(tok => emailTexto.includes(tok));
      }
      // Búsqueda general: construir texto combinado y verificar que todos
      // los tokens aparezcan en algún lugar (orden libre, sin tildes)
      const texto = [
        t.nombre_solicitante,
        t.email_solicitante,
        String(t.id),
        ...(t.regiones_list || []),
        ...(t.areas_protegidas || []),
        ...(t.etapas || []).flatMap(e => [e.email, e.nombres]),
      ].map(norm).join(' ');
      return tokens.every(tok => texto.includes(tok));
    });
  }

  renderSearchResults(resultados, query);
}

function renderSearchResults(tramites, query, hint = '') {
  if (!tramites.length) {
    $('search-results').innerHTML = `<div class="empty-msg">No se encontraron trámites para "<strong>${query}</strong>" ${hint}</div>`;
    return;
  }

  const CONAF_BASE = 'https://conaf.cerofilas.gob.cl/backend/seguimiento';
  const rows = tramites.map(t => {
    const auth = t.archivo_autorizacion;
    let authBtn;
    if (auth) {
      // Abrir directamente la etapa con el documento en CONAF (requiere sesión CONAF)
      const etapaId = t.etapa_autorizacion_id;
      const conafUrl = etapaId
        ? `${CONAF_BASE}/ver_etapa/${etapaId}`
        : `${CONAF_BASE}/ver/${t.id}`;
      authBtn = `<a class="btn-auth-dl" href="${conafUrl}" target="_blank" rel="noopener" title="Ver autorización en CONAF (debe estar autenticado)">📄 Ver en CONAF</a>`;
    } else {
      authBtn = `<span style="color:#aaa;font-size:12px">–</span>`;
    }
    return `
    <tr>
      <td><button class="btn-detalle" onclick="openModal(${t.id})">#${t.id}</button></td>
      <td>${badgeHtml(t.estado, { recepcionPendiente: t.recepcion_pendiente })}</td>
      <td>${tipoBadgeHtml(t)}</td>
      <td>${nombreProceso(t.proceso_id).slice(0, 40)}</td>
      <td>${t.nombre_solicitante || '–'}</td>
      <td>${t.email_solicitante || '–'}</td>
      <td>${regionMiniMapHtml(t)}</td>
      <td>${progressHtml(t.porcentaje_avance)}</td>
      <td>${formatDate(t.fecha_inicio)}</td>
      <td>${formatDate(t.fecha_termino)}</td>
      <td>${authBtn}</td>
    </tr>`;
  }).join('');

  $('search-results').innerHTML = `
    <div style="padding:12px 16px;background:#f8f9fa;border-bottom:1px solid #dee2e6;font-weight:700;color:#2E7D32">
      ${tramites.length} resultado${tramites.length !== 1 ? 's' : ''} para "${query}"
      ${hint ? `<span style="font-weight:400;font-size:12px;color:#666;margin-left:8px">${hint}</span>` : ''}
    </div>
    <table>
      <thead><tr>
        <th>ID</th><th>Estado</th><th>Tipo</th><th>Proceso</th>
        <th>Solicitante</th><th>Email</th><th>Regiones</th>
        <th style="min-width:120px">Avance</th><th>Inicio</th><th>Término</th>
        <th>Autorización</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
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
    body.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
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
        <thead><tr>${headers.map(h => `<th>${h ?? ''}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(row =>
          `<tr>${headers.map((_, i) => `<td>${row[i] ?? '–'}</td>`).join('')}</tr>`
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
    return `<div class="modal-kv-item"><span class="label">${etiqueta}</span><span class="value">${vMostrar}</span></div>`;
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
      const regionDeMatch = k.match(/^region_de(?:l)?_(.+)$/i);
      if (regionDeMatch) {
        // La región viene siempre de la CLAVE (ej: region_de_magallanes → Magallanes)
        const regionFromKey = humanizarRegion(regionDeMatch[1]);
        if (regionFromKey) {
          regAreaMap[idx].region = regionFromKey;
          // Si el valor no es "si/true" sino una lista de áreas → va a columna Área
          if (!_IGNORAR_VAL.test(rawV.trim()) && !rawV.startsWith('{')) {
            regAreaMap[idx].area = rawV;
          }
        }
        // Si no se pudo extraer región de la clave, se ignora la fila
      } else {
        regAreaMap[idx].region = rawV;
      }
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
  // si "Coquimbo, Los Ríos" aparece sin áreas pero ya existen filas individuales
  // con esas regiones, la fila combinada no aporta información útil.
  const regionesConArea = new Set(
    filasProc.filter(f => f.areas.length > 0).map(f => f.sortKey.toLowerCase())
  );
  const filasRegion = filasProc
    .filter(f => {
      if (f.areas.length > 0) return true;  // tiene áreas → conservar siempre
      // Si la región está cubierta por filas con áreas → suprimir
      const partes = f.sortKey.split(',').map(s => s.trim().toLowerCase());
      return !partes.every(p => regionesConArea.has(p));
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
                <td>${regionNombre}</td>
                <td>${areas.length
                  ? areas.map(a => `<div class="area-item">• ${a}</div>`).join('')
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
          <span class="label">${label}</span>${tabla}
        </div>`;
      }
      // Valor humanizado normal
      const display = humanizarValorCampo(v) ?? (typeof v === 'object' ? JSON.stringify(v) : String(v));
      // Texto largo → fila completa con salto de línea
      if (display.length > 80) {
        return `<div class="modal-kv-item modal-kv-item--full">
          <span class="label">${label}</span>
          <span class="value" style="margin-top:4px;line-height:1.6">${display}</span>
        </div>`;
      }
      return `<div class="modal-kv-item"><span class="label">${label}</span><span class="value">${display}</span></div>`;
    }).join('');

  // ── Adjuntos ────────────────────────────────────────────────────────────────
  const CONAF_SEG = 'https://conaf.cerofilas.gob.cl/backend/seguimiento';
  const authEtapaId = t.etapa_autorizacion_id;

  // Botón prominente de autorización final (si existe)
  const authFileKey = Object.keys(datos).find(k => /autori|aprob|firmad|resolu/i.test(k) && isAdjuntoUrl(datos[k]));
  const authBtnModal = authFileKey ? `
    <div class="modal-section" style="background:#E3F2FD;border:2px solid #1565C0;border-radius:8px;padding:14px 18px;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font-size:22px">📋</span>
        <div style="flex:1">
          <div style="font-weight:700;color:#1565C0;font-size:14px">Autorización / Resolución Final</div>
          <div style="font-size:12px;color:#555;margin-top:2px">Archivo: ${datos[authFileKey]}</div>
        </div>
        <a class="btn-auth-dl" href="${authEtapaId ? `${CONAF_SEG}/ver_etapa/${authEtapaId}` : `${CONAF_SEG}/ver/${t.id}`}"
           target="_blank" rel="noopener">📄 Ver en CONAF</a>
      </div>
    </div>` : '';

  const adjuntosHtml = adjuntos.length ? `
    <div class="modal-section">
      <h3>Archivos Adjuntos <span style="font-size:11px;font-weight:400;color:#888">(se abren en CONAF — requiere sesión)</span></h3>
      <div class="adjuntos-grid">
        ${adjuntos.map(([k, valor]) => {
          const { nombre, icono } = adjuntoNombreDesdeKey(k);
          const ext = adjuntoExtension(valor);
          // Los archivos se sirven a través de CONAF autenticado → abrir tramite en CONAF
          const conafUrl = authEtapaId && /autori|aprob|firmad|resolu/i.test(k)
            ? `${CONAF_SEG}/ver_etapa/${authEtapaId}`
            : `${CONAF_SEG}/ver/${t.id}`;
          return `<a class="btn-adjunto" href="${conafUrl}" target="_blank" rel="noopener" title="${valor}">
            <span class="adjunto-icono">${icono}</span>
            <span class="adjunto-nombre">${nombre}</span>
            <span class="badge-ext">${ext}</span>
          </a>`;
        }).join('')}
      </div>
    </div>` : '';

  // ── Etapas — ordenar por ID ascendente: la más antigua (solicitante) = Etapa 1 ─
  const etapasOrdenadas = [...(t.etapas || [])].sort((a, b) => (a.id || 0) - (b.id || 0));
  const etapasHtml = etapasOrdenadas.map((e, i) => {
    const vencida = e.estado === 'pendiente' && isVencida(e.fecha_vencimiento);
    const clase   = `etapa-item etapa-${e.estado || 'otro'} ${vencida ? 'etapa-vencida' : ''}`;
    return `
      <div class="${clase}">
        <div class="etapa-header">
          <span class="etapa-nombre">Etapa ${i + 1} – ID #${e.id}</span>
          ${badgeHtml(e.estado)}
        </div>
        <div class="etapa-usuario">👤 ${e.nombres || 'Sin asignar'} &nbsp;|&nbsp; ✉️ ${e.email || '–'}</div>
        <div class="etapa-fechas">
          Inicio: ${formatDate(e.fecha_inicio)} &nbsp;|&nbsp;
          Término: ${formatDate(e.fecha_termino)} &nbsp;|&nbsp;
          Vencimiento: ${e.fecha_vencimiento
            ? `<strong style="color:${vencida ? '#C0392B' : '#155724'}">${formatDate(e.fecha_vencimiento)}${vencida ? ' ⚠️ VENCIDA' : ''}</strong>`
            : '–'}
        </div>
      </div>`;
  }).join('');

  // ── EMAIL con link ──────────────────────────────────────────────────────────
  const emailHtml = t.email_solicitante
    ? `<a href="mailto:${t.email_solicitante}">${t.email_solicitante}</a>`
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
          <strong>${t.nombre_solicitante || t.email_solicitante || 'desconocido'}</strong>
          inició la solicitud pero <strong>todavía no terminó de completar ni enviar el formulario</strong>.
          <br>No requiere acción de parte de CONAF hasta que el solicitante lo envíe.
        </div>
      </div>
    </div>` : '';

  // ── Render completo ─────────────────────────────────────────────────────────
  $('modal-tramite-body').innerHTML = borradorBannerHtml + `

    <!-- 1. INFORMACIÓN GENERAL -->
    <div class="modal-section">
      <h3>Información General</h3>
      <div class="modal-kv">
        <div class="modal-kv-item"><span class="label">ID</span><span class="value fw-bold">#${t.id}</span></div>
        <div class="modal-kv-item"><span class="label">Estado</span><span class="value">${badgeHtml(t.estado, { recepcionPendiente: t.recepcion_pendiente })}</span></div>
        <div class="modal-kv-item"><span class="label">Proceso</span><span class="value">${nombreProceso(t.proceso_id)}</span></div>
        <div class="modal-kv-item"><span class="label">Tipo</span><span class="value">${tipoBadgeHtml(t)}</span></div>
        <div class="modal-kv-item"><span class="label">Fecha Inicio</span><span class="value">${formatDateTime(t.fecha_inicio)}</span></div>
        <div class="modal-kv-item"><span class="label">Fecha Modificación</span><span class="value">${formatDateTime(t.fecha_modificacion)}</span></div>
        <div class="modal-kv-item"><span class="label">Fecha Término</span><span class="value">${formatDateTime(t.fecha_termino)}</span></div>
        <div class="modal-kv-item"><span class="label">Región</span><span class="value">${t.region || '–'}</span></div>
      </div>
    </div>

    <!-- 2. DATOS DEL SOLICITANTE -->
    <div class="modal-section">
      <h3>Datos del Solicitante</h3>
      <div class="modal-kv">
        <div class="modal-kv-item"><span class="label">Nombre</span><span class="value fw-bold">${t.nombre_solicitante || '–'}</span></div>
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
          <span class="value" style="margin-top:4px;line-height:1.5">${buscarDato('objetivos_del_proyecto')}</span>
        </div>` : '')}
      ${(buscarDato('especifique_apoyo') ? `
        <div class="modal-kv-item modal-kv-item--full" style="padding-top:8px">
          <span class="label">Detalle apoyo solicitado</span>
          <span class="value" style="margin-top:4px;line-height:1.5">${buscarDato('especifique_apoyo')}</span>
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

    <!-- 3. PROGRESO DEL TRÁMITE -->
    <div class="modal-section">
      <h3>Progreso del Trámite</h3>
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span>${t.etapas_completadas} de ${t.total_etapas} etapas completadas</span>
          <strong>${t.porcentaje_avance}%</strong>
        </div>
        <div class="progress-bar-wrap" style="height:14px">
          <div class="progress-bar-fill" style="width:${t.porcentaje_avance}%"></div>
        </div>
      </div>
    </div>

    <!-- 4. ETAPAS DEL PROCESO -->
    <div class="modal-section">
      <h3>Etapas del Proceso</h3>
      <div class="etapas-timeline">
        ${etapasHtml || '<div class="empty-msg">Sin etapas registradas</div>'}
      </div>
    </div>

    <!-- 5. REGIONES Y ÁREAS PROTEGIDAS -->
    ${tablaRegionesHtml}

    <!-- 6. DATOS ADICIONALES -->
    ${datosAdicionalesHtml ? `
    <div class="modal-section">
      <h3>Datos Adicionales</h3>
      <div class="modal-kv">${datosAdicionalesHtml}</div>
    </div>` : ''}

    <!-- 7. AUTORIZACIÓN FINAL -->
    ${authBtnModal}

    <!-- 8. ARCHIVOS ADJUNTOS -->
    ${adjuntosHtml}

    <!-- 9. ARCHIVOS INVESTIGACIONES (Numeral 6) -->
    ${(() => {
      const inv = getArchivosTramite(t.id, t.nombre_solicitante || '');
      if (!inv || inv.archivos.length === 0) return '';
      const fileRows = inv.archivos.map(a =>
        `<tr><td style="padding:7px 10px"><a href="${a.url}" target="_blank" style="color:var(--accent)">${a.nombre}</a></td><td style="padding:7px 10px;color:var(--muted);text-align:right;white-space:nowrap">${a.size_kb} KB</td></tr>`
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
    <div style="margin-top:10px">
      <a href="${inv.url}" target="_blank" class="btn-export" style="font-size:12px;padding:6px 14px">📂 Abrir carpeta</a>
    </div>
  </div>`;
    })()}

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
        regionBadge = `<span class="badge-regional">🗺 Regional — ${rl[0]}</span>`;
      } else {
        regionBadge = `<span class="badge-multiregional">🗺 Multirregional — ${rl.join(', ')}</span>`;
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
    })()}`;
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
    if (rl.length === 1) return { label: `Regional<br><small>${rl[0]}</small>`, clase: 'badge-regional' };
    return { label: `Multirregional<br><small>${rl.join(', ')}</small>`, clase: 'badge-multiregional' };
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
        html: `<a href="${url}" target="_blank" class="badge-entregado">✅ Entregados<br><small>${inv.archivos.length} archivo(s)</small></a>`,
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
      <td>${t.nombre_solicitante || '–'}</td>
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

De acuerdo con el Numeral 6 del Reglamento de Investigación en Áreas Silvestres Protegidas del Estado:

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
  const aniosFmt = String(anios).replace(/\.0$/, '');
  const regionStr = region || 'el SNAP';
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:680px;margin:0 auto;padding:20px">
<p>Estimado/a <strong>${nombre}</strong>,</p>
<p>Por medio de la presente, el Departamento de Gestión de Áreas Protegidas de CONAF le informa que han transcurrido más de <strong>${aniosFmt} años</strong> desde la fecha de término de actividades de terreno de su investigación:</p>
<blockquote style="border-left:4px solid #1B4F1E;padding:12px 16px;background:#f5faf5;font-style:italic;margin:16px 0">"${titulo}"</blockquote>
<p>realizada en el Sistema Nacional de Áreas Protegidas (SNAP) — <strong>${regionStr}</strong>.</p>
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
    const errorHtml = c._error ? `<div class="correo-error">${c._error}</div>` : '';
    return `<tr id="correo-row-${i}" class="correo-row correo-row--${st}">
      <td style="font-size:12px;font-weight:700;color:var(--muted)">#${c.id}</td>
      <td><strong>${c.nombre_solicitante || '–'}</strong></td>
      <td><a href="mailto:${c.email_solicitante}" style="color:inherit">${c.email_solicitante || '–'}</a></td>
      <td class="correo-titulo">${(c.titulo_investigacion || '–').slice(0,70)}${c.titulo_investigacion?.length > 70 ? '…' : ''}</td>
      <td style="white-space:nowrap"><span class="badge-compliance-${c.anios_transcurridos >= 5 ? 'critico' : 'moderado'}">${c.anios_transcurridos} años</span></td>
      <td>${c.region || '–'}</td>
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
    `<strong>Para:</strong> ${c.nombre_solicitante} &lt;${c.email_solicitante}&gt;<br>
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
window.correoVer        = correoVer;
window.correoAbrirGmail = correoAbrirGmail;
window.correoOmitir     = correoOmitir;

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Tabs
  qsa('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.tab-btn').forEach(b => b.classList.remove('active'));
      qsa('.tab-content').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
    });
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
      showLoading(`Actualizando datos (${desde}–${hasta})…`);
      try {
        STATE.tramites = filtrarRango(await loadTramites(paramsRango()));
      } catch {
        showLoading('Descargando todos los trámites…');
        STATE.tramites = filtrarRango(await loadTramites());
      }
      STATE.tramitesFiltrados = [...STATE.tramites];
      updateLastUpdate();
      renderDashboard();
      renderTramitesTable(STATE.tramitesFiltrados);
      populateRegionSelect();
    } catch (err) {
      alert('Error actualizando: ' + err.message);
    } finally {
      hideLoading();
      $('btn-refresh').classList.remove('spinning');
    }
  });

  // Filters
  $('btn-aplicar-filtros').addEventListener('click', aplicarFiltros);
  $('btn-limpiar-filtros').addEventListener('click', limpiarFiltros);

  // Export from list
  $('btn-export-lista').addEventListener('click', () => {
    const url = buildExportUrl('filter');
    window.location.href = url;
  });

  $('btn-buscar').addEventListener('click', ejecutarBusqueda);
  $('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') ejecutarBusqueda(); });

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

  // Export from list tab – build from current filters
  $('btn-export-lista').addEventListener('click', () => {
    const estado  = $('filter-estado').value;
    const proceso = $('filter-proceso').value;
    const fIni    = $('filter-fecha-inicio').value;
    const fFin    = $('filter-fecha-fin').value;
    const params  = new URLSearchParams();
    if (estado)  params.set('estado', estado);
    if (proceso) params.set('proceso_id', proceso);
    if (fIni)    params.set('created_at_start', dateToTimestamp(fIni));
    if (fFin)    params.set('created_at_end', dateToTimestamp(fFin + 'T23:59:59'));
    window.location.href = `/api/export/excel?${params}`;
  });

  // Correos modal
  $('btn-abrir-correos').addEventListener('click', abrirModalCorreos);
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
