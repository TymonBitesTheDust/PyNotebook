"""Assemble an unsigned, aligned APK.

usage: assemble_apk.py BASE_APK CLASSES_DEX ASSETS_DIR OUT_APK

* entries from BASE_APK (manifest, resources.arsc, res/) are copied; resources.arsc is
  stored uncompressed (required for targetSdk >= 30)
* classes.dex is deflated
* assets/ files are deflated, except already-compressed formats which are stored
* every stored entry's data is 4-byte aligned (what zipalign does), using the
  Android alignment extra field (0xd935) for padding
"""
import os
import struct
import sys
import zipfile
import zlib

STORE_EXT = {".zip", ".whl", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff2", ".woff", ".gz", ".mp3", ".ogg"}


class Writer:
    def __init__(self, path):
        self.f = open(path, "wb")
        self.central = []

    def add(self, name, data, compress, date_time=(2026, 1, 1, 0, 0, 0)):
        name_b = name.encode("utf-8")
        crc = zlib.crc32(data) & 0xFFFFFFFF
        if compress:
            co = zlib.compressobj(9, zlib.DEFLATED, -15)
            payload = co.compress(data) + co.flush()
            if len(payload) >= len(data):
                compress = False
        if not compress:
            payload = data
        method = 8 if compress else 0
        y, mo, d, h, mi, s = date_time
        dos_time = (h << 11) | (mi << 5) | (s // 2)
        dos_date = ((y - 1980) << 9) | (mo << 5) | d
        offset = self.f.tell()
        extra = b""
        if method == 0:
            header_end = offset + 30 + len(name_b)
            align = 4096 if name.endswith(".so") else 4
            pad = (-(header_end + 6)) % align
            extra = struct.pack("<HHH", 0xD935, 2 + pad, align) + b"\0" * pad
        flags = 0x0800  # UTF-8 names
        local = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20 if method else 10, flags, method, dos_time, dos_date,
                            crc, len(payload), len(data), len(name_b), len(extra))
        self.f.write(local + name_b + extra + payload)
        self.central.append((name_b, method, dos_time, dos_date, crc, len(payload), len(data), offset, flags))

    def close(self):
        cd_start = self.f.tell()
        for name_b, method, t, d, crc, csize, usize, off, flags in self.central:
            self.f.write(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20 if method else 10, flags, method, t, d,
                                     crc, csize, usize, len(name_b), 0, 0, 0, 0, 0, off) + name_b)
        cd_end = self.f.tell()
        n = len(self.central)
        self.f.write(struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, n, n, cd_end - cd_start, cd_start, 0))
        self.f.close()


def main():
    base, dex, assets, out = sys.argv[1:5]
    w = Writer(out)
    with zipfile.ZipFile(base) as z:
        names = z.namelist()
        # manifest first, then resources.arsc, then the rest
        order = sorted(names, key=lambda n: (n != "AndroidManifest.xml", n != "resources.arsc", n))
        for n in order:
            info = z.getinfo(n)
            data = z.read(n)
            if n == "resources.arsc":
                w.add(n, data, compress=False)
            else:
                w.add(n, data, compress=info.compress_type == zipfile.ZIP_DEFLATED)
    with open(dex, "rb") as f:
        w.add("classes.dex", f.read(), compress=True)
    files = []
    for dirpath, _, fnames in os.walk(assets):
        for fn in fnames:
            full = os.path.join(dirpath, fn)
            files.append((os.path.relpath(full, assets).replace(os.sep, "/"), full))
    for rel, full in sorted(files):
        with open(full, "rb") as f:
            data = f.read()
        ext = os.path.splitext(rel)[1].lower()
        w.add("assets/" + rel, data, compress=ext not in STORE_EXT)
    w.close()
    # sanity check
    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        if bad:
            raise SystemExit(f"corrupt entry {bad}")
        print(f"assembled {out}: {len(z.namelist())} entries, {os.path.getsize(out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
