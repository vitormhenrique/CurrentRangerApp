"""
Generate RGBA PNG icons for Tauri from the app SVG.

Renderers tried in order:
  1. cairosvg   — pip install cairosvg
  2. rsvg-convert — brew install librsvg
  3. inkscape   — brew install inkscape
  4. Fallback   — flat dark-blue placeholder PNG

Run:  cd src-tauri/icons && python3 make_icons.py
"""
import os
import shutil
import struct
import subprocess
import tempfile
import zlib

BASE = os.path.dirname(os.path.abspath(__file__)) + '/'
SVG = os.path.normpath(os.path.join(BASE, '../../icon_r_monogram_iteration_1_split_beam.svg'))


# ── Renderers ────────────────────────────────────────────────────────────────

def render_cairosvg(svg_path: str, size: int) -> bytes:
    import cairosvg  # type: ignore
    return cairosvg.svg2png(url=svg_path, output_width=size, output_height=size)


def render_rsvg(svg_path: str, size: int) -> bytes:
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        tmp = f.name
    try:
        subprocess.run(
            ['rsvg-convert', '-w', str(size), '-h', str(size), '-o', tmp, svg_path],
            check=True, capture_output=True,
        )
        return open(tmp, 'rb').read()
    finally:
        os.unlink(tmp)


def render_inkscape(svg_path: str, size: int) -> bytes:
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        tmp = f.name
    try:
        subprocess.run(
            ['inkscape', svg_path,
             f'--export-filename={tmp}',
             f'--export-width={size}',
             f'--export-height={size}'],
            check=True, capture_output=True,
        )
        return open(tmp, 'rb').read()
    finally:
        os.unlink(tmp)


def make_fallback_png(size: int) -> bytes:
    """Pure-Python RGBA PNG — dark-blue background matching the SVG."""
    r, g, b, a = 8, 19, 30, 255  # #08131E

    def chunk(name: bytes, data: bytes) -> bytes:
        c = struct.pack('>I', len(data)) + name + data
        return c + struct.pack('>I', zlib.crc32(c[4:]) & 0xFFFFFFFF)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    row = b'\x00' + bytes([r, g, b, a]) * size
    idat = chunk(b'IDAT', zlib.compress(row * size))
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend


def get_png(size: int) -> bytes:
    if os.path.exists(SVG):
        for renderer in (render_cairosvg, render_rsvg, render_inkscape):
            try:
                data = renderer(SVG, size)
                print(f'  Rendered {size}px via {renderer.__name__}')
                return data
            except Exception:
                pass
        print(f'  Warning: could not render SVG — using placeholder. '
              f'Install cairosvg or rsvg-convert.')
    else:
        print(f'  Warning: SVG not found at {SVG}')
    return make_fallback_png(size)


# ── Generate icons ───────────────────────────────────────────────────────────

SIZES = [
    (32,  '32x32.png'),
    (128, '128x128.png'),
    (256, '128x128@2x.png'),
]

print('Generating Tauri icons...')
for size, fname in SIZES:
    data = get_png(size)
    path = BASE + fname
    with open(path, 'wb') as f:
        f.write(data)
    print(f'  Wrote {fname} ({size}x{size})')

# ico and icns fallback to PNG copies (Tauri accepts PNG for these on macOS)
shutil.copy(BASE + '32x32.png', BASE + 'icon.ico')
shutil.copy(BASE + '128x128@2x.png', BASE + 'icon.icns')
print('Done. To render from SVG: pip install cairosvg')

