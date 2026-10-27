/* ═══════════════════════════════════════════════
   Ficha del trámite (modal de detalle), en tres capas de lectura:
     1. Encabezado: qué permiso es, su estado y las acciones.
     2. «Situación ahora» y la línea de tiempo del permiso (estilo LifeLines,
        Plaisant et al. 1996): trámite, etapas con su plazo y quién las tiene,
        resolución, período en terreno y hoy, en un solo eje.
     3. Pestañas con todo el detalle: resumen del proyecto, solicitud completa,
        territorio y registro del titular, seguimiento de CONAF, documentos,
        cumplimiento y permisos relacionados.
   app.js (renderModalBody) arma las piezas del formulario y llama a Ficha.html / Ficha.activar.
   Usa de app.js: escHtml, safeUrl, badgeHtml, tipoBadgeHtml, tipoTramite, nombreProceso,
   formatDate, situacionTramite, humanizarValorCampo, adjuntoNombreDesdeKey, adjuntoExtension,
   openModal, STATE. De resumen.js: RES_ESTADOS, _regionesDeResponsables.
   ═══════════════════════════════════════════════ */
'use strict';
window.Ficha = (() => {
  let pendiente = null;   // { tab, ajustar } al abrir desde la tabla de permisos
  const DIA = 86400000;
  const RESOLUCION = /^(autorizacion|autorizacion_firmada|resolucion|resolucion_aprobacion|documento_aprobacion)$/i;
  const esConaf = email => /@conaf\.(gob\.)?cl$/i.test((email || '').trim());
  const f = iso => iso ? formatDate(String(iso).length === 10 ? `${iso}T12:00:00` : iso) : '–';   // fecha sola: sin corrimiento por zona horaria
  const dias = (a, b) => Math.round((b - a) / DIA);
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

  // Fechas del formulario: dd-mm-aaaa, aaaa-mm-dd o dd/mm/aaaa
  function fecha(v) {
    const s = String(v || '').trim().slice(0, 10);
    let m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], 12);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : null;
  }

  // Los formularios traen saltos de línea en medio de las frases: se unen las líneas y se
  // conservan solo los párrafos (línea en blanco o viñeta), así el texto se justifica a todo el ancho.
  const parrafos = v => String(v || '').replace(/\r/g, '').split(/\n\s*\n|\n(?=\s*[-•*·]\s|\s*\d+[.)]\s)/)
    .map(x => x.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join('\n');

  // Primer campo del formulario cuyo nombre calza con alguno de los patrones
  function campo(datos, ...patrones) {
    for (const p of patrones) {
      const k = Object.keys(datos).find(k => p.test(k) && datos[k] != null && String(datos[k]).trim() !== '' && typeof datos[k] !== 'object');
      if (k) return humanizarValorCampo(datos[k]) ?? String(datos[k]);
    }
    return '';
  }

  function periodo(t) {
    const d = t.datos_raw || {};
    let ini = fecha(d.fecha_inicio_actividades), fin = fecha(d.fecha_termino_actividades);
    if (!ini) {   // filmación: fechas por región
      const inis = Object.keys(d).filter(k => /^fecha_inicio_/.test(k)).map(k => fecha(d[k])).filter(Boolean);
      const fins = Object.keys(d).filter(k => /^fecha_termino_/.test(k)).map(k => fecha(d[k])).filter(Boolean);
      ini = inis.length ? new Date(Math.min(...inis)) : null;
      fin = fins.length ? new Date(Math.max(...fins)) : null;
    }
    return { ini, fin };
  }

  function etapas(t) {
    const regionDe = typeof _regionesDeResponsables === 'function' ? _regionesDeResponsables() : new Map();
    return [...(t.etapas || [])].sort((a, b) => (a.id || 0) - (b.id || 0)).map((e, i) => {
      const ini = e.fecha_inicio ? new Date(e.fecha_inicio) : null;
      const fin = e.fecha_termino ? new Date(e.fecha_termino) : (e.estado === 'pendiente' ? new Date() : null);
      const vence = e.fecha_vencimiento ? new Date(e.fecha_vencimiento) : null;
      const conaf = !e.email || esConaf(e.email);
      const clave = (e.email || e.nombres || '').toLowerCase();
      return {
        e, n: i + 1, nombre: e.tarea_nombre || `Etapa ${i + 1}`, ini, fin, vence, conaf,
        oficina: conaf ? (regionDe.get(clave) || (clave ? 'Nivel central / varias regiones' : 'Sin responsable')) : 'Titular del permiso',
        usados: ini && fin ? dias(ini, fin) : null,
        plazo: ini && vence ? dias(ini, vence) : null,
        atraso: vence && fin && fin > vence ? dias(vence, fin) : 0,
      };
    });
  }

  // ─── Situación ahora ───────────────────────────────────────────────────────
  function situacion(t, et, piezas) {
    const sit = situacionTramite(t);
    if (t.ajuste) {
      const a = t.ajuste;
      const color = (RES_ESTADOS.find(e => e.key === sit) || {}).color || '#888';
      return `<section class="fx-ahora" style="--c:${color}"><span class="fx-eyebrow">Situación ahora · ajustada por CONAF</span>
        <strong>${escHtml(a.nombre)}</strong>
        <p>Desde el ${f(a.fecha_efectiva)}. Registrado por ${escHtml(a.autor || 'un funcionario')} el ${f(a.creado_en)}; en Cero Filas figura «${escHtml(t.estado)}».
          <button class="fx-link" data-fx-ir="seguimiento">Ver justificación y respaldos</button></p></section>`;
    }
    const color = (RES_ESTADOS.find(e => e.key === sit) || {}).color || '#888';
    const actual = et.find(x => x.e.estado === 'pendiente');
    const hoy = new Date();
    let titulo = '', detalle = '';
    if (sit === 'vencido' && actual) {
      // el plazo vencido puede ser el de la etapa o el plazo total del proceso
      const vence = actual.vence || (t.fecha_limite_proceso ? new Date(t.fecha_limite_proceso) : null);
      titulo = vence ? `Atraso de CONAF: venció hace ${plural(dias(vence, hoy), 'día', 'días')}${actual.vence ? ` el plazo de «${escHtml(actual.nombre)}»` : ' el plazo del proceso'}`
        : `Atraso de CONAF en «${escHtml(actual.nombre)}»`;
      detalle = `A cargo de ${escHtml(actual.e.nombres || 'sin asignar')} (${escHtml(actual.oficina)}) desde el ${f(actual.e.fecha_inicio)}.`;
    } else if (sit === 'al_dia' && actual) {
      titulo = `En evaluación en CONAF: «${escHtml(actual.nombre)}»`;
      detalle = `Desde el ${f(actual.e.fecha_inicio)} (${plural(dias(actual.ini, hoy), 'día', 'días')}) · a cargo de ${escHtml(actual.e.nombres || 'sin asignar')} (${escHtml(actual.oficina)})${actual.vence ? ` · vence el ${f(actual.e.fecha_vencimiento)} (en ${plural(Math.max(0, dias(hoy, actual.vence)), 'día', 'días')})` : ''}.`;
    } else if (sit === 'espera_solicitante') {
      titulo = 'Esperando al titular: debe responder o subsanar en Cero Filas';
      detalle = actual ? `Desde el ${f(actual.e.fecha_inicio)} (${plural(dias(actual.ini, hoy), 'día', 'días')}). No es atraso de CONAF.` : '';
    } else if (sit === 'suspendido') {
      titulo = 'Trámite en suspensión';
    } else {
      const res = t.fecha_resolucion || t.fecha_termino;
      const tomo = res && t.fecha_inicio ? dias(new Date(t.fecha_inicio), new Date(res)) : null;
      titulo = sit === 'rechazado' ? 'Rechazado por CONAF' : 'Aprobado por CONAF';
      detalle = `${res ? `Resuelto el ${f(res)}` : ''}${tomo !== null ? `, ${plural(tomo, 'día', 'días')} después del ingreso` : ''}.`;
      const pend = [];
      if (sit === 'cierre_solicitante') pend.push('el titular debe cerrar el trámite en Cero Filas');
      if (sit !== 'rechazado' && IDS_INVESTIGACION.has(t.proceso_id) && !piezas.entregaOk) pend.push('entregar resultados (Numeral 6)');
      if (pend.length) detalle += ` Pendiente: ${pend.join(' · ')}.`;
      if (sit !== 'rechazado') detalle += '<span id="fx-pend-registro"></span>';   // se completa al consultar el registro geográfico
    }
    return `<section class="fx-ahora" style="--c:${color}">
      <span class="fx-eyebrow">Situación ahora</span>
      <strong>${titulo}</strong>${detalle ? `<p>${detalle}</p>` : ''}
      ${t.estado === 'pendiente' ? `<div class="fx-avance" title="${t.etapas_completadas} de ${t.total_etapas} etapas"><i style="width:${Math.min(100, t.porcentaje_avance || 0)}%"></i></div>` : ''}
    </section>`;
  }

  // ─── Línea de tiempo resumida ──────────────────────────────────────────────
  // Forma estándar de «tiempo en cada estado» (análisis de flujo / lead time): UNA barra con
  // el tiempo total del trámite repartido entre quién lo tenía (CONAF, titular) y lo que pasó
  // fuera de plazo, más los hitos en una fila. El detalle por etapa está en «Seguimiento CONAF».
  function plazoResultados(t) {
    // Numeral 6: resultados dentro de 3 años desde el término del trámite (o la resolución)
    const base = t.fecha_termino || t.fecha_resolucion;
    const fin = base ? new Date(base) : null;
    return fin ? new Date(fin.getFullYear() + 3, fin.getMonth(), fin.getDate(), 12) : null;
  }

  // Tramos consecutivos: en cada momento manda CONAF si tiene una etapa abierta (rojo si ya
  // pasó su plazo); si no, el titular; si nadie, «sin etapa abierta».
  function tramos(et) {
    const hoy = Date.now();
    const iv = et.filter(s => s.ini).map(s => ({ a: +s.ini, b: +(s.fin || hoy), conaf: s.conaf, vence: s.vence ? +s.vence : null }));
    if (!iv.length) return [];
    const cortes = [...new Set(iv.flatMap(x => [x.a, x.b, ...(x.vence && x.vence > x.a && x.vence < x.b ? [x.vence] : [])]))].sort((p, q) => p - q);
    const res = [];
    for (let i = 0; i < cortes.length - 1; i++) {
      const a = cortes[i], b = cortes[i + 1], m = (a + b) / 2;
      const act = iv.filter(x => x.a <= m && x.b >= m);
      const c = act.filter(x => x.conaf);
      const tipo = c.length ? (c.some(x => x.vence && m > x.vence) ? 'atraso' : 'conaf') : act.length ? 'titular' : 'nadie';
      const ult = res[res.length - 1];
      if (ult && ult.tipo === tipo) ult.b = b; else res.push({ a, b, tipo });
    }
    return res;
  }

  function lineaDeTiempo(t, et) {
    const tr = tramos(et);
    const ingreso = t.fecha_inicio ? new Date(t.fecha_inicio) : null;
    if (!ingreso || !tr.length) return '';
    const hoy = new Date();
    const ini = Math.min(+ingreso, tr[0].a), fin = tr[tr.length - 1].b;
    const total = Math.max(fin - ini, DIA / 2);
    const d = ms => Math.round(ms / DIA);
    const suma = tipo => tr.filter(x => x.tipo === tipo).reduce((s, x) => s + (x.b - x.a), 0);
    const NOM = { conaf: 'En CONAF', atraso: 'En CONAF, fuera de plazo', titular: 'Con el titular', nadie: 'Sin etapa abierta' };
    const QUE = {
      conaf: 'Un funcionario de CONAF tenía la etapa: evaluar, visar o firmar.',
      atraso: 'La etapa seguía en CONAF después de su plazo.',
      titular: 'El titular debía actuar: enviar la solicitud, subsanar observaciones o cerrar el trámite. No es atraso de CONAF.',
      nadie: 'Ninguna etapa estaba abierta en Cero Filas.',
    };
    const tip = html => `data-tip="${escHtml(html)}" tabindex="0"`;
    const COL = { conaf: '#347A17', atraso: '#B9412F', titular: '#3F7CB8', nadie: '#C9C6BA' };
    const barra = tr.map(x => {
      const pct = (x.b - x.a) / total * 100;
      return `<span class="fx-lt-seg" style="width:${Math.max(pct, .8)}%;background:${COL[x.tipo]}" ${tip(`<strong>${NOM[x.tipo]}: ${d(x.b - x.a)} días</strong><br>${new Date(x.a).toLocaleDateString('es-CL')} → ${new Date(x.b).toLocaleDateString('es-CL')}<br><small>${QUE[x.tipo]}</small>`)}>${pct > 9 ? `${d(x.b - x.a)} d` : ''}</span>`;
    }).join('');
    const res = t.estado !== 'pendiente' && (t.fecha_resolucion || t.fecha_termino) ? new Date(t.fecha_resolucion || t.fecha_termino) : null;
    const marcaRes = res && +res >= ini && +res <= fin ? `<i class="fx-lt-res" style="left:${(+res - ini) / total * 100}%" ${tip(`<strong>Resolución de CONAF</strong><br>${res.toLocaleDateString('es-CL')}<br><small>Lo que sigue es el cierre del trámite por parte del titular.</small>`)}></i>` : '';
    const cifras = [['conaf', suma('conaf') + suma('atraso')], ['atraso', suma('atraso')], ['titular', suma('titular')]]
      .filter(([k, v]) => v > 0 || k !== 'atraso')
      .map(([k, v]) => `<span ${tip(`<strong>${k === 'conaf' ? 'En CONAF' : NOM[k]}: ${d(v)} días</strong><br><small>${k === 'conaf' ? 'Suma de todo el tiempo en que la etapa abierta estaba en manos de CONAF (incluye lo fuera de plazo).' : QUE[k]}</small>`)}><i style="background:${COL[k]}"></i>${k === 'conaf' ? 'En CONAF' : NOM[k]} <b>${d(v)} d</b>${k !== 'atraso' ? ` <small>${Math.round(v / total * 100)}%</small>` : ''}</span>`).join('');
    const { ini: aIni, fin: aFin } = periodo(t);
    const n6 = IDS_INVESTIGACION.has(t.proceso_id) ? plazoResultados(t) : null;
    const fecha = x => x.toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
    const AYUDA = {
      'Ingreso': 'Fecha en que el titular envió la solicitud en Cero Filas.',
      'Resolución': 'CONAF aprobó y firmó la autorización. La resolución está en la pestaña Documentos.',
      'Rechazo': 'CONAF rechazó la solicitud. El motivo está en Seguimiento CONAF.',
      'En terreno': 'Período de actividades que el titular declaró en la solicitud.',
      'Entrega de resultados': 'Numeral 6 del Reglamento: el titular debe entregar informe final, publicaciones y material dentro de 3 años desde el término del trámite. Se marca cumplido cuando hay archivos entregados.',
    };
    const hitos = [
      ['Ingreso', ingreso, true],
      [t.estado === 'rechazado' ? 'Rechazo' : 'Resolución', res, !!res, res ? `${d(+res - +ingreso)} días` : 'pendiente'],
      ...(aIni ? [['En terreno', aIni, +aIni <= +hoy, `${fecha(aIni)} → ${fecha(aFin || aIni)}`]] : []),
      ...(n6 && t.estado !== 'rechazado' ? [['Entrega de resultados', n6, !!(window.STATE && getArchivosTramite(t.id, t.nombre_solicitante || '')?.archivos.length), `plazo ${fecha(n6)}`]] : []),
    ];
    return `<section class="fx-lt" aria-label="Resumen de tiempos del permiso">
      <div class="fx-lt-cab"><strong ${tip('<strong>Tiempo total del trámite</strong><br><small>Desde el ingreso hasta que se cerró la última etapa (o hasta hoy, si sigue abierto). Pase el cursor sobre la barra para ver cada tramo.</small>')}>${d(total)} días de trámite</strong><span>${t.estado === 'pendiente' ? 'en curso' : 'desde el ingreso hasta la última etapa'} ·
        <button class="fx-link" data-fx-ir="seguimiento">ver detalle por etapa</button></span></div>
      <div class="fx-lt-barra">${barra}${marcaRes}</div>
      <div class="fx-lt-cifras">${cifras}</div>
      <ol class="fx-lt-hitos">${hitos.map(([n, f, hecho, extra]) => `<li class="${hecho ? 'hecho' : ''}" ${tip(`<strong>${n}</strong><br><small>${AYUDA[n]}</small>`)}><b>${n}</b><span>${f ? (n === 'En terreno' || n === 'Entrega de resultados' ? '' : fecha(f)) : ''}${extra ? `${f && n !== 'En terreno' && n !== 'Entrega de resultados' ? ' · ' : ''}${escHtml(extra)}` : ''}</span></li>`).join('')}</ol>
    </section>`;
  }

  // ─── Pestañas ──────────────────────────────────────────────────────────────
  function resumen(t, piezas) {
    const d = t.datos_raw || {};
    const tarjetas = [
      ['Objetivo', campo(d, /^objetivo_general$/, /^objetivos?_del_proyecto$/, /^objetivos?$/, /^descripcion(_proyecto)?$/, /objetivo/)],
      ['Metodología y actividades', campo(d, /metodolog/, /^breve_descripcion_actividades/, /^actividades(_a_realizar)?$/, /descripcion_actividades/)],
      ['Especies o grupos de estudio', campo(d, /^especies?$/, /nombre_cientifico/, /nombre_comun/, /especie/)],
      ['Colecta o toma de muestras', campo(d, /colect/, /muestra/, /captura/)],
      ['Equipo', campo(d, /investigadores_asociados/, /^equipo/, /integrantes/)],
      ['Institución', campo(d, /institucion_patrocinante/, /^institucion/, /universidad/, /nombre_empresa/, /razon_social/)],
      ['Financiamiento', campo(d, /financiamiento/, /fondo/, /fondecyt/)],
      ['Ubicación declarada', campo(d, /localizacion_geografica/, /^ubicacion/, /coordenad/)],
    ].filter(([, v]) => v);
    const { ini, fin } = periodo(t);
    return `<div class="fx-resumen">
      ${piezas.banners}
      ${tarjetas.length ? `<div class="fx-tarjetas">${tarjetas.map(([k, v]) => {
        const txt = parrafos(v);
        const ancho = txt.length > 700 ? ' fx-larga' : txt.length > 220 ? ' fx-media' : '';
        return `<article class="fx-tarjeta${ancho}"><h4>${k}</h4><p>${escHtml(txt)}</p></article>`;
      }).join('')}</div>`
        : '<p class="fx-nota">El formulario no trae objetivo, metodología ni especies. Revise «Solicitud completa».</p>'}
      <div class="fx-mini">
        <div><span>Período en terreno</span><strong>${ini ? `${ini.toLocaleDateString('es-CL')} → ${(fin || ini).toLocaleDateString('es-CL')}` : '–'}</strong></div>
        <div><span>Áreas protegidas</span><strong>${escHtml((t.areas_protegidas || []).join(', ') || '–')}</strong></div>
        <div><span>Regiones</span><strong>${escHtml((t.regiones_list || []).join(', ') || '–')}</strong></div>
        <div><span>Proceso</span><strong>${escHtml(nombreProceso(t.proceso_id))}</strong></div>
      </div>
    </div>`;
  }

  function seguimiento(t, et) {
    if (!et.length) return '<p class="fx-nota">Sin etapas registradas en Cero Filas.</p>';
    return `<ol class="fx-etapas">${et.map(s => {
      const estado = s.e.estado === 'completado' ? 'hecha' : s.e.estado === 'pendiente' ? 'actual' : 'otra';
      const uso = s.usados !== null && s.plazo ? Math.min(100, s.usados / s.plazo * 100) : null;
      return `<li class="fx-etapa fx-etapa--${estado}${s.atraso ? ' fx-etapa--atraso' : ''}">
        <div class="fx-etapa-cab"><strong>${s.n}. ${escHtml(s.nombre)}</strong>${badgeHtml(s.e.estado)}${s.atraso ? `<span class="fx-atraso">${s.atraso} d fuera de plazo</span>` : ''}</div>
        <div class="fx-etapa-quien">${s.conaf ? '🏛' : '👤'} ${escHtml(s.e.nombres || 'Sin asignar')}${s.e.email ? ` · ${escHtml(s.e.email)}` : ''} · <em>${escHtml(s.oficina)}</em></div>
        <div class="fx-etapa-fechas"><span>Inicio <b>${f(s.e.fecha_inicio)}</b></span><span>Término <b>${s.e.fecha_termino ? f(s.e.fecha_termino) : 'en curso'}</b></span><span>Plazo <b>${s.e.fecha_vencimiento ? f(s.e.fecha_vencimiento) : '–'}</b></span>
          ${s.usados !== null ? `<span>Días usados <b>${s.usados}${s.plazo ? ` de ${s.plazo}` : ''}</b></span>` : ''}</div>
        ${uso !== null ? `<div class="fx-uso"><i style="width:${uso}%;background:${s.atraso ? '#B9412F' : uso > 80 ? '#D9A13B' : '#347A17'}"></i></div>` : ''}
      </li>`;
    }).join('')}</ol>
    ${t.estado === 'rechazado' && t.motivo_rechazo ? `<div class="fx-motivo"><h4>Motivo del rechazo (registrado por CONAF)</h4><p>${escHtml(t.motivo_rechazo)}</p></div>` : ''}
    <p class="fx-nota">Ingreso ${f(t.fecha_inicio)} · última modificación ${f(t.fecha_modificacion)}${t.fecha_resolucion ? ` · resolución ${f(t.fecha_resolucion)}` : ''}. La oficina se infiere de la región que atiende cada funcionario.</p>`;
  }

  function documentos(t, piezas) {
    const adj = piezas.adjuntos;
    const res = adj.find(([k]) => RESOLUCION.test(k));
    const url = k => `/api/tramites/${t.id}/adjuntos/${encodeURIComponent(k)}`;
    const tarjetas = adj.map(([k, v]) => {
      const { nombre, icono } = adjuntoNombreDesdeKey(k);
      const ext = adjuntoExtension(v);
      return `<a class="fx-doc${RESOLUCION.test(k) ? ' fx-doc--res' : ''}" href="${url(k)}" target="_blank" rel="noopener">
        <span class="fx-doc-ico">${icono}</span><span class="fx-doc-nom">${escHtml(RESOLUCION.test(k) ? 'Resolución / autorización de CONAF' : nombre)}</span><span class="badge-ext">${escHtml(ext)}</span></a>`;
    }).join('');
    return `${res && adjuntoExtension(res[1]) === 'PDF' ? `<div class="fx-visor"><div class="fx-visor-cab"><strong>Resolución / autorización</strong>
        <a href="${url(res[0])}" target="_blank" rel="noopener">Abrir en otra pestaña ↗</a></div>
        <iframe src="${url(res[0])}" title="Resolución del trámite ${t.id}" aria-label="Resolución del trámite ${t.id}"></iframe></div>` : ''}
      ${adj.length ? `<div class="fx-docs-cab"><h4>Documentos del trámite <small>${adj.length}</small></h4>
        <a class="fx-btn" href="/api/tramites/${t.id}/adjuntos.zip">Descargar todos (ZIP)</a></div><div class="fx-docs">${tarjetas}</div>`
        : '<p class="fx-nota">El trámite no tiene documentos adjuntos.</p>'}
      ${piezas.entregados || ''}
      <p class="fx-nota">Los documentos se abren desde la plataforma, sin cuenta en Cero Filas. Cada apertura queda registrada.</p>`;
  }

  function relacionados(t) {
    const dup = (STATE.duplicados.get(t.id) || []);
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const email = norm(t.email_solicitante), nombre = norm(t.nombre_solicitante);
    const vistos = new Set([t.id, ...dup.map(r => r.id)]);
    const otros = [...STATE.tramites, ...(STATE.portadaHistorico || [])].filter(x => {
      if (vistos.has(x.id)) return false;
      const ok = (email && norm(x.email_solicitante) === email) || (nombre && nombre.length > 6 && norm(x.nombre_solicitante) === nombre);
      if (ok) vistos.add(x.id);
      return ok;
    }).sort((a, b) => ((b.fecha_inicio || '') > (a.fecha_inicio || '') ? 1 : -1));
    const areas = new Set(t.areas_protegidas || []);
    const mismaArea = areas.size ? STATE.tramites.filter(x => !vistos.has(x.id) && x.estado !== 'rechazado'
      && (x.areas_protegidas || []).some(a => areas.has(a))).slice(0, 12) : [];
    const fila = x => `<li><button data-fx-abrir="${x.id}"><b>#${x.id}</b><span>${escHtml(_tituloTramite(x) || x.titulo_investigacion || nombreProceso(x.proceso_id))}</span>
      <em>${escHtml(x.nombre_solicitante || '')} · ${f(x.fecha_inicio)}</em></button></li>`;
    return {
      n: dup.length + otros.length,
      html: `${dup.length ? `<h4>Posibles duplicados regionales <small>mismo proyecto en otra región; deben consolidarse</small></h4><ul class="fx-rel">${dup.map(fila).join('')}</ul>` : ''}
        <h4>Otros permisos del mismo titular <small>para dar continuidad a sus investigaciones</small></h4>
        ${otros.length ? `<ul class="fx-rel">${otros.map(fila).join('')}</ul>` : '<p class="fx-nota">No hay otros permisos del mismo titular en los años cargados.</p>'}
        ${mismaArea.length ? `<h4>Otros permisos en las mismas áreas protegidas <small>${escHtml([...areas].join(', '))}</small></h4><ul class="fx-rel">${mismaArea.map(fila).join('')}</ul>` : ''}`,
    };
  }

  // ─── Cumplimiento: lo que el titular debe hacer, enlazado con el portal y las entregas ───
  function cumplimiento(t, piezas) {
    const sit = situacionTramite(t);
    const inv = IDS_INVESTIGACION.has(t.proceso_id);
    const plazo = inv ? plazoResultados(t) : null;
    const puedeSubir = !!window.PERFIL?.permisos?.agregar && inv;
    const item = (id, titulo, estado, cuerpo) => `<li class="fx-cum fx-cum--${estado}" id="${id}">
      <div class="fx-cum-cab"><span class="fx-cum-ico" aria-hidden="true">${estado === 'ok' ? '✓' : estado === 'no' ? '!' : '○'}</span><strong>${titulo}</strong></div>
      <div class="fx-cum-cuerpo">${cuerpo}</div></li>`;
    return `<ol class="fx-cums">
      ${item('fx-cum-registro', 'Registro geográfico de los sitios de trabajo', 'espera',
        `<p class="fx-nota" style="margin-top:0">El titular marca sus puntos de muestreo, transectos y parcelas en el <b>portal del investigador</b>, con un enlace y clave temporales que genera el administrador.</p>
         <div id="fx-registro"><div class="empty-msg">Consultando el portal del investigador…</div></div>`)}
      ${inv ? item('fx-cum-n6', 'Entrega de resultados (Numeral 6 del Reglamento)', piezas.entregaOk ? 'ok' : (plazo && new Date() > plazo ? 'no' : 'espera'),
        `${plazo ? `<p>Plazo: <b>${plazo.toLocaleDateString('es-CL')}</b> (3 años desde el término del trámite).</p>` : '<p>El plazo corre desde que termine el trámite.</p>'}
         ${piezas.entregados || '<p class="fx-nota">Aún no hay informes, publicaciones ni material entregado en la carpeta de Drive del titular.</p>'}
         ${puedeSubir ? `<button class="fx-btn" onclick="toggleUploadPanel(${t.id})">Subir lo entregado por el titular</button>
           <table class="bq-upload"><tbody>${_uploadPanelHtml(t)}</tbody></table>` : ''}
         <div id="fx-fotos-titular"></div>`) : ''}
      ${sit === 'cierre_solicitante' ? item('fx-cum-cierre', 'Cerrar el trámite en Cero Filas', 'espera',
        '<p>CONAF ya resolvió; falta que el titular confirme la recepción en su cuenta de Cero Filas. No es atraso de CONAF.</p>') : ''}
      ${item('fx-cum-cond', 'Respetar el período, las áreas y las condiciones de la resolución', sit === 'rechazado' ? 'no' : 'ok',
        `<p>${(() => { const { ini, fin } = periodo(t); return ini ? `Período autorizado: <b>${ini.toLocaleDateString('es-CL')}</b> al <b>${(fin || ini).toLocaleDateString('es-CL')}</b>. ` : ''; })()}
          Áreas: <b>${escHtml((t.areas_protegidas || []).join(', ') || '–')}</b>. Las condiciones están en la resolución (pestaña Documentos).</p>`)}
    </ol>
    ${piezas.cumplimiento ? `<details class="fx-cum-n6"><summary>Detalle del cumplimiento del Numeral 6</summary>${piezas.cumplimiento}</details>` : ''}`;
  }

  // Fotos «desde el terreno» extraídas de los informes de este titular (galería de la Portada)
  async function fotosDelTitular(t) {
    const cont = document.getElementById('fx-fotos-titular');
    if (!cont) return;
    try {
      const fotos = (await (await fetch('/api/fotos')).json()).data || [];
      const nombre = _normInv((t.nombre_solicitante || '').replace(/_/g, ' '));
      const suyas = fotos.filter(x => _normInv(x.investigador) === nombre).slice(0, 8);
      if (suyas.length) cont.innerHTML = `<h4>Fotos extraídas de sus informes <small>aparecen en «Desde el terreno» de la Portada</small></h4>
        <div class="fx-fotos">${suyas.map(x => `<img src="${x.url}" alt="" loading="lazy" title="${escHtml(x.documento)}">`).join('')}</div>`;
    } catch (e) { /* sin fotos */ }
  }

  // ─── Ajuste manual del estado (tramites/ajustes.py) ───────────────────────
  async function ajustes(t) {
    const cont = document.getElementById('fx-ajustes');
    if (!cont) return;
    let d;
    try {
      const r = await fetch(`/api/tramites/${t.id}/ajustes`);
      d = await r.json();
      if (!d.ok) return;
    } catch (e) { return; }
    if (!document.body.contains(cont)) return;
    const hist = d.historial.map((a, i) => `<li class="fx-aj${i === 0 && a.situacion !== 'revertido' ? ' fx-aj--vigente' : ''}">
        <div class="fx-aj-cab"><strong>${escHtml(a.nombre)}</strong>${i === 0 && a.situacion !== 'revertido' ? '<span class="fx-aj-vig">vigente</span>' : ''}
          <span class="fx-nota" style="margin:0">desde ${f(a.fecha_efectiva)} · registrado por ${escHtml(a.autor || '–')} el ${f(a.creado_en)}</span></div>
        <p>${escHtml(a.motivo)}</p>
        ${a.adjuntos.length ? `<div class="fx-aj-adj">${a.adjuntos.map(x => `<a href="/api/ajustes/${a.id}/adjuntos/${x.n}">📎 ${escHtml(x.nombre)} <small>${Math.max(1, Math.round(x.tamano / 1024))} KB</small></a>`).join('')}</div>` : ''}
      </li>`).join('');
    const hoy = new Date().toLocaleDateString('sv');   // AAAA-MM-DD en hora local
    const vigente = d.historial.length && d.historial[0].situacion !== 'revertido';
    const opciones = Object.entries(d.situaciones).filter(([k]) => k !== 'revertido' || vigente);
    cont.innerHTML = `<section class="fx-ajustes">
      <div class="fx-docs-cab"><h4 style="margin:0">Estado real del permiso <small>ajustes registrados por CONAF</small></h4>
        ${d.puede_ajustar ? '<button class="fx-btn" data-fx-aj-abrir>Ajustar estado</button>' : ''}</div>
      ${hist ? `<ol class="fx-ajs">${hist}</ol>` : `<p class="fx-nota">Sin ajustes: la plataforma usa el estado de Cero Filas.${d.puede_ajustar ? ' Si no refleja la realidad (el solicitante desistió, se resolvió por otra vía, es un duplicado…), regístrelo aquí con su justificación.' : ''}</p>`}
      ${d.puede_ajustar ? `<form class="fx-aj-form" hidden>
        <label>Estado real<select name="situacion" required><option value="">Elija…</option>${opciones.map(([k, v]) => `<option value="${k}">${escHtml(v)}</option>`).join('')}</select></label>
        <label>Desde (fecha en que ocurrió)<input type="date" name="fecha_efectiva" max="${hoy}" value="${hoy}" required></label>
        <label class="fx-aj-ancho">Justificación <small>(obligatoria: qué ocurrió, cómo se supo y quién lo informó; mín. 30 caracteres)</small>
          <textarea name="motivo" rows="4" required minlength="30" placeholder="Ej.: El 12-08 el titular informó por correo a la oficina regional que desiste del permiso por falta de financiamiento. No se registró en Cero Filas."></textarea></label>
        <label class="fx-aj-ancho">Respaldos <small>(opcional: correos .eml o .msg, PDF, imágenes; hasta 5 archivos de 10 MB)</small>
          <input type="file" name="archivos" multiple accept=".eml,.msg,.pdf,.png,.jpg,.jpeg,.txt,.doc,.docx"></label>
        <p class="pt-error fx-aj-error" hidden></p>
        <div class="fx-aj-ancho" style="display:flex;gap:8px"><button class="fx-btn fx-btn--pri" type="submit">Registrar ajuste</button>
          <button class="fx-btn" type="button" data-fx-aj-cancelar>Cancelar</button></div>
        <p class="fx-nota fx-aj-ancho">El ajuste queda en el historial con su autor y fecha (no se puede borrar) y se refleja en toda la plataforma. Cero Filas no se modifica.</p>
      </form>` : ''}
    </section>`;
    const form = cont.querySelector('.fx-aj-form');
    if (pendiente?.ajustar && form) { form.hidden = false; form.elements.situacion.focus(); }
    pendiente = null;
    cont.addEventListener('click', e => {
      if (e.target.closest('[data-fx-aj-abrir]')) { form.hidden = false; form.elements.situacion.focus(); }
      if (e.target.closest('[data-fx-aj-cancelar]')) form.hidden = true;
    });
    form?.addEventListener('submit', async e => {
      e.preventDefault();
      const err = form.querySelector('.fx-aj-error'), btn = form.querySelector('[type=submit]');
      err.hidden = true;
      if (form.elements.motivo.value.trim().length < 30) { err.textContent = 'La justificación debe tener al menos 30 caracteres.'; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = 'Registrando…';
      try {
        const r = await fetch(`/api/tramites/${t.id}/ajustes`, { method: 'POST', body: new FormData(form) });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || `Error ${r.status}`);
        // se refleja de inmediato en el resto de la plataforma y se recarga la ficha
        const x = STATE.tramites.find(z => z.id === t.id);
        const fr = await (await fetch(`/api/tramites/${t.id}`)).json();
        if (x && fr.ok) { if (fr.data.ajuste) x.ajuste = fr.data.ajuste; else delete x.ajuste; }
        if (typeof renderDashboard === 'function' && STATE.tramites.length) renderDashboard();
        openModal(t.id);
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
        btn.disabled = false; btn.textContent = 'Registrar ajuste';
      }
    });
  }

  // ─── Armado ────────────────────────────────────────────────────────────────
  function html(t, piezas) {
    const et = etapas(t);
    const d = t.datos_raw || {};
    const titulo = _tituloTramite(t) || campo(d, /nombre_del_proyecto/, /nombre_proyecto/) || nombreProceso(t.proceso_id);
    const institucion = campo(d, /institucion_patrocinante/, /^nombre_empresa/, /^razon_social/, /^institucion/);
    const res = piezas.adjuntos.find(([k]) => RESOLUCION.test(k));
    const rel = relacionados(t);
    const nCampos = (piezas.solicitudHtml.match(/modal-kv-item/g) || []).length;
    const tabs = [
      ['resumen', 'Resumen', '', resumen(t, piezas)],
      ['solicitud', 'Solicitud completa', nCampos, `<input class="fx-filtro" placeholder="Buscar un dato del formulario…" aria-label="Buscar en la solicitud">${piezas.solicitudHtml}`],
      ['territorio', 'Territorio', '', `${piezas.regiones || '<p class="fx-nota">El formulario no detalla regiones ni áreas.</p>'}
        <div class="fx-enlaces"><button class="fx-btn" data-fx-ir="cumplimiento">Ver los sitios que registró el titular</button>
        ${(t.regiones_list || []).length === 1 && window.PERFIL?.secciones?.some(x => x.startsWith('resumen')) ? `<button class="fx-btn" data-fx-territorio="${escHtml(t.regiones_list[0])}">Ver presión de permisos en la región</button>` : ''}</div>`],
      ['seguimiento', 'Seguimiento CONAF', et.length, `<div id="fx-ajustes"></div>${seguimiento(t, et)}`],
      ['documentos', 'Documentos', piezas.adjuntos.length + (piezas.nEntregados || 0), documentos(t, piezas)],
      ['cumplimiento', 'Cumplimiento del titular', '', cumplimiento(t, piezas)],
      ['relacionados', 'Relacionados', rel.n || '', rel.html],
    ];
    return `<div class="fx">
      <header class="fx-cab">
        <div class="fx-cab-txt">
          <div class="fx-chips">${badgeHtml(t.estado, { recepcionPendiente: t.recepcion_pendiente, tramite: t })}${tipoBadgeHtml(t)}<span class="fx-id">#${t.id}</span></div>
          <h2>${escHtml(titulo)}</h2>
          <p>${escHtml(t.nombre_solicitante || 'Sin nombre')}${institucion ? ` · ${escHtml(institucion)}` : ''}${t.email_solicitante
            ? (t.email_solicitante.includes('█') ? ` · ${escHtml(t.email_solicitante)}` : ` · <a href="${safeUrl('mailto:' + t.email_solicitante)}">${escHtml(t.email_solicitante)}</a>`) : ''}</p>
        </div>
        <div class="fx-acciones">
          ${res ? `<a class="fx-btn fx-btn--pri" href="/api/tramites/${t.id}/adjuntos/${encodeURIComponent(res[0])}" target="_blank" rel="noopener">Resolución</a>` : ''}
          <a class="fx-btn" href="/api/tramites/${t.id}/informe.pdf" data-tip="${escHtml('<strong>Informe PDF del permiso</strong><br><small>Ficha completa: situación, tiempos, proyecto, territorio, seguimiento CONAF, documentos, cumplimiento y la solicitud completa.</small>')}">Informe PDF</a>
          ${piezas.adjuntos.length ? `<a class="fx-btn" href="/api/tramites/${t.id}/adjuntos.zip">Adjuntos (ZIP)</a>` : ''}
          <a class="fx-btn" href="${safeUrl(`https://conaf.cerofilas.gob.cl/backend/seguimiento/ver/${t.id}`)}" target="_blank" rel="noopener">Cero Filas ↗</a>
          <button class="fx-btn" data-fx-copiar>Copiar enlace</button>
        </div>
      </header>
      ${!window.PERFIL?.ve_sensible && window.avisoPrivacidad ? `<div class="fx-aviso">${window.avisoPrivacidad()}</div>` : ''}
      ${situacion(t, et, piezas)}
      <div id="fx-tl-host">${lineaDeTiempo(t, et)}</div>
      <nav class="fx-tabs" role="tablist">${tabs.map(([id, nombre, n], i) => `<button role="tab" data-fx-tab="${id}" aria-selected="${i === 0}">${nombre}${n !== '' && n !== 0 ? ` <span>${n}</span>` : ''}</button>`).join('')}</nav>
      ${tabs.map(([id, , , cont], i) => `<section class="fx-panel" data-fx-panel="${id}" role="tabpanel" ${i ? 'hidden' : ''}>${cont}</section>`).join('')}
    </div>`;
  }

  function activar(t) {
    const body = document.getElementById('modal-tramite-body');
    const raiz = body.querySelector('.fx');
    if (!raiz) return;
    if (!body.dataset.tips && typeof _activarInteraccion === 'function') { _activarInteraccion(body); body.dataset.tips = '1'; }
    const irA = id => raiz.querySelector(`[data-fx-tab="${id}"]`)?.click();
    raiz.addEventListener('click', e => {
      const ir = e.target.closest('[data-fx-ir]');
      if (ir) return irA(ir.dataset.fxIr);
      const terr = e.target.closest('[data-fx-territorio]');
      if (terr) {
        document.getElementById('modal-tramite').style.display = 'none';
        document.querySelector(`.tab-btn[data-tab="dashboard"][data-tipo="${IDS_INVESTIGACION.has(t.proceso_id) ? 'inv' : 'film'}"]`)?.click();
        if (STATE.region !== terr.dataset.fxTerritorio) setRegion(terr.dataset.fxTerritorio);
        setTimeout(() => document.getElementById('terr-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
        return;
      }
      const tab = e.target.closest('[data-fx-tab]');
      if (tab) {
        raiz.querySelectorAll('[data-fx-tab]').forEach(b => b.setAttribute('aria-selected', String(b === tab)));
        raiz.querySelectorAll('[data-fx-panel]').forEach(p => { p.hidden = p.dataset.fxPanel !== tab.dataset.fxTab; });
        window.dispatchEvent(new Event('resize'));   // el mapa (Leaflet) recalcula su tamaño al hacerse visible
        return;
      }
      const ab = e.target.closest('[data-fx-abrir]');
      if (ab) return openModal(Number(ab.dataset.fxAbrir));
      const cp = e.target.closest('[data-fx-copiar]');
      if (cp) {
        const enlace = `${location.origin}/?tramite=${t.id}`;
        navigator.clipboard?.writeText(enlace).then(() => { cp.textContent = 'Enlace copiado ✓'; }, () => { prompt('Copie el enlace:', enlace); });
      }
    });
    raiz.querySelector('.fx-filtro')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      raiz.querySelectorAll('[data-fx-panel="solicitud"] .modal-kv-item').forEach(el => {
        el.hidden = q && !el.textContent.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q);
      });
    });
    if (pendiente?.tab) irA(pendiente.tab);
    window.RegistroGeo?.montar(t, document.getElementById('fx-registro'), n => {
      const p = document.getElementById('fx-pend-registro');
      if (p && !n) p.textContent = ' Falta el registro geográfico del titular (puntos, transectos o parcelas).';
      const item = document.getElementById('fx-cum-registro');
      if (item && n) { item.className = 'fx-cum fx-cum--ok'; item.querySelector('.fx-cum-ico').textContent = '✓'; }
    });
    fotosDelTitular(t);
    ajustes(t);
  }

  // Enlace directo: /?tramite=ID abre la ficha al terminar de cargar
  document.addEventListener('DOMContentLoaded', async () => {
    const id = new URLSearchParams(location.search).get('tramite');
    if (!/^\d{4,12}$/.test(id || '')) return;
    for (let k = 0; k < 240 && getComputedStyle(document.getElementById('loading-overlay') || document.body).display !== 'none'
      && document.getElementById('loading-overlay')?.offsetParent !== null; k++) await new Promise(r => setTimeout(r, 500));
    openModal(Number(id));
  });

  function abrir(id, opciones) { pendiente = opciones || null; openModal(id); }

  return { html, activar, abrir };
})();
