branch=$1 # Branch name
version=$2 # Game version
tag=$3 # Gluadev tag

slim build \
    --target "glua-dev-$branch-fat" \
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
    --tag "glua-dev-$branch:latest" \
    --tag "glua-dev-$branch:$version" \
    --tag "glua-dev-$branch:$tag"

