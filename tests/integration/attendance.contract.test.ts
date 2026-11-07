import { sessionCreationContract } from "../contracts/sessionCreation.ts";
import { attendanceContract } from "../contracts/attendance.ts";
import { createAttendanceHarness } from "./_attendance.ts";

const { create } = createAttendanceHarness();
attendanceContract("PostgreSQL", create);
sessionCreationContract("PostgreSQL", create);
