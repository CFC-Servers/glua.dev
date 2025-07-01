#!/bin/bash

home=/home/steam
gmodroot=$home/gmodserver
server=$home/gmodserver/garrysmod
gmodbranch="${GMOD_BRANCH:-live}"

gamemode="${GAMEMODE:-sandbox}"
collection="${COLLECTION_ID:-0}"
map="${MAP:-gm_construct}"
echo "Starting the server with gamemode: $gamemode"

pidfile="gmod.pid"

# Dirs
mkdir -p "$server/data"
mkdir -p "$server/lua/gluadev"
touch "$server/console.log"

# Screen setup
mkdir -p "$home/.screen"
chmod 700 "$home/.screen"
export SCREENDIR="$home/.screen"
echo "logfile flush 0" > "$home/.screenrc"

base_srcds_args=(
    # Test requirements
    -systemtest       # Allows us to exit the game from inside Lua
    #-condebug         # Logs everything to console.log
    #-debug            # On crashes generate a debug.log allowing for better debugging.
    -norestart        # If we crash, do not restart.

    # Disabling things we don't need/want
    -nodns            # Disables DNS requests and resolving DNS addresses
    -nohltv           # Disable SourceTV
    -nodttest         # Skips datatable testing
    -nomaster         # Hides server from master list
    -nominidumps      # Don't write minidumps
    -nop4             # No "Perforce" integration
    -noshaderapi      # Don't try to load other shader APIs, use the "shaderapiempty.dll"
    -nogamestats      # No need for game stats
    -noipx            # Disables IPX support
    -fs_nopreloaddata # "Loads in the precompiled keyvalues for each datatype"
    -hushasserts      # "Disables a number of asserts in core Source libraries, skipping some error checks and messages"
    -snoforceformat   # Skips sound buffer creation
    -insecure         # Disable VAC
    -disablehttp      # Disables HTTP functionality

    # Optimizations
    -collate          # "Skips everything, just merges the reslist from temp folders to the final folder again"
    -high             # Sets "high" process affinity
    -threads 6        # Double the allocated threads to the threadpool

    -maxplayers 12
    -disableluarefresh
    +mat_dxlevel 1

    -pidfile "$pidfile"

    # Game setup
    -game garrysmod
    -ip 127.0.0.1
    -port 27015
    +clientport 27005
    +gamemode "$gamemode"
    +host_workshop_collection "$collection"
    +map "$map"
    +servercfgfile test.cfg
)
srcds_args="$EXTRA_STARTUP_ARGS ${base_srcds_args[@]}"

echo "Size of the agent binary: $(du -h /usr/local/bin/gluadev-agent | cut -f1)"
# Start command server
/usr/local/bin/gluadev-agent &

# Start game server
if [ "$gmodbranch" = "x86-64" ]; then
    echo "Starting 64-bit server"
    screen -L -Logfile "$server/console.log" -dmS gmod timeout 6m "$gmodroot"/srcds_run_x64 "${srcds_args[@]}"
else
    echo "Starting 32-bit server"
    screen -L -Logfile "$server/console.log" -dmS gmod timeout 6m "$gmodroot"/srcds_run "${srcds_args[@]}"
fi

echo ""
echo ""
echo "Waiting for server to start..."
timeout 1m bash -c "until [ -f '$server/$pidfile' ]; do sleep 0.1; done"
if [ ! -f "$server/$pidfile" ]; then
    echo "Server did not start in time, exiting"
    cat "$server/console.log"
    exit 1
fi

pid=$(cat "$server/$pidfile")
echo "Server started successfully"
echo "Server PID: $pid"
echo ""
echo ""

echo ""
echo ""
echo "Server console output:"

tail \
    --follow=name \
    --retry \
    --lines=500 \
    --sleep-interval=0.25 \
    --quiet \
    --pid "$pid" \
    "$server/console.log"

echo "Server has stopped - exiting"
kill -9 $pid 2>/dev/null
