"use client";

import { ButtonLink } from "@/components/ui/button";

/**
 * "Clear" next to the Other teams search: back to every team. It empties the search box and puts keyboard focus
 * there (the link itself goes away once the search is cleared, which would otherwise leave focus on <body>).
 */
export function TeamSearchClear({ inputId, href }: { inputId: string; href: string }) {
  return (
    <ButtonLink
      href={href}
      variant="ghost"
      onClick={() => {
        const input = document.getElementById(inputId);
        if (input instanceof HTMLInputElement) {
          input.value = "";
          input.focus();
        }
      }}
    >
      Clear
    </ButtonLink>
  );
}
