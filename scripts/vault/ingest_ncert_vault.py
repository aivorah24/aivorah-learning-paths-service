"""Fills the single curriculum vault (Qdrant `aivorah_curriculum_vault_v1`, alias `aivorah_curriculum`) from the NCERT PDFs.

Every chunk keeps the book's real structure: unit (the chapter PDF), section and sub-section headings read from the
PDF's own heading styles, page numbers, book code and title. Text is embedded locally with multilingual-e5-small
(dense, 384) plus a hashed term-frequency sparse vector for keyword search. No LLM is used.

Usage (from the service root):
  python scripts/vault/ingest_ncert_vault.py --cache <pdf dir> [--grades 8] [--subjects Mathematics,English]
         [--limit 3] [--dry-run] [--report out.json]
Point ids are UUIDv5 of the chunk URN, so re-running upserts in place.
"""
import argparse, collections, glob, json, math, os, re, sys, time, uuid, zlib
import urllib.request

import fitz  # PyMuPDF

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VAULT = 'aivorah_curriculum_vault_v1'
ALIAS = 'aivorah_curriculum'
NS = uuid.UUID('6f1b1a2a-6e9b-4c9a-9f0d-2a6b7c8d9e0f')  # same namespace as ai-coach-service multiCurriculumSchema
BOOK_URL = 'https://aivorah-auth-service-g27s.onrender.com/data/ncert_books/'
MODEL = 'intfloat/multilingual-e5-small'

SUBJECTS = {
    'mathematics': 'mathematics', 'science': 'science', 'physics': 'physics', 'chemistry': 'chemistry',
    'biology': 'biology', 'english': 'english', 'hindi': 'hindi', 'urdu': 'urdu', 'sanskrit': 'sanskrit',
    'social science': 'social_science', 'history': 'history', 'geography': 'geography',
    'political science': 'political_science', 'economics': 'economics', 'computer science': 'computer_science',
    'arts': 'fine_arts', 'fine art': 'fine_arts', 'physical education and well being': 'physical_education',
    'health and physical education': 'physical_education', 'the world around us': 'environmental_science',
    'business studies': 'business_studies', 'accountancy': 'accountancy', 'psychology': 'psychology',
    'sociology': 'sociology', 'home science': 'home_science', 'biotechnology': 'biotechnology',
}


def tier(g):
    return 'foundational' if g <= 2 else 'preparatory' if g <= 5 else 'middle_school' if g <= 8 else 'secondary' if g <= 10 else 'higher_secondary'


def slug(t):
    s = re.sub(r'[^a-z0-9]+', '-', str(t).lower()).strip('-')
    return s[:60] or format(zlib.crc32(str(t).encode()) & 0xffffffff, '08x')


def load_units(grades, subjects):
    cat = json.load(open(os.path.join(ROOT, 'data', 'book-catalog.json'), encoding='utf-8'))
    books = cat.get('books', cat)
    units = []
    for f in sorted(glob.glob(os.path.join(ROOT, 'data', 'curricula', '*-chapters.json'))):
        j = json.load(open(f, encoding='utf-8'))
        j['code'] = j.get('code') or os.path.basename(f).split('-')[-2]
        if not j.get('grade') or not j.get('subject'):
            continue
        g = int(re.sub(r'\D', '', str(j['grade'])))
        meta = books.get(j['code'], {})
        if meta.get('hidden'):
            continue
        if grades and g not in grades:
            continue
        if subjects and j['subject'].lower() not in subjects:
            continue
        for c in j.get('chapters', []):
            units.append({'grade': g, 'subject': j['subject'], 'book_code': j['code'], 'book_title': meta.get('title') or j['code'],
                          'unit_no': c.get('chapter'), 'unit_title': c.get('title') or '', 'pdf': c['pdfFile'],
                          'book_path': c.get('bookPath') or '', 'toc_sections': c.get('subtopics') or []})
    return units


