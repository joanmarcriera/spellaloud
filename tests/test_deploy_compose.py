"""Guards deploy/compose.yaml (SEC-1 deployment side): the published port must not be reachable from the LAN
without the shared secret. The in-container bind stays 0.0.0.0 (the port map needs it), so the exposure is decided
by the `ports:` entry and by SPELLING_AUTH_TOKEN. The file is read as text (no YAML dependency).
Run: python3 -m unittest discover -s tests"""
import pathlib, re, unittest

COMPOSE = (pathlib.Path(__file__).resolve().parent.parent / "deploy" / "compose.yaml").read_text()
# Active lines only: a commented-out example must not satisfy (or break) a guard.
ACTIVE = "\n".join(l for l in COMPOSE.splitlines() if not l.lstrip().startswith("#"))


class ComposeExposure(unittest.TestCase):
    def test_published_port_is_bound_to_loopback(self):
        ports = re.findall(r"^\s*-\s*\"?([\d.]+:\d+:\d+)\"?\s*$", ACTIVE, re.M)
        self.assertTrue(ports, "compose must publish the port with an explicit host address")
        for p in ports:
            self.assertTrue(p.startswith("127.0.0.1:"), f"port {p!r} must publish on 127.0.0.1 only")

    def test_no_bare_port_mapping(self):
        """`- "30320:8080"` publishes on every interface (0.0.0.0): any LAN client reaches the service."""
        self.assertIsNone(re.search(r"^\s*-\s*\"?\d+:\d+\"?\s*$", ACTIVE, re.M))

    def test_auth_token_is_passed_from_the_environment_and_required(self):
        m = re.search(r"^\s*SPELLING_AUTH_TOKEN:\s*(.+?)\s*$", ACTIVE, re.M)
        self.assertIsNotNone(m, "compose must set SPELLING_AUTH_TOKEN (uncommented)")
        # ${VAR:?msg} makes `docker compose up` fail when unset, so the deploy cannot silently run without the secret.
        self.assertRegex(m.group(1), r"^\"?\$\{SPELLING_AUTH_TOKEN:\?[^}]+\}\"?$")


if __name__ == "__main__":
    unittest.main()
