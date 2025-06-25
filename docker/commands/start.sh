#!/bin/sh
home=/home/steam
gameversion=$(cat $home/metadata/game_version.txt)
gmodbranch=$(cat $home/metadata/game_branch.txt)
containertag=$(cat $home/metadata/container_tag.txt)

printf "Content-Type: application/json\r\n"
printf "\r\n"
printf "{\n"
printf "  \"gameversion\": %s,\n" "${gameversion:-unknown}"
printf "  \"gmodbranch\": %s,\n" "${gmodbranch:-unknown}"
printf "  \"containertag\": %s\n" "${containertag:-unknown}"
printf "}\n"
