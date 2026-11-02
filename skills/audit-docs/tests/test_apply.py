"""Tests for apply_changes.py: every refusal, restore and warning, byte-exact round trips, moves, adds, history, install.

Run from the skill folder: python -B -m unittest discover -s tests
"""
import os
import re
import shutil
import unittest
from unittest import mock

from fixtures import BS, CR, EM, LF, LS, SKILL, apply, apply_changes, check, out_bytes, read, row, run, setup

DOC = LF.join([
    '# Doc',
    '',
    '## Rules',
    '',
    'The first rule says something long enough to anchor.',
    'The second rule (since 2026-10-27) is also long enough.',
    'A third line that is plain.',
    '',
    '## Old',
    '',
    'Old text that moves to history, line one.',
    'Old text that moves to history, line two.',
    '',
    '## End',
    '',
    'Last line of the doc.',
]) + LF


def lines_of(text):
    return text.split(LF)


def anchor(n, doc=DOC):
    return lines_of(doc)[n - 1][:30]


def edit(rid, n, new_text, **kw):
    return row(rid, start=n, end=n, first_line=anchor(n), new_text=new_text, **kw)


class Refusals(unittest.TestCase):
    def refused(self, changes, reason, decisions=None, docs=None, files=None, history=None, texts=None, raw=None):
        root, cl, plan, work = setup(files or {'a.md': DOC}, changes, decisions, texts, docs, history, raw_decisions=raw)
        code, out = check(root, cl, plan)
        self.assertEqual(code, 1, out)
        self.assertRegex(out, rf': {reason} \(', out)
        code, out = apply(root, cl, plan, work)
        self.assertEqual(code, 1)
        self.assertFalse(os.path.exists(os.path.join(work, 'out')), 'no output on a refusal')
        return out

    def test_range(self):
        out = self.refused([row('a-1', start=5, end=5, first_line='Something else entirely here', new_text='x')], 'range')
        self.refused([row('a-1', start=6, end=6, first_line=anchor(5), new_text='x')], 'range')
        self.assertNotIn('matches line', out)

    def test_range_hint_near(self):
        root, cl, plan, work = setup({'a.md': DOC}, [row('a-1', start=7, end=7, first_line=anchor(5), new_text='x')])
        code, out = check(root, cl, plan)
        self.assertIn('first_line matches line 5', out)

    def test_short_anchor(self):
        self.refused([row('a-1', start=5, end=5, first_line='The first', new_text='x')], 'range')

    def test_anchor_blank_pair(self):
        self.refused([row('a-1', action='DELETE', start=8, end=13, first_line='', last_line='')], 'field')
        doc = LF.join(['a', '', 'b', '---', 'c']) + LF
        self.refused([row('a-1', action='DELETE', start=2, end=4, first_line=' ', last_line='---')], 'anchor', files={'a.md': doc})

    def test_quote_missing_and_twice(self):
        self.refused([edit('a-1', 5, 'y', quote='not on the line')], 'quote')
        self.refused([edit('a-1', 6, 'y', quote='o')], 'quote')

    def test_instruction(self):
        for text in ['(delete the sentence)', '[Remove this line]', 'see finding head-3', 'moved [lines 3-9]', '(slet saetningen)']:
            self.refused([edit('a-1', 5, text)], 'instruction')

    def test_instruction_allows_see_and_links(self):
        for text in ['(see Rules)', '[README](README.md)']:
            root, cl, plan, work = setup({'a.md': DOC}, [edit('a-1', 5, text)])
            code, out = check(root, cl, plan)
            self.assertEqual(code, 0, out)

    def test_instruction_exempts_user_rows(self):
        root, cl, plan, work = setup({'a.md': DOC}, [], {'rows': [edit('user-1', 5, '(Keep this line as it is.)')]})
        self.assertEqual(check(root, cl, plan)[0], 0)

    def test_repeat(self):
        self.refused([edit('a-1', 6, 'The second rule is also', quote='(since 2026-10-27) is also')], 'repeat')
        self.refused([edit('a-1', 6, 'rule is also long enough.', quote='rule (since 2026-10-27)')], 'repeat')

    def test_overlap_and_disjoint_quotes(self):
        self.refused([row('a-1', start=5, end=6, first_line=anchor(5), last_line=anchor(6), new_text='x'), edit('a-2', 6, 'y')], 'overlap')
        root, cl, plan, work = setup({'a.md': DOC}, [edit('a-1', 6, 'rule', quote='second rule'), edit('a-2', 6, 'big', quote='long enough')])
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        self.assertIn(b'The rule (since 2026-10-27) is also big.', out_bytes(work, 'a.md'))

    def test_noop(self):
        self.refused([edit('a-1', 7, 'A third line that is plain.')], 'noop')

    def test_ask_and_unverified(self):
        self.refused([row('a-1', action='ASK', start=5, end=5, first_line=anchor(5), options=[{'label': 'leave'}])], 'ask')
        self.refused([edit('a-1', 5, 'x', verdict='UNVERIFIED')], 'unverified')
        root, cl, plan, work = setup({'a.md': DOC}, [edit('a-1', 5, 'x', verdict='UNVERIFIED')], {'picks': {'a-1': 'accept'}})
        self.assertEqual(check(root, cl, plan)[0], 0)

    def test_kind(self):
        docs = [{'file': 'a.md', 'kind': 'record', 'tracked': True}, {'file': 'h.md', 'kind': 'history', 'tracked': False}]
        move = row('a-1', action='MOVE', start=11, end=12, first_line=anchor(11), last_line=anchor(12), destination={'file': 'h.md', 'section': 'Old'})
        self.refused([move], 'kind', docs=docs, history={'file': 'h.md', 'heading': '## 2026-11-02: docs audit'})
        self.refused([edit('a-1', 5, 'x')], 'kind', docs=[{'file': 'a.md', 'kind': 'generated', 'tracked': True}])
        docs = [{'file': 'a.md', 'kind': 'current', 'tracked': True}, {'file': 'r.md', 'kind': 'record', 'tracked': True}]
        add = row('a-1', action='ADD', destination={'file': 'r.md', 'section': None}, new_text='a rule')
        self.refused([add], 'kind', docs=docs, files={'a.md': DOC, 'r.md': 'x' + LF})

    def test_destination(self):
        self.refused([row('a-1', action='ADD', destination={'file': 'a.md', 'section': '## Missing'}, new_text='t')], 'destination')
        self.refused([row('a-1', action='ADD', destination={'file': 'a.md', 'section': '## Rules', 'after': 'No such line here at all'}, new_text='t')], 'destination')
        rows = [row('a-1', action='DELETE', start=11, end=12, first_line=anchor(11), last_line=anchor(12)),
                row('a-2', action='ADD', destination={'file': 'a.md', 'section': '## Old', 'after': anchor(11)}, new_text='t')]
        self.refused(rows, 'destination')

    def test_strip(self):
        hist = {'file': 'h.md', 'heading': '## 2026-11-02: docs audit'}
        docs = [{'file': 'a.md', 'kind': 'current', 'tracked': True}, {'file': 'h.md', 'kind': 'history', 'tracked': False}]
        move = row('a-1', action='MOVE', start=6, end=6, first_line=anchor(6), strip=['(not there)'], destination={'file': 'h.md', 'section': 'x'})
        self.refused([move], 'strip', docs=docs, history=hist)

    def test_field(self):
        self.refused([row('a-1', action='MOVE', start=11, end=11, first_line=anchor(11), new_text='moved', destination={'file': 'a.md', 'section': None})], 'field')
        self.refused([edit('a-1', 5, '')], 'field')
        self.refused([row('a-1', start=5, end=5, first_line=anchor(5))], 'field')

    def test_scope(self):
        self.refused([edit('a-1', 1, 'x', file='other.md')], 'scope', files={'a.md': DOC, 'other.md': DOC})
        self.refused([edit('a-1', 1, 'x', file='~/somewhere.md')], 'scope')

    def test_escape(self):
        raw = '{"rows": [{"id": "user-1", "new_text": "a ' + BS + 'u2014 b"}]}'
        root, cl, plan, work = setup({'a.md': DOC}, [], raw_decisions=raw)
        code, out = check(root, cl, plan)
        self.assertEqual(code, 1)
        self.assertIn('escape', out)

    def test_file(self):
        self.refused([edit('a-1', 1, 'x')], 'file', files={'a.md': b'one\r\ntwo\nthree\n'})
        self.refused([edit('a-1', 1, 'x')], 'file', files={'a.md': b'\xff\xfe bad bytes\n'})


