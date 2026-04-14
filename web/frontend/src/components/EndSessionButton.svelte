<script lang="ts">
    import { createEventDispatcher } from "svelte";

    const dispatch = createEventDispatcher();

    let confirming = false;

    function confirm() {
        dispatch("endsession");
        confirming = false;
    }
</script>

{#if confirming}
    <div class="w-full space-y-1.5">
        <p class="text-xs text-gray-400 text-center">End this session?</p>
        <div class="flex justify-center gap-2">
            <button on:click={confirm} class="w-[38%] text-xs py-1.5 rounded-md bg-red-600/20 hover:bg-red-600/35 text-red-400 hover:text-red-300 border border-red-500/30 font-semibold transition-colors">Yes</button>
            <button on:click={() => confirming = false} class="w-[38%] text-xs py-1.5 rounded-md bg-gray-700/40 hover:bg-gray-700/60 text-gray-400 hover:text-gray-300 border border-gray-600/30 transition-colors">No</button>
        </div>
    </div>
{:else}
    <button on:click={() => confirming = true} class="w-full text-xs text-center py-1.5 rounded-md bg-red-600/10 hover:bg-red-600/25 text-red-400/70 hover:text-red-300 border border-red-500/20 hover:border-red-500/30 transition-colors">
        End Session
    </button>
{/if}
