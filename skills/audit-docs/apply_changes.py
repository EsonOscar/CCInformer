"""Applies an audit-docs changelist: the only gate between the workflow's rows and the docs.

Usage (with the user's Python, always with -B so nothing is cached in the skill folder):
  python -B apply_changes.py summary CHANGELIST
  python -B apply_changes.py show CHANGELIST ID [ID ...]
  python -B apply_changes.py check CHANGELIST --plan PLAN --root ROOT [--table]
  python -B apply_changes.py apply CHANGELIST --plan PLAN --root ROOT --work WORK
  python -B apply_changes.py install --work WORK

CHANGELIST is the workflow's .output file (its "result") or a changelist.json holding the same object.
PLAN is the plan file with the audit-decisions block (picks, restores, the main session's own rows) and its
audit-text blocks. summary, show and check write nothing, so they run in plan mode. apply writes only into WORK
(before copies, out/, applied.json, changes.diff) and nothing at all when any row is refused. install checks the live
files are still the before copies, writes the kept copies first, then copies out/ over the live files.

Files are read as bytes and written back with the same BOM, line ending and final newline. Lines split only on \\n.
Inserted blocks are kept one blank line apart from the lines around them, except between list items or table rows.
"""
import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import sys

# The same lists live in audit-docs-fanout.js; tests/test_apply.py compares them.
KINDS = ['current', 'instructions', 'record', 'changelog', 'archive', 'history', 'generated', 'translation', 'copy', 'parsed', 'index', 'third_party', 'code']
ACTIONS = ['EDIT', 'MOVE', 'DELETE', 'ADD', 'ASK']
CATEGORIES = ['DRIFT', 'STALE_STATUS', 'HISTORY_LEAK', 'BROKEN_REF', 'CONTRADICTION', 'MISPLACED', 'INCOMPLETE_LIST', 'DUPLICATE']
ALL = set(ACTIONS)
ALLOWED = {
    'current': ALL, 'instructions': ALL, 'record': {'EDIT', 'ASK'}, 'changelog': {'EDIT', 'ASK'}, 'archive': {'ASK'},
    'history': {'MOVE', 'ASK'}, 'generated': {'ASK'}, 'translation': ALL, 'copy': ALL, 'parsed': ALL, 'index': ALL,
    'third_party': {'ASK'}, 'code': {'EDIT'},
}
TAKES_TEXT = {'current', 'instructions', 'history', 'translation', 'copy', 'parsed', 'index'}
INSTRUCTION = re.compile(r'^\s*[\(\[]\s*(delete|remove|drop|keep|move|replace|insert|unchanged)\b|\[lines? \d+|\bsee finding\b', re.I)
REPEAT_MIN = 4
ANCHOR_MIN = 20
NEAR = 5
TABLE_PROBLEM = 100
BS = chr(92)
BOM = b'\xef\xbb\xbf'
DASHES = (chr(0x2014), chr(0x2013))
TAG = re.compile(r'<' + re.escape(BS) + r'([A-Za-z][\w-]*)')
FENCE = re.compile(r'^\s*(```|~~~)')
HEADING = re.compile(r'^(#{1,6})\s+\S')


class Refused(Exception):
    pass


# ---------- reading and writing docs ----------

def read_doc(path):
    if not os.path.exists(path):
        return None
    with open(path, 'rb') as f:
        raw = f.read()
    bom = raw.startswith(BOM)
    body = raw[len(BOM):] if bom else raw
    try:
        text = body.decode('utf-8')
    except UnicodeDecodeError:
        raise Refused('not UTF-8')
    crlf, lf = text.count('\r\n'), text.count('\n')
    if crlf and crlf != lf:
        raise Refused('mixed line endings')
    eol = '\r\n' if crlf else '\n'
    text = text.replace('\r\n', '\n')
    final = text.endswith('\n')
    if final:
        text = text[:-1]
    lines = text.split('\n') if (text or final) else []
    return {'bom': bom, 'eol': eol, 'final': final, 'lines': lines}


def render(doc):
    text = '\n'.join(doc['lines'])
    if doc['final']:
        text += '\n'
    data = text.replace('\n', doc['eol']).encode('utf-8')
    return (BOM if doc['bom'] else b'') + data


def new_doc(like=None):
    return {'bom': False, 'eol': like['eol'] if like else '\n', 'final': True, 'lines': []}


# ---------- changelist and decisions ----------

def load_changelist(path):
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    if isinstance(data, dict) and 'result' in data:
        data = data['result']
    if isinstance(data, str):
        data = json.loads(data)
    if not isinstance(data, dict) or 'changes' not in data:
        raise SystemExit(f'{path}: no changelist (expected a "changes" list)')
    data.setdefault('rejected', [])
    data.setdefault('docs', [])
    data.setdefault('run', {})
    data.setdefault('summary', {})
    return data


