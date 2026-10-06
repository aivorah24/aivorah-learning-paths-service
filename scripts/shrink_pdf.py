"""Re-render each page as a compressed JPEG so a scanned chapter PDF fits under a size limit.
Usage: shrink_pdf.py in.pdf out.pdf [max_mb=9.5]. Prints the final size in MB. Text layer is not kept (display-only copy)."""
import sys, os, fitz

src, out = sys.argv[1], sys.argv[2]
limit = float(sys.argv[3]) * 1048576 if len(sys.argv) > 3 else 9.5 * 1048576
doc = fitz.open(src)
best = None
for dpi, quality in ((110, 60), (90, 50), (75, 45), (60, 40)):
    dst = fitz.open()
    for page in doc:
        pix = page.get_pixmap(dpi=dpi)
        img = pix.tobytes('jpeg', jpg_quality=quality)
        new = dst.new_page(width=page.rect.width, height=page.rect.height)
        new.insert_image(new.rect, stream=img)
    dst.save(out, garbage=4, deflate=True)
    best = os.path.getsize(out)
    if best <= limit:
        break
print(f'{best / 1048576:.1f}')
