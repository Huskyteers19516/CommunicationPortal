"use client";

import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import { Alert } from "@/components/ui/alert";

const DismissContext = createContext<(() => void) | null>(null);

/**
 * What happened to the announcement the list opened at ("Posted. Everyone can read it now.", "Changes saved."),
 * shown at the top of its card — once. The page's address drops the message right away (TidyAddress), so a reload
 * doesn't repeat it; this keeps showing it until the person does something else on the card (Pin / Unpin), so the
 * card never says two things at once.
 */
export function AnnouncementCardNotice({ id, message, children }: { id: string; message: string | null; children: ReactNode }) {
  const [shown, setShown] = useState(message);
  // A new message (a later save) shows again; the message going away (the address was tidied up) doesn't hide it.
  const [lastMessage, setLastMessage] = useState(message);
  if (message !== lastMessage) {
    setLastMessage(message);
    if (message) setShown(message);
  }
  const dismiss = useCallback(() => setShown(null), []);
  return (
    <DismissContext.Provider value={dismiss}>
      {shown && (
        <div id={id}>
          <Alert tone="success" className="py-2">
            {shown}
          </Alert>
        </div>
      )}
      {children}
    </DismissContext.Provider>
  );
}

/** Hides the card's notice (null outside a card). */
export function useDismissCardNotice(): (() => void) | null {
  return useContext(DismissContext);
}