class Restores(unittest.TestCase):
    def test_tag_in_new_text_and_anchor(self):
        doc = LF.join(['Intro line of the document here.', 'The `<task-notification>` prompt ends a task.', 'end']) + LF
        neutral = '<' + BS + 'task-notification>'
        rows = [row('a-1', start=2, end=2, first_line='The `' + neutral + '` prompt', new_text='The `' + neutral + '` prompt ends a background task.')]
        root, cl, plan, work = setup({'a.md': doc}, rows)
        code, out = check(root, cl, plan)
        self.assertEqual(code, 0, out)
        self.assertIn('restore a-1: first_line', out)
        self.assertIn('restore a-1: new_text', out)
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        self.assertIn(b'The `<task-notification>` prompt ends a background task.', out_bytes(work, 'a.md'))

    def test_tag_kept_when_the_file_has_it(self):
        neutral = '<' + BS + 'tag>'
        doc = LF.join(['A line that documents the ' + neutral + ' form itself.', 'end']) + LF
        root, cl, plan, work = setup({'a.md': doc}, [row('a-1', start=1, end=1, first_line='A line that documents', new_text='Documents the ' + neutral + ' form.')])
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        self.assertIn(neutral.encode(), out_bytes(work, 'a.md'))

    def test_decoded_escape(self):
        esc = BS + 'u2014'
        doc = LF.join(['Dashes are written as `' + esc + '` escapes in fixtures.', 'end']) + LF
        root, cl, plan, work = setup({'a.md': doc}, [row('a-1', start=1, end=1, first_line='Dashes are written as', new_text='Dashes are always written as `' + EM + '` escapes in fixtures.')])
        code, out = check(root, cl, plan)
        self.assertIn('restore a-1: new_text', out)
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        data = out_bytes(work, 'a.md')
        self.assertIn(('always written as `' + esc + '`').encode(), data)
        self.assertNotIn(EM.encode(), data)