def fetch_pdf(u, cache):
    path = os.path.join(cache, u['pdf'])
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return path
    if not u['book_path']:
        return None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(BOOK_URL + u['book_path'], timeout=180) as r, open(path, 'wb') as out:
                out.write(r.read())
            if os.path.getsize(path) > 1000:
                return path
        except Exception:
            time.sleep(3 * (attempt + 1))
    return None


NOISE = re.compile(r'^(reprint\s*20\d\d.*|\d{1,3}|poorvi|ganita prakash.*|curiosity.*|let us (read|discuss|think|learn|speak|write|listen).*)$', re.I)
COMMON = set('the and of to a in is that it was for on with as he she they are this be by from at his her'.split())
KIND = [(re.compile(r'^(example|solution)\b', re.I), 'example'), (re.compile(r'figure it out|exercise|try these|questions', re.I), 'exercise'),
        (re.compile(r'activity|let us (do|explore)', re.I), 'activity')]


SUP = str.maketrans('0123456789+-n', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿ')


def join_spans(spans):
    """Joins a line's spans; raised small text (powers such as the 2 in 8²) is written as superscript characters."""
    out = ''
    for i, s in enumerate(spans):
        t = s['text'].strip()
        prev = spans[i - 1] if i else None
        raised = prev is not None and (s['flags'] & 1 or (s['size'] < prev['size'] * 0.85 and s['bbox'][3] < prev['bbox'][3] - 1))
        if raised and re.fullmatch(r'[0-9+\-n]{1,3}', t):
            out += t.translate(SUP)
        else:
            out += (' ' if out else '') + t
    return out


def extract(path, unit_title=''):
    """Returns (paragraphs, quality) where each paragraph is {page, section, sub, text}."""
    doc = fitz.open(path)
    sizes = collections.Counter()
    pages = []
    for pno, page in enumerate(doc, 1):
        lines = []
        for b in page.get_text('dict')['blocks']:
            for l in b.get('lines', []):
                sp = [s for s in l['spans'] if s['text'].strip()]
                if not sp:
                    continue
                text = join_spans(sp)
                size = max(s['size'] for s in sp)
                bold = all(('bold' in s['font'].lower()) or (s['flags'] & 16) for s in sp)
                for s in sp:
                    sizes[round(s['size'])] += len(s['text'])
                lines.append((text, size, bold, l['bbox'][1]))
        pages.append(lines)
    body = sizes.most_common(1)[0][0] if sizes else 11
    paras, section, sub = [], '', ''
    cur = None
    unit_key = re.sub(r'[^a-z]', '', unit_title.lower())
    for pno, lines in enumerate(pages, 1):
        for text, size, bold, _y in lines:
            t = re.sub(r'\s+', ' ', text).strip()
            t = re.sub(r'\b([A-Z]) (?=[a-z])', r'\1', t)  # "T he W it" -> "The Wit" (letter-spaced titles)
            if not t or NOISE.match(t) or re.match(r'^u\s?nit\s*\d+$', t, re.I):
                continue
            numbered = re.match(r'^(\d{1,2}(\.\d{1,2})+)\s+(\S.{1,80})$', t)
            if bold and size >= body + 1.5 and len(t) < 90:
                key = re.sub(r'[^a-z]', '', t.lower())
                if key and (key == unit_key or (size >= body * 1.7 and key in unit_key)):
                    continue  # the unit's own title
                if numbered:
                    section, sub = f'{numbered.group(1)} {numbered.group(3)}', ''
                elif size >= body + 5.5:
                    section, sub = t, ''  # a piece title (story, poem, play) or a big part heading
                else:
                    sub = t
                cur = None
                continue
            if size < body * 0.8:  # margin glossary, captions, footnotes
                continue
            if cur and cur['page'] == pno and cur['section'] == section and cur['sub'] == sub and not re.search(r'[.!?:]["”’)]?$', cur['text']):
                cur['text'] += ' ' + t
            else:
                cur = {'page': pno, 'section': section, 'sub': sub, 'text': t}
                paras.append(cur)
    alltext = ' '.join(p['text'] for p in paras)
    letters = sum(ch.isalpha() for ch in alltext) or 1
    deva = sum('ऀ' <= ch <= 'ॿ' or '؀' <= ch <= 'ۿ' for ch in alltext)
    ascii_ = sum(ch.isascii() and ch.isalpha() for ch in alltext)
    odd = sum(not ch.isascii() and not ('ऀ' <= ch <= 'ॿ' or '؀' <= ch <= 'ۿ') and ch.isalpha() for ch in alltext)
    words = re.findall(r'[a-z]+', alltext.lower())
    common = sum(w in COMMON for w in words)
    quality = 'ok'
    if deva == 0 and ascii_ / letters > 0.9 and words and common / len(words) < 0.04:
        quality = 'legacy_font'  # Hindi/Urdu typed in an old font (e.g. Krutidev): ASCII letters, not English
    elif len(alltext) < 800:
        quality = 'too_little_text'
    elif odd / letters > 0.15 or (deva == 0 and ascii_ / letters < 0.6):
        quality = 'garbled'
    return paras, quality


def chunks_for(u, paras):
    groups = collections.OrderedDict()
    for p in paras:
        groups.setdefault((p['section'], p['sub']), []).append(p)
    out = []
    for (section, sub), ps in groups.items():
        parent = ' '.join(p['text'] for p in ps)
        buf, pages = '', set()
        def flush():
            if len(buf.strip()) >= 200 or (buf.strip() and not out):
                kind = next((k for rx, k in KIND if rx.search(sub or section or '') or rx.search(buf[:60])), 'text')
                out.append({'section': section, 'sub': sub, 'text': buf.strip(), 'pages': sorted(pages), 'parent': parent[:6000], 'kind': kind})
        for p in ps:
            for sent in re.split(r'(?<=[.!?])\s+', p['text']):
                if len(buf) + len(sent) > 1800 and len(buf) >= 600:
                    flush()
                    buf, pages = '', set()
                buf += (' ' if buf else '') + sent
                pages.add(p['page'])
        flush()
    return out


TOKEN = re.compile(r'[\wऀ-ॿ؀-ۿ]+', re.U)


def sparse(text):
    tf = collections.Counter(t for t in TOKEN.findall(text.lower()) if len(t) > 1)
    idx = {}
    for tok, n in tf.items():
        k = zlib.crc32(tok.encode()) & 0xffffffff
        idx[k] = idx.get(k, 0) + 1 + math.log(n)
    return {'indices': list(idx.keys()), 'values': list(idx.values())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True)
    ap.add_argument('--grades', default='')
    ap.add_argument('--subjects', default='')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--report', default='')
    a = ap.parse_args()
    grades = {int(x) for x in a.grades.split(',') if x}
    subjects = {x.strip().lower() for x in a.subjects.split(',') if x.strip()}
    units = load_units(grades, subjects)
    if a.limit:
        units = units[:a.limit]
    print(f'units to ingest: {len(units)}', flush=True)

    env = {}
    for line in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
        m = re.match(r'^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?', line)
        if m:
            env[m.group(1)] = m.group(2).strip()
    client = None
    if not a.dry_run:
        from qdrant_client import QdrantClient, models
        client = QdrantClient(url=env['QDRANT_URL'], api_key=env.get('QDRANT_API_KEY'), timeout=120)
        for field, kind in [('curriculum', 'keyword'), ('academic_level.grade_numeric', 'integer'), ('subject_canonical', 'keyword'),
                            ('hierarchy.unit_no', 'integer'), ('hierarchy.section', 'keyword'), ('hierarchy.chapter_title', 'keyword'),
                            ('curriculum_context.book_code', 'keyword'), ('provenance.source_pdf', 'keyword'), ('pedagogy.chunk_type', 'keyword')]:
            try:
                client.create_payload_index(VAULT, field_name=field, field_schema=kind)
            except Exception:
                pass
        try:
            client.update_collection(VAULT, sparse_vectors_config={'sparse': models.SparseVectorParams(modifier=models.Modifier.IDF)})
        except Exception as e:
            print('note: could not set IDF on sparse vectors:', str(e)[:120])
        try:
            client.update_collection_aliases(change_aliases_operations=[models.CreateAliasOperation(create_alias=models.CreateAlias(collection_name=VAULT, alias_name=ALIAS))])
        except Exception:
            pass
    model = None
    if not a.dry_run:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(MODEL)

    report = []
    for i, u in enumerate(units, 1):
        row = {'grade': u['grade'], 'subject': u['subject'], 'book': u['book_code'], 'unit_no': u['unit_no'], 'unit': u['unit_title'], 'pdf': u['pdf']}
        path = fetch_pdf(u, a.cache)
        if not path:
            row['status'] = 'pdf_missing'; report.append(row); print(f'[{i}/{len(units)}] {u["pdf"]} PDF MISSING', flush=True); continue
        try:
            paras, quality = extract(path, u['unit_title'])
        except Exception as e:
            row['status'] = f'extract_error: {e}'; report.append(row); continue
        row['quality'] = quality
        sections = sorted({p['section'] for p in paras if p['section']})
        row['sections'] = sections
        if quality != 'ok':
            row['status'] = 'skipped_' + quality; report.append(row)
            print(f'[{i}/{len(units)}] {u["pdf"]} skipped ({quality})', flush=True); continue
        chunks = chunks_for(u, paras)
        subj = SUBJECTS.get(u['subject'].lower(), slug(u['subject']).replace('-', '_'))
        points = []
        for n, c in enumerate(chunks):
            urn = f'urn:aivorah:curriculum:ncert:{u["grade"]}:{subj}:{slug(u["unit_title"] or u["pdf"])}:{n:04d}'
            head = ' > '.join(x for x in [u['unit_title'], c['section'], c['sub']] if x)
            payload = {
                'id': urn, '_urn': urn, 'curriculum': 'NCERT',
                'academic_level': {'grade_numeric': u['grade'], 'tier': tier(u['grade'])},
                'subject_canonical': subj, 'subject_label': u['subject'],
                'hierarchy': {'unit_no': u['unit_no'], 'unit': f'Unit {u["unit_no"]}: {u["unit_title"]}', 'chapter_title': u['unit_title'],
                              'section': c['section'] or None, 'subtopic': c['sub'] or None},
                'curriculum_context': {'book_code': u['book_code'], 'book_title': u['book_title']},
                'content': {'child_text': c['text'], 'parent_context': c['parent']},
                'visuals': [],
                'provenance': {'source_pdf': u['pdf'], 'book_path': u['book_path'], 'page_numbers': c['pages'], 'edition_year': 2026},
                'pedagogy': {'chunk_type': c['kind']},
                'embedding_model': MODEL, 'schema_version': 1,
            }
            points.append((str(uuid.uuid5(NS, urn)), f'passage: {head}. {c["text"]}', payload))
        row['chunks'] = len(points)
        if a.dry_run:
            row['sample'] = [p[2]['hierarchy'] | {'pages': p[2]['provenance']['page_numbers'], 'text': p[2]['content']['child_text'][:160]} for p in points[:3]]
        else:
            from qdrant_client import models
            vecs = model.encode([p[1] for p in points], batch_size=32, normalize_embeddings=True, show_progress_bar=False)
            batch = [models.PointStruct(id=pid, vector={'dense': v.tolist(), 'sparse': models.SparseVector(**sparse(txt))}, payload=pl)
                     for (pid, txt, pl), v in zip(points, vecs)]
            for s in range(0, len(batch), 64):
                client.upsert(VAULT, points=batch[s:s + 64], wait=True)
        row['status'] = 'ok'; report.append(row)
        print(f'[{i}/{len(units)}] G{u["grade"]} {u["subject"]} U{u["unit_no"]} {u["unit_title"][:40]}: {len(points)} chunks, {len(sections)} sections', flush=True)
        if a.report and i % 10 == 0:
            json.dump(report, open(a.report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if a.report:
        json.dump(report, open(a.report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    c = collections.Counter(r['status'] for r in report)
    print('SUMMARY', dict(c), flush=True)


if __name__ == '__main__':
    main()
