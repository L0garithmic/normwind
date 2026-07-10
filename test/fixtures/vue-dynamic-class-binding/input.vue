<template>
    <div :class="cond ? 'px-4 py-4 rounded' : 'pl-2 pr-2'">ternary</div>
    <span :class="{ 'w-4 h-4': active }">object binding</span>
    <p v-bind:class="cond ? 'mt-2 mb-2' : 'gap-x-2 gap-y-2'">v-bind variant</p>
    <i class="static-note">static</i>
</template>
