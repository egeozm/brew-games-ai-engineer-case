"""Render part1/NOTE.md and part2/NOTE.md to compact PDFs (the case allows at most 2 pages each).

Usage (from repo root):  python3 make_note_pdfs.py
"""
import os, subprocess, tempfile, markdown

ROOT = os.path.dirname(os.path.abspath(__file__))
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
CSS = """@page { size: A4; margin: 12mm 13mm; }
body { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 8.6pt; line-height: 1.32; color: #111; }
h1 { font-size: 12.5pt; margin: 0 0 4px; } h2 { font-size: 10pt; margin: 8px 0 3px; }
p, ul, ol { margin: 3px 0; } ul, ol { padding-left: 16px; } li { margin: 1px 0; }
table { border-collapse: collapse; margin: 4px 0; font-size: 8pt; } th, td { border: 1px solid #ccc; padding: 1px 5px; }
th { background: #f2f2f2; } code { font-size: 7.8pt; background: #f4f4f4; padding: 0 2px; }"""

for part in ['part1', 'part2']:
    md = open(os.path.join(ROOT, part, 'NOTE.md'), encoding='utf8').read()
    html = markdown.markdown(md, extensions=['tables', 'sane_lists'])
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf8') as f:
        f.write(f'<!doctype html><meta charset="utf-8"><style>{CSS}</style>{html}')
    out = os.path.join(ROOT, part, 'NOTE.pdf')
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--no-pdf-header-footer', f'--print-to-pdf={out}', f.name],
                   capture_output=True)
    pages = open(out, 'rb').read().count(b'/Type /Page') - open(out, 'rb').read().count(b'/Type /Pages')
    print(f'{part}/NOTE.pdf: {pages} page(s)')
