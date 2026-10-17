#!/usr/bin/env python3
"""Create public synthetic file-input probes; never read the clipboard or user files."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import zlib

out = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/sessionbay-file-input-fixtures')
out.mkdir(parents=True, exist_ok=True)
# Four unequal solid color regions, useful for detecting image receipt without a hinted answer.
w, h = 320, 240
pixels = bytearray()
for y in range(h):
    pixels.append(0)
    for x in range(w):
        pixels.extend((220, 30, 30) if x < 200 and y < 140 else
                      (30, 80, 220) if y < 140 else
                      (245, 210, 20) if x < 200 else (30, 170, 70))
def chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')
text = b'Synthetic SessionBay file-input probe.\nThe verification token is FI31-TEXT-7284.\n'
stream = b'BT /F1 18 Tf 72 720 Td (Synthetic SessionBay file-input probe) Tj 0 -32 Td (Verification token: FI31-PDF-5931) Tj ET'
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream']
pdf = b'%PDF-1.4\n'
offsets = []
for i, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += str(i).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
xref = len(pdf)
pdf += b'xref\n0 6\n0000000000 65535 f \n' + b''.join(f'{o:010d} 00000 n \n'.encode() for o in offsets)
pdf += b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + str(xref).encode() + b'\n%%EOF\n'
manifest = {}
for name, data in [('color probe.png', png), ('read probe.txt', text), ('document probe.pdf', pdf), ('opaque probe.bin', b'\x00\x01\xffFI31-BINARY'), ('empty probe.txt', b'')]:
    path = out / name
    # Never overwrite a user's pre-existing file, including a symlink.
    with path.open('xb') as handle:
        handle.write(data)
    manifest[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
with (out / 'manifest.json').open('x') as handle:
    json.dump(manifest, handle, indent=2)
print(out)
print(json.dumps(manifest, indent=2))
