/** A time ("7:00 AM") or a time range ("7:00 AM – 12:00 PM"), as formatTime / formatEventTimes print them. */
const TIMES = /(\d{1,2}:\d{2} [AP]M(?: – \d{1,2}:\d{2} [AP]M)?)/;

/**
 * A when-label (formatEventWhen and friends) whose times never break across lines: on a phone "7:00 AM –
 * 12:00 PM" wraps as a whole instead of between "7:00" and "AM".
 */
export function WhenText({ text }: { text: string }) {
  const parts = text.split(TIMES);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="whitespace-nowrap">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
