<script setup lang="ts">
import { h } from "vue";

const serializedHtml = '<div class="px-4 py-4">serialized</div>';
const unrelatedData = { class: "mt-2 mb-2" };
const rendered = h("div", { class: "pl-2 pr-2" });

void serializedHtml;
void unrelatedData;
void rendered;
</script>

<template>
    <!-- <div class="pt-4 pb-4">comment</div> -->
    <code>{{ '<div class="ml-3 mr-3">serialized interpolation</div>' }}</code>
    <div title='<span class="gap-x-2 gap-y-2">serialized attribute</span>' class="w-4 h-4">
        rendered
    </div>
</template>