def load_decisions(plan_path):
    if not plan_path:
        return {}, {}
    with open(plan_path, encoding='utf-8') as f:
        plan = f.read().replace('\r\n', '\n')
    texts = {}
    for m in re.finditer(r'^```audit-text[ \t]+(\S+)[ \t]*\n(.*?)\n```[ \t]*$', plan, re.M | re.S):
        texts[m.group(1)] = m.group(2).replace('{BS}', BS)
    m = re.search(r'^```audit-decisions[ \t]*\n(.*?)\n```[ \t]*$', plan, re.M | re.S)
    if not m:
        return {}, texts
    raw = m.group(1)
    for i, ch in enumerate(raw):
        if ch == BS and raw[i + 1:i + 2] != '"':
            raise Refused('escape: a backslash in the audit-decisions block (write {BS} in an audit-text block, and paths with forward slashes)')
    return json.loads(raw), texts


def with_texts(value, texts):
    if isinstance(value, dict):
        if set(value) == {'text'}:
            if value['text'] not in texts:
                raise Refused(f'field: no audit-text block named {value["text"]}')
            return texts[value['text']]
        return {k: with_texts(v, texts) for k, v in value.items()}
    if isinstance(value, list):
        return [with_texts(v, texts) for v in value]
    return value


def resolve(cl, dec, texts):
    """The final rows after picks, skips, restores and the main session's own rows, plus the refusals that need a decision."""
    picks = dec.get('picks', {})
    rows, refusals = [], []
    for c in cl['changes']:
        p = picks.get(c['id'])
        if p == 'skip':
            continue
        row = dict(c, origin='agent')
        if c['action'] == 'ASK':
            if not isinstance(p, int) or isinstance(p, bool):
                refusals.append((c['id'], 'ask', 'no pick'))
                continue
            options = c.get('options') or []
            if not 0 <= p < len(options):
                refusals.append((c['id'], 'ask', f'pick {p} is not an option'))
                continue
            option = options[p]
            if not option.get('action'):
                continue
            row = {k: v for k, v in c.items() if k not in ('options', 'quote', 'new_text', 'leave', 'strip', 'destination')}
            row.update({k: v for k, v in option.items() if k != 'label'})
            row['origin'] = 'agent'
        elif c.get('verdict') == 'UNVERIFIED' and p != 'accept':
            refusals.append((c['id'], 'unverified', 'check its lines, then pick accept or skip'))
            continue
        rows.append(row)
    rejected = {r['id']: r for r in cl['rejected']}
    for r in dec.get('restore', []):
        entry = rejected.get(r.get('id'))
        version = entry and entry.get(r.get('version', 'original'))
        if not version:
            refusals.append((r.get('id'), 'field', 'restore names no such rejected row or version'))
            continue
        rows.append(dict(version, id=entry['id'], origin='agent', verdict='RESTORED'))
    for r in dec.get('rows', []):
        r = with_texts(r, texts)
        if 'text' in r and isinstance(r['text'], str):
            if r['text'] not in texts:
                refusals.append((r.get('id'), 'field', f'no audit-text block named {r["text"]}'))
                continue
            r = dict(r, new_text=texts[r.pop('text')])
        rows.append(dict(r, origin='user'))
    return rows, refusals


# ---------- paths ----------

def same_bytes(a, b):
    with open(a, 'rb') as fa, open(b, 'rb') as fb:
        return fa.read() == fb.read()


def rel_of(file):
    if file.startswith('~'):
        return '_home/' + file[1:].lstrip('/\\')
    return file


def live_path(root, file):
    if file.startswith('~'):
        return os.path.expanduser(file)
    return os.path.join(root, file)


def repo_key(root):
    full = os.path.abspath(root)
    return os.path.basename(full.rstrip('/\\')) + '-' + hashlib.sha1(full.encode('utf-8')).hexdigest()[:6]


# ---------- matching ----------

def norm(s):
    return s.rstrip()


def needed(line):
    n = min(len(norm(line)), ANCHOR_MIN)
    b = line.find(BS)
    return min(n, b) if b >= 0 else n


def anchor_ok(anchor, line):
    a = norm(anchor)
    return norm(line).startswith(a) and len(a) >= needed(line)


def restore_tags(value, reference):
    """Turns a neutralised <\\name back into <name, per occurrence, when the reference has <name and not <\\name."""
    def fix(m):
        name = m.group(1)
        if ('<' + name) in reference and ('<' + BS + name) not in reference:
            return '<' + name
        return m.group(0)
    return TAG.sub(fix, value)


