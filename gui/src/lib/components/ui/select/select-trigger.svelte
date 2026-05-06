<script lang="ts">
  import { Select as SelectPrimitive } from "bits-ui";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import type { Snippet } from "svelte";
  import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithoutChildrenOrChild<SelectPrimitive.TriggerProps> & {
    children?: Snippet;
  } = $props();
</script>

<SelectPrimitive.Trigger
  bind:ref
  data-slot="select-trigger"
  class={cn(
    "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground dark:bg-input/30",
    className
  )}
  {...restProps}
>
  <span data-slot="select-value" class="truncate text-left">
    {@render children?.()}
  </span>
  <ChevronDownIcon class="size-4 shrink-0 opacity-50" />
</SelectPrimitive.Trigger>
