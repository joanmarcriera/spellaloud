#!/usr/bin/env python3
"""Extract England's statutory spelling lists into content/uk-statutory/lists.json.

Usage:  pdftotext -layout English_Appendix_1_-_Spelling.pdf a1.txt
        python3 tools/extract_statutory_lists.py a1.txt > content/uk-statutory/lists.json

Source: DfE, "The national curriculum in England - English Appendix 1: Spelling" (2013),
(c) Crown copyright, Open Government Licence v3.0. The script only parses; provenance is
the SOURCES block below. Stdlib only. Re-running on the same text gives identical output.
"""
import json, re, sys

SOURCE = {
    "title": "The national curriculum in England - English Appendix 1: Spelling",
    "publisher": "Department for Education",
    "published": "2013-09",
    "landing_page": "https://www.gov.uk/government/publications/national-curriculum-in-england-english-programmes-of-study",
    "url": "https://assets.publishing.service.gov.uk/media/5a7ccc06ed915d63cc65ce61/English_Appendix_1_-_Spelling.pdf",
    "retrieved": "2026-10-23",
    "licence": "Open Government Licence v3.0",
    "licence_url": "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    "attribution": "Contains public sector information licensed under the Open Government Licence v3.0. "
                   "(c) Crown copyright 2013. Not affiliated with or endorsed by the Department for Education.",
}


def forms_of(official):
    """Words a child practises, derived from the printed entry."""
    s = official.replace("*", "").strip()
    m = re.match(r"^(\w+) \(–ped, –ment\)$", s)           # equip (–ped, –ment)
    if m:
        w = m.group(1)
        return [w, w + "ped", w + "ment"]
    s = re.sub(r"\s*\(.*? \+ .*?\)$", "", s)               # criticise (critic + ise)
    out = []
    for part in s.split("/"):
        part = part.strip()
        m = re.match(r"^([A-Za-z']+)\(([a-z]+)\)$", part)  # accident(ally), forward(s)
        out += [m.group(1), m.group(1) + m.group(2)] if m else [part]
    return out


def block(lines, start_pat, end_pat, col=None):
    """Lines between start/end markers, optionally sliced to a column."""
    i = next(n for n, l in enumerate(lines) if re.search(start_pat, l))
    j = next(n for n, l in enumerate(lines) if n > i and re.search(end_pat, l))
    return [l[col:] if col is not None else l for l in lines[i:j + 1]]


def prose_list(chunk, first, last):
    """Comma-separated prose list from `first` word to `last` word inclusive."""
    t = " ".join(x.strip() for x in chunk)
    t = t[t.index(first):]
    m = re.search(r"(?:^|, )" + re.escape(last) + r"(?:,| –|$)", t)   # whole entry, not 'our' in 'your'
    t = t[:m.end()].rstrip(",").split(" –")[0]
    return [w.strip() for w in t.split(",") if w.strip()]


def columns(chunk):
    """Words from a multi-column word-table, in the printed order (alphabetical DOWN each column).

    pdftotext -layout gives rows; cells are separated by 2+ spaces. Column starts come from the first
    (full) row, every cell is assigned to the nearest column start at or left of it, and the result is
    read column by column.
    """
    rows = []
    for l in chunk:
        if re.fullmatch(r"\f?\s*\d*\s*", l):                  # blank lines and page numbers
            continue
        # a cell = text with only single spaces inside; 2+ spaces separate cells
        rows.append([(m.start(), m.group()) for m in re.finditer(r"\S(?: ?\S)*", l)])
    starts = [pos for pos, _ in rows[0]]
    cols = [[] for _ in starts]
    for r in rows:
        for pos, text in r:
            j = max(i for i, st in enumerate(starts) if st <= pos + 2) if pos + 2 >= starts[0] else 0
            cols[j].append(text)
    return [w for c in cols for w in c]


def main(path):
    lines = open(path, encoding="utf-8").read().split("\n")
    # Year 1: the 'Common exception words' row ('the, a, ... house, our')
    y1c = next(l for l in lines if "the, a, do, to" in l).index("the, a")
    y1 = prose_list(block(lines, r"the, a, do, to", r"according to the programme", y1c), "the", "our")
    # Year 2: the row 'door, floor, ... Mr, Mrs, parents, Christmas'
    y2c = next(l for l in lines if "door, floor, poor" in l).index("door")
    y2 = prose_list(block(lines, r"door, floor, poor", r"others according to", y2c), "door", "Christmas")
    y2 = [w.replace("*", "") for w in y2]
    # Years 3-4 / 5-6 word lists
    def wl(title, stop):
        # pdftotext puts a form feed (\f) at the start of the first line of each page
        chunk = block(lines, r"^\f?Word list – " + title, stop)[1:-1]
        return columns(chunk)
    y34 = wl("years 3 and 4", r"^\f?Notes and guidance")
    y56 = wl("years 5 and 6", r"^\f?Notes and guidance")
    def entries(ws):
        return [{"official": w, "forms": forms_of(w)} for w in ws]
    lists = [
        dict(id="y1-common-exception-words", title="Year 1 common exception words", years=[1],
             statutory=False, note="Printed as non-statutory example words, 'and/or others according to the programme used'.",
             entries=entries(y1)),
        dict(id="y2-common-exception-words", title="Year 2 common exception words", years=[2],
             statutory=False, note="Printed as non-statutory example words, 'and/or others according to programme used'. 'children' is included because of its relationship with 'child'.",
             entries=entries(y2)),
        dict(id="y3-4-word-list", title="Years 3 and 4 word list", years=[3, 4], statutory=True, entries=entries(y34)),
        dict(id="y5-6-word-list", title="Years 5 and 6 word list", years=[5, 6], statutory=True, entries=entries(y56)),
    ]
    json.dump({"schema": 1, "source": SOURCE, "lists": lists}, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main(sys.argv[1])
