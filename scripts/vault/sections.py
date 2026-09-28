"""Prints a unit PDF's real sections with page ranges as JSON: [{"no": 1, "title": "1.1 Square Numbers", "from": 3, "to": 10}].
A unit without numbered sections comes back as one section covering the whole unit.
Usage: python scripts/vault/sections.py <pdf> "<unit title>"
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fitz  # noqa: E402
import ingest_ncert_vault as v  # noqa: E402


def sections(path, unit_title):
    paras, quality = v.extract(path, unit_title)
    pages = len(fitz.open(path))
    out = []
    for p in paras:
        sec = p['section']
        if not sec or not sec[0].isdigit():
            continue
        if not out or out[-1]['title'] != sec:
            out.append({'title': sec, 'from': p['page'], 'to': p['page']})
        else:
            out[-1]['to'] = max(out[-1]['to'], p['page'])
    if not out:
        out = [{'title': unit_title, 'from': 1, 'to': pages}]
    for i, s in enumerate(out):
        s['no'] = i + 1
        if i + 1 < len(out):
            s['to'] = max(s['to'], out[i + 1]['from'])
    out[-1]['to'] = pages
    out[0]['from'] = 1 if out[0]['from'] <= 3 else out[0]['from']
    return {'quality': quality, 'pages': pages, 'sections': out}


if __name__ == '__main__':
    print(json.dumps(sections(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ''), ensure_ascii=False))
