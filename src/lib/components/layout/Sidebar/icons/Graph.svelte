<script lang="ts">
	export let className = 'size-4';
	export let strokeWidth = '1.5';
</script>

<svg
	class={className}
	aria-hidden="true"
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 24 24"
	stroke-width={strokeWidth}
	fill="none"
>
	<circle cx="5" cy="6" r="2" stroke="currentColor" />
	<circle cx="19" cy="6" r="2" stroke="currentColor" />
	<circle cx="12" cy="18" r="2" stroke="currentColor" />
	<path d="M6.8 7.5L10.2 16.5" stroke="currentColor" stroke-linecap="round" />
	<path d="M17.2 7.5L13.8 16.5" stroke="currentColor" stroke-linecap="round" />
	<path d="M7 6H17" stroke="currentColor" stroke-linecap="round" />
</svg>