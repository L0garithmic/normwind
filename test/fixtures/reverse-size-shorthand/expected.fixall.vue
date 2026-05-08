<template>
    <!-- height-first authoring is just as valid as width-first -->
    <span class="size-5 shrink-0 rounded-full" />
    <!-- variant-prefixed, height-first -->
    <button class="hover:size-8 inline-block">hover size</button>
    <!-- mixed: one width-first, one height-first, both must collapse -->
    <div class="size-6 mt-2 size-10"></div>
</template>

<script setup lang="ts">
// no-op
</script>