def restore_escapes(value, reference):
    """Turns a decoded character back into its literal backslash-u escape when the reference has the escape, not the character."""
    out = []
    for ch in value:
        if ord(ch) > 127 and ch not in reference:
            for esc in (BS + 'u%04x' % ord(ch), BS + 'u%04X' % ord(ch)):
                if esc in reference:
                    out.append(esc)
                    break
            else:
                out.append(ch)
        else:
            out.append(ch)
    return ''.join(out)


def restored(value, reference):
    return restore_escapes(restore_tags(value, reference), reference)


SEE = re.compile(r'^\s*[\(\[]\s*see\s+(?!finding\b)', re.I)


def is_wrapped(text):
    """Text that is wrapped whole in () or [], like '(delete the sentence)'; a Markdown link is not."""
    t = text.strip()
    if len(t) < 2:
        return False
    return (t[0] == '(' and t[-1] == ')') or (t[0] == '[' and t[-1] == ']' and '](' not in t)


def blankish(line):
    s = line.strip()
    return s == '' or s == '---' or bool(FENCE.match(line))


def in_fence_map(lines):
    inside, flags = False, []
    for line in lines:
        if FENCE.match(line):
            flags.append(True)
            inside = not inside
            continue
        flags.append(inside)
    return flags


def heading_level(line):
    m = HEADING.match(line)
    return len(m.group(1)) if m else 0


def section_end(lines, i):
    """The index after which text goes at the end of the section whose heading is at i."""
    level = heading_level(lines[i])
    fence = in_fence_map(lines)
    j = len(lines)
    for k in range(i + 1, len(lines)):
        if not fence[k] and 0 < heading_level(lines[k]) <= level:
            j = k
            break
    k = j - 1
    while k > i and lines[k].strip() in ('', '---'):
        k -= 1
    return k


def find_heading(lines, section):
    fence = in_fence_map(lines)
    return [i for i, line in enumerate(lines) if not fence[i] and norm(line) == norm(section)]


def demote(text_lines, below):
    fence = in_fence_map(text_lines)
    levels = [heading_level(l) for i, l in enumerate(text_lines) if not fence[i] and heading_level(l)]
    if not levels or min(levels) > below:
        return text_lines
    shift = below - min(levels) + 1
    return ['#' * shift + l if not fence[i] and heading_level(l) else l for i, l in enumerate(text_lines)]


# ---------- validation ----------

