<script lang="ts">
    export let limit: number = 2;
</script>

<div class="fixed inset-0 bg-gray-900 bg-opacity-80 flex items-center justify-center z-50 transition-opacity duration-300">
    <div class="bg-gray-800 p-8 rounded-lg shadow-2xl transform scale-95 transition-transform duration-300 w-full max-w-md">
        <svg class="h-10 w-10 text-red-400 mx-auto mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
        <h2 class="text-2xl font-bold mb-2 text-white">Session Limit Reached</h2>
        <p class="text-gray-400">You already have {limit} active session{limit === 1 ? "" : "s"} running. Please wait for an existing session to end before starting a new one.</p>
    </div>
</div>