class Warnings(unittest.TestCase):
    def test_dash_and_backticks(self):
        root, cl, plan, work = setup({'a.md': DOC}, [edit('a-1', 5, 'A rule ' + EM + ' with a dash.'), edit('a-2', 7, 'An `odd backtick line.')])
        code, out = check(root, cl, plan)
        self.assertEqual(code, 0, out)
        self.assertIn('warn a-1', out)
        self.assertIn('warn a-2: a new_text line has an odd number of backticks', out)


class RoundTrips(unittest.TestCase):
    def roundtrip(self, raw, n, new_line, old_line):
        root, cl, plan, work = setup({'a.md': raw}, [row('a-1', start=n, end=n, first_line=old_line[:25], new_text=new_line)])
        code, out = apply(root, cl, plan, work)
        self.assertEqual(code, 0, out)
        self.assertEqual(out_bytes(work, 'a.md'), raw.replace(old_line.encode('utf-8'), new_line.encode('utf-8'), 1))

    def test_crlf(self):
        self.roundtrip(b'first line of the file here\r\nsecond line of the file here\r\nthird\r\n', 2, 'second line, changed', 'second line of the file here')

    def test_bom(self):
        self.roundtrip(b'\xef\xbb\xbffirst line of the file here\nsecond line of the file here\n', 1, 'first line, changed', 'first line of the file here')

    def test_no_final_newline(self):
        self.roundtrip(b'first line of the file here\nsecond line of the file here', 2, 'second line, changed', 'second line of the file here')

    def test_unicode_line_separator_and_form_feed(self):
        raw = ('first line of the file here' + LF + 'a line with ' + LS + ' and ' + chr(12) + ' inside it' + LF + 'third line of the file here' + LF).encode('utf-8')
        self.roundtrip(raw, 3, 'third line, changed', 'third line of the file here')

    def test_literal_escapes_untouched(self):
        raw = ('first line of the file here' + LF + 'escapes: ' + BS + 'u2014 ' + BS + 'n <' + BS + 'task-notification>' + LF + 'third line of the file here' + LF).encode('utf-8')
        self.roundtrip(raw, 1, 'first line, changed', 'first line of the file here')