def validate(rows, docs, read, run):
    """Checks every row against the files read() returns. Gives (refusals, restores, warnings, ops)."""
    refusals, restores, warnings, ops = [], [], [], []
    history = (run.get('history') or {}).get('file')

    def refuse(row, reason, detail):
        refusals.append((row.get('id'), reason, detail))

    def kind_of(row, file):
        if file in docs:
            return docs[file].get('kind', 'current')
        if row.get('origin') == 'user':
            return row.get('kind', 'current')
        return None

    cache = {}

    def get(file):
        if file not in cache:
            cache[file] = read(file)
        return cache[file]

    for row in rows:
        rid, action, file = row.get('id'), row.get('action'), row.get('file')
        if action not in ALLOWED['current']:
            refuse(row, 'field', f'unknown action {action}')
            continue
        if action == 'ASK':
            refuse(row, 'ask', 'no pick')
            continue
        if row.get('blocked') == 'outside docs' or (file and file.startswith('~') and row.get('origin') != 'user'):
            refuse(row, 'scope', f'{file} is not in the docs list; redo it as a user row or skip it')
            continue
        kind = kind_of(row, file) if file else None
        if action != 'ADD' and kind is None:
            refuse(row, 'scope', f'{file} is not in the docs list')
            continue
        need = {'EDIT': ['start', 'end', 'first_line'], 'DELETE': ['start', 'end', 'first_line'], 'MOVE': ['start', 'end', 'first_line', 'destination'], 'ADD': ['destination']}[action]
        missing = [k for k in need if row.get(k) in (None, '')]
        if action in ('EDIT', 'ADD') and not isinstance(row.get('new_text'), str):
            missing.append('new_text')
        if action in ('MOVE', 'DELETE') and row.get('new_text') is not None:
            refuse(row, 'field', f'{action} takes no new_text')
            continue
        if missing:
            refuse(row, 'field', 'missing ' + ', '.join(missing))
            continue
        if action != 'ADD' and action not in ALLOWED.get(kind, set()):
            refuse(row, 'kind', f'{action} is not allowed on a {kind} doc')
            continue
        ok = True
        doc, lines, start, end, rng = None, None, row.get('start'), row.get('end'), ''
        if action != 'ADD' or start:
            try:
                doc = get(file)
            except Refused as e:
                refuse(row, 'file', f'{file}: {e}')
                continue
            if doc is None:
                refuse(row, 'file', f'{file} does not exist')
                continue
            lines = doc['lines']
            if not (1 <= start <= end <= len(lines)):
                refuse(row, 'range', f'lines {start}-{end} are outside {file} ({len(lines)} lines)')
                continue
            rng = '\n'.join(lines[start - 1:end])
            for field, at in (('first_line', start), ('last_line', end)):
                anchor = row.get(field)
                if anchor is None:
                    continue
                if not anchor_ok(anchor, lines[at - 1]):
                    fixed = restored(anchor, lines[at - 1])
                    if fixed != anchor and anchor_ok(fixed, lines[at - 1]):
                        restores.append((rid, field, 'restored a neutralised tag or escape'))
                        row[field] = fixed
                    else:
                        near = [k + 1 for k in range(max(0, at - 1 - NEAR), min(len(lines), at + NEAR)) if anchor_ok(fixed, lines[k])]
                        hint = f'; first_line matches line {near[0]}' if field == 'first_line' and len(near) == 1 else ''
                        refuse(row, 'range', f'{field} does not start line {at}{hint}')
                        ok = False
            if not ok:
                continue
            if end > start and blankish(lines[start - 1]) and blankish(lines[end - 1]):
                refuse(row, 'anchor', 'both anchors are blank, fence or rule lines')
                continue
        quote = row.get('quote')
        if quote is not None:
            if action != 'EDIT' or start != end:
                refuse(row, 'field', 'a quote needs an EDIT with start = end')
                continue
            line = lines[start - 1]
            if line.count(quote) != 1:
                fixed = restored(quote, line)
                if fixed != quote and line.count(fixed) == 1:
                    restores.append((rid, 'quote', 'restored a neutralised tag or escape'))
                    row['quote'] = quote = fixed
                else:
                    refuse(row, 'quote', f'found {line.count(quote)} times on line {start}')
                    continue
        text = row.get('new_text')
        if isinstance(text, str):
            reference = rng
            if action == 'ADD':
                reference = rng
                if not reference:
                    try:
                        dest = get(row['destination']['file'])
                    except Refused:
                        dest = None
                    reference = '\n'.join(dest['lines']) if dest else ''
            fixed = restored(text, reference)
            if fixed != text:
                restores.append((rid, 'new_text', 'restored a neutralised tag or escape'))
                row['new_text'] = text = fixed
            if row.get('origin') == 'agent':
                wrapped = is_wrapped(text) and not is_wrapped(quote if quote is not None else rng)
                if INSTRUCTION.search(text) or (wrapped and not SEE.match(text)):
                    refuse(row, 'instruction', 'new_text reads as an instruction, not text')
                    continue
            for ch in sorted(set(text)):
                if (ch in DASHES or ch == '\t' or (ord(ch) < 32 and ch != '\n')) and ch not in reference:
                    warnings.append((rid, f'new_text adds {ascii(ch)}, which its reference text lacks'))
            if rng:
                even = all(l.count('`') % 2 == 0 for l in rng.split('\n'))
                if even and any(l.count('`') % 2 for l in text.split('\n')):
                    warnings.append((rid, 'a new_text line has an odd number of backticks'))
        if action == 'EDIT':
            line = lines[start - 1]
            if quote is not None:
                i = line.index(quote)
                before, after = line[:i], line[i + len(quote):]
                p, s = before.strip(), after.strip()
                i0, i1 = i, i + len(quote)
                if text == '':
                    if before.endswith(' '):
                        before, i0 = before[:-1], i0 - 1
                    elif after.startswith(' '):
                        after, i1 = after[1:], i1 + 1
                if text and ((len(re.sub(r'\s', '', p)) >= REPEAT_MIN and text.lstrip().startswith(p)) or (len(re.sub(r'\s', '', s)) >= REPEAT_MIN and text.rstrip().endswith(s))):
                    refuse(row, 'repeat', 'new_text repeats the text around the quote')
                    continue
                new_lines = (before + text + after).split('\n')
                span = (i0, i1, text)
            else:
                span = None
                if text == '':
                    refuse(row, 'field', 'an empty new_text needs a quote (or use DELETE)')
                    continue
                new_lines = text.split('\n')
            if new_lines == lines[start - 1:end]:
                refuse(row, 'noop', 'the result equals the before text')
                continue
            ops.append({'id': rid, 'file': file, 'start': start, 'end': end, 'lines': new_lines, 'seam': False, 'span': span})
        elif action == 'DELETE':
            ops.append({'id': rid, 'file': file, 'start': start, 'end': end, 'lines': [], 'seam': True})
        elif action in ('MOVE', 'ADD'):
            dest = row['destination']
            dkind = kind_of(row, dest['file']) if dest['file'] != history else 'history'
            if dkind is None and dest['file'] in docs:
                dkind = docs[dest['file']].get('kind')
            if dkind is None:
                refuse(row, 'scope', f'destination {dest["file"]} is not in the docs list')
                continue
            if dkind not in TAKES_TEXT:
                refuse(row, 'kind', f'a {dkind} doc takes no moved or added text')
                continue
            if action == 'MOVE':
                moved = lines[start - 1:end]
                for s in row.get('strip') or []:
                    if s not in '\n'.join(moved):
                        refuse(row, 'strip', f'{s!r} is not in the range')
                        ok = False
                        break
                    moved = [l.replace(s, '') for l in moved]
                if not ok:
                    continue
                while moved and moved[0].strip() in ('', '---'):
                    moved.pop(0)
                while moved and moved[-1].strip() in ('', '---'):
                    moved.pop()
                leave = row.get('leave')
                ops.append({'id': rid, 'file': file, 'start': start, 'end': end, 'lines': leave.split('\n') if leave else [], 'seam': True})
                payload = moved
            else:
                payload = text.split('\n')
            ops.append({'id': rid, 'insert': True, 'file': dest['file'], 'section': dest.get('section'), 'after': dest.get('after'),
                        'create': bool(dest.get('create')), 'lines': payload, 'history': dest['file'] == history, 'src': (file, start or 0)})
    place(ops, get, refuse_by_id(rows, refusals), run)
    overlap_check(ops, refusals)
    hist_ops = [op for op in ops if op.get('insert') and op['history']]
    if history and hist_ops:
        try:
            why = history_blocked(get(history), run.get('history') or {}, run.get('date', ''))
        except Refused as e:
            why = str(e)
        for op in hist_ops if why else []:
            refusals.append((op['id'], 'destination', why))
    return refusals, restores, warnings, ops


