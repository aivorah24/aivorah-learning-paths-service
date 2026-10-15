"""Generates the synthetic fixture PDFs for the CISCE pipeline tests.
No CISCE content: every subject, unit and topic name here is made up.
Run: python3 -I tests/fixtures/cisce/make_fixtures.py  (needs reportlab)."""
import os
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))


def page(c, lines):
    y = 800
    for line in lines:
        c.drawString(60, y, line)
        y -= 18
    c.showPage()


def syllabus():
    c = canvas.Canvas(os.path.join(HERE, 'syllabus-text.pdf'), pagesize=A4, invariant=1)
    page(c, ['TESTOLOGY', 'Aims:', 'To build familiarity with invented synthetic concepts used only in tests.',
             'CLASS IX', 'There will be one paper of two hours duration for this synthetic subject.',
             '1. Synthetic Unit Alpha', '(i) Placeholder topic one', 'Detail line for placeholder topic one.',
             '(ii) Placeholder topic two', '2. Synthetic Unit Beta', '(a) Imaginary topic gamma'])
    page(c, ['CLASS X', '1. Synthetic Unit Delta', '(i) Fictional topic epsilon', 'Explanation text for epsilon goes here.',
             '(ii) Fictional topic zeta', '2. Synthetic Unit Eta', '(i) Fictional topic theta', 'Body of theta continues.'])
    c.save()


def scanned():
    c = canvas.Canvas(os.path.join(HERE, 'scanned-mixed.pdf'), pagesize=A4, invariant=1)
    page(c, ['MOCKOLOGY', 'CLASS IX', '1. Mock Unit One', '(i) Mock topic one with enough characters to count as text'])
    # Page 2: only a drawn shape, no text layer — stands in for a scanned page.
    c.rect(100, 400, 300, 200, fill=1)
    c.showPage()
    c.save()


def framework():
    c = canvas.Canvas(os.path.join(HERE, 'framework.pdf'), pagesize=A4, invariant=1)
    page(c, ['SYNTHETIC PRIMARY FRAMEWORK', 'General principles of a made-up primary framework for testing only.',
             'CLASS I', 'Learners explore invented ideas through play and talk in this fixture text.',
             'CLASS II', 'Learners extend the invented ideas through stories in this fixture text.'])
    c.save()


def theme_framework():
    # Shaped like a theme-based primary framework: cover/introduction, then
    # per subject a CLASS I and a CLASS II section, no numbered topic list.
    c = canvas.Canvas(os.path.join(HERE, 'theme-framework.pdf'), pagesize=A4, invariant=1)
    page(c, ['INVENTED CURRICULUM FOR PRIMARY CLASSES', 'Introduction to a made-up framework.',
             'This fixture curriculum is theme based and does not proceed with a list of topics.'])
    page(c, ['SYNTHETIC LANGUAGE', 'CLASS I', 'Learners listen to invented rhymes and talk about fictional pictures.',
             'CLASS II', 'Learners retell invented stories in their own words in this fixture.'])
    page(c, ['SYNTHETIC NUMBERS', 'CLASS I', 'THEME 1: Made-up Shapes Around Us', 'Learners sort imaginary shapes by colour.',
             'THEME 2: Pretend Patterns', 'Learners continue pretend patterns using beads.',
             'CLASS II', 'Learners compare invented quantities in this fixture text.'])
    c.save()


def row(c, y, cells, xs=(60, 200, 330, 460)):
    for x, text in zip(xs, cells):
        if text:
            c.drawString(x, y, text)


def primary_layouts():
    # The layouts that broke the first real Primary Curriculum run: a by-skill
    # table with classes as columns, two-column table rows under a topic, a
    # sentence in a lettered list, a heading wrapped over two lines, a repeated
    # CLASS page header, and a sentence that mentions pre-primary.
    c = canvas.Canvas(os.path.join(HERE, 'primary-layouts.pdf'), pagesize=A4, invariant=1)
    page(c, ['FICTIONAL PRIMARY CURRICULUM', 'Pre-primary learning in this fixture is mentioned only in passing.'])
    c.drawString(60, 800, 'INVENTED LANGUAGE')
    c.drawString(60, 782, 'READING')
    row(c, 764, ['Skill', 'Class I', 'Class II', 'Class III'])
    row(c, 746, ['Phonics', 'Hears made-up sounds', 'Blends sounds', 'Reads made-up words'])
    row(c, 728, ['Stories', 'Listens to fake tales', 'Retells fake tales', 'Writes fake tales'])
    c.showPage()
    page(c, ['INVENTED MATHS', 'CLASS I', '1. Pretend Measurement'])
    row(c, 746, ['(a) Length', 'Using concrete toy blocks to bring', 'Material available in a box'], xs=(60, 230, 420))
    c.drawString(60, 728, '(b) printing done by the pretend robot can also be beautiful and it is fun for everyone')
    c.showPage()
    page(c, ['SOCIAL', 'STUDIES', 'CLASS III', 'Learners map an imaginary town in this fixture.'])
    page(c, ['SOCIAL', 'STUDIES', 'CLASS III', 'Learners continue the imaginary town map.'])
    c.save()


if __name__ == '__main__':
    primary_layouts()
    theme_framework()
    syllabus()
    scanned()
    framework()
    with open(os.path.join(HERE, 'not-a-pdf.html'), 'w') as f:
        f.write('<!DOCTYPE html><html><head><title>Page not found</title></head><body>404</body></html>\n')
    with open(os.path.join(HERE, 'corrupt.pdf'), 'wb') as f:
        f.write(b'%PDF-1.4\n%this is not a real pdf body\n')
