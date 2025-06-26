#!/bin/sh

echo "Content-Type: text/plain"
echo "" # End of headers

if [ -n "$CONTENT_LENGTH" ] && [ "$CONTENT_LENGTH" -gt 0 ]; then
    COMMAND=$(head -c "$CONTENT_LENGTH")
    
    inp="$(printf '%s\n' "$COMMAND")"
    echo "Sending command to screen session: [$inp]"

    /usr/bin/screen -S gmod -X stuff "$inp"
    
    echo "OK"
else
    echo "No command received."
fi