def refuse_by_id(rows, refusals):
    def refuse(rid, reason, detail):
        refusals.append((rid, reason, detail))
    return refuse


def place(ops, get, refuse, run):
    """Turns each insert's section and after into a line position in its destination's before coordinates."""
    removed = {}
    for op in ops:
        if not op.get('insert') and (op['seam'] or op['lines'] != []):
            removed.setdefault(op['file'], []).append((op['start'], op['end']))
    for op in [o for o in ops if o.get('insert')]:
        if op['history']:
            continue
        try:
            doc = get(op['file'])
        except Refused as e:
            refuse(op['id'], 'file', f'{op["file"]}: {e}')
            op['bad'] = True
            continue
        if doc is None:
            if not op['create']:
                refuse(op['id'], 'destination', f'{op["file"]} does not exist (create: true makes it)')
                op['bad'] = True
                continue
            doc = new_doc()
        lines = doc['lines']
        if op['section'] is None:
            pos = len(lines)
            op['new_heading'] = None
        else:
            found = find_heading(lines, op['section'])
            if len(found) == 1:
                pos = section_end(lines, found[0]) + 1
            elif not found and op['create']:
                pos = len(lines)
                op['new_heading'] = op['section']
            else:
                refuse(op['id'], 'destination', f'heading {op["section"]!r} found {len(found)} times')
                op['bad'] = True
                continue
            if op.get('after') and not op.get('new_heading'):
                lo = found[0] if found else 0
                hits = [k for k in range(lo, pos) if anchor_ok(op['after'], lines[k])]
                if len(hits) != 1:
                    refuse(op['id'], 'destination', f'after anchor found {len(hits)} times in the section')
                    op['bad'] = True
                    continue
                pos = hits[0] + 1
        for s, e in removed.get(op['file'], []):
            if s <= pos <= e:
                refuse(op['id'], 'destination', f'it lands inside lines {s}-{e}, which another row removes')
                op['bad'] = True
        op['pos'] = pos


def overlap_check(ops, refusals):
    by_file = {}
    for op in ops:
        if not op.get('insert'):
            by_file.setdefault(op['file'], []).append(op)
    for items in by_file.values():
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                a, b = items[i], items[j]
                if a['start'] > b['end'] or b['start'] > a['end']:
                    continue
                sa, sb = a.get('span'), b.get('span')
                if sa and sb and a['start'] == b['start'] and (sa[1] <= sb[0] or sb[1] <= sa[0]):
                    continue
                refusals.append((a['id'], 'overlap', f'lines {a["start"]}-{a["end"]} overlap {b["id"]}'))
                refusals.append((b['id'], 'overlap', f'lines {b["start"]}-{b["end"]} overlap {a["id"]}'))


