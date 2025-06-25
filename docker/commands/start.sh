#!/bin/sh
home=/home/steam
gameversion=$(cat $home/metadata/game_version.txt)
gmodbranch=$(cat $home/metadata/game_branch.txt)
containertag=$(cat $home/metadata/container_tag.txt)

pidfile="$home/gmodserver/garrysmod/gmod.pid"

# Don't respond until the server is actually ready
timeout 60s bash -c "until [ -f '$pidfile' ]; do sleep 0.25; done"
if [ ! -f "$pidfile" ]; then
    printf "Status: 500 Server did not start in time\r\n"
    exit 1
fi

printf "Content-Type: application/json\r\n"
printf "\r\n"
printf "{\n"
printf "  \"gameversion\": \"%s\",\n" "${gameversion:-unknown}"
printf "  \"gmodbranch\": \"%s\",\n" "${gmodbranch:-unknown}"
printf "  \"containertag\": \"%s\"\n" "${containertag:-unknown}"
printf "}\n"
