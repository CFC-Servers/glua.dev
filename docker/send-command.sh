#!/bin/sh

/usr/bin/screen -S gmod -X stuff "$(cat)"

echo "Status: 204 No Content"
echo ""
