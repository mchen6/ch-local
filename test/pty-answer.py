#!/usr/bin/env python3
# Runs a command on a pseudo-terminal, as a user's own terminal runs it, and
# types one answer when a prompt appears (ch-local's smoke and acceptance
# runs: add-module asks only at a terminal whose output is seen). POSIX only
# (Linux, macOS).
#
#   python3 pty-answer.py <answer> <prompt> <command> [args...]
#
# What the command writes is copied to standard output as it comes, so a
# hang still shows how far it got. Exits with the command's exit code (128 +
# n for a signal n); with 124 when the command outlives DEADLINE seconds (it
# is killed; "prompt never seen" is said when it never asked). Ends once the
# command itself exits, even if something it started keeps the terminal.
import codecs
import os
import pty
import select
import signal
import sys
import time

DEADLINE = 100
answer, prompt, argv = sys.argv[1], sys.argv[2].encode(), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
seen = b''
answered = False
# (a character split across two reads is printed whole)
decoder = codecs.getincrementaldecoder('utf-8')('replace')
status = None
until = time.monotonic() + DEADLINE


def drain():
    global seen, answered
    while time.monotonic() <= until:
        ready, _, _ = select.select([fd], [], [], 0.25)
        if not ready:
            return True
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            return False
        if not chunk:
            return False
        seen += chunk
        sys.stdout.write(decoder.decode(chunk))
        sys.stdout.flush()
        if not answered and prompt in seen:
            os.write(fd, (answer + '\n').encode())
            answered = True
    return True


while status is None:
    open_ = drain()
    done, st = os.waitpid(pid, os.WNOHANG)
    if done != 0:
        status = st
        drain()
        break
    if not open_:
        # (the terminal closed: wait for the command, within the deadline)
        while time.monotonic() <= until:
            done, st = os.waitpid(pid, os.WNOHANG)
            if done != 0:
                status = st
                break
            time.sleep(0.05)
        if status is not None:
            break
    if time.monotonic() > until:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        sys.stdout.write(decoder.decode(b'', final=True))
        sys.stdout.write('\npty-answer: timed out after %d s%s\n' % (DEADLINE, '' if answered else '; prompt never seen'))
        sys.exit(124)
sys.stdout.write(decoder.decode(b'', final=True))
sys.stdout.flush()
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(os.WEXITSTATUS(status))
