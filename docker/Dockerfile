FROM golang:1.22-alpine AS agent-builder
WORKDIR /app

COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /go-agent .


FROM ghcr.io/cfc-servers/steamcmd:latest

ARG GMOD_BRANCH=live
ARG GAME_VERSION=unknown
ARG GLUA_DEV_TAG=unknown

USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt update && apt install -y --no-install-recommends --no-install-suggests screen && apt autoremove

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
COPY --from=agent-builder /go-agent /usr/local/bin/gluadev-agent

COPY --chmod=755 "entrypoint.sh" "/entrypoint.sh"
RUN chown --recursive steam:steam "/entrypoint.sh"

USER steam
RUN mkdir -v "$home/metadata" && \
    echo "${GAME_VERSION}" > "$home/metadata/game_version.txt" && \
    echo "${GMOD_BRANCH}" > "$home/metadata/game_branch.txt" && \
    echo "${GLUA_DEV_TAG}" > "$home/metadata/container_tag.txt"

ENV GMOD_BRANCH=${GMOD_BRANCH}

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
