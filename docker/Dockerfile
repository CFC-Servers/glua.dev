FROM busybox:1.36 AS busybox_stage

FROM ghcr.io/cfc-servers/steamcmd:latest

ARG GMOD_BRANCH=live

USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt update && apt install -y --no-install-recommends --no-install-suggests screen && apt autoremove
COPY --from=busybox_stage /bin/busybox /bin/busybox

ARG home=/home/steam
ARG gmodroot=$home/gmodserver
ARG server=$home/gmodserver/garrysmod

USER steam
RUN if [ "$GMOD_BRANCH" = "x86-64" ]; then \
    echo "Downloading x86-64 branch"; \
    ./steamcmd.sh +force_install_dir $gmodroot +login anonymous +app_update 4020 -beta x86-64 validate +quit; \
elif [ "$GMOD_BRANCH" = "dev" ]; then \
    echo "Downloading dev branch"; \
    ./steamcmd.sh +force_install_dir $gmodroot +login anonymous +app_update 4020 -beta dev validate +quit; \
elif [ "$GMOD_BRANCH" = "prerelease" ]; then \
    echo "Downloading prerelease branch"; \
    ./steamcmd.sh +force_install_dir $gmodroot +login anonymous +app_update 4020 -beta prerelease validate +quit; \
else \
    echo "Downloading live branch"; \
    ./steamcmd.sh +force_install_dir $gmodroot +login anonymous +app_update 4020 validate +quit; \
fi

USER root

# Copies
COPY base_server.cfg $server/cfg/test.cfg

COPY --chmod=755 "entrypoint.sh" "/entrypoint.sh"

RUN mkdir -p /www/cgi-bin
COPY --chmod=755 "healthcheck.sh" "/www/cgi-bin/healthcheck.sh"
COPY --chmod=755 "send-command.sh" "/www/cgi-bin/send-command.sh"
COPY --chmod=755 "get-output.sh" "/www/cgi-bin/get-output.sh"
COPY --chmod=755 "test.sh" "/www/cgi-bin/test.sh"

RUN chown --recursive steam:steam \
    "/entrypoint.sh" \
    "/www"

USER steam

ENV GMOD_BRANCH=${GMOD_BRANCH}

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
