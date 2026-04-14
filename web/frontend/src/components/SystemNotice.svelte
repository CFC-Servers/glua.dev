<script lang="ts">
    export let message: string;
</script>

<div class="px-4 py-2">
    <div class="bg-indigo-900/25 border border-indigo-500/40 rounded-lg px-4 py-3 max-w-md flex items-start gap-3">
        <img src="/favicon.png" alt="" class="w-8 h-8 rounded shrink-0 mt-0.5" />
        <div>
            <p class="text-indigo-300 text-xs font-semibold">glua.dev</p>
            <p class="text-gray-200 text-sm mt-0.5">{message}</p>
        </div>
    </div>
</div>