# ---------- applying ----------

def apply_ops(ops, get, run, history_entry):
    """Applies every op bottom to top per file and returns {file: doc} for each changed file."""
    files = {}
    for op in ops:
        if op.get('bad'):
            continue
        if op.get('insert') and op['history']:
            continue
        doc = files.get(op['file'])
        if doc is None:
            base = get(op['file'])
            doc = {'bom': base['bom'], 'eol': base['eol'], 'final': base['final'], 'lines': list(base['lines'])} if base else new_doc()
            files[op['file']] = doc
    by_file = {}
    for op in ops:
        if op.get('bad') or (op.get('insert') and op['history']):
            continue
        by_file.setdefault(op['file'], []).append(op)
    for file, items in by_file.items():
        doc = files[file]
        lines = doc['lines']
        items = merge_quote_edits(items, lines)
        inserts = {}
        for op in items:
            if op.get('insert'):
                inserts.setdefault((op['pos'], op.get('new_heading')), []).append(op)
        events = [(op['start'], 0, op) for op in items if not op.get('insert')]
        events += [(pos - 0.5 + 1, 1, group) for (pos, _), group in inserts.items()]
        for key, kind, item in sorted(events, key=lambda e: (e[0], e[1]), reverse=True):
            if kind == 0:
                s, e = item['start'] - 1, item['end']
                lines[s:e] = item['lines']
                if item['seam'] and not item['lines']:
                    while 0 < s < len(lines) and lines[s - 1].strip() == '' and lines[s].strip() == '':
                        del lines[s]
            else:
                group = sorted(item, key=lambda o: id_key(o['id']))
                pos = group[0]['pos']
                block = []
                heading = group[0].get('new_heading')
                if heading:
                    block += [heading, '']
                for n, op in enumerate(group):
                    if n:
                        block.append('')
                    block += op['lines']
                spaced(lines, pos, block)
    history = run.get('history') or {}
    hist_ops = [op for op in ops if op.get('insert') and op['history'] and not op.get('bad')]
    if history.get('file') and (hist_ops or history_entry):
        base = get(history['file'])
        doc = {'bom': base['bom'], 'eol': base['eol'], 'final': base['final'], 'lines': list(base['lines'])} if base else new_doc()
        if not base:
            stem = os.path.splitext(os.path.basename(history['file']))[0]
            doc['lines'] = [f'# {stem} history']
        assemble_history(doc, history, run.get('date', ''), history_entry, hist_ops)
        files[history['file']] = doc
    return files


def merge_quote_edits(items, lines):
    """Quote edits with disjoint spans on one line become one edit of that line, applied right to left."""
    groups, rest = {}, []
    for op in items:
        if op.get('span') and not op.get('insert'):
            groups.setdefault(op['start'], []).append(op)
        else:
            rest.append(op)
    for start, ops in groups.items():
        if len(ops) == 1:
            rest.append(ops[0])
            continue
        line = lines[start - 1]
        for op in sorted(ops, key=lambda o: o['span'][0], reverse=True):
            i0, i1, text = op['span']
            line = line[:i0] + text + line[i1:]
        rest.append(dict(ops[0], lines=line.split('\n'), span=None))
    return rest


LIST_ITEM = re.compile(r'^\s*(?:[-*+]\s|\d+[.)]\s|\|)')


def apart(a, b):
    """Whether two neighbouring lines need a blank line between them: not when both are list items or table rows."""
    if a.strip() == '' or b.strip() == '':
        return False
    return not (LIST_ITEM.match(a) and LIST_ITEM.match(b))


def spaced(lines, pos, block):
    if not block:
        return
    if pos > 0 and apart(lines[pos - 1], block[0]):
        block = [''] + block
    if pos < len(lines) and apart(block[-1], lines[pos]):
        block = block + ['']
    lines[pos:pos] = block


def id_key(rid):
    m = re.match(r'^([a-z0-9]+)-(x?)(\d+)$', rid or '')
    return (m.group(1), 1 if m.group(2) else 0, int(m.group(3))) if m else (rid or '', 0, 0)


def history_heading(history, date):
    return history.get('heading') or f'## {date}: docs audit'


def history_blocked(doc, history, date):
    """Why rows can't go under today's heading, or None: it may be new, or the last heading at its level."""
    if not doc:
        return None
    lines = doc['lines']
    heading = history_heading(history, date)
    level = heading_level(heading) or 2
    fence = in_fence_map(lines)
    found = [i for i, l in enumerate(lines) if not fence[i] and norm(l) == norm(heading)]
    if found and [k for k in range(found[-1] + 1, len(lines)) if not fence[k] and 0 < heading_level(lines[k]) <= level]:
        return f'history heading {heading!r} exists but is not the last at its level'
    return None


