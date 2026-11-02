"""Builds test fixtures in temp folders. Special characters come from chr(), so no escape is ever typed."""
import contextlib
import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
sys.path.insert(0, SKILL)

import apply_changes  # noqa: E402

BS = chr(92)
CR = chr(13)
LF = chr(10)
EM = chr(0x2014)
LS = chr(0x2028)
DATE = '2026-11-02'


def make_root(files):
    root = tempfile.mkdtemp(prefix='audit-root-')
    for rel, data in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(data if isinstance(data, bytes) else data.encode('utf-8'))
    return root


def read(root, rel):
    with open(os.path.join(root, rel), 'rb') as f:
        return f.read()


def row(rid, **kw):
    base = {'id': rid, 'category': 'DRIFT', 'action': 'EDIT', 'file': 'a.md', 'problem': 'p', 'evidence': [], 'verdict': 'CONFIRMED'}
    base.update(kw)
    return {k: v for k, v in base.items() if v is not None}


def write_changelist(folder, changes, docs=None, history=None, rejected=None):
    docs = docs or [{'file': 'a.md', 'kind': 'current', 'tracked': True}]
    data = {'result': {'summary': {'counts': {}}, 'run': {'date': DATE, 'root': '', 'history': history, 'agents': 0},
                       'docs': docs, 'changes': changes, 'rejected': rejected or []}}
    path = os.path.join(folder, 'changelist.output')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    return path


def write_plan(folder, decisions=None, texts=None, raw_decisions=None):
    parts = ['# Plan', '']
    if decisions is not None or raw_decisions is not None:
        body = raw_decisions if raw_decisions is not None else json.dumps(decisions, ensure_ascii=False)
        parts += ['```audit-decisions', body, '```', '']
    for name, text in (texts or {}).items():
        parts += [f'```audit-text {name}', text, '```', '']
    path = os.path.join(folder, 'plan.md')
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(LF.join(parts))
    return path


def run(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = apply_changes.main(argv)
    return code, out.getvalue()


def setup(files, changes, decisions=None, texts=None, docs=None, history=None, rejected=None, raw_decisions=None):
    root = make_root(files)
    folder = tempfile.mkdtemp(prefix='audit-case-')
    cl = write_changelist(folder, changes, docs, history, rejected)
    plan = write_plan(folder, decisions if decisions is not None else {}, texts, raw_decisions)
    work = os.path.join(folder, 'work')
    return root, cl, plan, work


def check(root, cl, plan):
    return run(['check', cl, '--plan', plan, '--root', root])


def apply(root, cl, plan, work):
    return run(['apply', cl, '--plan', plan, '--root', root, '--work', work])


def out_bytes(work, rel):
    with open(os.path.join(work, 'out', rel), 'rb') as f:
        return f.read()
