<template>
    <div :class="cond ? 'p-4 rounded' : 'px-2'">ternary</div>
    <span :class="{ 'size-4': active }">object binding</span>
    <p v-bind:class="cond ? 'my-2' : 'gap-2'">v-bind variant</p>
    <i class="static-note">static</i>
</template>
