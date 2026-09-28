import "server-only";
import { ATTENDANCE_SETTINGS_KEY, type AttendanceSettings, parseAttendanceSettings } from "@/lib/attendance";
import { type Db, prisma } from "../db";

/** The team's attendance schedule (regular days, Flex days, first report period), with defaults. Anyone signed in may read it. */
export async function getAttendanceSettings(db: Db = prisma): Promise<AttendanceSettings> {
  const note = await db.teamNote.findUnique({ where: { key: ATTENDANCE_SETTINGS_KEY }, select: { body: true } });
  return parseAttendanceSettings(note?.body);
}
