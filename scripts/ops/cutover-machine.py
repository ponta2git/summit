#!/usr/bin/env python3
"""Operate one pinned Machine. All observations stay in private files."""
import argparse
import copy
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import tempfile
import urllib.request


class Refused(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), sort_keys=True).encode()).hexdigest()


def private_write(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        name = stream.name
        json.dump(value, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(name, path)


class Machines:
    def __init__(self, app, machine):
        require(re.fullmatch(r"[a-z0-9-]+", app) and re.fullmatch(r"[a-z0-9]+", machine), "invalid Machine identity")
        self.base = f"https://api.machines.dev/v1/apps/{app}/machines/{machine}"
        self.token = os.environ["FLY_API_TOKEN"]
        self.app, self.machine = app, machine

    def logs(self):
        try:
            result = subprocess.run(["flyctl", "logs", "--app", self.app, "--machine", self.machine, "--json", "--no-tail"], capture_output=True, text=True, timeout=30, check=True)
            return decode_log_stream(result.stdout)
        except Exception:
            raise Refused("provider readiness logs unavailable") from None

    def request(self, method, suffix="", body=None):
        request = urllib.request.Request(self.base + suffix, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        # Never echo provider errors: response bodies may contain configuration.
        try:
            with urllib.request.urlopen(request, timeout=65) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except Exception:
            raise Refused("provider result unknown; inspect state before retry") from None


def decode_log_stream(output):
    decoder = json.JSONDecoder()
    records, offset = [], 0
    while offset < len(output):
        if output[offset].isspace():
            offset += 1
            continue
        record, offset = decoder.raw_decode(output, offset)
        require(isinstance(record, dict), "unexpected provider log format")
        records.append(record)
    return records


def stopped_config(config):
    result = copy.deepcopy(config)
    result["restart"] = {"policy": "no"}
    for service in result.get("services", []):
        service["autostart"] = False
    result.pop("schedule", None)
    result.pop("standbys", None)
    return result


def validate_plan(plan):
    require(plan.get("formatVersion") == 1, "unsupported plan")
    require(plan.get("consumer") in ("api", "worker", "summit"), "invalid consumer")
    for key in ("sourceConfig", "maintenanceConfig", "activeConfig"):
        config = plan[key]
        require(isinstance(config, dict) and config.get("guest"), "complete Machine config required")
        image = config.get("image", "")
        require(isinstance(image, str) and re.fullmatch(r"[^\s]+", image), "image reference required")
        if key == "sourceConfig":
            source_image = plan.get("sourceImage", image)
            require(isinstance(source_image, str) and re.fullmatch(r"[^\s]+@sha256:[a-f0-9]{64}", source_image), "immutable sourceImage required for tagged source")
            require("@" not in image or image == source_image, "source image expectation mismatch")
        else:
            require(re.fullmatch(r"[^\s]+@sha256:[a-f0-9]{64}", image), "immutable image required")
    maintenance = plan["maintenanceConfig"]
    require(maintenance == stopped_config(maintenance), "maintenance must disable restart and autostart")
    require(not maintenance.get("services"), "maintenance must remove public services")
    env = maintenance.get("env", {})
    require(env.get("MOMO_CUTOVER_MODE") == "maintenance", "maintenance boot required")
    for key in ("EXPECTED_DATABASE", "EXPECTED_ROLE", "EXPECTED_LEDGER_SHA256", "REPORT_PATH", "IMAGE_DIGEST"):
        require(env.get("MOMO_CUTOVER_" + key), "incomplete maintenance expectations")
    require(all(isinstance(value, str) for value in env.values()), "Machine env values must be strings")
    require(re.fullmatch(r"[a-f0-9]{64}", env["MOMO_CUTOVER_EXPECTED_LEDGER_SHA256"]), "invalid ledger expectation")
    require(Path(env["MOMO_CUTOVER_REPORT_PATH"]).is_absolute(), "report path must be absolute")
    require(env["MOMO_CUTOVER_IMAGE_DIGEST"] == maintenance["image"].split("@", 1)[1], "image expectation mismatch")
    require(not any(key.startswith("MOMO_CUTOVER_") for key in plan["activeConfig"].get("env", {})), "active config retains maintenance settings")
    require(plan["activeConfig"]["image"] == maintenance["image"], "active image differs from verified image")


def readiness_command(plan, phase):
    command = plan.get(phase + "ReadinessCommand")
    require(isinstance(command, list) and bool(command) and all(isinstance(arg, str) and arg for arg in command), "missing or invalid " + phase + " readiness command")
    if plan["consumer"] == "api":
        expected = ["/opt/momo-result/bin/momo-runtime-tool", "smoke", "maintenance" if phase == "maintenance" else "local"]
        require(command == expected, "API readiness command must use runtime smoke")
        if phase == "active":
            require(plan["activeConfig"].get("env", {}).get("MOMO_POSTDEPLOY_PUBLIC_EDGE") == "deferred", "cordoned API readiness must defer public edge")
    return command


def started_at(machine):
    starts = [event["timestamp"] for event in machine.get("events", []) if event.get("type") == "start" and event.get("status") == "started"]
    require(bool(starts), "Machine boot event unavailable")
    return max(starts)


def ready_logs(plan, machine, records):
    started = started_at(machine)
    expected = {}
    if plan["consumer"] == "worker":
        env = plan["activeConfig"].get("env", {})
        analysis, ocr = env.get("MOMO_ANALYSIS_WORKER_ID"), env.get("MOMO_OCR_V2_WORKER_ID")
        require(analysis and ocr, "active worker identities required")
        expected = {"analysis_worker_ready": analysis, "ocr_rust_v2_worker_ready": ocr,
            "processing_jobs_notification_route_ready": analysis, "processing_scheduler_ready": analysis}
    seen = set()
    for record in records:
        if record.get("instance") != plan["machineId"] or record.get("meta", {}).get("Event", {}).get("Provider") != "app":
            continue
        try:
            stamp = datetime.fromisoformat(record["timestamp"].replace("Z", "+00:00"))
            if stamp.tzinfo is None or stamp.timestamp() * 1000 < started:
                continue
            inner = json.loads(record["message"])
        except (ValueError, KeyError, TypeError):
            continue
        if plan["consumer"] == "summit":
            if inner.get("event") == "startup.ready" and inner.get("applicationReady") is True and inner.get("bootId"):
                return True
        else:
            fields = inner.get("fields", {})
            event = fields.get("event")
            if event in expected and fields.get("worker_id") == expected[event]:
                seen.add(event)
    return bool(expected) and seen == set(expected)


def wait_active_command(api, command):
    deadline = time.monotonic() + 60
    while True:
        result = api.request("POST", "/exec", {"command": command, "timeout": 30})
        if result.get("exit_code") == 0 and not result.get("exit_signal"):
            return
        require(time.monotonic() < deadline, "active readiness command failed")
        time.sleep(2)


def wait_active_logs(api, plan, machine):
    deadline = time.monotonic() + 60
    while True:
        if ready_logs(plan, machine, api.logs()):
            return
        require(time.monotonic() < deadline, "active readiness logs incomplete or stale")
        time.sleep(2)


def config_matches(machine, config, image=None):
    expected = (image or config.get("image", "")).split("@")[-1]
    resolved = machine.get("image_ref", {}).get("digest")
    return digest(machine.get("config")) == digest(config) and resolved == expected


def operate(api, plan, action):
    validate_plan(plan)
    if action in ("verify", "resume"):
        maintenance_readiness = readiness_command(plan, "maintenance")
    if action == "resume":
        if plan["consumer"] == "api":
            active_readiness = readiness_command(plan, "active")
        else:
            require(plan.get("activeReadiness") == "fly-logs", "active Fly log readiness required")
            if plan["consumer"] == "worker":
                env = plan["activeConfig"].get("env", {})
                require(env.get("MOMO_ANALYSIS_WORKER_ID") and env.get("MOMO_OCR_V2_WORKER_ID"), "active worker identities required")
    state = api.request("GET")
    require(state.get("id") == plan["machineId"], "Machine identity mismatch")
    if action == "state":
        return state
    require(state.get("state") in ("started", "stopped"), "Machine transition or unknown state; inspect first")
    source = plan["sourceConfig"]
    source_image = plan.get("sourceImage", source["image"])
    stopped = stopped_config(source)
    stopped["image"] = source_image
    maintenance = plan["maintenanceConfig"]
    active = plan["activeConfig"]
    stopped_active = stopped_config(active)
    known = config_matches(state, source, source_image) or any(config_matches(state, config) for config in (stopped, maintenance, active, stopped_active))
    require(known, "Machine configuration drift")

    def reload(expected, status):
        observed = api.request("GET")
        require(observed.get("state") == status and config_matches(observed, expected), "post-operation state mismatch; inspect before retry")
        return observed

    def stop(current):
        if current["state"] == "started":
            api.request("POST", "/cordon", {})
            api.request("POST", "/stop", {"signal": "SIGTERM", "timeout": "60s"})
            api.request("GET", "/wait?state=stopped&timeout=60")
        result = api.request("GET")
        current_image = source_image if current["config"] == source else current["config"]["image"]
        require(result["state"] == "stopped" and config_matches(result, current["config"], current_image), "stop result unknown")
        return result

    def update(current, config):
        require(current["state"] == "stopped", "only stopped Machines may be updated")
        api.request("POST", "", {"config": config, "current_version": current["instance_id"], "skip_launch": True, "skip_service_registration": True})
        api.request("GET", "/wait?state=stopped&timeout=60")
        return reload(config, "stopped")

    if action == "stop":
        guarded = stopped if config_matches(state, source, source_image) else stopped_config(state["config"])
        state = stop(state)
        return update(state, guarded) if not config_matches(state, guarded) else state
    if action == "restore-source":
        # Old images need not implement maintenance boot. Restore only the approved
        # stopped configuration; database rollback and normal restart are separate.
        state = stop(state)
        return update(state, stopped) if not config_matches(state, stopped) else state
    if action == "stage":
        require(state["state"] == "stopped", "stage requires stopped Machine")
        require(any(config_matches(state, config) for config in (stopped, maintenance, stopped_active)), "stage requires guarded source or same candidate")
        return update(state, maintenance) if not config_matches(state, maintenance) else state
    if action == "observe":
        require(config_matches(state, maintenance), "observation requires pinned maintenance config")
        if state["state"] == "stopped":
            api.request("POST", "/start", {})
            api.request("GET", "/wait?state=started&timeout=60")
        return reload(maintenance, "started")
    if action in ("verify", "resume"):
        require(state["state"] == "started" and config_matches(state, maintenance), "verification requires running maintenance candidate")
        env = maintenance["env"]
        result = api.request("POST", "/exec", {"command": ["cat", env["MOMO_CUTOVER_REPORT_PATH"]], "timeout": 10})
        require(result.get("exit_code") == 0 and not result.get("exit_signal"), "maintenance report unavailable")
        report = json.loads(result["stdout"])
        require(report.get("formatVersion") == 1 and report.get("consumer") == plan["consumer"] and report.get("mode") == "maintenance" and report.get("readOnly") is True, "invalid maintenance observation")
        require(report.get("database") == env["MOMO_CUTOVER_EXPECTED_DATABASE"] and report.get("role") == env["MOMO_CUTOVER_EXPECTED_ROLE"], "database observation mismatch")
        ledger = [{"hash": row["hash"], "created_at": row["created_at"]} for row in report["ledger"]]
        ledger_hash = hashlib.sha256(json.dumps(ledger, separators=(",", ":")).encode()).hexdigest()
        require(ledger_hash == env["MOMO_CUTOVER_EXPECTED_LEDGER_SHA256"], "ledger observation mismatch")
        starts = [event["timestamp"] for event in state.get("events", []) if event.get("type") == "start" and event.get("status") == "started"]
        require(bool(starts), "Machine boot event unavailable")
        observed_at = datetime.fromisoformat(report["observedAt"].replace("Z", "+00:00"))
        require(observed_at.tzinfo is not None and observed_at.timestamp() * 1000 >= max(starts), "stale process observation")
        machine = report["machine"]
        require(machine.get("id") == plan["machineId"] and machine.get("imageDigest") == env["MOMO_CUTOVER_IMAGE_DIGEST"] and machine.get("bootId"), "process identity mismatch")
        readiness = api.request("POST", "/exec", {"command": maintenance_readiness, "timeout": 30})
        require(readiness.get("exit_code") == 0 and not readiness.get("exit_signal"), "maintenance readiness failed")
        after = reload(maintenance, "started")
        after_starts = [event["timestamp"] for event in after.get("events", []) if event.get("type") == "start" and event.get("status") == "started"]
        require(after["instance_id"] == state["instance_id"] and after_starts and max(after_starts) == max(starts), "Machine restarted during observation")
        if action == "verify":
            return {"machine": after, "observation": report}
        # Opening one component is explicit. Cross-component approval belongs to the protected job.
        current = stop(after)
        update(current, active)
        try:
            api.request("POST", "/start", {})
            api.request("GET", "/wait?state=started&timeout=60")
            result = reload(active, "started")
            if plan["consumer"] == "api":
                wait_active_command(api, active_readiness)
            else:
                wait_active_logs(api, plan, result)
            ready = reload(active, "started")
            require(ready["instance_id"] == result["instance_id"] and ready.get("events") == result.get("events"), "Machine restarted during active readiness")
        except Exception:
            failed = api.request("GET")
            require(failed.get("state") in ("started", "stopped") and config_matches(failed, active), "active readiness failed with unknown Machine state; inspect before retry")
            stopped_state = stop(failed)
            update(stopped_state, stopped_active)
            raise Refused("active readiness failed; component stopped") from None
        api.request("POST", "/uncordon", {})
        return result
    raise Refused("unknown operation")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("state", "stop", "stage", "observe", "verify", "resume", "restore-source"))
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    api = None
    try:
        plan = json.loads(args.plan.read_text())
        api = Machines(plan["app"], plan["machineId"])
        result = operate(api, plan, args.action)
        private_write(args.output, result)
    except Exception as error:
        reason = str(error) if isinstance(error, Refused) else "cutover operation failed; inspect private inputs and state"
        failure = {"formatVersion": 1, "action": args.action, "status": "failed", "reason": reason}
        if api is not None:
            try:
                failure["observedAfterFailure"] = api.request("GET")
            except Exception:
                failure["observedAfterFailure"] = None
        try:
            private_write(args.output, failure)
        except Exception:
            pass
        print(reason, file=__import__("sys").stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