class Applying(unittest.TestCase):
    def test_bottom_to_top_in_before_coordinates(self):
        rows = [edit('a-1', 5, 'Rule one, changed.'), row('a-2', action='DELETE', start=11, end=12, first_line=anchor(11), last_line=anchor(12)), edit('a-3', 16, 'Last line, changed.')]
        root, cl, plan, work = setup({'a.md': DOC}, rows)
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        text = out_bytes(work, 'a.md').decode()
        self.assertIn('Rule one, changed.', text)
        self.assertIn('Last line, changed.', text)
        self.assertNotIn('Old text', text)
        self.assertNotIn(LF + LF + LF, text, 'the seam collapses to one blank line')

    def test_sub_line_delete(self):
        root, cl, plan, work = setup({'a.md': DOC}, [edit('a-1', 6, '', quote='(since 2026-10-27)')])
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        self.assertIn(b'The second rule is also long enough.', out_bytes(work, 'a.md'))

    def history_case(self, history_text=None, heading='## 2026-11-02: docs audit', **move):
        files = {'a.md': DOC}
        if history_text is not None:
            files['h.md'] = history_text
        docs = [{'file': 'a.md', 'kind': 'current', 'tracked': True}, {'file': 'h.md', 'kind': 'history', 'tracked': False}]
        m = row('a-1', action='MOVE', start=9, end=13, first_line=anchor(9), last_line='', destination={'file': 'h.md', 'section': 'From Old'}, **move)
        return setup(files, [m], {'history_entry': ['- Audited the doc.']}, docs=docs, history={'file': 'h.md', 'heading': heading})

    def test_move_to_new_history_file(self):
        root, cl, plan, work = self.history_case()
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        hist = out_bytes(work, 'h.md').decode()
        self.assertTrue(hist.startswith('# h history'))
        self.assertIn('## 2026-11-02: docs audit' + LF + LF + '- Audited the doc.' + LF + LF + '### From Old' + LF + LF + '#### Old', hist)
        self.assertIn('Old text that moves to history, line two.', hist)
        src = out_bytes(work, 'a.md').decode()
        self.assertNotIn('## Old', src)
        self.assertNotIn(LF + LF + LF, src)

    def test_history_reuses_todays_heading(self):
        existing = LF.join(['# h history', '', '## 2026-11-02: docs audit', '', '- An earlier line.']) + LF
        root, cl, plan, work = self.history_case(existing)
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        hist = out_bytes(work, 'h.md').decode()
        self.assertEqual(hist.count('## 2026-11-02: docs audit'), 1)
        self.assertIn('- An earlier line.' + LF + LF + '- Audited the doc.', hist)

    def test_history_heading_not_last_is_refused(self):
        existing = LF.join(['# h history', '', '## 2026-11-02: docs audit', '', '- x', '', '## 2026-11-03: later', '']) + LF
        root, cl, plan, work = self.history_case(existing)
        code, out = check(root, cl, plan)
        self.assertEqual(code, 1)
        self.assertIn('destination', out)

    def test_move_leave_and_strip(self):
        files = {'a.md': DOC}
        docs = [{'file': 'a.md', 'kind': 'current', 'tracked': True}, {'file': 'h.md', 'kind': 'history', 'tracked': False}]
        m = row('a-1', action='MOVE', start=6, end=6, first_line=anchor(6), leave='The second rule, see history.', strip=['(since 2026-10-27) '], destination={'file': 'h.md', 'section': 'Rule two'})
        root, cl, plan, work = setup(files, [m], docs=docs, history={'file': 'h.md', 'heading': '## 2026-11-02: docs audit'})
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        self.assertIn(b'The second rule, see history.', out_bytes(work, 'a.md'))
        self.assertIn(b'The second rule is also long enough.', out_bytes(work, 'h.md'))

    def test_add_after_create_and_section_end(self):
        doc = LF.join(['# Doc', '', '## A', '', 'a text', '', '### A sub', '', '```', '## not a heading', '```', '', 'sub text', '', '---', '', '## B', '', 'b text']) + LF
        rows = [row('a-1', action='ADD', destination={'file': 'a.md', 'section': '## A'}, new_text='added to A'),
                row('a-2', action='ADD', destination={'file': 'a.md', 'section': '## A', 'after': 'a text'}, new_text='after a text'),
                row('a-3', action='ADD', destination={'file': 'a.md', 'section': '## Learned', 'create': True}, new_text='- a gotcha')]
        root, cl, plan, work = setup({'a.md': doc}, rows)
        code, out = apply(root, cl, plan, work)
        self.assertEqual(code, 0, out)
        text = out_bytes(work, 'a.md').decode()
        self.assertIn('a text' + LF + LF + 'after a text' + LF + LF + '### A sub', text)
        self.assertIn('sub text' + LF + LF + 'added to A' + LF + LF + '---', text)
        self.assertTrue(text.endswith('## Learned' + LF + LF + '- a gotcha' + LF))

    def test_add_into_a_list_keeps_it_one_list(self):
        doc = LF.join(['# Doc', '', '## Learned', '', '- first gotcha in the list', '- second gotcha in the list', '', '## Next', '', 'text']) + LF
        rows = [row('a-1', action='ADD', destination={'file': 'a.md', 'section': '## Learned', 'after': '- first gotcha in the list'}, new_text='- added gotcha'),
                row('a-2', action='ADD', destination={'file': 'a.md', 'section': '## Learned'}, new_text='- last gotcha')]
        root, cl, plan, work = setup({'a.md': doc}, rows)
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        self.assertIn(LF.join(['- first gotcha in the list', '- added gotcha', '- second gotcha in the list', '- last gotcha', '', '## Next']), out_bytes(work, 'a.md').decode())

    def test_audit_text_block_with_bs(self):
        texts = {'dash': 'Write dashes as `{BS}u2014` escapes.'}
        root, cl, plan, work = setup({'a.md': DOC}, [], {'rows': [dict(edit('user-1', 7, ''), text='dash')]}, texts)
        code, out = apply(root, cl, plan, work)
        self.assertEqual(code, 0, out)
        self.assertIn(('Write dashes as `' + BS + 'u2014` escapes.').encode(), out_bytes(work, 'a.md'))

    def test_ask_pick_and_restore(self):
        ask = row('a-1', action='ASK', start=5, end=5, first_line=anchor(5), options=[{'label': 'edit', 'action': 'EDIT', 'new_text': 'Picked text.'}, {'label': 'leave'}])
        rejected = [{'id': 'a-2', 'by': 'keep', 'reason': 'r', 'original': edit('a-2', 7, 'Restored text.')}]
        root, cl, plan, work = setup({'a.md': DOC}, [ask], {'picks': {'a-1': 0}, 'restore': [{'id': 'a-2', 'version': 'original'}]}, rejected=rejected)
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        text = out_bytes(work, 'a.md').decode()
        self.assertIn('Picked text.', text)
        self.assertIn('Restored text.', text)


