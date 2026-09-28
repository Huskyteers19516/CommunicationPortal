"use client";

import type { ComponentProps } from "react";
import { Select } from "./field";

/**
 * A `Select` in a GET filter form that applies itself as soon as an option is picked (one tap on phones).
 * Keep the form's submit button: it's how the search box is sent, and how the form works without JavaScript.
 */
export function AutoSubmitSelect({ onChange, ...props }: ComponentProps<typeof Select>) {
  return (
    <Select
      {...props}
      onChange={(e) => {
        onChange?.(e);
        e.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