def assemble_history(doc, history, date, entry, hist_ops):
    lines = doc['lines']
    heading = history_heading(history, date)
    level = heading_level(heading) or 2
    why = history_blocked(doc, history, date)
    if why:
        raise Refused(why)
    fence = in_fence_map(lines)
    if any(not fence[i] and norm(l) == norm(heading) for i, l in enumerate(lines)):
        block = []
    else:
        block = [heading, '']
    block += list(entry)
    for op in sorted(hist_ops, key=lambda o: o['src']):
        if block and block[-1].strip() != '':
            block.append('')
        label = op.get('section') or 'Moved'
        block += ['#' * (level + 1) + ' ' + label, '']
        block += demote(op['lines'], level + 1)
    while lines and lines[-1].strip() == '':
        lines.pop()
    if lines:
        lines.append('')
    lines += block


# ---------- commands ----------

def docs_map(cl):
    return {d['file']: d for d in cl.get('docs', [])}


def cmd_summary(args):
    cl = load_changelist(args.changelist)
    s = cl.get('summary', {})
    counts = s.get('counts', {})
    print('counts: ' + ', '.join(f'{k} {v}' for k, v in counts.items()))
    if s.get('incomplete'):
        print('incomplete: ' + ', '.join(s['incomplete']))
    for b in s.get('blocked', []):
        print(f'blocked {b["id"]}: {b["why"]}')
    for c in cl['changes']:
        if c['action'] == 'ASK':
            print(f'ASK {c["id"]} {c["file"]}:{c.get("start")}-{c.get("end")}: {c.get("problem", "")[:200]}')
            for i, o in enumerate(c.get('options') or []):
                print(f'  [{i}] {o.get("label", "")}')
    second = set(s.get('rejected_by_second_opinion', []))
    for r in cl['rejected']:
        tag = ' (second opinion)' if r['id'] in second else ''
        print(f'rejected {r["id"]} by {r.get("by")}{tag}: {r.get("reason", "")[:200]}')
    unverified = [c['id'] for c in cl['changes'] if c.get('verdict') == 'UNVERIFIED']
    if unverified:
        print('unverified: ' + ', '.join(unverified))


def cmd_show(args):
    cl = load_changelist(args.changelist)
    rows = {c['id']: c for c in cl['changes']}
    rows.update({r['id']: r for r in cl['rejected']})
    for i in args.ids:
        print(json.dumps(rows.get(i, {'id': i, 'missing': True}), ensure_ascii=True, indent=1))


def gather(args):
    cl = load_changelist(args.changelist)
    dec, texts = load_decisions(args.plan)
    rows, refusals = resolve(cl, dec, texts)
    return cl, dec, rows, refusals


def touched(rows, cl, dec):
    """Every file the rows read or write, plus the history file when anything lands there."""
    files = set()
    history = (cl['run'].get('history') or {}).get('file')
    for r in rows:
        if r.get('file') and (r.get('action') != 'ADD' or r.get('start')):
            files.add(r['file'])
        if r.get('action') in ('MOVE', 'ADD') and isinstance(r.get('destination'), dict) and r['destination'].get('file'):
            files.add(r['destination']['file'])
    if history and dec.get('history_entry'):
        files.add(history)
    return sorted(files)


def report(refusals, restores, warnings):
    for rid, reason, detail in refusals:
        print(f'{rid}: {reason} ({detail})')
    for rid, field, what in restores:
        print(f'restore {rid}: {field} {what}')
    for rid, what in warnings:
        print(f'warn {rid}: {what}')
    print(f'{len(refusals)} refusals, {len(restores)} restores, {len(warnings)} warnings')


def reader(root):
    def read(file):
        return read_doc(live_path(root, file))
    return read


def cmd_check(args):
    try:
        cl, dec, rows, refusals = gather(args)
    except Refused as e:
        print(f'decisions: {e}')
        return 1
    more, restores, warnings, ops = validate(rows, docs_map(cl), reader(args.root), cl['run'])
    refusals += more
    if args.table:
        for c in cl['changes']:
            print(f'{c["id"]} | {c["file"]}:{c.get("start", "")}-{c.get("end", "")} | {c["action"]} | {c.get("category", "")} | {c.get("problem", "")[:TABLE_PROBLEM]}')
    report(refusals, restores, warnings)
    return 1 if refusals else 0