class Install(unittest.TestCase):
    def prepared(self):
        root, cl, plan, work = setup({'a.md': DOC}, [edit('a-1', 5, 'Rule one, changed.')], {'keep_before': None})
        keep = os.path.join(os.path.dirname(work), 'keep')
        with open(plan, 'w', encoding='utf-8') as f:
            f.write('```audit-decisions' + LF + '{"keep_before": "' + keep.replace(BS, '/') + '"}' + LF + '```' + LF)
        self.assertEqual(apply(root, cl, plan, work)[0], 0)
        return root, work, keep

    def test_install_keeps_before_then_writes(self):
        root, work, keep = self.prepared()
        code, out = run(['install', '--work', work])
        self.assertEqual(code, 0, out)
        self.assertEqual(read(root, 'a.md'), out_bytes(work, 'a.md'))
        with open(os.path.join(keep, 'a.md.before'), 'rb') as f:
            self.assertEqual(f.read(), DOC.encode())

    def test_install_refuses_a_changed_target(self):
        root, work, keep = self.prepared()
        with open(os.path.join(root, 'a.md'), 'ab') as f:
            f.write(b'edited meanwhile' + LF.encode())
        code, out = run(['install', '--work', work])
        self.assertEqual(code, 1)
        self.assertIn('changed since apply', out)
        self.assertFalse(os.path.exists(keep))

    def test_keep_is_written_before_the_live_file(self):
        root, work, keep = self.prepared()
        real = shutil.copyfile

        def copy(src, dst, *a, **k):
            if os.path.abspath(dst) == os.path.abspath(os.path.join(root, 'a.md')):
                self.assertTrue(os.path.exists(os.path.join(keep, 'a.md.before')), 'keep_before exists before the live write')
            return real(src, dst, *a, **k)
        with mock.patch('apply_changes.shutil.copyfile', side_effect=copy):
            self.assertEqual(run(['install', '--work', work])[0], 0)

    def test_second_install_keeps_both_copies(self):
        root, work, keep = self.prepared()
        os.makedirs(keep)
        with open(os.path.join(keep, 'a.md.before'), 'wb') as f:
            f.write(b'an earlier copy')
        self.assertEqual(run(['install', '--work', work])[0], 0)
        self.assertTrue(os.path.exists(keep + '-2' + os.sep + 'a.md.before'))


