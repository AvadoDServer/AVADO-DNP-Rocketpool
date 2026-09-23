#!/bin/bash
# log-tee.sh <file> [max_bytes]
# Copies stdin to stdout and to <file>. When <file> grows past max_bytes
# (default 5 MB) it is moved to <file>.1 (one old file is kept).
# Ignore TERM/INT/HUP: supervisord signals the whole process group on stop,
# and the daemon must be able to log while it shuts down (if this process
# died first, the daemon would be killed by SIGPIPE instead of exiting
# cleanly). It exits at EOF, when the daemon has exited.
trap '' TERM INT HUP
file="$1"
max="${2:-5242880}"
n=0
while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line"
    printf '%s\n' "$line" >>"$file"
    n=$((n + 1))
    if [ $((n % 200)) -eq 0 ]; then
        size="$(stat -c %s "$file" 2>/dev/null || stat -f %z "$file" 2>/dev/null || echo 0)"
        if [ "$size" -gt "$max" ]; then
            mv -f "$file" "$file.1"
        fi
    fi
done
