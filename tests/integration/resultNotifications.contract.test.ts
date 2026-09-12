import { resultNotificationContract } from "../contracts/resultNotifications.ts";
import { isIntegration } from "./_support.ts";
import { createResultNotificationHarness } from "./_resultNotifications.ts";

resultNotificationContract("PostgreSQL", createResultNotificationHarness, isIntegration);
