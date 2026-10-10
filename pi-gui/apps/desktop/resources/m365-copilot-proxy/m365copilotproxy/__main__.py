from __future__ import annotations

import argparse
import os
import sys
from http.server import ThreadingHTTPServer

from .auth import AuthenticationError, login
from .server import APPLICATION, ProxyHandler


def main() -> int:
    if sys.version_info < (3, 14):
        print("Python 3.14 or newer is required", file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser(prog="m365copilotproxy")
    parser.add_argument("command", nargs="?", choices=("serve", "login", "e2e"), default="serve")
    parser.add_argument("--port", type=int, default=int(os.environ.get("M365_PROXY_PORT", "4141")))
    args = parser.parse_args()
    if args.command == "login":
        try:
            print(f"Signed in as {login()}")
            return 0
        except AuthenticationError as exc:
            print(f"Microsoft sign-in failed: {exc}", file=sys.stderr)
            return 1
    if args.command == "e2e":
        from .e2e import main as run_e2e
        return run_e2e()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), ProxyHandler)
    print(f"M365 OpenAI proxy listening at http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        APPLICATION.clear()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
