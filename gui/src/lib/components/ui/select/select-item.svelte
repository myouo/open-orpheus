<script lang="ts">
  import { Select as SelectPrimitive } from "bits-ui";
  import CheckIcon from "@lucide/svelte/icons/check";
  import type { Snippet } from "svelte";
  import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    children: itemChildren,
    ...restProps
  }: WithoutChildrenOrChild<SelectPrimitive.ItemProps> & {
    children?: Snippet;
  } = $props();
</script>

<SelectPrimitive.Item
  bind:ref
  data-slot="select-item"
  class={cn(
    "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
    className
  )}
  {...restProps}
>
  {#snippet children({ selected })}
    <span
      class="absolute right-2 flex size-4 items-center justify-center text-current"
    >
      {#if selected}
        <CheckIcon class="size-4" />
      {/if}
    </span>
    <span data-slot="select-item-text" class="truncate">
      {@render itemChildren?.()}
    </span>
  {/snippet}
</SelectPrimitive.Item>
