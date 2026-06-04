# -*- coding: utf-8 -*-
"""
reorganizar_local.py
====================
Reorganiza la carpeta Investigaciones usando los trámites ya cargados
en la app Flask (http://localhost:5001/api/tramites).
No hace llamadas a la API de CeroFilas — termina en segundos.

Estructura final:
  Investigaciones/{Nombre Completo}/{id_tramite}/archivos...

Para carpetas sin match: se dejan intactas (estructura plana existente).
Genera _mapeo.json con el resultado.
"""
import os, sys, shutil, json, unicodedata, time, requests

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

FLASK_URL   = "http://localhost:5001"
API_URL     = "https://conaf.cerofilas.gob.cl/backend/api"
TOKEN       = "GI1K0CaTKltnR9ziu60jBUKfsbNI13"
INV_DIR     = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Investigaciones")
INV_PIDS    = [517, 692, 1992]
INV_EXT     = {'.pdf', '.doc', '.docx', '.csv', '.xls', '.xlsx'}
MAX_PAGES   = 300  # páginas máx a descargar por proceso (300×10=3000 trámites)

# ── Normalización ─────────────────────────────────────────────────────────────
def norm(s):
    s = (s or "").lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join("".join(c if c.isalnum() else " " for c in s).split())

# ── Leer carpetas para early-stop ─────────────────────────────────────────────
carpetas_para_match = sorted(
    f for f in os.listdir(INV_DIR)
    if os.path.isdir(os.path.join(INV_DIR, f))
    and not f.startswith("_") and not f.startswith(".")
)
carpeta_tokens = {
    folder: [t for t in norm(folder.replace("_", " ")).split() if len(t) > 1]
    for folder in carpetas_para_match
}

def all_matched(name_map):
    """True si todas las carpetas ya tienen al menos una coincidencia."""
    for folder, tokens in carpeta_tokens.items():
        found = any(
            all(tok in name_n for tok in tokens)
            for name_n in name_map
        )
        if not found:
            return False
    return True

# ── Cargar trámites directamente de CeroFilas ─────────────────────────────────
print("Cargando trámites desde CeroFilas (puede tardar varios minutos)...")
name_map = {}  # norm_nombre -> [(nombre_completo, tramite_id)]

for pid in INV_PIDS:
    page_token = None
    page = 0
    t0 = time.time()
    print(f"\n  Proceso {pid}:")
    while page < MAX_PAGES:
        params = {"token": TOKEN, "per_page": 100}
        if page_token:
            params["page_token"] = page_token
        try:
            r = requests.get(f"{API_URL}/procesos/{pid}/tramites", params=params, timeout=30)
            r.raise_for_status()
            feed = r.json().get("tramites", {})
            batch = feed.get("items") or []
            page_token = feed.get("nextPageToken")
            page += 1

            for t in batch:
                for e in (t.get("etapas") or []):
                    ua = e.get("usuario_asignado") or {}
                    n  = (ua.get("nombres") or "").strip()
                    ap = (ua.get("apellido_paterno") or "").strip()
                    am = (ua.get("apellido_materno") or "").strip()
                    if n:
                        nombre = " ".join(p for p in [n, ap, am] if p)
                        key = norm(nombre)
                        name_map.setdefault(key, []).append((nombre, t["id"]))
                        break

            if page % 50 == 0:
                elapsed = time.time() - t0
                matched = sum(1 for folder, tokens in carpeta_tokens.items()
                              if any(all(tok in nn for tok in tokens) for nn in name_map))
                print(f"    pág {page:4d} | {page*10:6d} trámites | {matched}/{len(carpetas_para_match)} coincidencias | {elapsed:.0f}s")

            if all_matched(name_map):
                print(f"    ¡Todas las carpetas coincididas! Deteniendo en pág {page}.")
                break

            if not page_token or not batch:
                print(f"    Fin de proceso {pid} en pág {page}.")
                break

            time.sleep(0.2)

        except Exception as e:
            print(f"    Error pág {page}: {e}")
            time.sleep(2)
            continue

