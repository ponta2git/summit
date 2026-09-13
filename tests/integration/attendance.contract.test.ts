import { attendanceContract } from "../contracts/attendance.ts";
import { createAttendanceHarness } from "./_attendance.ts";

attendanceContract("PostgreSQL", createAttendanceHarness().create);
