#!/bin/sh
home=/home/steam
gameversion=$(cat $home/metadata/game_version.txt)
gmodbranch=$(cat $home/metadata/game_branch.txt)
containertag=$(cat $home/metadata/container_tag.txt)

# Don't respond until the server is actually ready
timeout 60s bash -c "until [ -f '$home/gmodserver/garrysmod/gmod.pid' ]; do sleep 0.25; done"
if [ ! -f "$server/$pidfile" ]; then
    printf "Content-Type: application/json\r\n"
    printf "\r\n"
    printf "{\n"
    printf "  \"error\": \"Server did not start in time\"\n"
    printf "}\n"
    exit 1
fi

printf "Content-Type: application/json\r\n"
printf "\r\n"
printf "{\n"
printf "  \"gameversion\": %s,\n" "${gameversion:-unknown}"
printf "  \"gmodbranch\": %s,\n" "${gmodbranch:-unknown}"
printf "  \"containertag\": %s\n" "${containertag:-unknown}"
printf "}\n"