print(f"\n  {len(name_map)} solicitantes únicos en el mapa")

# ── Leer carpetas actuales ────────────────────────────────────────────────────
carpetas = carpetas_para_match
print(f"  {len(carpetas)} carpetas en Investigaciones/\n")

# ── Matching ──────────────────────────────────────────────────────────────────
mapping  = []
sin_match = []

for folder in carpetas:
    tokens = [t for t in norm(folder.replace("_", " ")).split() if len(t) > 1]
    matched = {}  # id → (nombre, tid)

    for name_n, items in name_map.items():
        if tokens and all(tok in name_n for tok in tokens):
            for nombre, tid in items:
                matched[tid] = nombre

    src = os.path.join(INV_DIR, folder)
    archivos = []
    for root, dirs, files in os.walk(src):
        for f in sorted(files):
            if f.startswith("."): continue
            ext = os.path.splitext(f)[1].lower()
            if ext not in INV_EXT: continue
            archivos.append(os.path.relpath(os.path.join(root, f), src))

    if not matched:
        print(f"  SIN MATCH: {folder!r}  ({len(archivos)} archivos)")
        sin_match.append({"folder": folder, "archivos": archivos})
    else:
        nombre = list(matched.values())[0]
        ids    = sorted(matched.keys())
        print(f"  OK  {folder!r}")
        print(f"      → '{nombre}'  IDs={ids}  ({len(archivos)} archivos)")
        mapping.append({
            "folder_orig": folder,
            "full_name":   nombre,
            "ids":         ids,
            "archivos":    archivos,
        })

print(f"\n{len(mapping)} con match / {len(sin_match)} sin match\n")

# ── Guardar mapeo ─────────────────────────────────────────────────────────────
mapeo_path = os.path.join(INV_DIR, "_mapeo.json")
with open(mapeo_path, "w", encoding="utf-8") as f:
    json.dump({"mapping": mapping, "sin_match": sin_match}, f,
              ensure_ascii=False, indent=2)
print(f"Mapeo guardado en {mapeo_path}\n")

# ── Preguntar antes de reorganizar ────────────────────────────────────────────
if not mapping:
    print("Nada que reorganizar.")
    sys.exit(0)

resp = input("¿Ejecutar reorganización? (s/N): ").strip().lower()
if resp != 's':
    print("Cancelado. Puede revisar _mapeo.json primero.")
    sys.exit(0)

# ── Reorganizar ───────────────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("Reorganizando...\n")

for entry in mapping:
    src_folder = os.path.join(INV_DIR, entry["folder_orig"])
    full_name  = entry["full_name"]
    ids        = entry["ids"]
    archivos   = entry["archivos"]

    dst_root = os.path.join(INV_DIR, full_name)

    for tid in ids:
        tid_folder = os.path.join(dst_root, str(tid))
        os.makedirs(tid_folder, exist_ok=True)
        for rel_path in archivos:
            src_file = os.path.join(src_folder, rel_path)
            if not os.path.exists(src_file):
                continue
            filename = os.path.basename(rel_path)
            dst_file = os.path.join(tid_folder, filename)
            if os.path.exists(dst_file) and os.path.abspath(dst_file) != os.path.abspath(src_file):
                subdir = os.path.dirname(rel_path).replace(os.sep, "_")
                if subdir:
                    filename = f"{subdir}_{filename}"
                    dst_file = os.path.join(tid_folder, filename)
            shutil.copy2(src_file, dst_file)
        print(f"  ✓ {full_name}/{tid}/  ({len(archivos)} archivos)")

    # Eliminar carpeta original si el destino es diferente
    if os.path.abspath(src_folder) != os.path.abspath(dst_root):
        try:
            shutil.rmtree(src_folder)
            print(f"  ✗ Eliminada: {entry['folder_orig']}")
        except Exception as e:
            print(f"  ! No se pudo eliminar {entry['folder_orig']}: {e}")

print("\nReorganización completada.")