def cmd_apply(args):
    work = args.work
    os.makedirs(work, exist_ok=True)
    shutil.copyfile(args.changelist, os.path.join(work, 'changelist.json'))
    try:
        cl, dec, rows, refusals = gather(args)
    except Refused as e:
        print(f'decisions: {e}')
        return 1
    files = touched(rows, cl, dec)
    before_dir = os.path.join(work, 'before')
    before = {}
    for f in files:
        live = live_path(args.root, f)
        copy = os.path.join(before_dir, rel_of(f))
        if os.path.exists(live):
            if os.path.exists(copy):
                if not same_bytes(copy, live):
                    refusals.append((f, 'file', f'{copy} differs from the live file; use a fresh --work'))
                    continue
            else:
                os.makedirs(os.path.dirname(copy), exist_ok=True)
                shutil.copyfile(live, copy)
            before[f] = copy
        else:
            before[f] = None

    def read_before(file):
        p = before.get(file)
        return read_doc(p) if p else (None if file in before else read_doc(live_path(args.root, file)))

    more, restores, warnings, ops = validate(rows, docs_map(cl), read_before, cl['run'])
    refusals += more
    if refusals:
        report(refusals, restores, warnings)
        return 1
    try:
        changed = apply_ops(ops, read_before, cl['run'], dec.get('history_entry', []))
    except Refused as e:
        print(f'history: {e}')
        return 1
    out_dir = os.path.join(work, 'out')
    diff, out = [], {}
    for f, doc in changed.items():
        path = os.path.join(out_dir, rel_of(f))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = render(doc)
        with open(path, 'wb') as fh:
            fh.write(data)
        out[f] = path
        old = read_before(f)
        diff += difflib.unified_diff(old['lines'] if old else [], doc['lines'], f'before/{f}', f'out/{f}', lineterm='')
    with open(os.path.join(work, 'changes.diff'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('\n'.join(diff) + '\n')
    keep = dec.get('keep_before') or os.path.join('~', '.claude', 'audit-backups', repo_key(args.root), cl['run'].get('date', 'undated'))
    applied = {'run': cl['run'], 'docs': cl['docs'], 'rows': rows, 'root': os.path.abspath(args.root), 'keep_before': keep,
               'files': {f: {'live': live_path(args.root, f), 'before': before.get(f), 'out': out[f]} for f in out}}
    with open(os.path.join(work, 'applied.json'), 'w', encoding='utf-8') as fh:
        json.dump(applied, fh, ensure_ascii=True, indent=1)
    report([], restores, warnings)
    print(f'wrote {len(out)} files to {out_dir}; review {os.path.join(work, "changes.diff")}')
    return 0


def cmd_install(args):
    with open(os.path.join(args.work, 'applied.json'), encoding='utf-8') as fh:
        applied = json.load(fh)
    files = applied['files']
    for f, p in files.items():
        live = p['live']
        if p['before'] is None:
            if os.path.exists(live):
                print(f'{f}: refused, it exists now but did not at apply')
                return 1
        elif not os.path.exists(live) or not same_bytes(live, p['before']):
            print(f'{f}: refused, the live file changed since apply')
            return 1
    keep = os.path.expanduser(applied['keep_before'])
    base, n = keep, 1
    while True:
        clash = False
        for f, p in files.items():
            if p['before'] is None:
                continue
            target = os.path.join(keep, rel_of(f) + '.before')
            if os.path.exists(target) and not same_bytes(target, p['before']):
                clash = True
                break
        if not clash:
            break
        n += 1
        keep = f'{base}-{n}'
    for f, p in files.items():
        if p['before'] is None:
            continue
        target = os.path.join(keep, rel_of(f) + '.before')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(p['before'], target)
        if not same_bytes(target, p['before']):
            print(f'{f}: refused, the kept copy did not verify')
            return 1
    for f, p in files.items():
        os.makedirs(os.path.dirname(os.path.abspath(p['live'])), exist_ok=True)
        shutil.copyfile(p['out'], p['live'])
        print(f'changed {f}')
    print(f'kept before copies in {keep}')
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description='Validate, apply and install an audit-docs changelist.')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('summary')
    s.add_argument('changelist')
    s = sub.add_parser('show')
    s.add_argument('changelist')
    s.add_argument('ids', nargs='+')
    for name in ('check', 'apply'):
        s = sub.add_parser(name)
        s.add_argument('changelist')
        s.add_argument('--plan', required=True)
        s.add_argument('--root', required=True)
        if name == 'check':
            s.add_argument('--table', action='store_true')
        else:
            s.add_argument('--work', required=True)
    s = sub.add_parser('install')
    s.add_argument('--work', required=True)
    args = p.parse_args(argv)
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    return {'summary': cmd_summary, 'show': cmd_show, 'check': cmd_check, 'apply': cmd_apply, 'install': cmd_install}[args.cmd](args) or 0


if __name__ == '__main__':
    sys.exit(main())
