#!/usr/bin/env python3
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("cutover", Path(__file__).parents[1] / "ops/cutover-machine.py")
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)


def fixture():
    image = "registry.example/app@sha256:" + "a" * 64
    base = {"image": image, "guest": {"cpus": 1, "memory_mb": 256}, "env": {}, "restart": {"policy": "always"}, "services": [{"autostart": True}]}
    maintenance = cutover.stopped_config(base)
    maintenance["services"] = []
    maintenance["env"] = {
        "MOMO_CUTOVER_MODE": "maintenance", "MOMO_CUTOVER_EXPECTED_DATABASE": "fixture",
        "MOMO_CUTOVER_EXPECTED_ROLE": "reader", "MOMO_CUTOVER_EXPECTED_LEDGER_SHA256": cutover.hashlib.sha256(b"[]").hexdigest(),
        "MOMO_CUTOVER_IMAGE_DIGEST": "sha256:" + "a" * 64, "MOMO_CUTOVER_REPORT_PATH": "/tmp/report.json"}
    active = copy.deepcopy(base)
    active["env"] = {"MOMO_ANALYSIS_WORKER_ID": "analysis", "MOMO_OCR_V2_WORKER_ID": "ocr"}
    base["image"] = "registry.example/app@sha256:" + "b" * 64
    return {"formatVersion": 1, "consumer": "worker", "app": "fixture", "machineId": "abc123", "maintenanceReadinessCommand": ["fixture-maintenance-readiness"], "activeReadiness": "fly-logs", "sourceConfig": base, "maintenanceConfig": maintenance, "activeConfig": active}


class FakeMachines:
    def __init__(self, plan):
        self.state = {"id": plan["machineId"], "state": "started", "instance_id": "v1", "image_ref": {"digest": plan.get("sourceImage", plan["sourceConfig"]["image"]).split("@", 1)[1]}, "config": copy.deepcopy(plan["sourceConfig"]), "events": [{"type": "start", "status": "started", "timestamp": 1000}]}
        self.calls = []
        self.fail_update = False
        self.async_update = False
        self.fail_readiness = None
        self.report = {"formatVersion": 1, "consumer": "worker", "mode": "maintenance", "observedAt": "2026-01-01T00:00:00.000Z", "role": "reader", "database": "fixture", "ledger": [], "readOnly": True, "machine": {"id": "abc123", "bootId": "boot1", "imageDigest": "sha256:" + "a" * 64}}

    def logs(self):
        if self.fail_readiness == "fly-logs":
            raise cutover.Refused("missing logs")
        return [{"instance": "abc123", "meta": {"Event": {"Provider": "app"}}, "timestamp": "2026-01-01T00:00:00Z", "message": json.dumps({"fields": {"event": event, "worker_id": worker}})} for event, worker in [("analysis_worker_ready", "analysis"), ("ocr_rust_v2_worker_ready", "ocr"), ("processing_jobs_notification_route_ready", "analysis"), ("processing_scheduler_ready", "analysis")]]

    def request(self, method, suffix="", body=None):
        self.calls.append((method, suffix, copy.deepcopy(body)))
        if method == "GET":
            if suffix.startswith("/wait?state=stopped") and self.state["state"] == "updating":
                self.state["state"] = "stopped"
            return copy.deepcopy(self.state)
        if suffix == "/exec":
            if body["command"] == self.fail_readiness:
                return {"exit_code": 1}
            return {"exit_code": 0, "stdout": json.dumps(self.report)}
        if suffix == "/stop":
            self.state["state"] = "stopped"
        elif suffix == "/start":
            self.state["state"] = "started"
        elif suffix == "":
            assert self.state["state"] == "stopped"
            assert body["skip_launch"] is True
            assert body["current_version"] == self.state["instance_id"]
            self.state["config"] = copy.deepcopy(body["config"])
            self.state["image_ref"] = {"digest": body["config"]["image"].split("@", 1)[1]}
            self.state["instance_id"] += "n"
            if self.async_update:
                self.state["state"] = "updating"
            if self.fail_update:
                raise cutover.Refused("provider result unknown")
        return {}


