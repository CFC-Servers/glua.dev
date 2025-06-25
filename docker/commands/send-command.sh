#!/bin/sh

echo "Content-Type: text/plain"
echo "" # End of headers

if [ -n "$CONTENT_LENGTH" ] && [ "$CONTENT_LENGTH" -gt 0 ]; then
    COMMAND=$(head -c "$CONTENT_LENGTH")
    
    /usr/bin/screen -S gmod -X stuff "$(printf '%s\n' "$COMMAND")"
    
    echo "OK"
else
    echo "No command received."
fi
