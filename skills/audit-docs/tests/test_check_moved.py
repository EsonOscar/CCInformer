"""Tests for check_moved_text.py: per-row drop lists, unexplained lines, the history refusal, line splitting."""
import contextlib
import io
import os
import unittest

from fixtures import LF, LS, apply, row, setup

import check_moved_text

DOC = LF.join([
    '# Doc',
    '',
    'Keep the `alpha` token and the 42 ms figure.',
    'The `beta` rule goes away with this edit, on purpose.',
    'The `gamma` rule moves into the history file whole.',
    'A line with a `delta` token that a delete removes.',
    'The `epsilon` stamp (since 2026-10-01) is stripped.',
    'A source line with `zeta` that an ADD rewrites.',
    'A plain line with `kappa` that nothing touches.',
]) + LF
DOCS = [{'file': 'a.md', 'kind': 'current', 'tracked': True}, {'file': 'h.md', 'kind': 'history', 'tracked': False}]
HISTORY = {'file': 'h.md', 'heading': '## 2026-11-02: docs audit'}


def first(n):
    return DOC.split(LF)[n - 1][:30]


def run(argv):
    out = io.StringIO()
    code = 0
    with contextlib.redirect_stdout(out):
        try:
            check_moved_text.main(argv)
        except SystemExit as e:
            code = e.code
    return code, out.getvalue()


class MovedText(unittest.TestCase):
    def setUp(self):
        rows = [
            row('a-1', start=4, end=4, first_line=first(4), new_text='The rule changed.'),
            row('a-2', action='MOVE', start=5, end=5, first_line=first(5), destination={'file': 'h.md', 'section': 'Gamma'}),
            row('a-3', action='DELETE', start=6, end=6, first_line=first(6)),
            row('a-4', action='MOVE', start=7, end=7, first_line=first(7), strip=['(since 2026-10-01) '], destination={'file': 'h.md', 'section': 'Epsilon'}),
            row('a-5', action='ADD', start=8, end=8, first_line=first(8), destination={'file': 'a.md', 'section': None}, new_text='Rewritten without the token.'),
            row('a-6', action='MOVE', start=8, end=8, first_line=first(8), destination={'file': 'h.md', 'section': 'Zeta'}),
        ]
        root, cl, plan, work = setup({'a.md': DOC}, rows, docs=DOCS, history=HISTORY)
        code, out = apply(root, cl, plan, work)
        self.assertEqual(code, 0, out)
        self.work = work
        self.applied = os.path.join(work, 'applied.json')
        self.before = os.path.join(work, 'before', 'a.md')
        self.after = os.path.join(work, 'out', 'a.md')

    def test_rows_get_their_drops(self):
        code, out = run(['--changelist', self.applied, self.before, self.after])
        self.assertIn('edit a-1 drops: beta', out)
        self.assertIn('move a-2 takes last copy of: gamma', out)
        self.assertIn('delete a-3 drops: delta', out)
        self.assertIn('move a-4 strips: (since 2026-10-01) ', out)
        self.assertIn('add a-5 drops: zeta', out)
        self.assertIn('move a-6 takes last copy of: zeta', out)
        self.assertIn('0 tokens and 0 sentences', out)

    def test_unexplained_lines(self):
        with open(self.after, 'rb') as f:
            data = f.read()
        with open(self.after, 'wb') as f:
            f.write(data.replace(b'`kappa`', b'something else'))
        code, out = run(['--changelist', self.applied, self.before, self.after])
        self.assertIn('token 9: kappa', out)

    def test_history_refused_as_after(self):
        code, out = run(['--changelist', self.applied, self.before, self.after, os.path.join(self.work, 'out', 'h.md')])
        self.assertNotEqual(code, 0)

    def test_without_changelist_as_before(self):
        code, out = run([self.before, self.after])
        self.assertIn('unexplained', out)
        self.assertIn('token 4: beta', out)


class Splitting(unittest.TestCase):
    def test_line_separator_does_not_split(self):
        root, cl, plan, work = setup({'a.md': 'one ' + LS + ' two' + LF + 'The `omega` line.' + LF, 'b.md': 'nothing' + LF}, [])
        code, out = run([os.path.join(root, 'a.md'), os.path.join(root, 'b.md')])
        self.assertIn('token 2: omega', out)


if __name__ == '__main__':
    unittest.main()
