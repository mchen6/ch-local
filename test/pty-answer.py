#!/usr/bin/env python3
# Runs a command on a pseudo-terminal, as a user's own terminal runs it, and
# types one answer when a prompt appears (ch-local's smoke test: add-module
# asks only at a terminal whose output is seen). POSIX only (Linux, macOS).
#
#   python3 pty-answer.py <answer> <prompt> <command> [args...]
#
# Prints everything the command wrote to the terminal; exits with its exit
# code (128 + n for a signal n).
import os
import pty
import sys

answer, prompt, argv = sys.argv[1], sys.argv[2].encode(), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
seen = b''
answered = False
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    seen += chunk
    if not answered and prompt in seen:
        os.write(fd, (answer + '\n').encode())
        answered = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(seen.decode('utf-8', 'replace'))
sys.stdout.flush()
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(os.WEXITSTATUS(status))
