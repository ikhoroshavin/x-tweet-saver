#!/usr/bin/env python3
"""Сборка подписанного CRX3 + updates.xml + meta.json для self-hosted раздачи.

Зависимости: только stdlib и `openssl` в PATH (Chrome на сервере не нужен).

Версия релиза считается автоматически: `<major>.<minor>.<N>`, где major.minor —
первые два числа `version` из manifest.json, а N — число коммитов, затронувших
файлы самого расширения (README/tools/deploy не считаются). Так каждый push с
правкой расширения — новый релиз, а Chrome обновляет расширение только когда
версия строго выросла. История git не должна переписываться (force-push
уменьшит N, и Chrome такую «старую» версию не поставит).

Ключ подписи (RSA) определяет ID расширения: потеряете ключ — ID сменится,
и расширение придётся ставить заново.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from xml.sax.saxutils import quoteattr

ROOT = Path(__file__).resolve().parent.parent

# Что попадает в пакет. Всё остальное (README, tools, deploy, .git) — нет.
PACKAGE_FILES = ["manifest.json", "background.js", "content.js", "interceptor.js"]
PACKAGE_DIRS = ["icons"]

CRX_NAME = "x-tweet-saver.crx"
ZIP_DATE = (2020, 1, 1, 0, 0, 0)  # детерминированный zip


def die(msg: str) -> "None":
    print(f"build_crx: {msg}", file=sys.stderr)
    sys.exit(1)


def git(*args: str) -> str:
    r = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True,
                       encoding="utf-8", check=True)
    return r.stdout.strip()


def openssl(args: list[str], data: bytes | None = None) -> bytes:
    try:
        r = subprocess.run(["openssl", *args], input=data, capture_output=True, check=True)
    except FileNotFoundError:
        die("openssl не найден в PATH")
    except subprocess.CalledProcessError as e:
        die(f"openssl {' '.join(args[:2])} упал: {e.stderr.decode(errors='replace').strip()}")
    return r.stdout


# ---------- пакет ----------
def package_paths() -> list[Path]:
    paths = [ROOT / f for f in PACKAGE_FILES]
    for d in PACKAGE_DIRS:
        paths += sorted(p for p in (ROOT / d).rglob("*") if p.is_file())
    missing = [p for p in paths if not p.exists()]
    if missing:
        die("нет файлов пакета: " + ", ".join(str(p.relative_to(ROOT)) for p in missing))
    return paths


def release_version(manifest: dict) -> str:
    base = ".".join(str(manifest["version"]).split(".")[:2])
    rel = [p.relative_to(ROOT).as_posix() for p in package_paths()]
    count = int(git("rev-list", "--count", "HEAD", "--", *rel))
    return f"{base}.{count}"


def build_zip(manifest: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in package_paths():
            rel = p.relative_to(ROOT).as_posix()
            if rel == "manifest.json":
                data = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
            else:
                data = p.read_bytes()
            zi = zipfile.ZipInfo(rel, ZIP_DATE)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, data)
    return buf.getvalue()


# ---------- CRX3 ----------
def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _ld(field: int, payload: bytes) -> bytes:
    """protobuf: поле length-delimited."""
    return _varint((field << 3) | 2) + _varint(len(payload)) + payload


def extension_id(crx_id: bytes) -> str:
    return "".join(chr(ord("a") + n) for b in crx_id for n in (b >> 4, b & 15))


def make_crx(zip_bytes: bytes, key: Path) -> tuple[bytes, str]:
    pub = openssl(["rsa", "-in", str(key), "-pubout", "-outform", "DER"])
    crx_id = hashlib.sha256(pub).digest()[:16]
    signed_header_data = _ld(1, crx_id)  # SignedData { crx_id }
    signed = (b"CRX3 SignedData\x00" + struct.pack("<I", len(signed_header_data))
              + signed_header_data + zip_bytes)
    signature = openssl(["dgst", "-sha256", "-sign", str(key)], signed)
    proof = _ld(1, pub) + _ld(2, signature)  # AsymmetricKeyProof { public_key, signature }
    header = _ld(2, proof) + _ld(10000, signed_header_data)  # CrxFileHeader
    return b"Cr24" + struct.pack("<II", 3, len(header)) + header + zip_bytes, extension_id(crx_id)


# ---------- вывод ----------
def atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def updates_xml(ext_id: str, version: str, codebase: str, sha256: str) -> bytes:
    xml = (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        f"  <app appid={quoteattr(ext_id)}>\n"
        f"    <updatecheck codebase={quoteattr(codebase)} version={quoteattr(version)} "
        f"hash_sha256={quoteattr(sha256)} />\n"
        "  </app>\n"
        "</gupdate>\n"
    )
    return xml.encode("utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key", required=True, help="RSA-ключ подписи (PEM)")
    ap.add_argument("--out", required=True, help="куда класть crx/updates.xml/meta.json")
    ap.add_argument("--base-url", required=True, help="публичный URL каталога раздачи (без слэша на конце)")
    ap.add_argument("--gen-key", action="store_true", help="создать ключ, если файла нет")
    ap.add_argument("--if-changed", action="store_true", help="не пересобирать, если версия та же")
    args = ap.parse_args()

    key = Path(args.key)
    base_url = args.base_url.rstrip("/")
    out = Path(args.out)

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = release_version(manifest)
    meta_path = out / "meta.json"

    if args.if_changed and meta_path.exists() and (out / CRX_NAME).exists():
        try:
            old = json.loads(meta_path.read_text(encoding="utf-8"))
            if old.get("version") == version and old.get("base_url") == base_url:
                print(f"up to date: v{version}")
                return 0
        except Exception:
            pass  # битый meta — пересоберём

    if not key.exists():
        if not args.gen_key:
            die(f"ключ {key} не найден (создать: --gen-key)")
        key.parent.mkdir(parents=True, exist_ok=True)
        old_umask = os.umask(0o077)
        try:
            openssl(["genrsa", "-out", str(key), "2048"])
        finally:
            os.umask(old_umask)
        print(f"создан ключ подписи: {key}")

    expected_update_url = f"{base_url}/updates.xml"
    if manifest.get("update_url") != expected_update_url:
        print(f"ВНИМАНИЕ: manifest.update_url={manifest.get('update_url')!r} != {expected_update_url!r} "
              "— установленное расширение не будет обновляться отсюда", file=sys.stderr)

    manifest["version"] = version
    zip_bytes = build_zip(manifest)
    crx, ext_id = make_crx(zip_bytes, key)
    sha256 = hashlib.sha256(crx).hexdigest()
    codebase = f"{base_url}/{CRX_NAME}"

    meta = {
        "name": manifest.get("name", ""),
        "extension_id": ext_id,
        "version": version,
        "crx_name": CRX_NAME,
        "size": len(crx),
        "sha256": sha256,
        "built_at": int(time.time()),
        "commit": git("rev-parse", "--short", "HEAD"),
        "commit_subject": git("log", "-1", "--format=%s"),
        "commit_date": git("log", "-1", "--format=%cI"),
        "base_url": base_url,
        "update_url": expected_update_url,
        "codebase": codebase,
        "permissions": manifest.get("permissions", []),
        "host_permissions": manifest.get("host_permissions", []),
    }

    out.mkdir(parents=True, exist_ok=True)
    # Порядок важен: updates.xml — последним, чтобы Chrome не увидел версию,
    # для которой crx ещё не лежит на месте.
    atomic_write(out / CRX_NAME, crx)
    atomic_write(meta_path, json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8"))
    atomic_write(out / "updates.xml", updates_xml(ext_id, version, codebase, sha256))

    print(f"built v{version}  id={ext_id}  {len(crx)} B  sha256={sha256[:12]}  out={out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
