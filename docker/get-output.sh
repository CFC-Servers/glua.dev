#!/bin/sh

uniq=$(date +%N)
CONSOLE_LOG="/home/steam/gmodserver/garrysmod/console.log"
TEMP_LOG="/tmp/output_to_send.$uniq.log"

mv "$CONSOLE_LOG" "$TEMP_LOG" 2>/dev/null || true
touch "$CONSOLE_LOG"

# Output the contents of the captured log
echo "Content-Type: text/plain"
echo ""

if [ -f "$TEMP_LOG" ]; then
    cat "$TEMP_LOG"
    rm "$TEMP_LOG"
fi
