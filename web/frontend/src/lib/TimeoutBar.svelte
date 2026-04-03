<script lang="ts">
    import { onDestroy } from "svelte";
    import { sessionTimer } from "./stores";

    export let socket: WebSocket | null;

    let timeout = "00:00";
    let timeoutPercentage = 100;
    let interval: any;
    let showExtensionPrompt = false;
    let extensionRequested = false;

    $: if ($sessionTimer) {
        showExtensionPrompt = false;
        startInterval($sessionTimer.endTime, $sessionTimer.duration, $sessionTimer.extensionThreshold);
    }

    function startInterval(endTime: number, duration: number, extensionThreshold: number) {
        if (interval) clearInterval(interval);
        interval = setInterval(() => {
            const remaining = endTime - Date.now();
            if (remaining <= 0) {
                timeout = "00:00";
                timeoutPercentage = 0;
                showExtensionPrompt = false;
                clearInterval(interval);
                return;
            }
            timeoutPercentage = (remaining / duration) * 100;
            timeout = formatTime(remaining);

            if (remaining <= extensionThreshold && !extensionRequested) {
                showExtensionPrompt = true;
            }
        }, 1000);
    }

    function requestExtension() {
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "REQUEST_EXTENSION" }));
            extensionRequested = true;
            showExtensionPrompt = false;
        }
    }

    function formatTime(ms: number) {
        if (ms < 0) ms = 0;
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }

    onDestroy(() => { if (interval) clearInterval(interval); });

    $: barColor = timeoutPercentage > 50 ? "bg-green-500" : timeoutPercentage > 20 ? "bg-yellow-500" : "bg-red-500";
    $: labelColor = timeoutPercentage > 50 ? "text-green-300" : timeoutPercentage > 20 ? "text-yellow-300" : "text-red-300";
</script>

<div>
    <div class="flex justify-between items-baseline mb-1">
        <span class="text-xs font-semibold text-gray-300">Time Remaining</span>
        <span class="text-xs font-mono {labelColor}">{timeout}</span>
    </div>
    <div class="w-full bg-gray-700 rounded-full h-1.5">
        <div class="{barColor} h-1.5 rounded-full transition-all duration-500" style="width: {timeoutPercentage}%"></div>
    </div>
    {#if showExtensionPrompt}
        <button on:click={requestExtension} class="mt-2 w-full text-xs text-center py-1.5 rounded-md bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 hover:text-indigo-200 border border-indigo-500/30 transition-colors">
            Need a few more minutes?
        </button>
    {/if}
</div>
