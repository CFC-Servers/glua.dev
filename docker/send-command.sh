#!/bin/sh

/usr/bin/screen -S gmod -X stuff "$(cat)"

sync

echo "Status: 204 No Content"
echo ""
