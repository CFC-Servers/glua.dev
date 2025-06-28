<script lang="ts">
    import { onMount } from "svelte";

    export let socket: WebSocket | null;

    let collapsed = false;
    let cpuUsage = 0;
    let diskUsage = 0;
    let timeout = "00:00";
    let timeoutPercentage = 100;
    let branch = "...";
    let gameVersion = "...";
    let containerTag = "...";
    let sessionTimerInterval: any;
    const totalSessionDuration = 6 * 60 * 1000;

    onMount(() => {
        if (socket) {
            socket.addEventListener("message", handleMessage);
        }

        return () => {
            if (socket) {
                socket.removeEventListener("message", handleMessage);
            }
            if (sessionTimerInterval) {
                clearInterval(sessionTimerInterval);
            }
        };
    });

    function handleMessage(event: MessageEvent) {
        try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
                case "HEALTH":
                    updateStatusWidget(msg.payload);
                    break;
                case "SESSION_TIMER":
                    setupSessionTimer(msg.payload.endTime);
                    break;
                case "CONTEXT_UPDATE":
                    branch = msg.payload.branch;
                    gameVersion = msg.payload.gameVersion;
                    containerTag = msg.payload.containerTag;
                    break;
            }
        } catch (e) {
            console.error("Failed to process message in StatusPanel", e);
        }
    }

    function updateStatusWidget(data: { cpuusage?: number; diskusage?: number }) {
        if (data.cpuusage !== undefined) {
            cpuUsage = data.cpuusage;
        }
        if (data.diskusage !== undefined) {
            diskUsage = data.diskusage;
        }
    }

    function setupSessionTimer(endTime: number) {
        if (sessionTimerInterval) {
            clearInterval(sessionTimerInterval);
        }

        function formatTime(ms: number) {
            if (ms < 0) ms = 0;
            const totalSeconds = Math.floor(ms / 1000);
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }

        sessionTimerInterval = setInterval(() => {
            const remainingTime = endTime - Date.now();

            if (remainingTime <= 0) {
                timeout = "00:00";
                timeoutPercentage = 0;
                clearInterval(sessionTimerInterval);
                return;
            }

            timeoutPercentage = (remainingTime / totalSessionDuration) * 100;
            timeout = formatTime(remainingTime);
        }, 1000);
    }

    $: timeoutBarColor = timeoutPercentage > 50 ? 'bg-green-500' : timeoutPercentage > 20 ? 'bg-yellow-500' : 'bg-red-500';
    $: timeoutLabelColor = timeoutPercentage > 50 ? 'text-green-300' : timeoutPercentage > 20 ? 'text-yellow-300' : 'text-red-300';

</script>

<div id="status-panel" class="absolute top-4 right-4 z-20 w-72" class:collapsed>
    <div class="bg-gray-800 rounded-lg shadow-lg border border-gray-700/50">
        <button on:click={() => collapsed = !collapsed} class="w-full flex justify-between items-center p-3 text-left focus:outline-none">
            <span class="font-bold text-sm text-white">Session Status</span>
            <svg class="toggle-icon w-5 h-5 text-gray-400" class:rotate-180={collapsed} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
        </button>
        <div class="panel-content">
            <div class="px-4 pb-4 space-y-4">
                <div>
                    <div class="flex justify-between items-baseline mb-1"><span class="text-xs font-semibold text-gray-300">CPU Usage</span><span class="text-xs font-mono text-indigo-300">{cpuUsage.toFixed(1)}%</span></div>
                    <div class="w-full bg-gray-700 rounded-full h-1.5"><div class="bg-indigo-500 h-1.5 rounded-full transition-all duration-500" style="width: {cpuUsage}%"></div></div>
                </div>
                <div>
                    <div class="flex justify-between items-baseline mb-1"><span class="text-xs font-semibold text-gray-300">Disk Usage</span><span class="text-xs font-mono text-cyan-300">{diskUsage.toFixed(1)}%</span></div>
                    <div class="w-full bg-gray-700 rounded-full h-1.5"><div class="bg-cyan-500 h-1.5 rounded-full transition-all duration-500" style="width: {diskUsage}%"></div></div>
                </div>
                <div>
                    <div class="flex justify-between items-baseline mb-1"><span class="text-xs font-semibold text-gray-300">Time Remaining</span><span class="text-xs font-mono {timeoutLabelColor}">{timeout}</span></div>
                    <div class="w-full bg-gray-700 rounded-full h-1.5"><div class="{timeoutBarColor} h-1.5 rounded-full transition-all duration-500" style="width: {timeoutPercentage}%"></div></div>
                </div>
                <div class="border-t border-gray-700 pt-3 text-xs space-y-2">
                    <div class="flex justify-between"><span class="text-gray-400">Branch:</span><a href="https://steamdb.info/app/4000/depots/?branch={branch}" target="_blank" rel="noopener noreferrer" class="font-mono text-indigo-400 hover:text-indigo-300 hover:underline truncate">{branch}</a></div>
                    <div class="flex justify-between"><span class="text-gray-400">Game Ver:</span><a href="https://steamdb.info/patchnotes/{gameVersion}" target="_blank" rel="noopener noreferrer" class="font-mono text-indigo-400 hover:text-indigo-300 hover:underline truncate">{gameVersion}</a></div>
                    <div class="flex justify-between"><span class="text-gray-400">Container:</span><span class="font-mono text-gray-200 truncate">{containerTag}</span></div>
                </div>
            </div>
        </div>
    </div>
</div>