class Commands(unittest.TestCase):
    def test_show_prints_escapes(self):
        root, cl, plan, work = setup({'a.md': DOC}, [edit('a-1', 5, 'dash ' + EM + ' here')])
        code, out = run(['show', cl, 'a-1'])
        self.assertIn(BS + 'u2014', out)

    def test_summary_numbers_options(self):
        ask = row('a-1', action='ASK', start=5, end=5, first_line=anchor(5), options=[{'label': 'first'}, {'label': 'second'}])
        root, cl, plan, work = setup({'a.md': DOC}, [ask])
        code, out = run(['summary', cl])
        self.assertIn('[0] first', out)
        self.assertIn('[1] second', out)


class Contract(unittest.TestCase):
    def test_lists_match_the_workflow_script(self):
        with open(os.path.join(SKILL, 'audit-docs-fanout.js'), encoding='utf-8') as f:
            js = f.read()
        for name in ('KINDS', 'ACTIONS', 'CATEGORIES'):
            m = re.search(rf'const {name} = \[([^\]]*)\]', js)
            self.assertIsNotNone(m, name)
            self.assertEqual(re.findall(r"'([^']+)'", m.group(1)), getattr(apply_changes, name), name)

    def test_sources_hold_no_em_dash(self):
        for name in ('apply_changes.py', 'check_moved_text.py', 'audit-docs-fanout.js', 'SKILL.md'):
            with open(os.path.join(SKILL, name), encoding='utf-8') as f:
                self.assertNotIn(EM, f.read(), name)


if __name__ == '__main__':
    unittest.main()
