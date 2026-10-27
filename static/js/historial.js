/* ═══════════════════════════════════════════════
   Historial de auditoría (solo superusuario).
   API: /api/auditoria, /api/auditoria/{id}/revertir
   ═══════════════════════════════════════════════ */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const csrf = () => (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  let pagina = 1, totalPaginas = 1;

  async function apiFetch(url, opciones = {}) {
    const r = await fetch(url, {
      ...opciones,
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), ...(opciones.headers || {}) },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || `Error ${r.status}`);
    return d;
  }

  function fecha(iso) {
    if (!iso) return '–';
    return new Date(iso).toLocaleString('es-CL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const ICONOS = {
    ajuste_creado:        '🔄',
    acceso_creado:        '🔑',
    acceso_revocado:      '🚫',
    archivo_subido:       '📎',
    usuario_creado:       '👤',
    usuario_editado:      '✏️',
    password_restablecida:'🔐',
    registro_creado:      '📍',
    registro_editado:     '📍',
    registro_borrado:     '🗑️',
  };

  function filaHtml(a) {
    const icono = ICONOS[a.accion] || '•';
    const revertido = a.revertido
      ? `<span class="hist-tag hist-tag--rev" title="${_esc(a.revertido_nota)}">revertido</span>`
      : (a.es_reversible
          ? `<button class="hist-rev" data-id="${a.id}" title="Revertir esta acción">↩ Revertir</button>`
          : '');
    const enlace = a.objeto_tipo === 'tramite' && a.objeto_id
      ? `<button class="hist-tramite" data-tramite="${a.objeto_id}" title="Ver trámite #${a.objeto_id}">#${a.objeto_id}</button>`
      : (a.objeto_id ? `<span class="hist-obj">#${a.objeto_id}</span>` : '');
    return `<tr class="hist-fila${a.revertido ? ' hist-fila--rev' : ''}">
      <td class="hist-ico">${icono}</td>
      <td>${fecha(a.creado_en)}</td>
      <td class="hist-usuario">${_esc(a.usuario_nombre || '–')}</td>
      <td class="hist-accion">${_esc(a.accion_nombre || a.accion)}</td>
      <td class="hist-desc">${_esc(a.descripcion)}</td>
      <td>${enlace}</td>
      <td class="hist-acc">${revertido}</td>
    </tr>`;
  }

  async function cargar() {
    const filtroAccion = $('hist-filtro-accion')?.value || '';
    const filtroUser = $('hist-filtro-usuario')?.value?.trim() || '';
    const cont = $('hist-tabla');
    if (!cont) return;
    cont.innerHTML = '<tr><td colspan="7" class="empty-msg">Cargando…</td></tr>';
    try {
      const params = new URLSearchParams({ page: pagina });
      if (filtroAccion) params.set('accion', filtroAccion);
      if (filtroUser) params.set('usuario', filtroUser);
      const d = await apiFetch(`/api/auditoria?${params}`);
      totalPaginas = d.pages || 1;
      $('hist-pag-info').textContent = `Página ${pagina} de ${totalPaginas} · ${d.total} registros`;
      $('hist-pag-ant').disabled = pagina <= 1;
      $('hist-pag-sig').disabled = pagina >= totalPaginas;
      cont.innerHTML = d.data.length
        ? d.data.map(filaHtml).join('')
        : '<tr><td colspan="7" class="empty-msg">Sin registros que coincidan.</td></tr>';
    } catch (e) {
      cont.innerHTML = `<tr><td colspan="7" class="empty-msg">No se pudo cargar (${_esc(e.message)}).</td></tr>`;
    }
  }

  function inicializar() {
    if (!$('hist-tabla')) return;

    $('hist-filtro-accion')?.addEventListener('change', () => { pagina = 1; cargar(); });
    $('hist-filtro-usuario')?.addEventListener('input', () => { pagina = 1; cargar(); });
    $('hist-pag-ant')?.addEventListener('click', () => { if (pagina > 1) { pagina--; cargar(); } });
    $('hist-pag-sig')?.addEventListener('click', () => { if (pagina < totalPaginas) { pagina++; cargar(); } });

    $('hist-tabla').addEventListener('click', async e => {
      const btn = e.target.closest('.hist-rev');
      if (btn) {
        const id = Number(btn.dataset.id);
        if (!confirm('¿Revertir esta acción? El cambio no se puede deshacer nuevamente.')) return;
        btn.disabled = true; btn.textContent = 'Revirtiendo…';
        try {
          const r = await apiFetch(`/api/auditoria/${id}/revertir`, { method: 'POST' });
          alert(r.mensaje || 'Acción revertida.');
          cargar();
        } catch (err) {
          alert(err.message);
          btn.disabled = false; btn.textContent = '↩ Revertir';
        }
        return;
      }
      const tb = e.target.closest('.hist-tramite');
      if (tb && typeof openModal === 'function') {
        openModal(Number(tb.dataset.tramite));
      }
    });
  }

  document.querySelector('.tab-btn[data-tab="historial"]')?.addEventListener('click', () => {
    inicializar();
    pagina = 1;
    cargar();
  });
})();
