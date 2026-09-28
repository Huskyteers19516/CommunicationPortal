-- FTC 2026–2027 season: the Biobuzz league scrimmages (Saturdays, 7 AM – 12 PM).
-- Data only. `sourceKey` keeps this from ever adding the same event twice; leaders edit or remove them on the Team calendar.
-- The Qualifying Tournament's date is TBD: add it on the calendar once it's announced.
INSERT INTO "CalendarEvent" ("id", "title", "kind", "startsOn", "startTime", "endTime", "notes", "sourceKey", "updatedAt")
VALUES
  ('season2627scrimmage0', 'League Scrimmage 0', 'SCRIMMAGE', DATE '2026-10-31', '07:00', '12:00', 'Biobuzz league scrimmage (Saturday, 7 AM – 12 PM).', 'ftc-2026-27/scrimmage-0', CURRENT_TIMESTAMP),
  ('season2627scrimmage1', 'League Scrimmage 1', 'SCRIMMAGE', DATE '2026-11-14', '07:00', '12:00', 'Biobuzz league scrimmage (Saturday, 7 AM – 12 PM).', 'ftc-2026-27/scrimmage-1', CURRENT_TIMESTAMP),
  ('season2627scrimmage2', 'League Scrimmage 2', 'SCRIMMAGE', DATE '2026-12-05', '07:00', '12:00', 'Biobuzz league scrimmage (Saturday, 7 AM – 12 PM).', 'ftc-2026-27/scrimmage-2', CURRENT_TIMESTAMP),
  ('season2627scrimmage3', 'League Scrimmage 3', 'SCRIMMAGE', DATE '2027-01-09', '07:00', '12:00', 'Biobuzz league scrimmage (Saturday, 7 AM – 12 PM).', 'ftc-2026-27/scrimmage-3', CURRENT_TIMESTAMP)
ON CONFLICT ("sourceKey") DO NOTHING;
