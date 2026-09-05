"use client"

import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp, Search } from "lucide-react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

const Select = SelectPrimitive.Root

const SelectGroup = SelectPrimitive.Group

const SelectValue = SelectPrimitive.Value
const SEARCHABLE_SELECT_ITEM_THRESHOLD = 10
const SEARCH_DEBOUNCE_MS = 250
const INITIAL_VISIBLE_ITEM_COUNT = 120
const VISIBLE_ITEM_BATCH_SIZE = 120

const SelectTrigger = React.forwardRef(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background data-[placeholder]:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
      className
    )}
    {...props}>
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectScrollUpButton = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}>
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
))
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName

const SelectScrollDownButton = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}>
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
))
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName

const SelectLabel = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-sm font-semibold", className)}
    {...props} />
))
SelectLabel.displayName = SelectPrimitive.Label.displayName

const SelectItem = React.forwardRef(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}>
    <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

function getNodeText(node) {
  if (node === null || node === undefined || typeof node === "boolean") {
    return ""
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(getNodeText).join("")
  }
  if (React.isValidElement(node)) {
    return getNodeText(node.props?.children)
  }
  return ""
}

function isItemNode(node) {
  return (
    React.isValidElement(node)
    && (
      node.type === SelectItem
      || node.type?.displayName === SelectItem.displayName
    )
  )
}

function normalizeChildren(children) {
  return React.Children.toArray(children)
}

const SelectContent = React.forwardRef(({ className, children, position = "popper", ...props }, ref) => {
  const normalized = React.useMemo(() => normalizeChildren(children), [children])
  const searchableNodes = React.useMemo(() => {
    return normalized.map((child) => ({
      node: child,
      isItem: isItemNode(child),
      itemLabel: isItemNode(child)
        ? getNodeText(child.props?.children)
          .trim()
          .toLowerCase()
        : "",
      itemValue: isItemNode(child)
        ? String(child.props?.value || "").toLowerCase()
        : "",
    }))
  }, [normalized])
  const itemCount = React.useMemo(
    () => searchableNodes.filter((entry) => entry.isItem).length,
    [searchableNodes]
  )
  const searchable = itemCount > SEARCHABLE_SELECT_ITEM_THRESHOLD
  const [searchTerm, setSearchTerm] = React.useState("")
  const [debouncedSearchTerm, setDebouncedSearchTerm] = React.useState("")
  const [visibleLimit, setVisibleLimit] = React.useState(INITIAL_VISIBLE_ITEM_COUNT)

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchTerm(searchTerm.trim().toLowerCase())
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [searchTerm])

  React.useEffect(() => {
    if (!searchable) {
      setSearchTerm("")
    }
    setVisibleLimit(INITIAL_VISIBLE_ITEM_COUNT)
  }, [searchable])

  React.useEffect(() => {
    setVisibleLimit(INITIAL_VISIBLE_ITEM_COUNT)
  }, [debouncedSearchTerm])

  const filteredNodes = React.useMemo(() => {
    if (!searchable || !debouncedSearchTerm) {
      return searchableNodes
    }

    return searchableNodes.filter((entry) => {
      if (!entry.isItem) return false
      return (
        entry.itemLabel.includes(debouncedSearchTerm)
        || entry.itemValue.includes(debouncedSearchTerm)
      )
    })
  }, [debouncedSearchTerm, searchable, searchableNodes])

  const itemMatches = React.useMemo(
    () => filteredNodes.filter((entry) => entry.isItem),
    [filteredNodes]
  )
  const visibleNodes = React.useMemo(
    () => (searchable ? filteredNodes.slice(0, visibleLimit) : filteredNodes),
    [searchable, filteredNodes, visibleLimit]
  )

  const showLoadMore = React.useMemo(
    () => searchable ? itemMatches.length > visibleLimit : false,
    [searchable, itemMatches.length, visibleLimit]
  )

  const noResults = React.useMemo(
    () => searchable && debouncedSearchTerm && filteredNodes.length === 0,
    [searchable, debouncedSearchTerm, filteredNodes.length]
  )

  const onLoadMore = React.useCallback(() => {
    setVisibleLimit((current) => current + VISIBLE_ITEM_BATCH_SIZE)
  }, [])

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        className={cn(
          "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        {...props}>
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn("p-1", position === "popper" &&
            "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]")}>
          {searchable ? (
            <div className="sticky top-0 z-10 bg-popover px-2 py-1">
              <div className="relative">
                <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  placeholder="Search..."
                  className="pl-7 h-8"
                />
              </div>
            </div>
          ) : null}
          {noResults ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No matching items</div>
          ) : (
            <>
              {visibleNodes.map((entry, index) => (
                <React.Fragment
                  key={entry.node.key ?? `${entry.isItem ? "item" : "node"}-${index}-${entry.itemLabel || "entry"}`}>
                  {entry.node}
                </React.Fragment>
                ))}
              {showLoadMore ? (
                <div className="px-2 py-1.5">
                  <button
                    type="button"
                    className="w-full rounded-md border px-2 py-1.5 text-sm"
                    onClick={onLoadMore}>
                    Load more
                  </button>
                </div>
              ) : null}
            </>
          )}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectSeparator = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props} />
))
SelectSeparator.displayName = SelectPrimitive.Separator.displayName

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
}
