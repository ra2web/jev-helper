"""Local Laya decision server for the WannaFire extension.

Serves the same ``POST /v1/systemone`` choice protocol that the extension uses for Jev, backed
by a Laya checkpoint running on Apple silicon through MLX (the ``laya_mlx`` package from the
laya-vs-jev repository). Listens on loopback by default; ``--lan`` opens it to the local network
behind a bearer token. No game control, no outbound requests.

Run through the laya-vs-jev virtual environment, e.g. ``npm run laya`` in this repository or::

    /path/to/laya-vs-jev/.venv/bin/python tools/laya-server.py --model /path/to/checkpoint

The extension sends ``{"model", "state", "questions"}`` and expects ``{"model", "answers",
"usage"}`` back, which is exactly what ``laya_mlx.Agent.predict`` returns.
"""

import argparse
import json
import os
import secrets
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_PORT = 8742
MAX_BODY = 256_000  # matches the extension's own request bound
DEFAULT_CHECKPOINTS = ("models/hub/laya-multilingual-mlx", "models/laya-multilingual")


def compact_state(state):
    """Order state so Laya's right-side truncation drops detail before summaries.

    The extension's battlefield state is larger than Laya's context window. Scalars and short
    values (tick, credits, counts, flags) are kept first; long arrays and nested objects (unit
    lists, queues, inventory) follow in their original order, so the first tokens to be cut are
    the least important ones. Nothing is added or renamed.
    """
    if not isinstance(state, dict):
        return state
    short, long = {}, {}
    for key, value in state.items():
        target = long if isinstance(value, (list, dict)) else short
        target[key] = value
    return {**short, **long}


def validate_request(body):
    if not isinstance(body, dict):
        raise ValueError("request body must be a JSON object")
    if "state" not in body:
        raise ValueError("request is missing state")
    questions = body.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions must be a non-empty object")
    for qid, q in questions.items():
        if not isinstance(q, dict) or q.get("type") not in (None, "choice", "score", "noul"):
            raise ValueError(f"question {qid!r} has an unsupported type")
        if not isinstance(q.get("instructions"), str) or not q["instructions"]:
            raise ValueError(f"question {qid!r} is missing instructions")
    return body["state"], questions


class Service:
    """Owns the model and serializes inference; MLX is driven from one call at a time."""

    def __init__(self, predict, model_name, token=None, raw_state=False, log_path=None):
        self.predict = predict
        self.log_path = Path(log_path).expanduser() if log_path else None
        self.log_lock = threading.Lock()
        self.model_name = model_name
        self.token = token or None
        self.raw_state = raw_state
        self.lock = threading.Lock()
        self.requests = 0
        self.started = time.time()

    def authorized(self, header):
        if not self.token:
            return True
        return header == f"Bearer {self.token}"

    def decide(self, body):
        state, questions = validate_request(body)
        if not self.raw_state:
            state = compact_state(state)
        with self.lock:
            started = time.perf_counter()
            output = self.predict(state, questions)
            elapsed = (time.perf_counter() - started) * 1000
            self.requests += 1
        if self.log_path:
            self.log(state, questions, output, elapsed)
        return {
            "model": self.model_name,
            "answers": output["answers"],
            "usage": output.get("usage", {"input_tokens": 0, "output_tokens": 0}),
            "latency_ms": round(elapsed, 2),
        }

    def log(self, state, questions, output, elapsed):
        """One JSON line per decision: what was asked, what was chosen, how sure, how long."""
        record = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "latency_ms": round(elapsed, 1),
            "input_tokens": output.get("usage", {}).get("input_tokens"),
            "state_chars": len(json.dumps(state, ensure_ascii=False)),
            "state_head": {k: v for k, v in state.items() if not isinstance(v, (list, dict))} if isinstance(state, dict) else str(state)[:200],
            "questions": {
                qid: {
                    "options": list((q.get("criteria") or {}))[:64] if isinstance(q.get("criteria"), dict) else q.get("criteria"),
                    "choice": output["answers"].get(qid, {}).get("choice"),
                    "confidence": output["answers"].get(qid, {}).get("confidence"),
                    "probabilities": output["answers"].get(qid, {}).get("probabilities"),
                }
                for qid, q in questions.items()
            },
        }
        line = json.dumps(record, ensure_ascii=False) + "\n"
        with self.log_lock:
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(line)

    def health(self):
        return {
            "ok": True,
            "model": self.model_name,
            "requests": self.requests,
            "uptime_seconds": round(time.time() - self.started, 1),
            "protocol": "systemone",
            "auth": bool(self.token),
        }


