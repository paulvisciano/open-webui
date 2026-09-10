<script lang="ts">
	let { chatIdProp = '' }: { chatIdProp?: string } = $props();
</script>

<div data-testid="chat-stub">Preview {chatIdProp}</div>
