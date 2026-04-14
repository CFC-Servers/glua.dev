<script lang="ts">
    import { createEventDispatcher } from "svelte";
    import { sessionState, sessionMetadata, sessionTimer } from "../lib/stores";
    import { healthData } from "../lib/socket";
    import { formatTime } from "../lib/format";
    import { DISCORD_URL } from "../lib/links";
    import SessionMetadata from "./SessionMetadata.svelte";
    import TimeoutBar from "./TimeoutBar.svelte";
    import EndSessionButton from "./EndSessionButton.svelte";

    const dispatch = createEventDispatcher();

    export let socket: WebSocket | null;

    let collapsed = false;
    let sessionDuration = "";

    $: if ($sessionState === "closed" || $sessionState === "readonly") {
        computeDuration();
    }

    $: inactive = $sessionState === "closed" || $sessionState === "readonly";

    function computeDuration() {
        const meta = $sessionMetadata;
        if (!meta?.startedAt) return;
        const end = meta.endedAt ?? Date.now();
        sessionDuration = formatTime(end - meta.startedAt);
    }
</script>

<div id="status-panel" class="absolute top-4 right-4 z-20 w-72" class:collapsed>
    <div class="bg-gray-800 rounded-lg shadow-lg border border-gray-700/50">
        <div class="w-full flex justify-between items-center p-3">
            <button on:click={() => collapsed = !collapsed} class="flex-1 flex justify-between items-center text-left focus:outline-none pr-2">
                <span class="font-bold text-sm {inactive ? 'text-gray-400' : 'text-white'}">{inactive ? "Session Ended" : "Session Status"}</span>
            </button>
            <div class="flex items-center gap-2">
                <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" title="Questions, bugs, or feedback? Join the CFC dev Discord" class="text-gray-500 hover:text-indigo-300 transition-colors" aria-label="Join the CFC developer Discord">
                    <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3.2a.074.074 0 0 0-.079.037c-.34.607-.719 1.4-.984 2.024a18.302 18.302 0 0 0-5.487 0 12.64 12.64 0 0 0-.998-2.024.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.105 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.927 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.099.246.197.373.29a.077.077 0 0 1-.006.129 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.106c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.03ZM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.42 0-1.334.955-2.42 2.157-2.42 1.211 0 2.176 1.095 2.157 2.42 0 1.334-.955 2.42-2.157 2.42Zm7.974 0c-1.183 0-2.157-1.086-2.157-2.42 0-1.334.955-2.42 2.157-2.42 1.211 0 2.176 1.095 2.157 2.42 0 1.334-.946 2.42-2.157 2.42Z"/></svg>
                </a>
                <button on:click={() => collapsed = !collapsed} class="focus:outline-none" aria-label="Toggle panel">
                    <svg class="toggle-icon w-5 h-5 text-gray-400" class:rotate-180={collapsed} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                </button>
            </div>
        </div>
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
                        <div class="flex justify-between items-baseline mb-1"><span class="text-xs font-semibold text-gray-300">CPU Usage</span><span class="text-xs font-mono text-indigo-300">{$healthData.cpuUsage.toFixed(1)}%</span></div>
                        <div class="w-full bg-gray-700 rounded-full h-1.5"><div class="bg-indigo-500 h-1.5 rounded-full transition-all duration-500" style="width: {$healthData.cpuUsage}%"></div></div>
                    </div>
                    <div>
                        <div class="flex justify-between items-baseline mb-1"><span class="text-xs font-semibold text-gray-300">Disk Usage</span><span class="text-xs font-mono text-cyan-300">{$healthData.diskUsage.toFixed(1)}%</span></div>
                        <div class="w-full bg-gray-700 rounded-full h-1.5"><div class="bg-cyan-500 h-1.5 rounded-full transition-all duration-500" style="width: {$healthData.diskUsage}%"></div></div>
                    </div>
                    <TimeoutBar {socket} />
                    <div class="border-t border-gray-700 pt-3">
                        <SessionMetadata />
                    </div>
                    {#if $sessionState === "active"}
                        <EndSessionButton on:endsession={() => dispatch("endsession")} />
                    {/if}
                </div>
            {/if}
        </div>
    </div>
</div>
