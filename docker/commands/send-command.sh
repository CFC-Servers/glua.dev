#!/bin/sh

echo "Content-Type: text/plain"
echo "" # End of headers


LEN=${CONTENT_LENGTH:-$HTTP_CONTENT_LENGTH}

echo "Read content length: $LEN"

if [ -n "$LEN" ] && [ "$LEN" -gt 0 ]; then
    # Read exactly that many bytes from standard input
    COMMAND=$(head -c "$LEN")
    
    # Stuff the command and a newline into screen
    /usr/bin/screen -S gmod -X stuff "$(printf '%s\n' "$COMMAND")"
    
    echo "OK"
else
    echo "Error: No command received or Content-Length not set."
fi
