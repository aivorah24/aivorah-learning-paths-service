"""OCR the pages of a prelims PDF with Tesseract; prints JSON {page_index: text}. Usage: ncert_ocr_pages.py file.pdf [lang] [first] [last]"""
import io, json, subprocess, sys, os, tempfile
import fitz

TESS = os.environ.get('TESSERACT_EXE', r'C:\Program Files\Tesseract-OCR\tesseract.exe')

def ocr_page(page, lang, dpi=300):
    png = page.get_pixmap(dpi=dpi).tobytes('png')
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        f.write(png)
        path = f.name
    try:
        r = subprocess.run([TESS, path, 'stdout', '-l', lang, '--psm', '4'] + (['--tessdata-dir', os.environ['TESSDATA_DIR']] if os.environ.get('TESSDATA_DIR') else []), capture_output=True, timeout=120)
        return r.stdout.decode('utf-8', 'replace')
    finally:
        os.unlink(path)

if __name__ == '__main__':
    pdf, lang = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else 'eng')
    doc = fitz.open(pdf)
    first = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    last = int(sys.argv[4]) if len(sys.argv) > 4 else len(doc) - 1
    out = {i: ocr_page(doc[i], lang) for i in range(first, min(last, len(doc) - 1) + 1)}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))
