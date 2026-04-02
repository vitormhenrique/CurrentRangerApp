import struct
import zlib
import shutil

def make_png(size, r, g, b, a=255):
    def chunk(name, data):
        c = struct.pack('>I', len(data)) + name + data
        return c + struct.pack('>I', zlib.crc32(c[4:]) & 0xffffffff)
    sig = b'\x89PNG\r\n\x1a\n'
    # color type 6 = RGBA
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    raw = b''
    for _ in range(size):
        row = b'\x00'  # filter byte
        for _ in range(size):
            row += bytes([r, g, b, a])
        raw += row
    idat = chunk(b'IDAT', zlib.compress(raw))
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend

import os
base = os.path.dirname(os.path.abspath(__file__)) + '/'
for size, fname in [(32, '32x32.png'), (128, '128x128.png')]:
    with open(base + fname, 'wb') as f:
        f.write(make_png(size, 137, 180, 250))
shutil.copy(base + '128x128.png', base + '128x128@2x.png')
shutil.copy(base + '32x32.png', base + 'icon.ico')
shutil.copy(base + '128x128.png', base + 'icon.icns')
print('Icons created successfully')