class CutoverTests(unittest.TestCase):
    def test_stopped_candidate_retry_and_explicit_resume(self):
        plan = fixture()
        api = FakeMachines(plan)
        cutover.operate(api, plan, "stop")
        self.assertEqual(api.state["state"], "stopped")
        self.assertEqual(api.state["config"]["restart"]["policy"], "no")
        self.assertFalse(api.state["config"]["services"][0]["autostart"])
        cutover.operate(api, plan, "stage")
        api.calls.clear()
        cutover.operate(api, plan, "stage")
        self.assertEqual([call[0] for call in api.calls], ["GET"])
        cutover.operate(api, plan, "observe")
        self.assertEqual(api.state["config"], plan["maintenanceConfig"])
        cutover.operate(api, plan, "verify")
        self.assertEqual(api.state["config"], plan["maintenanceConfig"])
        cutover.operate(api, plan, "resume")
        self.assertEqual(api.state["state"], "started")
        self.assertEqual(api.state["config"], plan["activeConfig"])
        cutover.operate(api, plan, "stop")
        self.assertEqual(api.state["state"], "stopped")
        self.assertEqual(api.state["config"], cutover.stopped_config(plan["activeConfig"]))

    def test_restore_source_pins_old_image_and_full_config_without_starting_it(self):
        plan = fixture()
        api = FakeMachines(plan)
        for action in ("stop", "stage", "observe"):
            cutover.operate(api, plan, action)
        self.assertNotEqual(plan["sourceConfig"]["image"], plan["maintenanceConfig"]["image"])
        api.calls.clear()
        restored = cutover.operate(api, plan, "restore-source")
        self.assertEqual(restored["state"], "stopped")
        self.assertEqual(restored["config"], cutover.stopped_config(plan["sourceConfig"]))
        self.assertEqual(restored["image_ref"]["digest"], "sha256:" + "b" * 64)
        self.assertFalse(any(path in ("/start", "/uncordon", "/exec") for _, path, _ in api.calls))
        updates = [body for method, path, body in api.calls if method == "POST" and path == ""]
        self.assertEqual(len(updates), 1)
        self.assertTrue(updates[0]["skip_launch"])
        self.assertTrue(updates[0]["skip_service_registration"])
        api.calls.clear()
        cutover.operate(api, plan, "restore-source")
        self.assertFalse(any(method == "POST" for method, _, _ in api.calls))
        cutover.operate(api, plan, "stage")
        self.assertEqual(api.state["config"], plan["maintenanceConfig"])
        self.assertEqual(api.state["state"], "stopped")

    def test_tagged_source_is_verified_then_pinned_before_stage_and_restore(self):
        plan = fixture()
        plan["sourceImage"] = plan["sourceConfig"]["image"]
        plan["sourceConfig"]["image"] = "registry.example/app:approved-old"
        original = copy.deepcopy(plan["sourceConfig"])
        api = FakeMachines(plan)
        cutover.operate(api, plan, "stop")
        expected = cutover.stopped_config(original)
        expected["image"] = plan["sourceImage"]
        self.assertEqual(api.state["config"], expected)
        self.assertEqual(plan["sourceConfig"], original)
        for action in ("stage", "observe", "restore-source"):
            cutover.operate(api, plan, action)
        self.assertEqual(api.state["config"], expected)
        self.assertEqual(api.state["state"], "stopped")
        api.calls.clear()
        cutover.operate(api, plan, "stop")
        self.assertFalse(any(method == "POST" for method, _, _ in api.calls))

    def test_tagged_source_rejects_resolved_digest_or_tag_drift_before_mutation(self):
        plan = fixture()
        plan["sourceImage"] = plan["sourceConfig"]["image"]
        plan["sourceConfig"]["image"] = "registry.example/app:approved-old"
        for change in (
            lambda state: state["image_ref"].update(digest="sha256:" + "c" * 64),
            lambda state: state["config"].update(image="registry.example/app:other"),
        ):
            for action in ("stop", "restore-source"):
                api = FakeMachines(plan)
                change(api.state)
                with self.assertRaises(cutover.Refused):
                    cutover.operate(api, plan, action)
                self.assertEqual([call[0] for call in api.calls], ["GET"])

    def test_tagged_source_requires_immutable_separate_image_before_provider(self):
        for source_image in (None, "registry.example/app:latest"):
            plan = fixture()
            api = FakeMachines(plan)
            plan["sourceConfig"]["image"] = "registry.example/app:approved-old"
            if source_image is not None:
                plan["sourceImage"] = source_image
            with self.assertRaises(cutover.Refused):
                cutover.operate(api, plan, "stop")
            self.assertEqual(api.calls, [])

    def test_restore_source_unknown_update_result_requires_reconciliation(self):
        plan = fixture()
        api = FakeMachines(plan)
        for action in ("stop", "stage", "observe"):
            cutover.operate(api, plan, action)
        api.fail_update = True
        with self.assertRaises(cutover.Refused):
            cutover.operate(api, plan, "restore-source")
        self.assertEqual(api.state["state"], "stopped")
        api.fail_update = False
        api.calls.clear()
        cutover.operate(api, plan, "restore-source")
        self.assertFalse(any(method == "POST" for method, _, _ in api.calls))
        self.assertEqual(api.state["config"], cutover.stopped_config(plan["sourceConfig"]))

    def test_restore_source_rejects_unknown_state_partial_config_and_resolved_image_drift(self):
        plan = fixture()
        for change in (
            lambda state: state.update(state="starting"),
            lambda state: state["config"]["env"].update(PARTIAL_UPDATE="true"),
            lambda state: state["image_ref"].update(digest="sha256:" + "c" * 64),
        ):
            api = FakeMachines(plan)
            change(api.state)
            with self.assertRaises(cutover.Refused):
                cutover.operate(api, plan, "restore-source")
            self.assertEqual([call[0] for call in api.calls], ["GET"])

    def test_missing_resume_readiness_cannot_contact_provider(self):
        plan = fixture()
        del plan["activeReadiness"]
        api = FakeMachines(plan)
        with self.assertRaises(cutover.Refused):
            cutover.operate(api, plan, "resume")
        self.assertEqual(api.calls, [])

    def test_readiness_failure_keeps_component_closed(self):
        for phase in ("maintenance", "active"):
            plan = fixture()
            api = FakeMachines(plan)
            cutover.operate(api, plan, "stop")
            cutover.operate(api, plan, "stage")
            cutover.operate(api, plan, "observe")
            api.fail_readiness = plan["maintenanceReadinessCommand"] if phase == "maintenance" else "fly-logs"
            with self.assertRaises(cutover.Refused):
                cutover.operate(api, plan, "resume")
            self.assertFalse(any(path == "/uncordon" for _, path, _ in api.calls))
            if phase == "active":
                self.assertEqual(api.state["state"], "stopped")
                self.assertEqual(api.state["config"], cutover.stopped_config(plan["activeConfig"]))

    def test_skip_launch_update_waits_for_stopped_before_observation(self):
        plan = fixture()
        api = FakeMachines(plan)
        cutover.operate(api, plan, "stop")
        api.async_update = True
        cutover.operate(api, plan, "stage")
        self.assertEqual(api.state["state"], "stopped")
        self.assertEqual(api.state["config"], plan["maintenanceConfig"])

    def test_fly_pretty_json_stream_decodes_without_line_assumptions(self):
        records = [{"message": "one"}, {"message": "two", "meta": {"Event": {"Provider": "app"}}}]
        pretty = "\n".join(json.dumps(record, indent=2) for record in records)
        self.assertEqual(cutover.decode_log_stream(pretty), records)
        self.assertEqual(cutover.decode_log_stream(" \n"), [])
        with self.assertRaises(cutover.Refused):
            cutover.decode_log_stream("[]")

    def test_active_process_exit_still_disables_restart(self):
        plan = fixture()
        api = FakeMachines(plan)
        for action in ("stop", "stage", "observe"):
            cutover.operate(api, plan, action)
        def exited_logs():
            api.state["state"] = "stopped"
            raise cutover.Refused("process exited")
        api.logs = exited_logs
        with self.assertRaises(cutover.Refused):
            cutover.operate(api, plan, "resume")
        self.assertEqual(api.state["config"], cutover.stopped_config(plan["activeConfig"]))
        self.assertFalse(any(path == "/uncordon" for _, path, _ in api.calls))

    def test_log_readiness_rejects_stale_wrong_machine_worker_and_incomplete(self):
        plan = fixture()
        api = FakeMachines(plan)
        records = api.logs()
        self.assertTrue(cutover.ready_logs(plan, api.state, records))
        for invalid in ("stale", "machine", "worker", "incomplete"):
            altered = copy.deepcopy(records)
            if invalid == "stale":
                for row in altered: row["timestamp"] = "1970-01-01T00:00:00Z"
            if invalid == "machine":
                for row in altered: row["instance"] = "other"
            if invalid == "worker": altered[0]["message"] = json.dumps({"fields": {"event": "analysis_worker_ready", "worker_id": "old"}})
            if invalid == "incomplete": altered.pop()
            self.assertFalse(cutover.ready_logs(plan, api.state, altered), invalid)

    def test_summit_requires_current_boot_application_readiness(self):
        plan = fixture()
        plan["consumer"] = "summit"
        api = FakeMachines(plan)
        row = api.logs()[0]
        row["message"] = json.dumps({"event": "startup.ready", "applicationReady": True, "bootId": "boot"})
        self.assertTrue(cutover.ready_logs(plan, api.state, [row]))
        for payload in ({"event": "startup.ready", "applicationReady": False, "bootId": "boot"}, {"event": "startup.ready", "applicationReady": True}):
            row["message"] = json.dumps(payload)
            self.assertFalse(cutover.ready_logs(plan, api.state, [row]))

    def test_unknown_update_result_is_reconciled_before_retry(self):
        plan = fixture()
        api = FakeMachines(plan)
        cutover.operate(api, plan, "stop")
        api.fail_update = True
        with self.assertRaises(cutover.Refused):
            cutover.operate(api, plan, "stage")
        api.fail_update = False
        api.calls.clear()
        cutover.operate(api, plan, "stage")
        self.assertEqual([call[0] for call in api.calls], ["GET"])
        self.assertEqual(api.state["state"], "stopped")

    def test_drift_or_transition_cannot_mutate(self):
        plan = fixture()
        for change in (lambda s: s.update(state="starting"), lambda s: s["config"].update(image="other")):
            api = FakeMachines(plan)
            change(api.state)
            with self.assertRaises(cutover.Refused):
                cutover.operate(api, plan, "stop")
            self.assertEqual([call[0] for call in api.calls], ["GET"])

    def test_failed_read_only_evidence_never_opens_component(self):
        for invalid in ("stale", "role", "ledger", "writable", "digest", "boot"):
            plan = fixture()
            api = FakeMachines(plan)
            api.state["config"] = plan["maintenanceConfig"]
            api.state["image_ref"] = {"digest": plan["maintenanceConfig"]["image"].split("@", 1)[1]}
            if invalid == "stale": api.report["observedAt"] = "1970-01-01T00:00:00Z"
            if invalid == "role": api.report["role"] = "other"
            if invalid == "ledger": api.report["ledger"] = [{"hash": "other", "created_at": "1"}]
            if invalid == "writable": api.report["readOnly"] = False
            if invalid == "digest": api.report["machine"]["imageDigest"] = "sha256:" + "b" * 64
            if invalid == "boot": api.state["events"] = []
            with self.subTest(invalid=invalid), self.assertRaises(cutover.Refused):
                cutover.operate(api, plan, "resume")
            self.assertFalse(any(method == "POST" and path != "/exec" for method, path, _ in api.calls))

    def test_read_only_state_preserves_unknown_transition_for_operator(self):
        plan = fixture()
        api = FakeMachines(plan)
        api.state["state"] = "starting"
        api.state["config"]["image"] = "unexpected"
        observed = cutover.operate(api, plan, "state")
        self.assertEqual(observed["state"], "starting")
        self.assertEqual([call[0] for call in api.calls], ["GET"])

    def test_invalid_plan_cannot_contact_provider(self):
        for invalid in ("restart", "public", "mutable", "mode", "active"):
            plan = fixture()
            if invalid == "restart": plan["maintenanceConfig"]["restart"] = {"policy": "always"}
            if invalid == "public": plan["maintenanceConfig"]["services"] = [{"autostart": False}]
            if invalid == "mutable": plan["maintenanceConfig"]["image"] = "registry.example/app:latest"
            if invalid == "mode": plan["maintenanceConfig"]["env"]["MOMO_CUTOVER_MODE"] = "typo"
            if invalid == "active": plan["activeConfig"]["env"]["MOMO_CUTOVER_MODE"] = "maintenance"
            api = FakeMachines(plan)
            with self.subTest(invalid=invalid), self.assertRaises(cutover.Refused):
                cutover.operate(api, plan, "state")
            self.assertEqual(api.calls, [])


if __name__ == "__main__":
    unittest.main()
