<script lang="ts">
    export let label: string;
    export let value: string;
    export let href: string | null = null;
</script>

<div class="flex justify-between">
    <span class="text-gray-400">{label}:</span>
    {#if href}
        <a {href} target="_blank" rel="noopener noreferrer" class="font-mono text-indigo-400 hover:text-indigo-300 hover:underline truncate">{value}</a>
    {:else}
        <span class="font-mono text-gray-200 truncate">{value}</span>
    {/if}
</div>
