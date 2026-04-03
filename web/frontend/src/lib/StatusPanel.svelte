<script lang="ts">
    import { onMount } from "svelte";
    import { sessionState, sessionMetadata, sessionTimer } from "./stores";
    import SessionMetadata from "./SessionMetadata.svelte";
    import TimeoutBar from "./TimeoutBar.svelte";

    export let socket: WebSocket | null;

    let collapsed = false;
    let cpuUsage = 0;
    let diskUsage = 0;
    let sessionDuration = "";

    $: if ($sessionState === "closed" || $sessionState === "readonly") {
        computeDuration();
    }

    onMount(() => {
        if (socket) {
            socket.addEventListener("message", handleMessage);
        }

        return () => {
            if (socket) {
                socket.removeEventListener("message", handleMessage);
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
                    sessionTimer.set({ endTime: msg.payload.endTime });
                    break;
                case "CONTEXT_UPDATE":
                    sessionMetadata.set(msg.payload);
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

    function formatTime(ms: number) {
        if (ms < 0) ms = 0;
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }

    function computeDuration() {
        const meta = $sessionMetadata;
        if (!meta?.startedAt) return;
        const end = meta.endedAt ?? Date.now();
        sessionDuration = formatTime(end - meta.startedAt);
    }

    $: inactive = $sessionState === "closed" || $sessionState === "readonly";

</script>

<div id="status-panel" class="absolute top-4 right-4 z-20 w-72" class:collapsed>
    <div class="bg-gray-800 rounded-lg shadow-lg border border-gray-700/50">
        <button on:click={() => collapsed = !collapsed} class="w-full flex justify-between items-center p-3 text-left focus:outline-none">
            <span class="font-bold text-sm {inactive ? 'text-gray-400' : 'text-white'}">{inactive ? "Session Ended" : "Session Status"}</span>
            <svg class="toggle-icon w-5 h-5 text-gray-400" class:rotate-180={collapsed} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
        </button>
        <div class="panel-content">
            {#if inactive}
                <div class="px-4 pb-4 font-mono text-xs space-y-2">
                    <div class="text-gray-400">{$sessionState === "readonly" ? "Viewing saved session" : "Process exited"}</div>
                    {#if $sessionMetadata}
                        {#if sessionDuration}
                            <div class="text-gray-400">Session duration: <span class="text-gray-200">{sessionDuration}</span></div>
                        {/if}
                        <div class="border-t border-gray-700 my-2"></div>
                        <SessionMetadata />
                    {/if}
                    <div class="border-t border-gray-700 my-2"></div>
                    <button on:click={() => window.location.href = "/"} class="text-indigo-400 hover:text-indigo-300 transition-colors duration-200">New Session</button>
                </div>
            {:else}
                <div class="px-4 pb-4 space-y-4">
                    <div>
                        <div class="flex justify-between items-baseline mb-1"><span class="text-xs font-semibold text-gray-300">CPU Usage</span><span class="text-xs font-mono text-indigo-300">{cpuUsage.toFixed(1)}%</span></div>
                        <div class="w-full bg-gray-700 rounded-full h-1.5"><div class="bg-indigo-500 h-1.5 rounded-full transition-all duration-500" style="width: {cpuUsage}%"></div></div>
                    </div>
                    <div>
                        <div class="flex justify-between items-baseline mb-1"><span class="text-xs font-semibold text-gray-300">Disk Usage</span><span class="text-xs font-mono text-cyan-300">{diskUsage.toFixed(1)}%</span></div>
                        <div class="w-full bg-gray-700 rounded-full h-1.5"><div class="bg-cyan-500 h-1.5 rounded-full transition-all duration-500" style="width: {diskUsage}%"></div></div>
                    </div>
                    <TimeoutBar {socket} />
                    <div class="border-t border-gray-700 pt-3">
                        <SessionMetadata />
                    </div>
                </div>
            {/if}
        </div>
    </div>
</div>