def make_handler(service, quiet=False):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "laya-server/0.4"

        def log_message(self, fmt, *args):  # noqa: N802 - stdlib signature
            if not quiet:
                sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def reply(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802
            if self.path.rstrip("/") in ("", "/health", "/v1/health"):
                self.reply(200, service.health())
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            if self.path.rstrip("/") not in ("/v1/systemone", "/systemone"):
                self.reply(404, {"error": "not found; POST /v1/systemone"})
                return
            if not service.authorized(self.headers.get("Authorization")):
                self.reply(401, {"error": "invalid or missing bearer token"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY:
                self.reply(413 if length > MAX_BODY else 400, {"error": "invalid body size"})
                return
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8"))
                result = service.decide(body)
            except (ValueError, UnicodeDecodeError) as error:
                # Bad JSON, malformed questions, or too many options for Laya's token budget.
                self.reply(422, {"error": str(error)[:400]})
                return
            except Exception as error:  # model failure: report, keep serving
                self.log_message("inference failed: %s", error)
                self.reply(500, {"error": "inference failed"})
                return
            self.reply(200, result)

    return Handler


def resolve_checkpoint(value, repo):
    """A directory, or a checkpoint bundled with the laya-vs-jev repository."""
    candidates = [value] if value else [str(repo / name) for name in DEFAULT_CHECKPOINTS]
    for candidate in candidates:
        path = Path(candidate).expanduser()
        if path.is_dir():
            return path
    if value:
        raise FileNotFoundError(f"Laya checkpoint directory not found: {value}")
    raise FileNotFoundError(
        "No Laya checkpoint found. Download one into the laya-vs-jev repository first:\n"
        "  uv run --extra demo hf download aac6fef/laya-multilingual-mlx "
        "--local-dir models/hub/laya-multilingual-mlx\n"
        "or pass --model /path/to/checkpoint"
    )


def lan_addresses():
    """IPv4 addresses of this machine on private networks, for the startup banner."""
    found = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in found and not ip.startswith("127."):
                found.append(ip)
    except socket.gaierror:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("10.255.255.255", 1))
        ip = probe.getsockname()[0]
        probe.close()
        if ip not in found and not ip.startswith("127."):
            found.insert(0, ip)
    except OSError:
        pass
    return found


def load_agent(path, dtype, device):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    try:
        from laya_mlx import Agent
    except ImportError as error:
        raise SystemExit(
            "laya_mlx is not importable. Run this server with the laya-vs-jev virtual "
            "environment, e.g. `npm run laya` or "
            "`/path/to/laya-vs-jev/.venv/bin/python tools/laya-server.py`.\n"
            f"({error})"
        ) from error
    return Agent(path, dtype=dtype, device=device, batch_size=8)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", help="Laya checkpoint directory (default: laya-vs-jev models/)")
    parser.add_argument("--repo", default=os.environ.get("LAYA_REPO", ""), help="laya-vs-jev path")
    parser.add_argument("--port", type=int, default=int(os.environ.get("LAYA_PORT", DEFAULT_PORT)))
    parser.add_argument("--host", default="127.0.0.1", help="127.0.0.1 (default) or 0.0.0.0 for the LAN")
    parser.add_argument("--lan", action="store_true", help="listen on all interfaces and require a bearer token")
    parser.add_argument("--token", default=os.environ.get("LAYA_TOKEN", ""), help="bearer token; --lan generates and remembers one when omitted")
    parser.add_argument("--dtype", choices=("float16", "float32", "bfloat16"), default="float16")
    parser.add_argument("--device", choices=("gpu", "cpu"), default="gpu")
    parser.add_argument("--raw-state", action="store_true", help="send state as-is, no reordering")
    parser.add_argument("--quiet", action="store_true", help="do not log each request")
    parser.add_argument("--log", default=os.environ.get("LAYA_LOG", ""), help="append one JSON line per decision to this file")
    args = parser.parse_args(argv)
    if args.lan:
        args.host = "0.0.0.0"
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        # Anything beyond this machine must authenticate. The token is kept in the user's home so
        # it stays the same across restarts; delete the file to rotate it.
        if not args.token:
            token_file = Path.home() / ".laya-server-token"
            if token_file.is_file():
                args.token = token_file.read_text().strip()
            if not args.token:
                args.token = secrets.token_urlsafe(24)
                token_file.write_text(args.token + "\n")
                os.chmod(token_file, 0o600)

    repo = Path(args.repo).expanduser() if args.repo else Path(__file__).resolve().parents[2] / "laya-vs-jev"
    checkpoint = resolve_checkpoint(args.model, repo)
    print(f"Loading Laya checkpoint {checkpoint} ({args.dtype}, {args.device})…", flush=True)
    started = time.perf_counter()
    agent = load_agent(checkpoint, args.dtype, args.device)
    warm = agent.predict("warm-up", {"ready": {"type": "choice", "instructions": "Select ok.", "criteria": {"ok": "ready"}}})
    print(f"Model ready in {time.perf_counter() - started:.1f}s (warm-up answer: {warm['answers']['ready']['choice']})", flush=True)

    service = Service(agent.predict, checkpoint.name, token=args.token, raw_state=args.raw_state, log_path=args.log or None)
    if args.log:
        print(f"Decision log: {Path(args.log).expanduser()}", flush=True)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(service, quiet=args.quiet))
    server.daemon_threads = True
    hosts = [args.host] if args.host != "0.0.0.0" else ["127.0.0.1", *lan_addresses()]
    for host in hosts:
        print(f"Laya decision server listening on http://{host}:{args.port}/v1/systemone", flush=True)
    print("Extension setting: model source = Local Laya, local server URL = " + ", ".join(f"http://{h}:{args.port}/v1" for h in hosts), flush=True)
    if args.token:
        print(f"Extension setting: local access token = {args.token}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
