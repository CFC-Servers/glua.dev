<script lang="ts">
    import { createEventDispatcher } from "svelte";

    const dispatch = createEventDispatcher();

    let containerType = "public";
    let inQueue = false;
    let queuePosition = "...";

    async function requestSession() {
        inQueue = true;
        queuePosition = "Connecting...";

        try {
            const response = await fetch(`/api/request-session?type=${containerType}`, { method: "POST" });
            // Non-JSON error pages (e.g. a Cloudflare 5xx HTML) fall through to
            // the unknown-status branch below and surface a friendly error
            const data = await response.json().catch(() => ({}));

            if (data.status === "READY") {
                dispatch("startsession", { sessionId: data.sessionId, sessionType: containerType });
                return;
            }
            if (data.status === "IP_LIMIT") {
                dispatch("iplimited", { limit: data.limit });
                inQueue = false;
                return;
            }
            if (data.status === "QUEUED") {
                queuePosition = data.position;
                pollQueueStatus(data.ticketId);
                return;
            }

            inQueue = false;
            queueError = "Couldn't start a session. Please try again in a moment.";
        } catch (e) {
            console.error("Failed to request session:", e);
            inQueue = false;
            queueError = "Couldn't reach the server. Check your connection and try again.";
        }
    }

    let queueError = "";

    function pollQueueStatus(ticketId: string) {
        let failures = 0;
        const MAX_FAILURES = 10;

        const poll = async () => {
            try {
                const response = await fetch(`/api/queue-status?ticketId=${ticketId}`);
                const data = await response.json();

                if (data.error) {
                    inQueue = false;
                    queueError = "Your queue ticket was lost. Please try again.";
                    return;
                }

                if (data.status === "READY") {
                    dispatch("startsession", { sessionId: data.sessionId, sessionType: containerType });
                } else {
                    failures = 0;
                    queuePosition = data.position;
                    setTimeout(poll, 3000);
                }
            } catch (e) {
                failures++;
                if (failures >= MAX_FAILURES) {
                    inQueue = false;
                    queueError = "Lost connection to the queue. Please try again.";
                    return;
                }
                const backoff = Math.min(3000 * Math.pow(1.5, failures), 15000);
                setTimeout(poll, backoff);
            }
        };
        setTimeout(poll, 2000);
    }
</script>

<div class="fixed inset-0 bg-gray-900 bg-opacity-80 flex items-center justify-center z-50 transition-opacity duration-300">
    <div class="bg-gray-800 p-8 rounded-lg shadow-2xl transform scale-95 transition-transform duration-300 w-full max-w-md">
        {#if !inQueue}
            <div>
                <h2 class="text-2xl font-bold mb-4 text-white">Start New GLua Session</h2>
                <p class="text-gray-400 mb-6">Select your desired game branch and spin up a real GMod environment in seconds</p>
                <div class="mb-6">
                    <label for="container-type-select" class="block text-sm font-medium text-gray-300 mb-2 text-left">GMod Branch</label>
                    <select bind:value={containerType} class="block w-full bg-gray-700 border border-gray-600 text-white rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                        <option value="public">Public</option>
                        <option value="sixty-four">64-bit</option>
                        <option value="prerelease">Prerelease</option>
                        <option value="dev">Dev</option>
                    </select>
                </div>
                {#if queueError}
                    <p class="text-red-400 text-sm mb-4">{queueError}</p>
                {/if}
                <button on:click={() => { queueError = ""; requestSession(); }} class="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 px-8 rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-indigo-400 disabled:bg-gray-500 disabled:cursor-wait">Start</button>
            </div>
        {:else}
            <div>
                <svg class="animate-spin h-8 w-8 text-indigo-400 mx-auto mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                <h2 class="text-xl font-bold mb-2 text-white">You are in the queue...</h2>
                <p class="text-gray-400">All available sessions are currently in use. Please wait.</p>
                <p class="text-lg font-mono text-indigo-300 mt-4">Position: <span>{queuePosition}</span></p>
            </div>
        {/if}
    </div>
</div>