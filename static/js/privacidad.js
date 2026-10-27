/* ═══════════════════════════════════════════════
   Protección de datos (Ley N°21.719 y Ley N°21.663), igual que Recoge PH.
   El servidor ya reemplazó los datos sensibles por «█████» para quien no tiene rol
   Editor (tramites/privacidad.py): aquí solo se muestran difuminados y tachados, con
   el aviso al pasar el cursor. Se recorren nodos de texto (nunca HTML), así no hay
   riesgo de inyectar marcado.
   ═══════════════════════════════════════════════ */
'use strict';
(() => {
  if (window.PERFIL?.ve_sensible) return;
  const AVISO = 'Dato protegido (Ley N°21.719). Requiere rol Editor o superior.';
  const MARCA = /█+(?:·[0-9a-f]{4})?/g;

  function envolver(nodo) {
    const texto = nodo.nodeValue;
    if (!texto || !texto.includes('█')) return;
    const p = nodo.parentNode;
    if (!p || p.classList?.contains('dato-protegido') || ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'OPTION', 'TITLE'].includes(p.nodeName)) return;
    if (p.closest?.('svg')) return;
    const frag = document.createDocumentFragment();
    let i = 0;
    texto.replace(MARCA, (m, pos) => {
      if (pos > i) frag.appendChild(document.createTextNode(texto.slice(i, pos)));
      const s = document.createElement('span');
      s.className = 'dato-protegido';
      s.title = AVISO;
      s.textContent = '█████';
      frag.appendChild(s);
      i = pos + m.length;
    });
    if (i < texto.length) frag.appendChild(document.createTextNode(texto.slice(i)));
    p.replaceChild(frag, nodo);
  }

  function recorrer(raiz) {
    if (raiz.nodeType === 3) return envolver(raiz);
    if (raiz.nodeType !== 1) return;
    const w = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeValue.includes('█') ? 1 : 3 });
    const lista = [];
    while (w.nextNode()) lista.push(w.currentNode);
    lista.forEach(envolver);
  }

  new MutationObserver(cambios => cambios.forEach(c => c.addedNodes.forEach(recorrer)))
    .observe(document.body, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => recorrer(document.body));

  // Aviso legal (una vez por sesión) arriba de la ficha y de la búsqueda
  window.avisoPrivacidad = () => `<div class="aviso-privacidad"><b>Protección de datos.</b> Conforme a la <b>Ley N°21.719</b> de
    Protección de Datos Personales y a la Ley Marco de Ciberseguridad (N°21.663), la información sensible (RUT, correos,
    teléfonos, coordenadas exactas) se muestra <span class="dato-protegido">█████</span> <s>difuminada y tachada</s> para
    usuarios no autorizados. Las coordenadas de los mapas son aproximadas (~1 km). Para ver el contenido completo se requiere rol Editor o superior.</div>`;
})();
