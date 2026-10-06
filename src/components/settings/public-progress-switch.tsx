"use client";

import type { ActionState } from "@/lib/action-state";
import { AutoSaveSwitch } from "./auto-save-switch";

type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * Settings → Team website: "Show me on the team website's progress page" (and, while the team shows profiles, on the
 * Our Team page). Saves as soon as it's flipped (like the email switches): it shows the change while saving, then
 * whatever is really saved (`show`, from the page).
 */
export function PublicProgressSwitch({ action, show }: { action: FormAction; show: boolean }) {
  return (
    <AutoSaveSwitch
      action={action}
      checked={show}
      id="public-progress-show"
      label={<>Show me on the team website&apos;s progress page</>}
      description={
        <>
          Your name, position, and how many checklist items you&apos;ve finished. While the team shows profiles, also
          your profile on the Our Team page: your weekly counts and the last 25 items you finished, with when each was
          approved and the task titles (while the team shows them). Off: you&apos;re left off the list, out of recent
          completions, and have no profile. So nobody can work out your numbers from the totals, your items count in
          your subteam&apos;s and the team&apos;s totals only while someone else in your subteam is off too.
        </>
      }
    />
  );
}
