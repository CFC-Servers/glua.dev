slim build \
    --target glua-dev:latest \
    --http-probe-off \
    --continue-after 30 \
    --show-clogs --show-blogs \
    --include-bin "/usr/bin/date" \
    --include-bin "/usr/bin/echo" \
    --include-bin "/usr/bin/cp" \
    --include-bin "/usr/bin/screen" \
    --include-path "/www" \
    --include-path "/home/steam/metadata" \
    --include-shell \
    --expose 8080 \
    --tag glua-dev-slim:latest \

