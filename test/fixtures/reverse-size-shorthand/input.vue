<template>
    <!-- height-first authoring is just as valid as width-first -->
    <span class="h-5 w-5 shrink-0 rounded-full" />
    <!-- variant-prefixed, height-first -->
    <button class="hover:h-8 hover:w-8 inline-block">hover size</button>
    <!-- mixed: one width-first, one height-first, both must collapse -->
    <div class="w-6 h-6 mt-2 h-10 w-10"></div>
</template>

<script setup lang="ts">
// no-op
</script>
