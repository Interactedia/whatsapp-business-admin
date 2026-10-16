"use client";

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface SmartTagsComboboxProps {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  className?: string;
  /** Optional id for the inner input, to associate a <Label htmlFor>. */
  id?: string;
}

/** Normalize tag for comparison: trim + lowercase */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** Find existing tag matching normalized input, preserving original capitalization */
function findExistingTag(tags: string[], input: string): string | null {
  const normalized = normalizeTag(input);
  return tags.find((t) => normalizeTag(t) === normalized) ?? null;
}

export function SmartTagsCombobox({
  value,
  onChange,
  suggestions = [],
  placeholder = "Agregar etiqueta...",
  className,
  id,
}: SmartTagsComboboxProps) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter suggestions: exclude already selected, match normalized input
  const filtered = suggestions.filter((s) => {
    if (value.some((v) => normalizeTag(v) === normalizeTag(s))) return false;
    if (!input) return true;
    return normalizeTag(s).includes(normalizeTag(input));
  });

  // Check if exact normalized match already exists (to show "create" option)
  const exactMatch = findExistingTag(suggestions, input);
  const showCreate = input.trim().length > 0 && !exactMatch;

  // Auto-select when filtered list changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [input]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const addTag = useCallback(
    (tag: string) => {
      const trimmed = tag.trim();
      if (!trimmed) return;
      if (value.some((v) => normalizeTag(v) === normalizeTag(trimmed))) return;
      onChange([...value, trimmed]);
      setInput("");
      setOpen(false);
      inputRef.current?.focus();
    },
    [value, onChange]
  );

  const removeTag = useCallback(
    (tag: string) => {
      onChange(value.filter((v) => normalizeTag(v) !== normalizeTag(tag)));
    },
    [value, onChange]
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const totalItems = filtered.length + (showCreate ? 1 : 0);

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((i) => (i + 1) % totalItems);
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((i) => (i - 1 + totalItems) % totalItems);
        break;
      case "Enter":
        e.preventDefault();
        if (highlightedIndex < filtered.length) {
          const selected = filtered[highlightedIndex];
          const existing = findExistingTag(suggestions, selected);
          addTag(existing ?? selected);
        } else if (showCreate) {
          addTag(input);
        }
        break;
      case "Escape":
        setOpen(false);
        break;
      case "Backspace":
        if (!input && value.length > 0) {
          removeTag(value[value.length - 1]);
        }
        break;
    }
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* Selected tags as chips */}
      <div
        className="flex flex-wrap gap-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-within:ring-2 focus-within:ring-ring"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-0.5 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-300"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
              className="flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-blue-200 dark:hover:bg-blue-800"
              aria-label={`Eliminar etiqueta ${tag}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : ""}
          className="min-w-20 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          aria-label="Etiquetas"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="tags-listbox"
          role="combobox"
        />
      </div>

      {/* Dropdown suggestions */}
      {open && (filtered.length > 0 || showCreate) && (
        <ul
          className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover py-1 shadow-md"
          role="listbox"
          id="tags-listbox"
        >
          {filtered.map((tag, i) => (
            <li
              key={tag}
              role="option"
              aria-selected={i === highlightedIndex}
              className={cn(
                "cursor-pointer px-2 py-1.5 text-sm",
                i === highlightedIndex ? "bg-accent" : "hover:bg-accent/50"
              )}
              onClick={() => {
                const existing = findExistingTag(suggestions, tag);
                addTag(existing ?? tag);
              }}
              onMouseEnter={() => setHighlightedIndex(i)}
            >
              {tag}
            </li>
          ))}
          {showCreate && (
            <li
              role="option"
              aria-selected={highlightedIndex === filtered.length}
              className={cn(
                "cursor-pointer px-2 py-1.5 text-sm italic text-muted-foreground",
                highlightedIndex === filtered.length ? "bg-accent" : "hover:bg-accent/50"
              )}
              onClick={() => addTag(input)}
              onMouseEnter={() => setHighlightedIndex(filtered.length)}
            >
              Crear &ldquo;{input.trim()}&rdquo;
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
