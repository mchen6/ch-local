#!/usr/bin/env python3
"""Measures ch-shim's RSS and PSS against a runtime written from contract 2.

The fake runtime does the handshake (HMAC-SHA256 with the protocol byte),
sends settled after the first client frame, and answers each request: a
small result, or for method "big" a result of BIG bytes. The shim runs from
a temp home with a private run dir, secret, daemon.json and shim.json.

usage: measure.py <shim binary> <out json>
"""
import base64, hashlib, hmac, json, os, socket, struct, subprocess, sys, tempfile, threading, time

BIG = 1 << 20
SECRET = bytes([7]) * 32


def frame(kind, payload):
    return kind.encode() + struct.pack(">I", len(payload)) + payload


def read_exact(s, n):
    out = b""
    while len(out) < n:
        b = s.recv(n - len(out))
        if not b:
            raise EOFError
        out += b
    return out


def read_frame(s):
    head = read_exact(s, 5)
    kind, n = chr(head[0]), struct.unpack(">I", head[1:])[0]
    return kind, read_exact(s, n)


def mac(label, a, b):
    return hmac.new(SECRET, label + bytes([1]) + a + b, hashlib.sha256).digest()


def serve(listener):
    s, _ = listener.accept()
    k, hello = read_frame(s)
    nc = base64.b64decode(json.loads(hello)["nc"])
    ns = os.urandom(32)
    s.sendall(frame("P", json.dumps({"ns": base64.b64encode(ns).decode(), "ms": base64.b64encode(mac(b"ch-server", nc, ns)).decode()}).encode()))
    k, auth = read_frame(s)
    assert base64.b64decode(json.loads(auth)["mc"]) == mac(b"ch-client", ns, nc)
    w = {"session": "s", "resumeToken": "rt", "runtimeVersion": "8.0.0", "maxToRuntime": 8392704, "maxToShim": 537919488}
    s.sendall(frame("W", json.dumps(w).encode()))
    while True:
        try:
            k, p = read_frame(s)
        except EOFError:
            return
        if k == "C":
            op = json.loads(p)
            if op.get("op") == "client" and "seq" not in op:
                s.sendall(frame("C", b'{"op":"settled"}'))
            if op.get("op") == "bye":
                s.close()
                return
            continue
        hn = struct.unpack(">H", p[:2])[0]
        header = json.loads(p[2:2 + hn]) if hn else {}
        line = json.loads(p[2 + hn:])
        if "seq" not in header:
            continue
        result = {"text": "x" * BIG} if line.get("method") == "big" else {}
        body = json.dumps({"jsonrpc": "2.0", "id": line["id"], "result": result}).encode()
        h = json.dumps({"seq": header["seq"]}).encode()
        s.sendall(frame("M", struct.pack(">H", len(h)) + h + body))


def mem(pid):
    out = {}
    for line in open(f"/proc/{pid}/smaps_rollup"):
        k, *rest = line.split()
        if k in ("Rss:", "Pss:"):
            out[k[:-1].lower() + "Kb"] = int(rest[0])
    for line in open(f"/proc/{pid}/status"):
        if line.startswith("VmHWM:"):
            out["hwmKb"] = int(line.split()[1])
    return out


def private(path, body):
    with open(path, "w") as f:
        f.write(body)
    os.chmod(path, 0o600)


def main():
    binary, out_path = sys.argv[1], sys.argv[2]
    home = tempfile.mkdtemp(prefix="ch-shim-mem-")
    run = os.path.join(home, "run", "daemon")
    os.makedirs(run)
    os.chmod(home, 0o700)
    os.chmod(os.path.join(home, "run"), 0o700)
    os.chmod(run, 0o700)
    sock = os.path.join(run, "s.sock")
    private(os.path.join(run, "secret"), SECRET.hex() + "\n")
    private(os.path.join(run, "daemon.json"), json.dumps({"pid": os.getpid(), "socket": sock, "runtimeVersion": "8.0.0", "daemonVersion": "0.1.0", "started": "x"}))
    script = os.path.join(home, "ch-local.sh")
    with open(script, "w") as f:
        f.write("echo '{\"status\":\"ok\",\"conditions\":\"no\",\"repo\":null,\"token\":null}'\n")
    private(os.path.join(home, "shim.json"), json.dumps({"node": "/bin/sh", "chLocal": script, "env": {"PATH": "/usr/bin:/bin"}}))
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(sock)
    listener.listen(4)
    threading.Thread(target=serve, args=(listener,), daemon=True).start()
    shim = subprocess.Popen([binary, "--home", home], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    shim.stdin.write(b'{"jsonrpc":"2.0","id":0,"method":"ping"}\n')
    shim.stdin.flush()
    shim.stdout.readline()
    time.sleep(1.0)
    idle = mem(shim.pid)
    started = time.time()
    for i in range(1, 21):
        shim.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": "big"}).encode() + b"\n")
        shim.stdin.flush()
        line = shim.stdout.readline()
        assert len(line) > BIG, len(line)
    elapsed = time.time() - started
    time.sleep(0.5)
    after = mem(shim.pid)
    shim.stdin.close()
    shim.wait(timeout=20)
    result = {"idle": idle, "afterRelaying20x1MiB": after, "relaySeconds": round(elapsed, 2), "binaryBytes": os.path.getsize(binary)}
    json.dump(result, open(out_path, "w"), indent=1)
    print(json.dumps(result))
    subprocess.run(["rm", "-rf", home])


if __name__ == "__main__":
    main()
