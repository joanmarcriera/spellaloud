"""Tests for bin/monthly-numbers (Vikunja #5574). Fixtures in tests/fixtures/monthly/ use invented addresses only.

Run: python3 -m unittest discover -s tests -v
"""
import importlib.machinery
import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "monthly"
SCRIPT = ROOT / "bin" / "monthly-numbers"

loader = importlib.machinery.SourceFileLoader("monthly_numbers", str(SCRIPT))
spec = importlib.util.spec_from_loader("monthly_numbers", loader)
mn = importlib.util.module_from_spec(spec)
loader.exec_module(mn)

CONTACTS, ORDERS, SUPPORT, EXCLUDE = (FIX / n for n in ("contacts.csv", "orders.csv", "support.csv", "exclude.txt"))


def run(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True, timeout=30)


class Signups(unittest.TestCase):
    def test_duplicates_count_once_case_insensitively_and_returning_contacts_are_not_new(self):
        total, by_source = mn.signups(mn.rows(CONTACTS), "2026-11", set())
        # ann (twice, different case), bob, cat, dan, family, test1 = 6; old@ was first seen in October
        self.assertEqual(total, 6)
        self.assertEqual(by_source["reddit"], 4)
        self.assertEqual(by_source["mumsnet"], 1)
        self.assertEqual(by_source["(none)"], 1)

    def test_an_excluded_address_and_an_excluded_domain_are_dropped(self):
        total, by_source = mn.signups(mn.rows(CONTACTS), "2026-11", mn.load_exclude(EXCLUDE))
        self.assertEqual(total, 4)
        self.assertEqual(by_source["reddit"], 2)

    def test_other_month_is_independent(self):
        total, _ = mn.signups(mn.rows(CONTACTS), "2026-10", set())
        self.assertEqual(total, 1)  # old@ first appears 2026-10-30


class Orders(unittest.TestCase):
    def test_a_refunded_order_is_not_in_net_orders_and_a_repeated_id_counts_once(self):
        net, refunded = mn.orders(mn.rows(ORDERS), "2026-11")
        self.assertEqual((net, refunded), (2, 2))  # 1001, 1002 net; 1003 (flag) and 1004 (status) refunded; 1006 failed ignored

    def test_zero_orders_prints_na_not_a_division_error(self):
        out = mn.report("2026-11", mn.rows(CONTACTS), mn.rows(FIX / "orders-none.csv"), mn.rows(SUPPORT), set())
        lines = out.splitlines()
        self.assertIn("refund rate: n/a", lines[1])
        self.assertTrue(lines[2].endswith("support minutes per net paid order: n/a"))


class Support(unittest.TestCase):
    def test_minutes_per_net_order(self):
        self.assertEqual(mn.support_minutes(mn.rows(SUPPORT), "2026-11"), 20)
        out = mn.report("2026-11", [], mn.rows(ORDERS), mn.rows(SUPPORT), set())
        self.assertIn("support minutes per net paid order: 10.0", out)
        self.assertIn("refund rate: 50.0%", out)

    def test_no_support_file_is_na(self):
        self.assertIn("order: n/a", mn.report("2026-11", [], mn.rows(ORDERS), None, set()).splitlines()[2])


class Cli(unittest.TestCase):
    def test_three_lines_then_the_per_source_table(self):
        r = run("2026-11", "--contacts", CONTACTS, "--orders", ORDERS, "--support", SUPPORT, "--exclude", EXCLUDE)
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.splitlines()
        self.assertEqual(lines[0], "2026-11 new unique sign-ups: 4")
        self.assertEqual(lines[1], "2026-11 net paid orders: 2, refunded: 2, refund rate: 50.0%")
        self.assertEqual(lines[2], "2026-11 support minutes per net paid order: 10.0")
        self.assertEqual(lines[3], "")
        self.assertEqual(lines[4], "source\tsign-ups")
        self.assertEqual(lines[5:], ["reddit\t2", "(none)\t1", "mumsnet\t1"])

    def test_bad_month_and_missing_file_exit_2(self):
        self.assertEqual(run("2026-13", "--contacts", CONTACTS, "--orders", ORDERS).returncode, 2)
        self.assertEqual(run("2026-11", "--contacts", FIX / "nope.csv", "--orders", ORDERS).returncode, 2)

    def test_fixtures_contain_only_invented_addresses(self):
        for f in FIX.glob("*.csv"):
            for line in f.read_text().splitlines()[1:]:
                if "@" in line.split(",")[0]:
                    self.assertRegex(line.split(",")[0].lower(), r"@([a-z0-9.]+\.)?example\.invalid$", line)


if __name__ == "__main__":
    unittest.main()
