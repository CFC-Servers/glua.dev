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
    <div class="flex items-center justify-between text-xs">
        <span class="text-gray-300">End session?</span>
        <div class="flex gap-2">
            <button on:click={confirm} class="text-red-400 hover:text-red-300 font-semibold transition-colors">Yes</button>
            <button on:click={() => confirming = false} class="text-gray-400 hover:text-gray-300 transition-colors">No</button>
        </div>
    </div>
{:else}
    <button on:click={() => confirming = true} class="w-full text-xs text-center py-1.5 rounded-md bg-red-600/10 hover:bg-red-600/25 text-red-400/70 hover:text-red-300 border border-red-500/20 hover:border-red-500/30 transition-colors">
        End Session
    </button>
{/if}
