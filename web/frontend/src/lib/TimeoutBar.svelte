<script lang="ts">
    import { onDestroy } from "svelte";
    import { sessionTimer } from "./stores";

    let timeout = "00:00";
    let timeoutPercentage = 100;
    let interval: any;
    const totalSessionDuration = 6 * 60 * 1000;

    $: if ($sessionTimer) {
        startInterval($sessionTimer.endTime);
    }

    function startInterval(endTime: number) {
        if (interval) clearInterval(interval);
        interval = setInterval(() => {
            const remaining = endTime - Date.now();
            if (remaining <= 0) {
                timeout = "00:00";
                timeoutPercentage = 0;
                clearInterval(interval);
                return;
            }
            timeoutPercentage = (remaining / totalSessionDuration) * 100;
            timeout = formatTime(remaining);
        }, 1000);
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
</div>
