GLUA_DEV_TAG=0.6.5

## Version Getter
docker run \
    --rm \
    --name version_checker \
    ghcr.io/cfc-servers/steamcmd-slim:latest \
    /home/steam/steamcmd/steamcmd.sh +login anonymous +app_info_request 4020 +login anonymous +app_info_print 4020 +exit \
    > "./raw_version_output.txt"

# Extract just the part we care about
struct="./struct.txt"
sed -e '1,/"4020"$/ d' "./raw_version_output.txt" > "$struct"

# Get the latest build IDs
public=$(grep -A 2 '"public"' "$struct" | grep '"buildid"' | awk '{print $2}' | sed 's/"//g')
sixtyfour=$(grep -A 2 '"x86-64"' "$struct" | grep '"buildid"' | awk '{print $2}' | sed 's/"//g')
dev=$(grep -A 2 '"dev"' "$struct" | grep '"buildid"' | awk '{print $2}' | sed 's/"//g')
prerelease=$(grep -A 2 '"prerelease"' "$struct" | grep '"buildid"' | awk '{print $2}' | sed 's/"//g')

echo "Latest Public ID: '$public'"
echo "Latest 64bit ID: '$sixtyfour'"
echo "Latest Dev ID: '$dev'"
echo "Latest prerelease ID: '$prerelease'"

if [ -z "$public" ] || [ -z "$sixtyfour" ] || [ -z "$dev" ] || [ -z "$prerelease" ]; then
    echo "Failed to get one or more latest build IDs"
    echo "Raw Output from SteamCMD:"
    cat "./raw_version_output.txt"
    exit 1
fi


# Public build
docker build --build-arg GMOD_BRANCH=live --build-arg GAME_VERSION=$public --build-arg GLUA_DEV_TAG=$GLUA_DEV_TAG --tag glua-dev-public-fat ./docker/
./docker/slim.sh public "$public" "$GLUA_DEV_TAG"
docker image rm glua-dev-public-fat
docker builder prune -f


npx wrangler -c ./web containers push glua-dev-public:latest
docker image rm glua-dev-public:latest
docker builder prune -f

#--

# x86-64 build
docker build --build-arg GMOD_BRANCH=x86-64 --build-arg GAME_VERSION=$sixtyfour --build-arg GLUA_DEV_TAG=$GLUA_DEV_TAG --tag glua-dev-sixtyfour-fat ./docker/
./docker/slim.sh sixtyfour "$sixtyfour" "$GLUA_DEV_TAG"
docker image rm glua-dev-sixtyfour-fat
docker builder prune -f

npx wrangler -c ./web containers push glua-dev-sixtyfour:latest
docker image rm glua-dev-sixtyfour:latest
docker builder prune -f

#--

# Dev build
docker build --build-arg GMOD_BRANCH=dev --build-arg GAME_VERSION=$dev --build-arg GLUA_DEV_TAG=$GLUA_DEV_TAG --tag glua-dev-dev-fat ./docker/
./docker/slim.sh dev "$dev" "$GLUA_DEV_TAG"
docker image rm glua-dev-dev-fat
docker builder prune -f

npx wrangler -c ./web containers push glua-dev-dev:latest
docker image rm glua-dev-dev:latest
docker builder prune -f

#--

# Prerelease build
docker build --build-arg GMOD_BRANCH=prerelease --build-arg GAME_VERSION=$prerelease --build-arg GLUA_DEV_TAG=$GLUA_DEV_TAG --tag glua-dev-prerelease-fat ./docker/
./docker/slim.sh prerelease "$prerelease" "$GLUA_DEV_TAG"
docker image rm glua-dev-prerelease-fat
docker builder prune -f

npx wrangler -c ./web containers push glua-dev-prerelease:latest
docker image rm glua-dev-prerelease:latest
docker builder prune -f


echo "Pushed all images to Cloudflare registry"

npx wrangler -c ./web containers images list

rm ./struct.txt
rm ./raw_version_output.txt
