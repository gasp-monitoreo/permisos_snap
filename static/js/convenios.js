/* ═══════════════════════════════════════════════
   Módulo de Convenios institucionales
   API: GET /api/convenios, GET /api/convenios/filtros,
        POST /api/convenios, POST /api/convenios/{id}/pdf
   ═══════════════════════════════════════════════ */
'use strict';
(() => {
  const $    = id => document.getElementById(id);
  const csrf = () => (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const esc  = s  => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  let pagina = 1, totalPaginas = 1, totalItems = 0;
  let filtrosReady = false;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function fecha(iso) {
    if (!iso) return '–';
    return new Date(iso + 'T00:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function estadoPill(estado) {
    const cls = {
      'vigente':   'conv-pill--ok',
      'por_vencer':'conv-pill--ven',
      'vencido':   'conv-pill--sin',
      'terminado': 'conv-pill--term',
    }[estado] || 'conv-pill--otro';
    const nombres = { vigente:'Vigente', por_vencer:'Por vencer', vencido:'Vencido', terminado:'Terminado' };
    return `<span class="conv-pill ${cls}">${esc(nombres[estado] || estado)}</span>`;
  }

  function iconoPdf(driveUrl, nombre) {
    if (!driveUrl) return '<span class="conv-sin-pdf">Sin PDF</span>';
    return `<a class="conv-pdf-link" href="${esc(driveUrl)}" target="_blank" rel="noopener" title="${esc(nombre || 'Ver PDF')}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
      </svg>PDF</a>`;
  }

  // ── Carga de filtros ──────────────────────────────────────────────────────
  async function cargarFiltros() {
    if (filtrosReady) return;
    try {
      const d = await fetch('/api/convenios/filtros').then(r => r.json());
      if (!d.ok) return;
      const selReg = $('conv-filtro-region');
      if (selReg) {
        d.regiones.forEach(r => {
          const o = document.createElement('option'); o.value = r; o.textContent = r;
          selReg.appendChild(o);
        });
      }
      const selAnio = $('conv-filtro-anio');
      if (selAnio) {
        d.anios.forEach(a => {
          const o = document.createElement('option'); o.value = a; o.textContent = a;
          selAnio.appendChild(o);
        });
      }
      filtrosReady = true;
    } catch (e) { /* silencioso */ }
  }

  // ── Buscar ────────────────────────────────────────────────────────────────
  async function buscar(pag = 1) {
    pagina = pag;
    const params = new URLSearchParams({ page: pagina });
    const region   = $('conv-filtro-region')?.value   || '';
    const anio     = $('conv-filtro-anio')?.value     || '';
    const estado   = $('conv-filtro-estado')?.value   || '';
    const tipo_org = $('conv-filtro-tipo-org')?.value || '';
    const q        = $('conv-busqueda')?.value?.trim() || '';
    if (region)   params.set('region',   region);
    if (anio)     params.set('anio',     anio);
    if (estado)   params.set('estado',   estado);
    if (tipo_org) params.set('tipo_org', tipo_org);
    if (q)        params.set('q',        q);

    const tbody = $('conv-tabla');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">Buscando…</td></tr>';

    try {
      const d = await fetch(`/api/convenios?${params}`).then(r => r.json());
      if (!d.ok) throw new Error(d.error || 'Error');
      totalPaginas = d.pages || 1;
      totalItems   = d.total || 0;
      renderTabla(d.data);
      renderPaginacion();
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="empty-msg">Error: ${esc(e.message)}</td></tr>`;
    }
  }

  function renderTabla(lista) {
    const tbody = $('conv-tabla');
    if (!tbody) return;
    $('conv-conteo').textContent = `${totalItems} convenio${totalItems !== 1 ? 's' : ''}`;

    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">Sin resultados para los filtros seleccionados.</td></tr>';
      return;
    }
    tbody.innerHTML = lista.map(c => `
      <tr class="hist-fila conv-fila" data-id="${c.id}">
        <td class="conv-anio">${c.anio || '–'}</td>
        <td class="conv-region">${esc(c.region)}</td>
        <td class="conv-nombre">
          <button class="conv-ver-btn" data-id="${c.id}">${esc(c.nombre)}</button>
        </td>
        <td class="conv-razon">${esc(c.razon_social)}</td>
        <td>${esc(c.tipo_convenio_nombre)}</td>
        <td>${estadoPill(c.estado)}</td>
        <td>${iconoPdf(c.drive_url, c.nombre_archivo)}</td>
        <td>${c.drive_url2 ? iconoPdf(c.drive_url2, c.nombre_archivo2) : ''}</td>
      </tr>`).join('');
  }

  function renderPaginacion() {
    const info = $('conv-pag-info');
    const ant  = $('conv-pag-ant');
    const sig  = $('conv-pag-sig');
    if (info) info.textContent = `Página ${pagina} de ${totalPaginas} · ${totalItems} resultados`;
    if (ant)  ant.disabled  = pagina <= 1;
    if (sig)  sig.disabled  = pagina >= totalPaginas;
  }

  // ── Modal detalle ─────────────────────────────────────────────────────────
  async function verDetalle(id) {
    const modal = $('conv-modal');
    if (!modal) return;
    $('conv-modal-body').innerHTML = '<p class="empty-msg">Cargando…</p>';
    modal.classList.add('conv-modal--open');
    document.body.classList.add('modal-open');

    try {
      const d = await fetch(`/api/convenios/${id}`).then(r => r.json());
      if (!d.ok) throw new Error(d.error || 'Error');
      const c = d.data;
      $('conv-modal-body').innerHTML = `
        <h3 class="conv-det-titulo">${esc(c.nombre)}</h3>
        <div class="conv-det-grid">
          <span class="conv-det-lbl">Contraparte</span><span>${esc(c.razon_social) || '–'}</span>
          <span class="conv-det-lbl">RUT</span><span>${esc(c.rut) || '–'}</span>
          <span class="conv-det-lbl">Región</span><span>${esc(c.region) || '–'}</span>
          <span class="conv-det-lbl">Tipo de convenio</span><span>${esc(c.tipo_convenio_nombre)}</span>
          <span class="conv-det-lbl">Tipo de organización</span><span>${esc(c.tipo_organizacion_nombre)}</span>
          <span class="conv-det-lbl">Año</span><span>${c.anio || '–'}</span>
          <span class="conv-det-lbl">Fecha de firma</span><span>${fecha(c.fecha_firma)}</span>
          <span class="conv-det-lbl">Duración</span><span>${esc(c.duracion) || '–'}</span>
          <span class="conv-det-lbl">Término</span><span>${esc(c.termino) || '–'}</span>
          <span class="conv-det-lbl">Renovación automática</span><span>${esc(c.renovacion_automatica) || '–'}</span>
          <span class="conv-det-lbl">Estado</span><span>${estadoPill(c.estado)}</span>
          <span class="conv-det-lbl">Responsable CONAF</span><span>${esc(c.responsable_conaf) || '–'}</span>
        </div>
        ${c.objetivo ? `<div class="conv-det-campo"><strong>Objetivo:</strong><p>${esc(c.objetivo)}</p></div>` : ''}
        ${c.transf_bienes ? `<div class="conv-det-campo"><strong>Transferencia de bienes y servicios:</strong><p>${esc(c.transf_bienes)}</p></div>` : ''}
        ${c.transf_presup ? `<div class="conv-det-campo"><strong>Transferencia presupuestaria:</strong><p>${esc(c.transf_presup)}</p></div>` : ''}
        ${c.beneficios_ingreso ? `<div class="conv-det-campo"><strong>Beneficios de ingreso:</strong><p>${esc(c.beneficios_ingreso)}</p></div>` : ''}
        ${c.fecha_adendas ? `<div class="conv-det-campo"><strong>Fecha de adendas:</strong><p>${esc(c.fecha_adendas)}</p></div>` : ''}
        ${c.observaciones ? `<div class="conv-det-campo"><strong>Observaciones:</strong><p>${esc(c.observaciones)}</p></div>` : ''}
        <div class="conv-det-pdfs">
          ${c.drive_url ? `<a class="btn-sm conv-pdf-dl" href="${esc(c.drive_url)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg> Descargar PDF principal</a>` : '<span class="conv-sin-pdf">Sin PDF</span>'}
          ${c.drive_url2 ? `<a class="btn-sm conv-pdf-dl" href="${esc(c.drive_url2)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg> Descargar PDF adicional</a>` : ''}
        </div>`;
    } catch (e) {
      $('conv-modal-body').innerHTML = `<p class="empty-msg">Error: ${esc(e.message)}</p>`;
    }
  }

  function cerrarModal() {
    $('conv-modal')?.classList.remove('conv-modal--open');
    document.body.classList.remove('modal-open');
  }

  // ── Nuevo convenio ────────────────────────────────────────────────────────
  function abrirFormNuevo() {
    $('conv-form-modal')?.classList.add('conv-modal--open');
    document.body.classList.add('modal-open');
  }

  function cerrarFormNuevo() {
    $('conv-form-modal')?.classList.remove('conv-modal--open');
    document.body.classList.remove('modal-open');
    $('conv-form')?.reset();
    $('conv-form-error').textContent = '';
    $('conv-form-pdf-status').textContent = '';
  }

  async function guardarNuevo(e) {
    e.preventDefault();
    const btn = $('conv-form-guardar');
    btn.disabled = true; btn.textContent = 'Guardando…';
    $('conv-form-error').textContent = '';

    const body = {
      nombre:              $('cf-nombre').value.trim(),
      region:              $('cf-region').value.trim(),
      rut:                 $('cf-rut').value.trim(),
      razon_social:        $('cf-razon').value.trim(),
      tipo_convenio:       $('cf-tipo-conv').value,
      tipo_organizacion:   $('cf-tipo-org').value,
      estado:              $('cf-estado').value,
      anio:                $('cf-anio').value || null,
      fecha_firma:         $('cf-fecha').value || null,
      duracion:            $('cf-duracion').value.trim(),
      termino:             $('cf-termino').value.trim(),
      objetivo:            $('cf-objetivo').value.trim(),
      responsable_conaf:   $('cf-responsable').value.trim(),
      observaciones:       $('cf-obs').value.trim(),
    };

    try {
      const d = await fetch('/api/convenios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() },
        body: JSON.stringify(body),
      }).then(r => r.json());
      if (!d.ok) throw new Error(d.error || 'Error al guardar');

      const convId = d.data.id;

      // Subir PDF si hay uno
      const pdfFile = $('cf-pdf')?.files[0];
      if (pdfFile) {
        $('conv-form-pdf-status').textContent = 'Subiendo PDF…';
        const fd = new FormData();
        fd.append('archivo', pdfFile);
        fd.append('slot', '1');
        const dp = await fetch(`/api/convenios/${convId}/pdf`, {
          method: 'POST',
          headers: { 'X-CSRFToken': csrf() },
          body: fd,
        }).then(r => r.json());
        if (!dp.ok) {
          $('conv-form-pdf-status').textContent = `Convenio guardado, pero el PDF no se subió: ${dp.error}`;
        } else {
          $('conv-form-pdf-status').textContent = 'PDF subido correctamente.';
        }
      }

      cerrarFormNuevo();
      buscar(1);
    } catch (e) {
      $('conv-form-error').textContent = e.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Guardar convenio';
    }
  }

  // ── Inicialización ────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    // Activar al pulsar la pestaña
    document.querySelector('.sb-nav')?.addEventListener('click', async e => {
      if (e.target.closest('.tab-btn[data-tab="convenios"]')) {
        await cargarFiltros();
        buscar(1);
      }
    });

    // Filtros y búsqueda
    ['conv-filtro-region','conv-filtro-anio','conv-filtro-estado','conv-filtro-tipo-org'].forEach(id => {
      $(id)?.addEventListener('change', () => buscar(1));
    });

    let debounceQ;
    $('conv-busqueda')?.addEventListener('input', () => {
      clearTimeout(debounceQ);
      debounceQ = setTimeout(() => buscar(1), 350);
    });
    $('conv-busqueda')?.addEventListener('keydown', e => { if (e.key === 'Enter') buscar(1); });

    // Paginación
    $('conv-pag-ant')?.addEventListener('click', () => { if (pagina > 1) buscar(pagina - 1); });
    $('conv-pag-sig')?.addEventListener('click', () => { if (pagina < totalPaginas) buscar(pagina + 1); });

    // Tabla: abrir detalle
    $('conv-tabla')?.addEventListener('click', e => {
      const btn = e.target.closest('.conv-ver-btn');
      if (btn) verDetalle(+btn.dataset.id);
    });

    // Cerrar modal detalle
    $('conv-modal-cerrar')?.addEventListener('click', cerrarModal);
    $('conv-modal')?.addEventListener('click', e => { if (e.target === $('conv-modal')) cerrarModal(); });

    // Botón nuevo convenio
    $('conv-nuevo-btn')?.addEventListener('click', abrirFormNuevo);
    $('conv-form-cancelar')?.addEventListener('click', cerrarFormNuevo);
    $('conv-form-modal')?.addEventListener('click', e => { if (e.target === $('conv-form-modal')) cerrarFormNuevo(); });
    $('conv-form')?.addEventListener('submit', guardarNuevo);

    // Escape cierra modales
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { cerrarModal(); cerrarFormNuevo(); }
    });
  });
})();
