"""Lists what the before copy of a doc has that the current docs lack.

Usage:
  python -B check_moved_text.py BEFORE AFTER [AFTER ...]
  python -B check_moved_text.py --changelist WORK/applied.json BEFORE AFTER [AFTER ...]

AFTER is every current-design doc the change edited, never the history file: a rule that only landed in history is
lost. Every token (backtick code, quoted text, bold text, a number with its unit) and every sentence of BEFORE is looked
up in the AFTER files together, with whitespace collapsed.

With --changelist (the applied.json that apply_changes.py apply wrote), BEFORE is one of its before copies and the
AFTER files are normally in WORK/out/. What a row's range loses is printed under that row, never silently subtracted:
"edit <id> drops", "delete <id> drops", "add <id> drops" (an ADD's source range), "move <id> takes last copy of" (a
MOVE into history), "move <id> drops" (a MOVE elsewhere) and "move <id> strips". Everything else missing is printed as
unexplained, by line. Each printed item gets a look: either a row meant it, or it was lost.
"""
import json
import os
import re
import sys

TOKEN = re.compile(r'`([^`\n]{2,})`|"([^"\n]{3,})"|“([^”\n]{3,})”|„([^“”\n]{3,})[“”]|«([^»\n]{3,})»|\*\*([^*\n]+)\*\*|(\d+(?:[.,:]\d+)*\s?[%°A-Za-z][^\s,.;:)]*)')
SENTENCE_END = re.compile(r'(?<=[.!?])\s+')
LINE_MARKER = re.compile(r'^\s*(?:[-*>#]+|\d+\.)\s*')
MIN_SENTENCE = 25


def flat(text):
    return ' '.join(text.split())


def read(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data.startswith(b'\xef\xbb\xbf'):
        data = data[3:]
    return data.decode('utf-8').replace('\r\n', '\n')


def items_of(line):
    tokens = [flat(next(g for g in m.groups() if g)) for m in TOKEN.finditer(line)]
    sentences = [flat(s) for s in SENTENCE_END.split(LINE_MARKER.sub('', line))]
    return tokens, [s for s in sentences if len(s) >= MIN_SENTENCE]


def same(a, b):
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def covering(applied, before_path):
    """The rows whose range lies in this before copy, as (action, label, id, start, end, strip), plus the history file's paths."""
    files = applied.get('files', {})
    name = next((f for f, p in files.items() if p.get('before') and same(p['before'], before_path)), None)
    history = ((applied.get('run') or {}).get('history') or {}).get('file')
    hist_paths = [p for f, info in files.items() if f == history for p in (info.get('out'), info.get('live')) if p]
    rows = []
    for r in applied.get('rows', []):
        if name is None or r.get('file') != name or not r.get('start'):
            continue
        action = r.get('action')
        if action == 'MOVE':
            to_history = (r.get('destination') or {}).get('file') == history
            label = 'takes last copy of' if to_history else 'drops'
        else:
            label = 'drops'
        rows.append((action.lower(), label, r['id'], r['start'], r['end'], r.get('strip') or []))
    return name, rows, hist_paths


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    applied = None
    if argv[:1] == ['--changelist']:
        if len(argv) < 2:
            sys.exit('usage: python check_moved_text.py --changelist WORK/applied.json BEFORE AFTER [AFTER ...]')
        with open(argv[1], encoding='utf-8') as f:
            applied = json.load(f)
        argv = argv[2:]
    if len(argv) < 2:
        sys.exit('usage: python check_moved_text.py [--changelist WORK/applied.json] BEFORE AFTER [AFTER ...]')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    before_path, after_paths = argv[0], argv[1:]
    rows = []
    if applied is not None:
        name, rows, hist_paths = covering(applied, before_path)
        if name is None:
            sys.exit(f'{before_path} is not a before copy in that applied.json')
        for p in after_paths:
            if any(same(p, h) for h in hist_paths):
                sys.exit(f'{p} is the history file: never pass it as an AFTER (a rule found only there is lost)')
    before = read(before_path).split('\n')
    after = flat(' '.join(read(p) for p in after_paths))
    per_row = {}
    unexplained_tokens, unexplained_sentences, seen = [], [], set()
    for n, line in enumerate(before, 1):
        tokens, sentences = items_of(line)
        missing = []
        for t in tokens:
            if t not in seen:
                seen.add(t)
                if t not in after:
                    missing.append(('token', t))
        missing += [('sentence', s) for s in sentences if s not in after]
        if not missing:
            continue
        owners = [r for r in rows if r[3] <= n <= r[4]]
        if not owners:
            for kind, text in missing:
                (unexplained_tokens if kind == 'token' else unexplained_sentences).append((n, text))
            continue
        for action, label, rid, start, end, strip in owners:
            per_row.setdefault((action, label, rid), []).extend(text for _, text in missing)
    for action, label, rid, start, end, strip in rows:
        if strip:
            per_row.setdefault(('move', 'strips', rid), []).extend(strip)
    total = sum(len(v) for v in per_row.values())
    print(f'{len(unexplained_tokens)} tokens and {len(unexplained_sentences)} sentences of {before_path} unexplained, {total} items under rows')
    for (action, label, rid), texts in sorted(per_row.items(), key=lambda kv: kv[0][2]):
        print(f'{action} {rid} {label}: ' + ' | '.join(texts))
    for n, t in unexplained_tokens:
        print(f'token {n}: {t}')
    for n, s in unexplained_sentences:
        print(f'sentence {n}: {s}')


if __name__ == '__main__':
    main()
