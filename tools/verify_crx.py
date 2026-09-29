#!/usr/bin/env python3
"""Проверка CRX3: разбор заголовка, сверка crx_id/ID расширения, подпись RSA (через openssl).

    verify_crx.py x-tweet-saver.crx
    verify_crx.py https://host/.../x-tweet-saver.crx

Код возврата 0 — подпись валидна. Печатает ID расширения и версию из manifest.json.
"""
from __future__ import annotations

import hashlib
import io
import json
import struct
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path


def read_varint(buf: bytes, i: int) -> tuple[int, int]:
    n = shift = 0
    while True:
        b = buf[i]
        i += 1
        n |= (b & 0x7F) << shift
        if not b & 0x80:
            return n, i
        shift += 7


def parse(buf: bytes) -> list[tuple[int, bytes]]:
    """Плоский разбор protobuf: только length-delimited поля (других в CRX3-заголовке нет)."""
    out, i = [], 0
    while i < len(buf):
        tag, i = read_varint(buf, i)
        if tag & 7 != 2:
            raise ValueError(f"неожиданный wire type {tag & 7}")
        ln, i = read_varint(buf, i)
        out.append((tag >> 3, buf[i:i + ln]))
        i += ln
    return out


def load(src: str) -> bytes:
    if src.startswith(("http://", "https://")):
        with urllib.request.urlopen(src, timeout=30) as r:
            return r.read()
    return Path(src).read_bytes()


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    data = load(sys.argv[1])
    if data[:4] != b"Cr24":
        print("FAIL: нет сигнатуры Cr24")
        return 1
    version, hlen = struct.unpack("<II", data[4:12])
    if version != 3:
        print(f"FAIL: версия формата {version}, ожидалась 3")
        return 1
    header, zip_bytes = data[12:12 + hlen], data[12 + hlen:]

    fields = parse(header)
    proofs = [v for f, v in fields if f == 2]
    signed_header_data = next((v for f, v in fields if f == 10000), None)
    if not proofs or signed_header_data is None:
        print("FAIL: в заголовке нет подписи или signed_header_data")
        return 1
    pub = sig = None
    for f, v in parse(proofs[0]):
        if f == 1:
            pub = v
        elif f == 2:
            sig = v
    crx_id = dict(parse(signed_header_data)).get(1)
    if pub is None or sig is None or crx_id is None:
        print("FAIL: неполная подпись")
        return 1
    if hashlib.sha256(pub).digest()[:16] != crx_id:
        print("FAIL: crx_id не соответствует публичному ключу")
        return 1

    signed = (b"CRX3 SignedData\x00" + struct.pack("<I", len(signed_header_data))
              + signed_header_data + zip_bytes)
    with tempfile.TemporaryDirectory() as td:
        pub_pem = subprocess.run(["openssl", "pkey", "-pubin", "-inform", "DER", "-outform", "PEM"],
                                 input=pub, capture_output=True, check=True).stdout
        (Path(td) / "pub.pem").write_bytes(pub_pem)
        (Path(td) / "sig.bin").write_bytes(sig)
        r = subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(Path(td) / "pub.pem"),
                            "-signature", str(Path(td) / "sig.bin")], input=signed, capture_output=True)
    if r.returncode != 0:
        print("FAIL: подпись невалидна")
        return 1

    ext_id = "".join(chr(ord("a") + n) for b in crx_id for n in (b >> 4, b & 15))
    manifest = json.loads(zipfile.ZipFile(io.BytesIO(zip_bytes)).read("manifest.json"))
    print(f"OK  id={ext_id}  version={manifest.get('version')}  files={len(zipfile.ZipFile(io.BytesIO(zip_bytes)).namelist())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
