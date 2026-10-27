/* ═══════════════════════════════════════════════
   Panel de accesos temporales de investigadores (solo superusuario).
   API: GET /api/accesos, POST /api/accesos/{id}/revocar
   ═══════════════════════════════════════════════ */
'use strict';
(() => {
  const $    = id => document.getElementById(id);
  const csrf = () => (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const esc  = s  => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  let datos = [], cargado = false;

  function fecha(iso, conHora = false) {
    if (!iso) return '–';
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    if (conHora) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
    return new Date(iso).toLocaleString('es-CL', opts);
  }

  function esVencidoSinEntrega(a) {
    if (a.revocado) return false;
    const hoy   = new Date(); hoy.setHours(0, 0, 0, 0);
    const vence = new Date(a.vence); vence.setHours(0, 0, 0, 0);
    return vence < hoy && !a.registros && !a.n6;
  }

  function estadoPill(a) {
    if (a.revocado) return '<span class="acc-pill acc-pill--rev">revocado</span>';
    const hoy   = new Date(); hoy.setHours(0, 0, 0, 0);
    const vence = new Date(a.vence); vence.setHours(0, 0, 0, 0);
    if (vence < hoy) {
      if (!a.registros && !a.n6) return '<span class="acc-pill acc-pill--sin">vencido sin entrega</span>';
      return '<span class="acc-pill acc-pill--ven">vencido</span>';
    }
    return '<span class="acc-pill acc-pill--ok">vigente</span>';
  }

  function tipoPill(tipo) {
    return tipo === 'inv'
      ? '<span class="acc-tipo acc-tipo--inv">Inv</span>'
      : '<span class="acc-tipo acc-tipo--film">Film</span>';
  }

  function filtrar() {
    const estado = $('acc-filtro-estado').value;
    const tipo   = $('acc-filtro-tipo').value;
    return datos.filter(a => {
      if (tipo && a.tipo !== tipo) return false;
      if (estado === 'vigente')  return !a.revocado && a.vigente;
      if (estado === 'vencido')  return esVencidoSinEntrega(a);
      if (estado === 'revocado') return a.revocado;
      return true;
    });
  }

  function renderTabla() {
    const lista = filtrar();
    $('acc-conteo').textContent = `${lista.length} acceso${lista.length !== 1 ? 's' : ''}`;
    if (!lista.length) {
      $('acc-tabla').innerHTML = `<tr><td colspan="11" class="empty-msg">Sin resultados.</td></tr>`;
      return;
    }
    $('acc-tabla').innerHTML = lista.map(a => {
      const puedRev = !a.revocado && a.vigente;
      const alerta  = esVencidoSinEntrega(a);
      return `<tr class="hist-fila${alerta ? ' acc-fila--alerta' : ''}">
        <td><button class="hist-tramite" data-tramite="${a.tramite_id}">#${a.tramite_id}</button></td>
        <td class="acc-sol" title="${esc(a.titulo)}">${esc(a.solicitante)}</td>
        <td>${tipoPill(a.tipo)}</td>
        <td>${esc(a.creado_por_nombre || a.usuario)}</td>
        <td>${fecha(a.creado_en)}</td>
        <td>${fecha(a.vence)}</td>
        <td>${estadoPill(a)}</td>
        <td class="acc-cnt ${a.registros ? 'acc-cnt--ok' : 'acc-cnt--0'}">${a.registros || '–'}</td>
        <td class="acc-cnt ${a.n6 ? 'acc-cnt--ok' : 'acc-cnt--0'}">${a.n6 || '–'}</td>
        <td>${a.ultimo_ingreso ? fecha(a.ultimo_ingreso, true) : '<span class="acc-nunca">Nunca</span>'}</td>
        <td>${puedRev
          ? `<button class="btn-sm acc-revocar" data-id="${a.id}" data-tramite="${a.tramite_id}">Revocar</button>`
          : ''}</td>
      </tr>`;
    }).join('');
  }

  async function cargar() {
    if (cargado) { renderTabla(); return; }
    $('acc-tabla').innerHTML = '<tr><td colspan="11" class="empty-msg">Cargando…</td></tr>';
    try {
      const d = await fetch('/api/accesos').then(r => r.json());
      if (!d.ok) throw new Error(d.error || 'Error');
      datos   = d.data || [];
      cargado = true;
      renderTabla();
    } catch (e) {
      $('acc-tabla').innerHTML = `<tr><td colspan="11" class="empty-msg">Error: ${esc(e.message)}</td></tr>`;
    }
  }

  async function revocar(id, tramite) {
    if (!confirm(`¿Revocar el acceso del trámite #${tramite}?\nEl investigador no podrá ingresar al portal a partir de ahora.`)) return;
    const btn = document.querySelector(`.acc-revocar[data-id="${id}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const d = await fetch(`/api/accesos/${id}/revocar`, {
        method: 'POST',
        headers: { 'X-CSRFToken': csrf(), 'Content-Type': 'application/json' },
      }).then(r => r.json());
      if (!d.ok) throw new Error(d.error || 'Error');
      const idx = datos.findIndex(a => a.id === id);
      if (idx >= 0) datos[idx] = { ...datos[idx], ...d.acceso };
      renderTabla();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Revocar'; }
      alert('No se pudo revocar: ' + e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('.sb-nav')?.addEventListener('click', e => {
      if (e.target.closest('.tab-btn[data-tab="accesos"]')) cargar();
    });
    $('acc-filtro-estado')?.addEventListener('change', () => { if (cargado) renderTabla(); });
    $('acc-filtro-tipo')?.addEventListener('change',   () => { if (cargado) renderTabla(); });
    document.getElementById('acc-tabla')?.addEventListener('click', e => {
      const rev = e.target.closest('.acc-revocar');
      if (rev) { revocar(+rev.dataset.id, rev.dataset.tramite); return; }
      const tr = e.target.closest('.hist-tramite');
      if (tr) window.abrirFicha?.(+tr.dataset.tramite);
    });
  });
})();
