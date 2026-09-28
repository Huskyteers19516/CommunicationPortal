"use client";

import { Printer } from "lucide-react";
import { Button } from "../ui/button";

/** Opens the browser's print dialog (where "Save as PDF" is one of the printers). */
export function PrintButton() {
  return (
    <Button onClick={() => window.print()} autoFocus>
      <Printer className="size-4" aria-hidden />
      Print / Save as PDF
    </Button>
  );
}
